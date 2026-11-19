"""Keep streaming watches and background requests out of listener/control HTTP slots."""
from urllib.parse import parse_qs

from waitress.task import ThreadedTaskDispatcher


class RequestDispatcher:
    def __init__(self):
        self.pools = {}
        for name, threads in (("ordinary", 6), ("listener", 2), ("control", 2), ("media", 4), ("watch", 4)):
            pool = self.pools[name] = ThreadedTaskDispatcher()
            pool.set_thread_count(threads)

    def add_task(self, channel):
        request = channel.requests[0]
        path = request.path
        query = parse_qs(request.query)
        watch = query.get("watch") == ["1"]
        background = request.headers.get("X_FAMILYHUB_ACTIVITY") == "background"
        lane = "ordinary"
        if watch:
            lane = "watch"
        elif request.command == "GET" and (path == "/api/server/stats" or path.startswith("/api/catalogue/")):
            lane = "control"
        elif "/media/" in path or path.startswith("/api/library/") and ("/playback/" in path or path.endswith("/download")):
            lane = "media" if not background and (query.get('ticket') or '/media/' in path) else "ordinary"
        elif path.startswith("/api/jobs/") or not background and (
                path == "/api/jobs" or path.startswith("/api/library/") and path.endswith("/playback-info")):
            lane = "listener"
        self.pools[lane].add_task(channel)

    def shutdown(self, cancel_pending=True, timeout=5):
        for pool in self.pools.values():
            pool.shutdown(cancel_pending=cancel_pending, timeout=timeout)
