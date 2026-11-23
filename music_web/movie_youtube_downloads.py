"""Single-worker queue for YouTube downloads started from Movies."""
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import deque
from pathlib import Path
from threading import Event, Lock, Thread

from . import movie_search

log = logging.getLogger(__name__)
MAX_PENDING = 16
MAX_DOWNLOAD_BYTES = 20 << 30
FREE_RESERVE = 5 << 30
DOWNLOAD_TIMEOUT = 7200
DEFAULT_DIR = '/srv/familyhub/data/downloads/youtube'
PROGRESS = re.compile(r'familyhub-progress:\s*(\d+(?:\.\d+)?)%')


class YouTubeDownloads:
    def __init__(self, directory, spawn=None, stop=None):
        self.directory = Path(directory)
        self.spawn = spawn
        self.stop = stop
        self.lock = Lock()
        self.pending = deque()
        self.jobs = {}
        self.running = False

    def items(self):
        with self.lock:
            return [dict(job) for job in reversed(self.jobs.values())]

    def enqueue(self, tool, ident, title, height):
        with self.lock:
            if self.jobs.get(ident, {}).get('state') in ('Waiting', 'Downloading', 'Almost done', 'Finished'):
                return True
            if len(self.pending) >= MAX_PENDING:
                return False
            self.jobs.pop(ident, None)
            self.jobs[ident] = dict(name=title, progress=0, state='Waiting')
            self.pending.append((tool, ident, title, height))
            if not self.running:
                self.running = True
                Thread(target=self._work, name='movie-youtube-download', daemon=True).start()
            return True

    def _work(self):
        while True:
            with self.lock:
                if not self.pending:
                    self.running = False
                    return
                tool, ident, title, height = self.pending.popleft()
                job = self.jobs[ident]
                job['state'] = 'Downloading'
            try:
                success = self._download(tool, ident, title, height, job)
            except (OSError, ValueError, RuntimeError):
                success = False
            with self.lock:
                job['state'] = 'Finished' if success else 'Problem'
                if success:
                    job['progress'] = 1
                else:
                    log.warning('Movie YouTube download failed')
                finished = [key for key, item in self.jobs.items() if item['state'] in ('Finished', 'Problem')]
                for key in finished[:-50]:
                    del self.jobs[key]

    def _download(self, tool, ident, title, height, job):
        if not movie_search.VIDEO_ID.fullmatch(ident):
            return False
        folder = re.sub(r'[<>:"/\\|?*%$\x00-\x1f\x7f]', '_', title).strip(' .')
        folder = folder.encode('utf-8', errors='replace')[:200].decode('utf-8', errors='ignore').rstrip(' .') or ident
        if re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', folder):
            folder = '_' + folder
        root = self.directory.resolve()
        directory = (root / folder).resolve()
        if directory.parent != root or (root / folder).is_symlink():
            return False
        directory.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(root).free < FREE_RESERVE:
            return False
        with tempfile.TemporaryDirectory(prefix='.youtube-', dir=root) as work:
            return self._transfer(tool, ident, height, job, Path(work), directory)

    def _transfer(self, tool, ident, height, job, work, directory):
        cap = f'[height<={int(height)}]' if height else ''
        args = [tool, '--ignore-config', '--no-playlist', '--match-filter', '!is_live', '--socket-timeout', '15',
                '--max-filesize', str(MAX_DOWNLOAD_BYTES),
                '-f', f'bv*{cap}+ba/b{cap}', '--merge-output-format', 'mp4/mkv',
                '--remux-video', 'mp4>mp4/mkv>mkv/mkv', '--no-overwrites',
                '--newline', '--progress', '--progress-delta', '1',
                '--progress-template', 'download:familyhub-progress:%(progress._percent_str)s',
                '--progress-template', 'postprocess:familyhub-postprocess',
                '-P', str(work), '-o', '%(id)s.%(ext)s', '--', movie_search.video_url(ident)]
        with (self.spawn or subprocess.Popen)(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                               text=True, encoding='utf-8', errors='replace') as process:
            finished, interrupted = Event(), Event()
            monitor = Thread(target=self._watch_transfer, args=(process, work, finished, interrupted), daemon=True)
            monitor.start()
            try:
                for line in process.stdout:
                    match = PROGRESS.match(line) if line.startswith('familyhub-progress:') else None
                    with self.lock:
                        if match and job['state'] == 'Downloading':
                            job['progress'] = max(job['progress'], min(.94, float(match[1]) / 100 * .94))
                        elif line.strip() == 'familyhub-postprocess':
                            job.update(state='Almost done', progress=.99)
                code = process.wait()
            finally:
                finished.set()
                monitor.join()
                if os.name == 'nt' and self.stop and getattr(process, 'music_job', None):
                    self.stop(process)
            if code or interrupted.is_set():
                return False
        for ext in ('mp4', 'mkv'):
            source = work / f'{ident}.{ext}'
            target = directory / source.name
            if source.is_file() and not source.is_symlink() and source.stat().st_size <= MAX_DOWNLOAD_BYTES:
                try:
                    os.link(source, target)
                except FileExistsError:
                    return target.is_file() and not target.is_symlink()
                return True
        return False

    def _watch_transfer(self, process, directory, finished, interrupted):
        deadline = time.monotonic() + DOWNLOAD_TIMEOUT
        while not finished.wait(1):
            try:
                size = sum(f.stat().st_size for f in directory.iterdir() if f.is_file())
                out_of_space = size > 3 * MAX_DOWNLOAD_BYTES or shutil.disk_usage(directory).free < FREE_RESERVE
            except OSError:
                out_of_space = True
            if out_of_space or time.monotonic() >= deadline:
                interrupted.set()
                if self.stop:
                    self.stop(process)
                else:
                    process.kill()
                return
