"""Keep streaming watches and background requests out of listener/control HTTP slots."""
from urllib.parse import parse_qs

from waitress.task import ThreadedTaskDispatcher


class RequestDispatcher:
    LIMITS = {"ordinary": 4, "listener": 2, "control": 4, "media": 4,
              "download": 2, "watch": 4, "snapshot": 2, "artwork": 2}

    def __init__(self):
        self.pools = {}
        for name, threads in self.LIMITS.items():
            pool = self.pools[name] = ThreadedTaskDispatcher()
            pool.set_thread_count(threads)

    def add_task(self, channel):
        request = channel.requests[0]
        path = request.path
        query = parse_qs(request.query)
        watch = query.get("watch") == ["1"]
        background = request.headers.get("X_FAMILYHUB_ACTIVITY") == "background"
        lane = "ordinary"
        if path.startswith('/api/playback/') or path == '/api/profile/playback' or path.startswith('/api/listening/rooms'):
            lane = 'control'
        elif watch:
            lane = "watch"
        elif request.command == "GET" and (path == "/api/server/stats" or path.startswith("/api/catalogue/")):
            lane = "snapshot"
        elif path.startswith(('/api/artwork/', '/api/discovery/covers/', '/api/profile-images/')) or '/artwork/' in path:
            lane = 'artwork'
        elif request.command == 'POST' and (path in ('/api/uploads', '/api/library/additions')
                or path.startswith('/api/playlists/') and path.endswith(('/download', '/prepare', '/import'))):
            lane = 'download'
        elif "/media/" in path or path.startswith("/api/library/") and ("/playback/" in path or path.endswith("/download")):
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
