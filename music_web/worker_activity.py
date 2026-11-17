"""Read-only occupancy reporting for existing bounded workers and encoding lanes."""
from contextlib import contextmanager
import threading


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
