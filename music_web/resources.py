"""Presence leases, resource admission and stage observations."""
import logging
import os
import shutil
import threading
import time
from collections import Counter
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from pathlib import Path
from urllib.error import HTTPError


_current = ContextVar("resource_stages", default=())
background_request = ContextVar("background_provider_request", default=False)


def background_activity():
    from flask import request

    return request.headers.get("X-FamilyHub-Activity") == "background"


PRESENCE = {
    "offline": (0, 0), "online-idle": (1, 1), "browsing": (2, 1),
    "searching": (2, 1), "listening": (2, 2), "listen-together": (2, 2),
}


@contextmanager
def waiting(reason):
    previous = [(governor, ticket, governor.state(ticket, reason)) for governor, ticket in _current.get()]
    try:
        yield
    finally:
        for governor, ticket, state in previous:
            governor.state(ticket, state)


def observe(governor, stage, reason=""):
    if isinstance(governor, ResourceGovernor):
        return governor.track(stage, reason)
    return nullcontext(lambda reason="": None)


class PriorityLane:
    def __init__(self):
        self.cv = threading.Condition()
        self.busy = False
        self.waiting = []

    @contextmanager
    def turn(self, lead=0, background=lambda: False):
        deadline = time.monotonic() + lead
        ticket = (object(), background, lead > 0, deadline)
        with self.cv:
            self.waiting.append(ticket)
            try:
                while self.busy or min(self.waiting, key=lambda row: (row[1](), row[2], row[3])) != ticket:
                    self.cv.wait()
                self.busy = True
            finally:
                self.waiting.remove(ticket)
        try:
            yield
        finally:
            with self.cv:
                self.busy = False
                self.cv.notify_all()


