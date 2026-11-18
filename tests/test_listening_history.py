"""Store tests deliberately need only Python's standard library."""
import importlib
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType
from unittest import mock
from uuid import uuid4

package = ModuleType('listening_test_store')
package.__path__ = [str(Path(__file__).resolve().parents[1] / 'music_web')]
sys.modules[package.__name__] = package
ListeningHistory = importlib.import_module('.listening_history', package.__name__).ListeningHistory
DeezerChart = importlib.import_module('.wrapped', package.__name__).DeezerChart


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

    def test_genre_variants_share_counts_and_use_the_most_common_spelling(self):
        genres = ['hip hop', 'Hip-hop', 'Hip-hop', 'r&b', 'R&B / Soul',
                  'drum and bass', 'Drum & Bass', 'DNB', 'dance', 'Dance']
        self.store.append('alex', [self.event(recording_id=f'{i:011d}') for i in range(len(genres))])
        summary = self.store.summary('alex', {f'{i:011d}': {'genre': genre} for i, genre in enumerate(genres)})
        self.assertEqual({label: row['plays'] for label, row in summary['genres'].items()},
                         {'Hip-hop': 3, 'R&B / Soul': 2, 'DNB': 3, 'Dance': 2})

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

    def test_wrapped_migrates_legacy_rows_recovers_a_write_and_survives_pruning(self):
        path = self.store.path('alex')
        path.parent.mkdir()
        first = self.event(started_at='2025-12-31T23:00:00Z')
        path.write_text(json.dumps(first) + '\n', encoding='utf-8')
        track = dict(title='Song', channel='Artist', library_album='Album', genre='Pop')
        store = ListeningHistory(self.tmp.name, utc=lambda: self.now,
                                 track_metadata=lambda ids: {first['recording_id']: track})
        night = self.event(started_at='2026-01-01T02:00:00Z', device_kind='android')
        skip = self.event(started_at='2026-01-02T12:00:00Z', outcome='skipped', position=10, listened_seconds=10)
        with mock.patch.object(store, '_rollup', side_effect=OSError('interrupted write')):
            with self.assertRaises(OSError):
                store.append('alex', [skip, night])
        store = ListeningHistory(self.tmp.name, utc=lambda: self.now)
        self.assertEqual(store.append('alex', [night])['added'], 0)
        summary = store.wrapped('alex', 2026, {}, full=True)
        self.assertEqual(summary['favourite_artist'], 'Artist')
        self.assertEqual(summary['favourite_genre'], 'Pop')
        self.assertEqual(summary['top_albums'][0]['name'], 'Album')
        self.assertAlmostEqual(summary['total_minutes'], 110 / 60)
        self.assertAlmostEqual(summary['monthly_minutes'][0], 110 / 60)
        self.assertEqual(summary['top_hour'], 2)
        self.assertEqual(summary['longest_streak_days'], 2)
        self.assertEqual(summary['night_owl_share'], 1)
        self.assertEqual(summary['devices']['phone']['plays'], 1)
        self.assertEqual(summary['most_replayed_song']['replays'], 1)
        self.assertEqual(summary['most_skipped_song']['skips'], 1)
        self.assertEqual(summary['first_listened_per_artist'], {'Artist': '2025-12-31'})
        self.assertEqual(next(e['position'] for e in store.events('alex') if e['outcome'] == 'skipped'), 10)
        self.now += timedelta(days=400)
        store.prune()
        self.assertEqual(store.events('alex'), [])
        self.assertEqual(store.wrapped('alex', 2026, {}, full=True), summary)
        self.assertEqual(store.wrapped('alex', 2025, {})['total_minutes'], 100 / 60)
        store.clear('alex')
        self.assertEqual(store.wrapped('alex', 2026, {})['total_minutes'], 0)
        self.assertFalse(path.with_suffix('.yearly.json').exists())

    def test_chart_cache_baseline_later_entry_and_failed_refresh(self):
        def chart(artist):
            return {'artists': {'data': [{'name': artist}]},
                    'tracks': {'data': [{'title': 'Song', 'artist': {'name': artist}}]}}

        read = mock.Mock(side_effect=[chart('Other'), chart('Artist'), OSError('offline')])
        cache = DeezerChart(self.tmp.name, lambda: self.now, read)
        track = dict(title='Song', channel='Artist - Topic')
        self.store.append('alex', [self.event(started_at='2026-11-10T00:00:00Z', track=track)])
        first = cache.snapshot()
        self.assertEqual(self.store.wrapped('alex', 2026, first)['mainstream_score'], 0)
        self.now += timedelta(hours=23)
        self.assertEqual(DeezerChart(self.tmp.name, lambda: self.now, read).snapshot(), first)
        self.now += timedelta(hours=1)
        second = cache.snapshot()
        result = self.store.wrapped('alex', 2026, second)
        self.assertEqual(result['mainstream_score'], 1)
        self.assertEqual(result['early_listeners'], ['Artist - Topic'])
        self.now += timedelta(days=1)
        self.assertEqual(cache.snapshot()['day'], second['day'])
        cache.snapshot()
        self.assertEqual(read.call_args_list, [mock.call('chart?limit=50')] * 3)
