"""Reusable Opus playback copies; imported originals are never modified."""
import os
import secrets
import threading
import time
from .audio_profile import measure_loudness
from .worker_activity import WorkerActivity
from .resources import observe, PriorityLane, ResourceGovernor

_encoding = threading.Lock()
background_activity = WorkerActivity('opus-background', 'Opus background copy')
listening_activity = WorkerActivity('opus-listening', 'Opus listening copy')
TIERS = {
    "low": (48, "opus48-v2"),
    "normal": (96, "opus96-v2"),
    "high": (160, "opus160-v2"),
}
# Tiers phones asked for recently; "high" is the phone default away from home.
_wanted = {"high": time.time()}
WANTED_SECONDS = 14 * 86400


_listening = PriorityLane()
_downloads = PriorityLane()
_inflight_lock = threading.Lock()
_inflight = {}


def wanted_tiers():
    now = time.time()
    return [q for q, at in _wanted.items() if now - at < WANTED_SECONDS]


def copy_path(item, digest, quality):
    return os.path.join(item, f".{TIERS[quality][1]}-{digest}.opus")


def prepare(intake, item, source, digest, urgent=False, quality="normal", title='', lead=0, offline_only=False, requested=False):
    path = copy_path(item, digest, quality)
    if urgent:
        _wanted[quality] = time.time()
    # Published copies are immutable and appear through atomic replacement.
    # Playback of an existing copy must not wait behind another song's encoder.
    if os.path.lexists(path):
        intake.regular_file(path, "mobile audio")
        return path
    governor = getattr(intake, "RESOURCES", None)
    activity = listening_activity if urgent else background_activity
    with observe(governor, "opus", "encoder lane") as state:
        while True:
            state("encoder lane")
            with (_listening.turn(lead) if urgent else _downloads.turn(lead) if requested else _encoding):
                if os.path.lexists(path):
                    intake.regular_file(path, "mobile audio")
                    return path
                if offline_only and isinstance(governor, ResourceGovernor) and not governor.background_slots(1):
                    return None
                with _inflight_lock:
                    running = _inflight.get(path)
                    if running is None:
                        _inflight[path] = done = threading.Event()
                if running is None:
                    try:
                        state()
                        with activity.track(title):
                            _encode(intake, source, path, TIERS[quality][0])
                        return path
                    finally:
                        with _inflight_lock:
                            _inflight.pop(path, None)
                        done.set()
            state("same output")
            if not running.wait(240):
                raise ValueError("Mobile audio preparation timed out")


def _encode(intake, source, path, kbps):
    temporary = path + "." + secrets.token_hex(8) + ".opus"
    try:
        # Lossy encoding can create intersample peaks above its input.
        # Limit transient peaks, then verify the decoded delivery file itself.
        ceiling_db = -4
        requested_lufs = -14
        for _ in range(4):
            filters = ["-af", f"loudnorm=I={requested_lufs:.2f}:TP={ceiling_db:.2f}:LRA=50"]
            rc, _, _ = intake.run([intake.tool("ffmpeg"), "-nostdin", "-v", "error", "-y",
                *intake.SAFE_INPUT, "-i", source, "-map", "0:a:0", "-vn",
                *filters, "-ar", "48000", "-c:a", "libopus", "-b:a", f"{kbps}k", "-ac", "2", "-vbr", "constrained", "-application", "audio",
                "-fs", str(64 << 20), temporary], 180, "mobile audio")
            if rc or not os.path.getsize(temporary):
                raise ValueError("Mobile audio preparation failed")
            measured = measure_loudness(intake, temporary)
            if abs(measured["input_i"] + 14) <= 1.5 and measured["input_tp"] <= -1:
                break
            requested_lufs += -14 - measured["input_i"]
            if measured["input_tp"] > -1:
                ceiling_db -= measured["input_tp"] + 1.5
            if ceiling_db < -9 or not -16 <= requested_lufs <= -10:
                raise ValueError("Mobile audio requires excessive peak limiting")
        else:
            raise ValueError("Mobile audio failed loudness or peak verification")
        # Refuse an output truncated by the size limit.
        if os.path.getsize(temporary) >= (64 << 20):
            raise ValueError("Recording exceeds the mobile audio limit")
        if abs(intake.probe(temporary)["duration"] - intake.probe(source)["duration"]) > .2:
            raise ValueError("Mobile audio duration does not match the original")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Warmer:
    """Makes phone copies before anyone asks: songs playing on any device first,
    so a handover to a phone starts at once, then the rest of the library while idle.

    resolve(source_id) returns (item, source, digest, title) or None; library()
    lists source ids; idle() is False while someone is waiting for a song."""
    CACHE_LIMIT = 2000
    CHECK_SECONDS = 600

    def __init__(self, intake, resolve, library, idle, backfill=True, start_delay=60):
        self.intake, self.resolve, self.library, self.idle, self.backfill = intake, resolve, library, idle, backfill
        self.start_delay = start_delay
        self.cv = threading.Condition()
        self.playing = []
        self.failed = {}
        self.checked = {}
        self.stop = threading.Event()
        threading.Thread(target=self.work, name='opus-warm', daemon=True).start()

    def now_playing(self, source_id):
        now = time.monotonic()
        if self._recent(source_id, now):
            return
        with self.cv:
            if self._recent(source_id, now):
                return
            self.checked.pop(source_id, None)
            if len(self.checked) >= self.CACHE_LIMIT:
                del self.checked[next(iter(self.checked))]
            self.checked[source_id] = now
            self.playing.append(source_id)
            del self.playing[:-20]
            self.cv.notify()

    def _recent(self, source_id, now):
        checked_at = self.checked.get(source_id)
        return (checked_at is not None and now - checked_at < self.CHECK_SECONDS
                or source_id in self.failed or source_id in self.playing)

    def _next(self):
        with self.cv:
            if self.playing:
                return self.playing.pop(0), True
        return None, False

    def _warm(self, source_id):
        try:
            found = self.resolve(source_id)
            if not found:
                return False
            item, source, digest, title = found
            made = False
            for quality in wanted_tiers():
                if not os.path.lexists(copy_path(item, digest, quality)):
                    path = prepare(self.intake, item, source, digest, quality=quality, title=title,
                                   offline_only=True)
                    made |= path is not None
            return made
        except Exception:
            with self.cv:
                if source_id not in self.failed and len(self.failed) >= self.CACHE_LIMIT:
                    del self.failed[next(iter(self.failed))]
                self.failed[source_id] = None
            return False

    def work(self):
        pending, made_any = [], True
        # Let the server finish starting before the first library pass.
        self.stop.wait(self.start_delay)
        # Background copies run niced; a listener's own encode never does.
        control = getattr(self.intake, "CONTROL", None)
        if control is not None:
            control.background = True
            control.priority = lambda: 3
        while not self.stop.is_set():
            if not self.idle():
                with self.cv:
                    self.cv.wait(30)
                continue
            source_id, current = self._next()
            if source_id:
                self._warm(source_id)
                continue
            if not self.backfill:
                with self.cv:
                    self.cv.wait(30)
                continue
            if not pending:
                # A pass that made nothing means the library is done; look again hourly.
                if not made_any:
                    with self.cv:
                        self.cv.wait(3600)
                        self.failed.clear()
                try:
                    pending = [s for s in self.library() if s not in self.failed]
                except Exception:
                    pending = []
                made_any = False
                continue
            if self._warm(pending.pop()):
                made_any = True
