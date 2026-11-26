"""Select and publish one English or Hungarian subtitle for a completed release."""
from bisect import bisect_left
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
from uuid import uuid4

from .audio_tracks import FORMATS, media_command, opened
from .movie_subtitles import (LANGUAGES, MAX_FILE, TIMESTAMP, SubtitleError, sidecar_exists, subtitle_bytes,
                              subtitle_text, write_sidecar)
from .resources import background_command


log = logging.getLogger(__name__)
VARIANTS = {'forced', 'sdh', 'hi', 'cc'}
TEXT = {'.srt', '.ass', '.ssa'}
FORMATS_SUBTITLE = TEXT | {'.idx', '.sub'}
CUE_TIME = re.compile(rf'(?m)^([ \t]*)({TIMESTAMP})([ \t]+-->[ \t]+)({TIMESTAMP})([^\n]*)$')
MEDIA_ERRORS = (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError)


def words(name):
    return re.findall(r'[^\W_]+', name.casefold())


def language(tokens):
    matches = [code for code, names in LANGUAGES.items() if names.intersection(tokens)]
    return matches[0] if len(matches) == 1 else None


def subtitle_label(path, source):
    names = words(path.stem)
    video = words(source.stem)
    shared = next((index for index, (label, original) in enumerate(zip(names, video)) if label != original),
                  min(len(names), len(video)))
    names = names[shared:]
    code = language(names)
    parent_names = []
    for parent in path.parents:
        if parent == source.parent:
            break
        if source.parent not in parent.parents:
            break
        parent_names.extend(words(parent.name))
    return code or language(parent_names), bool(VARIANTS.intersection(names + parent_names))


def milliseconds(timestamp):
    hours, minutes, seconds, fraction = map(int, re.split(r'[:,.]', timestamp))
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fraction * (10 if '.' in timestamp else 1)


