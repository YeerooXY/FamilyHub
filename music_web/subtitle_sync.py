"""Align and record the timing of FamilyHub movie subtitle sidecars."""
import csv
from datetime import datetime, timezone
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
from threading import Lock, Thread

from .audio_tracks import FORMATS, media_command
from .movie_subtitles import (LANGUAGES, MAX_FILE, SRT_START, SubtitleError, read_sidecar,
                              subtitle_bytes as parse_subtitle, write_sidecar)
from .resources import background_command


log = logging.getLogger(__name__)
METADATA = '.familyhub-subtitles.json'
METHODS = {'audio', 'embedded', 'english', 'release', 'offset', 'pending', 'unknown'}
SYNC_SLOT = Lock()
METADATA_LOCK = Lock()
JOBS_LOCK = Lock()
RUNNING = set()
FAILED = {}
BUSY = 'Another subtitle sync is in progress. Try again in a moment.'


def cue_end_times(data):
    ends = []
    for block in re.split(r'\n[ \t]*\n', data.decode('utf-8').strip()):
        match = SRT_START.match(block)
        if not match or match[1] >= match[2]:
            raise ValueError('Invalid subtitle cue.')
        ends.append(match[2])
    return ends


def bind_mount(source, target, *, readonly=False):
    # Docker parses mount fields as CSV, including filenames containing commas or quotes.
    fields = ['type=bind', f'source={source}', f'target={target}']
    if readonly:
        fields.append('readonly')
    options = io.StringIO()
    csv.writer(options).writerow(fields)
    return options.getvalue().rstrip('\r\n')


def align(video, subtitle_bytes, reference_bytes=None):
    if not 0 < len(subtitle_bytes) <= MAX_FILE:
        return None
    if reference_bytes is not None and (len(reference_bytes) > MAX_FILE or reference_bytes == subtitle_bytes):
        return None
    video = Path(video)
    docker, probe = shutil.which('docker'), shutil.which('ffprobe')
    if not docker or not probe or not hasattr(os, 'geteuid') or video.suffix.lower() not in FORMATS:
        return None
    try:
        duration = float(media_command(probe, video, ['-show_entries', 'format=duration', '-of',
                                 'default=noprint_wrappers=1:nokey=1'], timeout=4, probe=True))
        if not math.isfinite(duration) or duration <= 0:
            return None
        expected = len(cue_end_times(subtitle_bytes))
        with TemporaryDirectory(prefix='movie-alass-') as directory:
            scratch = Path(directory)
            (scratch / 'incorrect.srt').write_bytes(subtitle_bytes)
            container = 'familyhub-alass-sync'
            command = [docker, 'run', '--rm', '--pull=never', '--name', container, '--network=none',
                       '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
                       '--memory=1g', '--cpus=1', '--cpu-shares=2', '--user', f'{os.geteuid()}:{os.getegid()}',
                       '--mount', bind_mount(directory, '/work'), '--workdir', '/work']
            reference = 'reference.srt'
            if reference_bytes is None:
                reference = '/work/video' + video.suffix.lower()
                command += ['--mount', bind_mount(video, reference, readonly=True)]
            else:
                (scratch / reference).write_bytes(reference_bytes)
            command += ['familyhub-alass', reference, 'incorrect.srt', 'out.srt']
            io_options = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                subprocess.run(background_command(command, nice=19), check=True,
                               timeout=600 if reference_bytes is None else 120, **io_options)
            except subprocess.TimeoutExpired:
                subprocess.run([docker, 'rm', '-f', container], timeout=5, check=False, **io_options)
                raise
            # The container can write to scratch. Read only a bounded regular file from it.
            from .movie_subtitle_import import read_file
            output = parse_subtitle(read_file(scratch / 'out.srt', MAX_FILE), 'en')
            cues = cue_end_times(output)
            hours, minutes, seconds = cues[0].replace(',', '.').split(':')
            if len(cues) == expected and int(hours) * 3600 + int(minutes) * 60 + float(seconds) <= duration:
                return output
    except (OSError, ValueError, SubtitleError, subprocess.SubprocessError):
        log.warning('Could not align movie subtitles.')
    return None


def metadata(folder):
    try:
        data, info = read_sidecar(folder, METADATA)
    except FileNotFoundError:
        return {}, None
    entries = json.loads(data)
    if not isinstance(entries, dict):
        raise ValueError('Invalid subtitle timing metadata.')
    return entries, info


def timing_snapshot(video, folder, *, include_unrecorded):
    names = [f'{video.stem}.{code}.srt' for code in LANGUAGES]
    # Read state first so a job finishing during this read cannot pair idle with stale metadata.
    with JOBS_LOCK:
        states = {name: 'running' if (video, name) in RUNNING else FAILED.get((video, name)) for name in names}
    try:
        entries, _ = metadata(folder)
    except (OSError, ValueError, RecursionError):
        entries = {}
    return {name: timing_status(entries, name, states[name]) for name in names
            if include_unrecorded or name in entries or states[name]}


def record_timing(video, folder, owner, name, method):
    try:
        with METADATA_LOCK:
            entries, expected = metadata(folder)
            entries[name] = {'method': method, 'synced_at': datetime.now(timezone.utc).isoformat()}
            data = json.dumps(entries, sort_keys=True).encode('utf-8') + b'\n'
            if len(data) > MAX_FILE:
                raise ValueError('Subtitle timing metadata is too large.')
            write_sidecar(video, folder, owner, METADATA, data, expected=expected)
    except (OSError, ValueError, RecursionError, SubtitleError):
        log.warning('Could not save movie subtitle timing metadata.')
        return False
    return True


def timing_status(entries, name, state=None):
    entry = entries.get(name)
    method = entry.get('method') if isinstance(entry, dict) else None
    if not isinstance(method, str) or method not in METHODS:
        method = 'unknown'
    return {'method': method, 'state': state or ('failed' if method == 'pending' else 'idle')}


def sync_running(video, name):
    with JOBS_LOCK:
        return (video, name) in RUNNING


def start_job(video, name, work, *, queue=False):
    key = video, name
    with JOBS_LOCK:
        if key in RUNNING or len(RUNNING) >= 16 or (not queue and not SYNC_SLOT.acquire(blocking=False)):
            return False
        RUNNING.add(key)
        FAILED.pop(key, None)

    def finish(success):
        with JOBS_LOCK:
            RUNNING.remove(key)
            if not success:
                FAILED[key] = 'failed'
                if len(FAILED) > 256:
                    del FAILED[next(iter(FAILED))]
            SYNC_SLOT.release()

    def run():
        if queue:
            SYNC_SLOT.acquire()
        success = False
        try:
            success = work()
        finally:
            finish(success)

    try:
        Thread(target=run, name='movie-subtitle-sync', daemon=True).start()
    except RuntimeError:
        if queue:
            with JOBS_LOCK:
                RUNNING.remove(key)
        else:
            finish(False)
        log.warning('Could not start movie subtitle sync.')
        return False
    return True
