"""Single-worker queue for YouTube downloads started from Movies."""
import logging
import re
import subprocess
from collections import deque
from pathlib import Path
from threading import Lock, Thread

from . import movie_search

log = logging.getLogger(__name__)
MAX_PENDING = 16
DEFAULT_DIR = '/srv/familyhub/data/downloads/youtube'
PROGRESS = re.compile(r'familyhub-progress:\s*(\d+(?:\.\d+)?)%')


class YouTubeDownloads:
    def __init__(self, directory):
        self.directory = Path(directory)
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
        folder = re.sub(r'[<>:"/\\|?*%$\x00-\x1f\x7f]', '_', title).strip(' .')
        folder = folder.encode('utf-8', errors='replace')[:200].decode('utf-8', errors='ignore').rstrip(' .') or ident
        if re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', folder):
            folder = '_' + folder
        root = self.directory.resolve()
        directory = (root / folder).resolve()
        if directory.parent != root or (root / folder).is_symlink():
            return False
        directory.mkdir(parents=True, exist_ok=True)
        cap = f'[height<={int(height)}]' if height else ''
        args = [tool, '--ignore-config', '--no-playlist', '--match-filter', '!is_live', '--socket-timeout', '15',
                '-f', f'bv*{cap}+ba/b{cap}', '--merge-output-format', 'mp4/mkv',
                '--remux-video', 'mp4>mp4/mkv>mkv/mkv', '--no-overwrites',
                '--newline', '--progress', '--progress-delta', '1',
                '--progress-template', 'download:familyhub-progress:%(progress._percent_str)s',
                '--progress-template', 'postprocess:familyhub-postprocess',
                '-P', str(directory), '-o', '%(id)s.%(ext)s', '--', movie_search.video_url(ident)]
        with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding='utf-8', errors='replace') as process:
            for line in process.stdout:
                match = PROGRESS.match(line) if line.startswith('familyhub-progress:') else None
                with self.lock:
                    if match and job['state'] == 'Downloading':
                        job['progress'] = max(job['progress'], min(.94, float(match[1]) / 100 * .94))
                    elif line.strip() == 'familyhub-postprocess':
                        job.update(state='Almost done', progress=.99)
            return process.wait() == 0 and any((directory / f'{ident}.{ext}').is_file() for ext in ('mp4', 'mkv'))