def timestamp(value):
    seconds, fraction = divmod(value, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f'{hours:02d}:{minutes:02d}:{seconds:02d},{fraction:03d}'


def ass_to_srt(raw, code):
    events, fields, cues = False, [], []
    clock = re.compile(r'\d{1,2}:[0-5]\d:[0-5]\d\.\d{2}')
    for line in subtitle_text(raw, code).splitlines():
        line = line.strip()
        if line.startswith('['):
            events = line.casefold() == '[events]'
            fields = []
        key, _, value = line.partition(':')
        if not events:
            continue
        if key.casefold() == 'format':
            fields = [field.strip().casefold() for field in value.split(',')]
        if key.casefold() != 'dialogue':
            continue
        columns = fields or ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
        if not {'start', 'end', 'text'}.issubset(columns):
            continue
        index = columns.index('text')
        parts = value.split(',', index)
        parts = parts[:-1] + parts[-1].rsplit(',', len(columns) - index - 1)
        if len(parts) != len(columns):
            continue
        cue = dict(zip(columns, parts))
        start, end = cue['start'].strip(), cue['end'].strip()
        if not clock.fullmatch(start) or not clock.fullmatch(end):
            continue
        start, end = milliseconds(start), milliseconds(end)
        body = re.sub(r'\{[^}]*\\p[1-9][^}]*\}.*?(?=\{[^}]*\\p0[^}]*\}|$)', '', cue['text'])
        body = re.sub(r'\{[^}]*\}|<[^>]*>', '', body).replace(r'\h', ' ')
        body = '\n'.join(line.strip() for line in re.split(r'\\[Nn]', body) if line.strip())
        if start < end and body:
            cues.append((start, end, body))
    return subtitle_bytes(''.join(f'{i}\n{timestamp(start)} --> {timestamp(end)}\n{body}\n\n'
                                  for i, (start, end, body) in enumerate(sorted(cues), 1)).encode(), code)


def read_file(path, limit):
    with opened(path) as fd, open(fd, 'rb', closefd=False) as file:
        if not 0 < os.fstat(fd).st_size <= limit:
            raise ValueError('Subtitle input size is out of range.')
        raw = file.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('Subtitle input grew while reading.')
        return raw


def select_text(paths, source, wanted):
    best = {}
    for path in sorted(paths):
        extension = path.suffix.lower()
        if extension not in TEXT:
            continue
        code, variant = subtitle_label(path, source)
        if code not in wanted:
            continue
        try:
            raw = read_file(path, MAX_FILE)
            data = subtitle_bytes(raw, code) if extension == '.srt' else ass_to_srt(raw, code)
            blocks = re.split(r'\n[ \t]*\n', data.decode('utf-8').strip())
            lines = sum(len(block[cue.end():].splitlines()) - 1 for block in blocks
                        if (cue := CUE_TIME.search(block)))
            score = (not variant, extension == '.srt', lines)
            if code not in best or score > best[code][0]:
                best[code] = score, data
        except (OSError, ValueError, SubtitleError):
            continue
    return {code: value[1] for code, value in best.items()}


def ocr_english(paths, source):
    docker = shutil.which('docker')
    pairs = {(path.parent, path.stem.casefold()): path for path in sorted(paths) if path.suffix.lower() == '.sub'}
    if not docker or not pairs:
        return None
    for idx in sorted((path for path in paths if path.suffix.lower() == '.idx'),
                      key=lambda path: (subtitle_label(path, source)[1], path)):
        sub = pairs.get((idx.parent, idx.stem.casefold()))
        if sub is None:
            continue
        try:
            index = read_file(idx, MAX_FILE)
            tracks = re.findall(rb'(?im)^id:\s*([a-z]+)\s*,', index)
            if not any(track.lower() in (b'en', b'eng') for track in tracks):
                continue
            bitmap = read_file(sub, 64 << 20)
        except (OSError, ValueError):
            continue
        try:
            with TemporaryDirectory(prefix='movie-vobsub-') as directory:
                scratch = Path(directory)
                (scratch / 'subtitle.idx').write_bytes(index)
                (scratch / 'subtitle.sub').write_bytes(bitmap)
                container = 'familyhub-vobsub-' + uuid4().hex
                command = [docker, 'run', '--rm', '--pull=never', '--name', container, '--network=none',
                           '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
                           '--memory=512m', '--cpus=1', '--cpu-shares=2', '--user', f'{os.geteuid()}:{os.getegid()}',
                           '--mount', f'type=bind,source={directory},target=/work', '--workdir', '/work',
                           '--entrypoint', '/usr/bin/nice', 'vobsub-try', '-n', '19',
                           '/src/build/bin/vobsub2srt', '--lang', 'en', 'subtitle']
                try:
                    subprocess.run(background_command(command, nice=19), timeout=90, check=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except subprocess.TimeoutExpired:
                    subprocess.run([docker, 'rm', '-f', container], timeout=5, check=False,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    raise
                return subtitle_bytes(read_file(scratch / 'subtitle.srt', MAX_FILE), 'en')
        except (OSError, ValueError, SubtitleError, subprocess.SubprocessError):
            log.warning('Movie import could not OCR the English subtitle.')
            return None
    return None


def embedded_text(ffprobe, video):
    if not ffprobe or video.suffix.lower() not in FORMATS:
        return set()
    try:
        result = media_command(ffprobe, video, ['-select_streams', 's', '-show_entries',
                               'stream=codec_name:stream_tags=language', '-of', 'json'], timeout=4, probe=True)
        return {language(words(stream.get('tags', {}).get('language', ''))) for stream in json.loads(result)['streams']
                if stream.get('codec_name') in {'subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'}}
    except MEDIA_ERRORS:
        return set()


def sync_offset(data, report):
    gaps = []
    start = None
    for kind, value in re.findall(rb'\[(?:Parsed_)?silencedetect[^\]\n]*\]\s+silence_(start|end):\s*(-?\d{1,4}(?:\.\d+)?)', report):
        point = round(float(value) * 1000)
        if kind == b'start':
            start = point
        elif start is not None and -250 <= start < point < 900000:
            gaps.append((start, point))
            start = None
    cues = sorted({milliseconds(match[2]) for match in CUE_TIME.finditer(data.decode('utf-8'))})
    if not gaps or gaps[0][0] > 250 or not cues or cues[0] >= 900000:
        return 0
    offset = gaps[0][1] - cues[0]
    if abs(offset) <= 2000:
        return 0
    anchors = [end for start, end in gaps[1:] if end - start >= 2000 and end <= cues[-1] + offset + 750]

    def count_matches(shift):
        matched = set()
        for end in anchors:
            index = bisect_left(cues, end - shift - 750)
            if index < len(cues) and cues[index] <= end - shift + 750:
                matched.add(index)
        return len(matched)

    matches, unshifted = count_matches(offset), count_matches(0)
    return offset if matches >= 2 and matches * 3 >= len(anchors) * 2 and matches > unshifted else 0


def shift_srt(data, offset):
    def shift(match):
        start, end = (timestamp(max(0, milliseconds(match[group]) + offset)) for group in (2, 4))
        return match[1] + start + match[3] + end + match[5]

    return CUE_TIME.sub(shift, data.decode('utf-8')).encode('utf-8')


def import_subtitles(video, source, paths, wanted, fallback, ffmpeg, ffprobe):
    with opened(video.parent, directory=True) as folder, opened(video) as video_fd:
        owner = os.fstat(video_fd)
        names = {}
        for code in wanted:
            name = f'{video.stem}.{code}.srt'
            try:
                if not sidecar_exists(folder, name):
                    names[code] = name
            except (OSError, SubtitleError):
                log.warning('Movie import could not use the %s subtitle destination.', code)
        wanted = names.keys()
        data = select_text(paths, source, wanted)
        missing = [code for code in wanted if code not in data]
        if missing:
            embedded = embedded_text(ffprobe, video)
            missing = [code for code in missing if code not in embedded]
        if 'en' in missing and (ocr := ocr_english(paths, source)):
            data['en'] = ocr
            missing.remove('en')
        for code in missing:
            if fetched := fallback(code):
                data[code] = fetched
        report = b''
        if data and ffmpeg and video.suffix.lower() in FORMATS:
            try:
                report = media_command(ffmpeg, video, ['-nostats', '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '900',
                                       '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-'],
                                       timeout=120, diagnostics=True)
            except MEDIA_ERRORS:
                pass
        for code, subtitle in data.items():
            offset = sync_offset(subtitle, report) if report else 0
            try:
                write_sidecar(video, folder, owner, names[code], shift_srt(subtitle, offset) if offset else subtitle)
            except FileExistsError:
                pass  # A concurrent writer published the sidecar first.
            except (OSError, SubtitleError):
                log.warning('Movie import could not save the %s subtitle sidecar.', code)
            else:
                if offset:
                    log.info('Movie import shifted %s subtitles by %d ms.', code, offset)