class ResourceGovernor:
    def __init__(self, queued=lambda: (), metrics=lambda: {}, clock=time.monotonic):
        self.queued, self.metrics, self.clock = queued, metrics, clock
        self.condition = threading.Condition()
        self.lock = self.condition
        self.stages, self.totals = {}, Counter()
        self.last_report = self.clock()
        self.reporter = None
        self.leases = {}
        self.last_activity = {}
        try:
            self.inactive_seconds = max(1, int(os.environ.get("FAMILYHUB_INACTIVE_MINUTES", 20))) * 60
        except ValueError:
            self.inactive_seconds = 20 * 60
        self.searches = {}
        self.handback = float("-inf")
        self.changed = lambda: None
        self.cpu_capacity = compute_capacity()
        self.cpu_active = 0
        self.cpu_waiters = []

    def _changed(self):
        self.condition.notify_all()
        self.changed()

    def _expire(self, now):
        for key, expiry in list(self.leases.items()):
            if expiry <= now:
                del self.leases[key]

    @staticmethod
    def _profile(identity):
        return identity[0] if isinstance(identity, tuple) else identity

    def inactive_count(self):
        with self.condition:
            cutoff = self.clock() - self.inactive_seconds
            return sum(last <= cutoff for last in self.last_activity.values())

    def remember_profile(self, profile):
        with self.condition:
            # Restoring a session automatically can introduce a profile before its first activity.
            self.last_activity.setdefault(profile, float("-inf"))

    def presence(self, identity, state="online-idle", seconds=15):
        with self.condition:
            now = self.clock()
            self._expire(now)
            self.last_activity[self._profile(identity)] = now
            self.leases[identity, "online-idle"] = now + 15
            if state != "online-idle":
                # A search can hold its lease until teardown, up to the inactivity cutoff.
                self.leases[identity, state] = now + min(seconds, self.inactive_seconds)
            self.handback = max(self.leases.values())
            self._changed()
        self.wake()

    def pause(self, *identities):
        with self.condition:
            now = self.clock()
            self._expire(now)
            for identity in identities:
                key = (identity, "listening")
                if key in self.leases:
                    self.leases[key] = min(self.leases[key], now + 5)
            if self.leases:
                self.handback = max(self.leases.values())
            self._changed()

    def close(self, identity):
        with self.condition:
            now = self.clock()
            self._expire(now)
            for key in [key for key in self.leases if key[0] == identity]:
                del self.leases[key]
            ticket = self.searches.pop(identity, None)
            if ticket:
                ticket.set()
            self.handback = max(self.leases.values(), default=min(now, self.handback))
            self._changed()

    def room(self, room_id, expiry, playing=True):
        identity = ("room", room_id)
        if expiry is None:
            self.close(identity)
            return
        with self.condition:
            now = self.clock()
            self._expire(now)
            key = (identity, "listen-together")
            if playing:
                self.leases[key] = expiry
            elif key in self.leases:
                self.leases[key] = min(self.leases[key], now + 5)
            self.leases[identity, "online-idle"] = now + 15
            self.handback = max(self.leases.values())
            self._changed()
        self.wake()

    def begin_search(self, identity):
        with self.condition:
            previous = self.searches.get(identity)
            if previous:
                previous.set()
            ticket = self.searches[identity] = threading.Event()
            self.presence(identity, "searching", float("inf"))
            return ticket

    def end_search(self, identity, ticket):
        with self.condition:
            if self.searches.get(identity) is not ticket:
                return
            del self.searches[identity]
            now = self.clock()
            self._expire(now)
            remaining = self.last_activity.get(self._profile(identity), float("-inf")) + self.inactive_seconds - now
            if remaining > 0:
                self.leases[identity, "searching"] = now + min(3, remaining)
            self.handback = max(self.leases.values(), default=min(now, self.handback))
            self._changed()

    def reservations(self):
        with self.condition:
            self._expire(self.clock())
            states = {state for _, state in self.leases}
            state = next((state for state in reversed(PRESENCE) if state in states), "offline")
            return state, *PRESENCE[state]

    def background_slots(self, limit, floor=0):
        """Background slots: `floor` stays available while people are online; the rest returns
        one per second after everyone leaves."""
        with self.condition:
            elapsed = self.clock() - self.handback
            idle = limit if elapsed >= limit else max(0, int(elapsed)) if elapsed >= 0 else 0
            return max(min(floor, limit), idle)

    def background_delay(self, slot):
        with self.condition:
            delay = self.handback + slot - self.clock()
            return None if delay == float("inf") else max(0, delay)

    def wait_background(self, cancelled=lambda: False):
        with self.condition:
            while not cancelled():
                delay = self.background_delay(1)
                if delay == 0:
                    return True
                self.condition.wait(delay)
        return False

    @contextmanager
    def compute(self, background, *, cost=1, start_offline=False, wait=True):
        """Reserve a child slot through reap. Scanners retry at their next idle pass."""
        priority = background if callable(background) else lambda: background
        ticket = (object(), priority)
        granted = False
        background_capacity = max(1, min(self.cpu_capacity - 1, (self.cpu_capacity + 1) // 2))
        with self.condition:
            if cost <= self.cpu_capacity:
                if start_offline:
                    granted = (self.background_slots(1) and not self.cpu_waiters
                               and self.cpu_active + cost <= background_capacity)
                elif not wait:
                    granted = not self.cpu_waiters and self.cpu_active + cost <= self.cpu_capacity
                else:
                    self.cpu_waiters.append(ticket)
                    try:
                        while (min(self.cpu_waiters, key=lambda row: row[1]()) != ticket
                               or self.cpu_active + cost > (background_capacity if priority() else self.cpu_capacity)):
                            with waiting("CPU capacity"):
                                self.condition.wait()
                        granted = True
                    finally:
                        self.cpu_waiters.remove(ticket)
                if granted:
                    self.cpu_active += cost
                self.condition.notify_all()
        try:
            yield bool(granted)
        finally:
            if granted:
                with self.condition:
                    self.cpu_active -= cost
                    self.condition.notify_all()

    def wake(self):
        with self.lock:
            if self.reporter is None:
                self.reporter = threading.Timer(30, self.report)
                self.reporter.daemon = True
                self.reporter.start()

    def state(self, ticket, reason):
        with self.lock:
            stage, previous, since = self.stages[ticket]
            if reason != previous:
                now = self.clock()
                self.totals[stage, previous] += now - max(since, self.last_report)
                self.stages[ticket] = stage, reason, now
            return previous

    @contextmanager
    def track(self, stage, reason=""):
        ticket = object()
        with self.lock:
            self.stages[ticket] = stage, reason, self.clock()
        self.wake()
        token = _current.set((*_current.get(), (self, ticket)))
        try:
            yield lambda reason="": self.state(ticket, reason)
        finally:
            _current.reset(token)
            with self.lock:
                _, reason, since = self.stages.pop(ticket)
                self.totals[stage, reason] += self.clock() - max(since, self.last_report)

    def report(self):
        # Read the dispatch queue outside our lock. Producers can already hold the jobs lock.
        queued = list(self.queued())
        with self.lock:
            rows = queued + list(self.stages.values())
            now = self.clock()
            totals = self.totals.copy()
            self.totals.clear()
            for stage, reason, since in self.stages.values():
                totals[stage, reason] += now - max(since, self.last_report)
            self.last_report = now
            self.reporter = None
        state, cpu, transfer = self.reservations()
        metrics = self.metrics()
        if rows or state != "offline" or any(metrics.get(key) for key in ("backlog_pending", "backlog_backing_off", "backlog_running")):
            self.wake()
            counts = Counter((stage, reason) for stage, reason, _ in rows)
            stages = []
            for stage in sorted({stage for stage, _ in counts}):
                reasons = {reason: count for (key, reason), count in counts.items() if key == stage and reason}
                oldest = max((self.clock() - since for key, reason, since in rows if key == stage and reason), default=0)
                waits = ",".join(f"{reason}:{count}" for reason, count in sorted(reasons.items())) or "-"
                wait_seconds = sum(seconds for (key, reason), seconds in totals.items() if key == stage and reason)
                stages.append(f"{stage}={counts[stage, '']}r/{sum(reasons.values())}q"
                              f"[{waits},oldest={oldest:.0f}s,run={totals.get((stage, ''), 0):.1f}s,wait={wait_seconds:.1f}s]")
            logging.getLogger("music_web.resources").info(
                "resource presence=%s reserved_cpu=%d reserved_transfers=%d cpu=%d/%d inactive=%d %s %s",
                state, cpu, transfer, self.cpu_active, self.cpu_capacity, self.inactive_count(), " ".join(stages),
                " ".join(f"{key}={value}" for key, value in metrics.items()))


def transfer_limit(name="FAMILYHUB_TRANSFERS", default=4):
    try:
        return max(1, min(8, int(os.environ.get(name, default))))
    except ValueError:
        return default


def enabled(name):
    return os.environ.get(name, "1").strip().lower() not in ("0", "false", "off", "no")


def compute_capacity():
    cores = os.cpu_count() or 1
    if hasattr(os, "sched_getaffinity"):
        cores = min(cores, len(os.sched_getaffinity(0)))
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            cores = min(cores, int(quota) // int(period))
    except (OSError, ValueError, ZeroDivisionError):
        pass
    return max(0, cores - 1)


def background_command(command, nice=10):
    if os.name == "posix":
        if shutil.which("nice"):
            command = ["nice", "-n", str(nice), *command]
        if shutil.which("ionice"):
            command = ["ionice", "-c", "3", "-t", *command]
    return command


def audio_command(command):
    if Path(command[0]).stem.lower() == "ffmpeg":
        command = [command[0], "-filter_threads", "1", "-filter_complex_threads", "1",
                   "-threads", "1", *command[1:-1], "-threads", "1", command[-1]]
    if hasattr(os, "sched_getaffinity") and shutil.which("taskset"):
        cores = sorted(os.sched_getaffinity(0))[:-1]
        if cores:
            command = ["taskset", "-c", ",".join(map(str, cores)), *command]
    return command


def runtime_capacity(rss_only=False):
    if rss_only:
        try:
            return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE") >> 20
        except (OSError, ValueError, IndexError):
            return "unknown"
    values = {"affinity": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()}
    for key, path in {"cpu_quota": "/sys/fs/cgroup/cpu.max", "memory_limit": "/sys/fs/cgroup/memory.max",
                      "host_memory": "/proc/meminfo"}.items():
        try:
            values[key] = "_".join(Path(path).read_text().splitlines()[0].split())
        except (OSError, IndexError):
            values[key] = "unknown"
    return values


class TransferResources:
    def __init__(self, capacity, available, governor=None, listener_scratch=0):
        self.capacity, self.available = capacity, available
        self.listener_scratch = listener_scratch
        self.governor = governor
        self.idle_capacity = (max(capacity, transfer_limit("FAMILYHUB_TRANSFERS_IDLE", 6))
                              if governor and enabled("FAMILYHUB_IDLE_TRANSFERS") else capacity)
        self.condition = threading.Condition()
        self.transfer_condition = governor.condition if governor else self.condition
        self.waiters = {"transfer": [], "scratch": []}
        self.active = self.active_background = self.reserved = 0

    def background_floor(self):
        # Background downloads keep the base transfers not reserved for people online.
        return max(1, self.capacity - self.governor.reservations()[2]) if self.governor else self.capacity

    def wake(self):
        with self.condition:
            self.condition.notify_all()
        with self.transfer_condition:
            self.transfer_condition.notify_all()

    @contextmanager
    def lease(self, *, background, cancelled, error, size=0, defer=None):
        lane = "scratch" if size else "transfer"
        ticket = (object(), background)
        condition = self.condition if size else self.transfer_condition
        with condition:
            queue = self.waiters[lane]
            queue.append(ticket)
            condition.notify_all()
            try:
                while True:
                    if cancelled():
                        raise error("acquisition cancelled")
                    if not size and self.governor and defer and background() and not self.governor.background_slots(1, self.background_floor()):
                        defer()
                    delay = None
                    if min(queue, key=lambda row: row[1]()) == ticket:
                        if size:
                            available = self.available()
                            if size > available and not self.reserved:
                                raise error("scratch capacity exceeded")
                            reserve = self.listener_scratch if background() else 0
                            if size + self.reserved + reserve <= available:
                                self.reserved += size
                                break
                        else:
                            capacity = self.capacity
                            admitted_background = bool(background())
                            if self.governor:
                                if admitted_background:
                                    capacity = self.governor.background_slots(self.idle_capacity, self.background_floor())
                                elif self.active - self.active_background < self.capacity:
                                    # Idle expansion cannot consume the transfers reserved for listeners.
                                    capacity = self.active_background + self.capacity
                                if admitted_background and capacity <= self.active < self.idle_capacity:
                                    delay = self.governor.background_delay(self.active + 1)
                            if self.active < capacity:
                                self.active += 1
                                self.active_background += admitted_background
                                break
                    with waiting(lane):
                        condition.wait(delay)
            finally:
                queue.remove(ticket)
                condition.notify_all()
        try:
            yield
        finally:
            with condition:
                if size:
                    self.reserved -= size
                else:
                    self.active -= 1
                    self.active_background -= admitted_background
                condition.notify_all()


class ProviderGate:
    """Space request starts, giving the next turn to foreground waiters."""
    def __init__(self, spacing):
        self.spacing = spacing
        self.condition = threading.Condition()
        self.queue = []
        self.next_start = 0

    @contextmanager
    def request(self, max_wait=None):
        ticket = (object(), background_request.get())
        deadline = time.monotonic() + max_wait if max_wait is not None else None
        with self.condition:
            self.queue.append(ticket)
            self.condition.notify_all()
            try:
                while True:
                    first = min(self.queue, key=lambda row: row[1]) == ticket
                    delay = self.next_start - time.monotonic()
                    if first and delay <= 0:
                        self.next_start = time.monotonic() + self.spacing
                        break
                    remaining = deadline - time.monotonic() if deadline is not None else None
                    if remaining is not None and remaining <= 0:
                        raise TimeoutError('Provider pacing took too long.')
                    wait_for = remaining
                    if first:
                        wait_for = delay if remaining is None else min(delay, remaining)
                    with waiting("provider pacing"):
                        self.condition.wait(wait_for)
            finally:
                self.queue.remove(ticket)
                self.condition.notify_all()
        try:
            yield
        except HTTPError as error:
            if error.code == 429:
                retry = (error.headers or {}).get("Retry-After", "")
                delay = min(int(retry), 1800) if retry.isascii() and retry.isdecimal() and len(retry) <= 10 else 1
                with self.condition:
                    self.next_start = max(self.next_start, time.monotonic() + delay)
                    self.condition.notify_all()
            raise


PROVIDERS = {name: ProviderGate(spacing) for name, spacing in {
    "deezer": .25, "itunes": 3.2, "spotify": .25, "soundcloud": .25, "youtube-images": .25,
}.items()}
