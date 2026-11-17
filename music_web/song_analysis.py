"""Idle, single-song measurements of published library recordings."""
import json
import logging
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
from contextlib import suppress

from .source_quality import FFMPEG_LOCK, ScanPaused


def measure(path, duration, idle, ffmpeg):
    if not idle() or not FFMPEG_LOCK.acquire(blocking=False):
        raise ScanPaused()
    try:
        command = [sys.executable, '-m', 'music_web.analysis', '--library', str(path), str(duration), ffmpeg]
        options = {}
        if os.name == 'nt':
            options['creationflags'] = subprocess.IDLE_PRIORITY_CLASS
        else:
            options['start_new_session'] = True
            if shutil.which('nice'):
                command = ['nice', '-n', '15', *command]
        env = dict(os.environ, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1',
                   NUMBA_NUM_THREADS='1')
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, **options) as process:
            try:
                elapsed = 0
                while True:
                    if not idle():
                        raise ScanPaused()
                    try:
                        output, _ = process.communicate(timeout=.2)
                        break
                    except subprocess.TimeoutExpired:
                        elapsed += .2
                        if elapsed >= 240:
                            raise TimeoutError('Song analysis timed out')
                if process.returncode:
                    raise ValueError('Song analysis unavailable')
                return json.loads(output)
            finally:
                if process.poll() is None:
                    # Decoding is a child of the worker; reap the entire tree on demand.
                    if os.name == 'nt':
                        try:
                            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=5)
                        finally:
                            process.kill()
                    else:
                        with suppress(ProcessLookupError):
                            os.killpg(process.pid, signal.SIGKILL)
                    process.communicate()
    finally:
        FFMPEG_LOCK.release()


class SongAnalysis:
    def __init__(self, workspace, library, intake, idle=lambda: True):
        self.workspace, self.library = Path(workspace), Path(library)
        self.path = self.workspace / '.song-analysis.json'
        self.intake, self.idle = intake, idle
        self.stop = threading.Event()
        self.lock, self.scan_lock = threading.RLock(), threading.Lock()
        try:
            self.rows = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(self.rows, dict):
                self.rows = {}
        except (OSError, ValueError):
            self.rows = {}

    def metadata(self, identifier, digest):
        with self.lock:
            row = self.rows.get(identifier + ':' + digest)
            if not isinstance(row, dict):
                return {}
            result = {}
            bpm = row.get('bpm')
            if type(bpm) is int and 0 < bpm < 1000:
                result['bpm'] = bpm
            from .analysis import CAMELOT, PITCH_NAMES
            for mode, keys in CAMELOT.items():
                if row.get('key') in keys:
                    result.update(key=row['key'], key_name=PITCH_NAMES[keys.index(row['key'])] + ' ' + mode)
            return result

    def scan_once(self):
        if not self.scan_lock.acquire(blocking=False):
            return
        try:
            for item in sorted(self.workspace.iterdir()):
                if not self.idle() or self.stop.is_set():
                    return
                if not self.intake.ID_RE.fullmatch(item.name) or not item.name.startswith(('yt-', 'local-')):
                    continue
                try:
                    _, manifest, _ = self.intake.load_item(str(item))
                    record = manifest.get('import')
                    if not record or manifest.get('edit'):
                        continue
                    identifier = manifest['source']['id'] if manifest['source']['kind'] == 'youtube' else manifest['id']
                    digest = record['library_sha256']
                    key = identifier + ':' + digest
                    with self.lock:
                        if isinstance(self.rows.get(key), dict):
                            continue
                    audio = self.library.joinpath(*record['path'].split('/'))
                    if not self.intake.inside(str(audio), str(self.library)):
                        continue
                    self.intake.regular_file(str(audio), 'library audio')
                    duration = manifest['audio']['duration']
                    if not math.isfinite(duration) or duration <= 0:
                        continue
                    result = measure(audio, duration, lambda: self.idle() and not self.stop.is_set(), self.intake.tool('ffmpeg'))
                    if not isinstance(result, dict):
                        raise ValueError('Invalid song analysis')
                    with self.lock:
                        rows = {**self.rows, key: result}
                        temporary = self.path.with_suffix('.tmp')
                        temporary.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
                        temporary.replace(self.path)
                        self.rows = rows
                except ScanPaused:
                    return
                except (OSError, ValueError, KeyError, TimeoutError, self.intake.IntakeError) as error:
                    logging.getLogger(__name__).warning('Song analysis %s: %s', item.name, type(error).__name__)
        finally:
            self.scan_lock.release()


def register(app, workspace, library, intake, idle, enabled=True):
    scanner = SongAnalysis(workspace, library, intake, idle)
    app.extensions['music'].song_analysis = scanner

    def scan():
        while not scanner.stop.wait(30):
            try:
                scanner.scan_once()
            except Exception as error:
                app.logger.warning('Song analysis: %s', type(error).__name__)
            if scanner.stop.wait(1800 if idle() else 5):
                return

    if enabled:
        threading.Thread(target=scan, name='song-analysis', daemon=True).start()
    return scanner
