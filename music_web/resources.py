"""Stage observations and independent admission for external resources."""
import logging
import os
import threading
import time
from collections import Counter
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from pathlib import Path
from urllib.error import HTTPError


_current = ContextVar("resource_stages", default=())
background_request = ContextVar("background_provider_request", default=False)


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


class ResourceGovernor:
    def __init__(self, queued=lambda: (), metrics=lambda: {}, clock=time.monotonic):
        self.queued, self.metrics, self.clock = queued, metrics, clock
        self.lock = threading.Lock()
        self.stages, self.totals = {}, Counter()
        self.last_report = self.clock()
        self.reporter = None

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
        if rows:
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
                "resource shadow %s %s", " ".join(stages),
                " ".join(f"{key}={value}" for key, value in self.metrics().items()))


def transfer_limit():
    try:
        return max(1, min(8, int(os.environ.get("FAMILYHUB_TRANSFERS", "4"))))
    except ValueError:
        return 4


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
    def __init__(self, capacity, available):
        self.capacity, self.available = capacity, available
        self.condition = threading.Condition()
        self.waiters = {"transfer": [], "scratch": []}
        self.active = self.reserved = 0

    def wake(self):
        with self.condition:
            self.condition.notify_all()

    @contextmanager
    def lease(self, *, background, cancelled, error, size=0):
        lane = "scratch" if size else "transfer"
        ticket = (object(), background)
        with self.condition:
            queue = self.waiters[lane]
            queue.append(ticket)
            self.condition.notify_all()
            try:
                while True:
                    if cancelled():
                        raise error("acquisition cancelled")
                    if min(queue, key=lambda row: row[1]()) == ticket:
                        if size:
                            available = self.available()
                            if size > available and not self.reserved:
                                raise error("scratch capacity exceeded")
                            if size + self.reserved <= available:
                                self.reserved += size
                                break
                        elif self.active < self.capacity:
                            self.active += 1
                            break
                    with waiting(lane):
                        self.condition.wait()
            finally:
                queue.remove(ticket)
                self.condition.notify_all()
        try:
            yield
        finally:
            with self.condition:
                if size:
                    self.reserved -= size
                else:
                    self.active -= 1
                self.condition.notify_all()


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
