"""Store tests deliberately need only Python's standard library."""
import importlib.util
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

spec = importlib.util.spec_from_file_location('listening_history_store', Path(__file__).resolve().parents[1] / 'music_web/listening_history.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ListeningHistory = module.ListeningHistory


class HistoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = datetime(2026, 11, 18, 15, tzinfo=timezone.utc)
        self.store = ListeningHistory(self.tmp.name, utc=lambda: self.now)

    def event(self, **changes):
        return dict(event_id=str(uuid4()), recording_id='abcdefghijk', started_at=self.now.isoformat(),
                    listened_seconds=100, duration=100, position=100, outcome='completed', source='library', device_kind='windows') | changes

    def test_validation_is_atomic(self):
        valid = self.event()
        invalid = [dict(event_id='bad'), dict(recording_id='../bad'), dict(started_at='2026-11-18T10:00:00'),
                   dict(started_at=(self.now + timedelta(hours=1)).isoformat()), dict(listened_seconds=True),
                   dict(duration=0), dict(duration=float('inf')), dict(position=101), dict(listened_seconds=-1),
                   dict(listened_seconds=float('nan')), dict(outcome='liked'), dict(outcome=[]), dict(device_kind='web'),
                   dict(source='playlist:../bad'), dict(profile='someone')]
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.store.append('alex', [valid, self.event(**change)])
            self.assertEqual(self.store.events('alex'), [])
        for batch in ([], [valid] * 101, {}, None):
            with self.assertRaises(ValueError):
                self.store.append('alex', batch)

    def test_dedup_persistence_isolation_and_concurrent_append(self):
        event = self.event()
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: self.store.append('alex', [event, event]), range(8)))
        self.assertEqual(sum(r['added'] for r in results), 1)
        self.assertEqual(len(self.store.events('alex')), 1)
        self.assertEqual(self.store.events('sam'), [])
        loaded = ListeningHistory(self.tmp.name, utc=lambda: self.now)
        self.assertEqual(loaded.append('alex', [event])['added'], 0)
        self.assertEqual(loaded.append('sam', [event])['added'], 1)

    def test_calendar_retention_prunes_on_read_and_late_upload(self):
        self.store.append('alex', [self.event(started_at='2025-11-18T15:00:00+00:00')])
        self.now += timedelta(seconds=1)
        self.assertEqual(self.store.events('alex'), [])
        old = self.event(started_at='2024-02-29T00:00:00+00:00')
        self.assertEqual(self.store.append('alex', [old])['added'], 0)
        self.assertEqual(self.store.path('alex').read_text(), '')
        self.now = datetime(2024, 2, 29, tzinfo=timezone.utc)
        self.assertEqual(self.store.cutoff().isoformat(), '2023-02-28T00:00:00+00:00')

    def test_outcomes_summaries_recency_and_recent_order(self):
        events = [self.event(started_at=(self.now - timedelta(days=30)).isoformat()),
                  self.event(outcome='skipped', position=29, listened_seconds=29),
                  self.event(outcome='skipped', duration=200, position=40, listened_seconds=40),
                  self.event(outcome='skipped', position=30, listened_seconds=30),
                  self.event(outcome='stopped', position=5, listened_seconds=5)]
        self.store.append('alex', events)
        summary = self.store.summary('alex', {'abcdefghijk': dict(channel='Artist', genre='Pop')})
        row = summary['recordings']['abcdefghijk']
        self.assertEqual((row['plays'], row['completes'], row['skips'], row['early_skips'], row['total_seconds']), (5, 1, 3, 2, 204))
        self.assertAlmostEqual(summary['artists']['Artist']['score'], 1.5)
        self.assertEqual(summary['genres']['Pop']['plays'], 5)
        self.assertEqual(sum(summary['hours']), 204)
        self.assertEqual(sum(summary['weekdays']), 204)
        self.assertEqual(len(summary['recent_history']), 5)
        self.assertEqual(row['last_early_skip'], self.now.isoformat())
        self.assertEqual(row['last_played'], self.now.isoformat())

    def test_recent_bounded_pause_and_clear(self):
        for batch in range(3):
            self.store.append('alex', [self.event() for _ in range(100)])
        self.assertEqual(len(self.store.summary('alex', {})['recent_history']), 200)
        paused = self.event()
        self.assertEqual(self.store.append('alex', [paused], paused=True)['acknowledged'], [paused['event_id']])
        self.assertEqual(len(self.store.events('alex')), 300)
        self.store.clear('alex')
        self.assertEqual(self.store.summary('alex', {})['recordings'], {})
        self.assertEqual(self.store.summary('alex', {})['recent_history'], [])
        self.assertEqual(self.store.append('alex', [paused])['added'], 0)
        self.assertEqual(self.store.summary('alex', {})['cleared_at'], self.now.isoformat())
        self.now += timedelta(seconds=1)
        self.assertEqual(self.store.append('alex', [self.event()])['added'], 1)

    def test_cache_invalidates_and_inactive_profiles_are_pruned(self):
        event = self.event()
        self.store.append('alex', [event])
        first = self.store.summary('alex', {'abcdefghijk': dict(channel='A', genre='Pop')})
        first['recent_history'].clear()
        self.assertEqual(len(self.store.summary('alex', {})['recent_history']), 1)
        changed = self.store.summary('alex', {'abcdefghijk': dict(channel='B', genre='Rock')})
        self.assertIn('B', changed['artists'])
        self.store.append('alex', [self.event()])
        self.assertEqual(len(self.store.summary('alex', {})['recent_history']), 2)
        self.now = datetime(2027, 11, 19, tzinfo=timezone.utc)
        self.store.prune()
        self.assertEqual(self.store.path('alex').read_text(), '')
