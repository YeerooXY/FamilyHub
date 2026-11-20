"""Short-lived playback timings keyed by random client action IDs."""
import re
import threading
import time
from collections import OrderedDict


CLIENT_STAGES = frozenset({
    "kept_download", "cache_hit", "cache_miss",
    "play", "ready", "playing", "position_advanced", "stream_failed", "fallback", "failed", "cancelled",
    "fallback_ready", "fallback_playing", "fallback_position_advanced", "next_stream_failed",
})


class PlaybackDiagnostics:
    def __init__(self):
        self.actions = OrderedDict()
        self.lock = threading.Lock()

    @staticmethod
    def valid(action):
        return isinstance(action, str) and re.fullmatch(r"[0-9a-f]{32}", action) is not None

    def expire(self, now):
        while self.actions and next(iter(self.actions.values()))[1] <= now - 1800:
            self.actions.popitem(last=False)

    def record(self, owner, action, stage, *, client_ms=None, begin=False):
        if not self.valid(action):
            return
        with self.lock:
            now = time.monotonic()
            self.expire(now)
            key = owner, action
            if key not in self.actions:
                if not begin:
                    return
                self.actions[key] = (action, now, {})
                owned = [key for key in self.actions if key[0] == owner]
                if len(owned) > 32:
                    del self.actions[owned[0]]
                if len(self.actions) > 256:
                    self.actions.popitem(last=False)
            _, started, events = self.actions[key]
            if len(events) < 32:
                events.setdefault(stage, {"stage": stage, **(
                    {"client_ms": client_ms} if client_ms is not None
                    else {"server_ms": round((now - started) * 1000)})})

    def recent(self, owner):
        with self.lock:
            self.expire(time.monotonic())
            return [{"action": action, "events": [dict(event) for event in events.values()]}
                    for (profile, _), (action, _, events) in reversed(self.actions.items()) if profile == owner]
