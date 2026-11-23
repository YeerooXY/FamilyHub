"""Keep streaming watches and background requests out of listener/control HTTP slots."""
import logging
from threading import Lock
from time import monotonic
from urllib.parse import parse_qs

from waitress.task import ThreadedTaskDispatcher


class QueueWarnings:
    def __init__(self):
        self.lock = Lock()
        self.last = float('-inf')

    def warning(self, message, *args):
        with self.lock:
            now = monotonic()
            if now - self.last >= 60:
                self.last = now
                logging.getLogger('music_web.http_dispatch').warning(message, *args)


class RequestDispatcher:
    LIMITS = {"ordinary": 4, "listener": 2, "control": 4, "media": 4,
              "download": 2, "watch": 4, "snapshot": 2, "artwork": 2, "movie-media": 4}

    def __init__(self, threads=4):
        self.pools = {}
        warnings = QueueWarnings()
        for name, count in self.LIMITS.items():
            pool = self.pools[name] = ThreadedTaskDispatcher()
            pool.queue_logger = warnings
            pool.set_thread_count(threads if name == 'ordinary' else count)

    def interactive_queued(self):
        for name, pool in self.pools.items():
            if name in ('watch', 'download'):
                continue
            with pool.lock:
                for channel in pool.queue:
                    request = next(iter(channel.requests), None)
                    if request is not None and request.headers.get('X_FAMILYHUB_ACTIVITY') != 'background':
                        return True
        return False

    def add_task(self, channel):
        request = channel.requests[0]
        path = request.path
        query = parse_qs(request.query)
        watch = query.get("watch") == ["1"]
        background = request.headers.get("X_FAMILYHUB_ACTIVITY") == "background"
        lane = "ordinary"
        if (path.startswith('/api/playback/') and path != '/api/playback/diagnostics'
                or path in ('/api/connect', '/api/profile/select', '/api/profile/playback')
                or path.startswith('/api/listening/rooms')):
            lane = 'control'
        elif watch:
            lane = "watch"
        elif request.command == "GET" and (path in ("/api/activity/stats", "/api/server/stats", "/api/server/stats/now") or path.startswith("/api/catalogue/")):
            lane = "snapshot"
        elif path.startswith(('/api/artwork/', '/api/discovery/covers/', '/api/profile-images/')) or '/artwork/' in path:
            lane = 'artwork'
        elif path.startswith('/api/movies/media/') and request.command in ('GET', 'HEAD', 'OPTIONS'):
            lane = 'movie-media'
        elif path == '/api/files/upload' and request.command == 'PUT':
            lane = 'download'
        elif request.command == 'POST' and (path in ('/api/uploads', '/api/library/additions')
                or path.startswith('/api/playlists/') and path.endswith(('/download', '/prepare', '/import'))):
            lane = 'download'
        elif "/media/" in path or path.startswith("/api/library/") and (
                "/playback/" in path or "/playback-source/" in path or path.endswith("/download")):
            lane = "media" if not background and (query.get('ticket') or '/media/' in path) else "download"
        elif path.startswith('/api/library/') and path.endswith('/playback-info'):
            # Installed phone downloaders use the same metadata route as players.
            lane = 'listener' if not background and query.get('lead', ['0']) == ['0'] else 'download'
        elif path.startswith("/api/jobs/") or not background and (
                path in ("/api/jobs", "/api/transition")):
            lane = "listener"
        self.pools[lane].add_task(channel)

    def shutdown(self, cancel_pending=True, timeout=5):
        for pool in self.pools.values():
            pool.shutdown(cancel_pending=cancel_pending, timeout=timeout)
