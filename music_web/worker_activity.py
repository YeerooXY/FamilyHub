"""Read-only reporting for resource stages and worker occupancy."""
from contextlib import contextmanager
import threading


def stage_summary(governor, deferred_fetches=0):
    # The queue takes the jobs lock. Read it before taking the governor's lock.
    rows = list(governor.queued())
    with governor.lock:
        rows.extend(governor.stages.values())
    counts = {}
    for stage, reason, _ in rows:
        row = counts.setdefault(stage, dict(stage=stage, queued=0, backing_off=0, running=0))
        if not reason:
            row['running'] += 1
        elif any(word in reason.casefold().replace('_', ' ') for word in ('cooldown', 'backoff', 'back-off', 'backing off', 'retry')):
            row['backing_off'] += 1
        else:
            row['queued'] += 1
    for stage in ('fetch', 'preview'):
        if stage in counts and deferred_fetches:
            row = counts[stage]
            retrying = min(deferred_fetches, row['queued'])
            row['queued'] -= retrying
            row['backing_off'] += retrying
    return [counts[stage] for stage in sorted(counts)]


class WorkerActivity:
    def __init__(self, key, name, capacity=1):
        self.key, self.name = key, name
        self.lock = threading.Lock()
        self.slots = [None] * capacity

    @contextmanager
    def track(self, title, **detail):
        # The caller already holds its scheduling/encoding permit; this does not schedule work.
        with self.lock:
            slot = self.slots.index(None)
            self.slots[slot] = dict(current_title=title, **detail)
        try:
            yield
        finally:
            with self.lock:
                self.slots[slot] = None

    def snapshot(self, paused=False, waiting_for='New work'):
        with self.lock:
            return [dict(id=f'{self.key}-{i}', title=self.name + (f' {i + 1}' if len(self.slots) > 1 else ''),
                         state='working' if row is not None else 'paused' if paused else 'idle',
                         **(row if row is not None else dict(current_title='', waiting_for=waiting_for)))
                    for i, row in enumerate(self.slots)]
