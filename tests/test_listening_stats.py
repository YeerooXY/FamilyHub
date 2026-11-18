import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from music_web.listening_stats import ListeningStats, listening_records, longest_streak


class ListeningStatisticsTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.now = 100
        self.utc = datetime(2026, 11, 15, tzinfo=timezone.utc)
        self.stats = ListeningStats(self.root.name, clock=lambda: self.now, utc=lambda: self.utc)
        self.profiles = [dict(id='alex', name='Alex'), dict(id='sam', name='Sam')]

    def test_overlap_pauses_disconnect_and_persistence(self):
        self.stats.heartbeat('alex', 'pc1', True)
        self.stats.heartbeat('alex', 'pc2', True)
        self.now += 5
        self.stats.heartbeat('alex', 'pc1', True)
        self.stats.heartbeat('alex', 'pc2', True)
        self.assertEqual(self.stats.snapshot(self.profiles)['profiles'][0]['seconds'], 5)
        self.now += 5
        self.stats.heartbeat('alex', 'pc1', False)
        self.stats.heartbeat('alex', 'pc2', False)
        self.assertFalse(self.stats.playing())
        self.now += 10
        self.stats.heartbeat('alex', 'pc1', False)
        row = self.stats.snapshot(self.profiles)['profiles'][0]
        self.assertEqual((row['seconds'], row['month_seconds'], row['active_months']), (10, 10, 1))
        self.assertTrue(row['online'])
        self.now += 21
        self.assertFalse(self.stats.snapshot(self.profiles)['profiles'][0]['online'])
        self.stats.heartbeat('alex', 'pc1', True)
        self.assertEqual(self.stats.snapshot(self.profiles)['profiles'][0]['seconds'], 10)
        loaded = ListeningStats(self.root.name)
        self.assertEqual(loaded.snapshot(self.profiles)['profiles'][0]['seconds'], 10)
        self.assertFalse(loaded.playing())

    def test_profiles_are_counted_independently_and_idle_is_online(self):
        self.stats.heartbeat('alex', 'pc', True)
        self.stats.heartbeat('sam', 'pc', False)
        self.now += 5
        self.stats.heartbeat('alex', 'pc', True)
        self.stats.heartbeat('sam', 'pc', False)
        rows = self.stats.snapshot(self.profiles)['profiles']
        self.assertEqual([r['seconds'] for r in rows], [5, 0])
        self.assertTrue(all(r['online'] for r in rows))
        self.assertTrue(self.stats.playing())


    def row(self, index=0):
        return self.stats.snapshot(self.profiles)['profiles'][index]

    def test_records_use_real_days_and_current_profiles(self):
        daily = {'alex': {'2026-11-10': 60, '2026-11-11': 120, '2026-11-13': 600},
                 'sam': {'2026-11-12': 90, '2026-11-13': 30, '2026-11-14': 0},
                 'removed': {'2026-11-09': 90000}}
        before = copy.deepcopy(daily)
        records = {r['id']: r for r in listening_records(daily, self.profiles, self.utc.date())}
        self.assertEqual((records['family-day']['day'], records['family-day']['seconds']), ('2026-11-13', 630))
        self.assertEqual((records['personal-day']['owner'], records['personal-day']['seconds']), ('alex', 600))
        self.assertEqual((records['family-streak']['day'], records['family-streak']['end_day'], records['family-streak']['days']),
                         ('2026-11-10', '2026-11-13', 4))
        self.assertEqual(records['streak-alex']['days'], 2)
        self.assertEqual(records['streak-sam']['days'], 2)
        self.assertEqual(records['first-day']['day'], '2026-11-10')
        self.assertEqual(records['week-listener']['seconds'], 780)
        self.assertEqual(daily, before)

    def test_records_empty_future_zero_and_streak_ties(self):
        self.assertEqual(listening_records({}, self.profiles, self.utc.date()), [])
        self.assertEqual(listening_records({'alex': {'2026-11-14': 0, '2026-11-16': 100}}, self.profiles, self.utc.date()), [])
        self.assertEqual(longest_streak({'2026-10-31': 1, '2026-11-01': 1, '2026-11-02': 0,
                                        '2026-11-03': 1, '2026-11-04': 1}),
                         dict(day='2026-10-31', end_day='2026-11-01', days=2))
        records = listening_records({'sam': {'2026-11-14': 30}, 'alex': {'2026-11-13': 30}}, self.profiles, self.utc.date())
        self.assertEqual(next(r for r in records if r['id'] == 'personal-day')['owner'], 'alex')

    def test_sync_is_cumulative_idempotent_and_out_of_order(self):
        dev = 'a' * 32
        self.assertEqual(self.stats.sync('alex', dev, [dict(day='2026-11-14', seconds=100, plays=2)]),
                         dict(seconds=100, plays=2))
        self.assertEqual(self.stats.sync('alex', dev, [dict(day='2026-11-14', seconds=100, plays=2)]),
                         dict(seconds=0, plays=0))
        self.assertEqual(self.stats.sync('alex', dev, [dict(day='2026-11-14', seconds=160.5, plays=3),
                                                       dict(day='2026-11-13', seconds=40, plays=1)]),
                         dict(seconds=100.5, plays=2))
        self.assertEqual(self.stats.sync('alex', dev, [dict(day='2026-11-14', seconds=50, plays=0)]),
                         dict(seconds=0, plays=0))
        self.assertEqual(self.stats.sync('alex', 'b' * 32, [dict(day='2026-11-14', seconds=30, plays=1)]),
                         dict(seconds=30, plays=1))
        row = self.row()
        self.assertEqual((row['seconds'], row['month_seconds'], row['qualified_plays']), (230.5, 230.5, 5))
        self.assertEqual(row['royalty_usd'], round(5 * 0.00341, 5))
        loaded = ListeningStats(self.root.name, clock=lambda: self.now, utc=lambda: self.utc)
        loaded.sync('alex', dev, [dict(day='2026-11-14', seconds=160.5, plays=3)])
        self.assertEqual(loaded.snapshot(self.profiles)['profiles'][0]['seconds'], 230.5)
        snapshot = self.stats.snapshot(self.profiles)
        self.assertEqual((snapshot['total_seconds'], snapshot['total_qualified_plays']), (230.5, 5))
        self.assertEqual(snapshot['royalty_rate_usd'], 0.00341)
        self.assertEqual(snapshot['royalty_source'], 'https://report.duetti.co/')
        record = next(row for row in snapshot['records'] if row['id'] == 'family-day')
        self.assertEqual((record['day'], record['seconds']), ('2026-11-14', 190.5))
        self.assertEqual([d['day'] for d in snapshot['daily']][-3:], ['2026-11-13', '2026-11-14', '2026-11-15'])
        self.assertEqual(len(snapshot['daily']), 15)
        self.assertEqual([d['seconds'] for d in snapshot['daily']][-3:], [40, 190.5, 0])

    def test_daily_chart_keeps_prior_months_and_profile_breakdown(self):
        self.stats.sync('alex','a'*32,[dict(day='2026-10-05',seconds=90,plays=1),dict(day='2026-11-14',seconds=30,plays=1)])
        snapshot=self.stats.snapshot(self.profiles)
        self.assertEqual(snapshot['daily'][0]['day'],'2026-10-05')
        self.assertEqual(sum(d['seconds'] for d in snapshot['daily']),120)
        self.assertEqual(snapshot['profiles'][0]['daily'],[dict(day='2026-10-05',seconds=90),dict(day='2026-11-14',seconds=30)])
        self.assertEqual(snapshot['profiles'][1]['daily'],[])

    def test_journal_recovers_pending_counters_and_compacted_revisions(self):
        device = 'a' * 32
        first = dict(day='2026-11-14', seconds=30, plays=1)
        latest = dict(first, seconds=60, plays=2)
        self.stats.sync('alex', device, [first])
        self.now += 5
        self.stats.sync('alex', device, [latest])
        self.assertEqual(json.loads(self.stats.path.read_text())['plays']['alex'], 1)
        with self.stats.journal.open('ab') as journal:
            journal.write(b'["interrupted append"')

        restarted = ListeningStats(self.root.name, clock=lambda: self.now, utc=lambda: self.utc)
        self.assertEqual(restarted.data, self.stats.data)
        self.assertEqual(restarted.sync('alex', device, [latest]), dict(seconds=0, plays=0))
        with mock.patch.object(Path, 'unlink', side_effect=OSError('cleanup interrupted')):
            with self.assertLogs('music_web.listening_stats', level='ERROR'):
                restarted.sync('alex', device, [dict(latest, seconds=75)])
                restarted.clear('alex')
        self.assertEqual(len(restarted.journal.read_text().splitlines()), 2)
        reloaded = ListeningStats(self.root.name)
        self.assertEqual(reloaded.data, restarted.data)
        self.assertNotIn('alex', reloaded.data['counters'])

    def test_idle_heartbeats_do_not_flush_another_players_elapsed_time(self):
        self.stats.heartbeat('alex', 'active', True)
        self.now += 5
        self.stats.heartbeat('alex', 'active', True)
        self.now += 5
        self.stats.heartbeat('alex', 'active', True)
        with mock.patch.object(self.stats, '_write', wraps=self.stats._write) as write:
            self.stats.heartbeat('sam', 'idle', False)
            write.assert_not_called()
            self.stats.heartbeat('alex', 'active', False)
            write.assert_called_once()
        self.assertEqual(ListeningStats(self.root.name).data['daily']['alex']['2026-11-15'], 10)

    def test_empty_chart_covers_seven_days_across_month_boundary(self):
        self.utc = datetime(2026, 11, 1, tzinfo=timezone.utc)
        snapshot = self.stats.snapshot(self.profiles)
        self.assertEqual([row['day'] for row in snapshot['daily']],
                         ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
                          '2026-10-30', '2026-10-31', '2026-11-01'])
        self.assertTrue(all(row['seconds'] == 0 for row in snapshot['daily']))
        self.assertEqual(snapshot['records'], [])

    def test_invalid_batch_changes_nothing(self):
        dev, good = 'a' * 32, dict(day='2026-11-14', seconds=10, plays=1)
        self.stats.sync('alex', dev, [good])
        before = copy.deepcopy(self.stats.data)
        bad_entries = [dict(day='2026-11-17', seconds=1, plays=0), dict(day='2019-12-31', seconds=1, plays=0),
                       dict(day='2026-02-30', seconds=1, plays=0), dict(day='2026-1-1', seconds=1, plays=0),
                       dict(day='2026-11-14', seconds=float('nan'), plays=0),
                       dict(day='2026-11-14', seconds=float('inf'), plays=0),
                       dict(day='2026-11-14', seconds=-1, plays=0), dict(day='2026-11-14', seconds=86401, plays=0),
                       dict(day='2026-11-14', seconds=True, plays=0), dict(day='2026-11-14', seconds='5', plays=0),
                       dict(day='2026-11-14', seconds=1, plays=10001), dict(day='2026-11-14', seconds=1, plays=1.5),
                       dict(day='2026-11-14', seconds=1, plays=True), dict(day='2026-11-14', seconds=1), 'x']
        for bad in bad_entries:
            with self.assertRaises(ValueError, msg=bad):
                self.stats.sync('alex', dev, [dict(day='2026-11-14', seconds=500, plays=9), bad])
        with self.assertRaises(ValueError):
            self.stats.sync('alex', dev, [dict(day='2026-11-14', seconds=1, plays=0)] * 401)
        for device in ('ABC', 'A' * 32, 'a' * 31, None, 5):
            with self.assertRaises(ValueError):
                self.stats.sync('alex', device, [good])
        for entries in (None, {}, 'x'):
            with self.assertRaises(ValueError):
                self.stats.sync('alex', dev, entries)
        self.assertEqual(self.stats.data, before)
        self.assertEqual(ListeningStats(self.root.name).data, before)
        # Boundaries are accepted: tomorrow in UTC, 2020, and a full batch.
        self.stats.sync('alex', dev, [dict(day='2026-11-16', seconds=86400, plays=10000),
                                      dict(day='2020-01-01', seconds=0, plays=0)])
        full = [dict(day=f'2025-01-{n % 28 + 1:02d}', seconds=1, plays=0) for n in range(400)]
        self.stats.sync('alex', dev, full)

    def test_current_song_uses_latest_playing_device_and_clears_after_pause(self):
        first = dict(id='abcdefghijk', title='First', channel='Artist')
        second = dict(id='12345678901', title='Second', channel='Other')
        self.stats.heartbeat('alex', 'pc1', True, track=first)
        self.now += 1
        self.stats.heartbeat('alex', 'pc2', True, track=second)
        self.assertEqual(self.row()['current_track'], second)
        self.stats.heartbeat('alex', 'pc2', False, track=second)
        self.assertEqual(self.row()['current_track'], first)
        self.stats.heartbeat('alex', 'pc1', False)
        self.assertIsNone(self.row()['current_track'])
        self.assertNotIn('First', self.stats.path.read_text())

    def test_legacy_heartbeat_is_skipped_for_counter_clients(self):
        self.stats.heartbeat('alex', 'pc1', True, count_time=False)
        self.now += 5
        self.stats.heartbeat('alex', 'pc1', True, count_time=False)
        row = self.row()
        self.assertEqual((row['seconds'], row['listening'], row['online']), (0, True, True))
        self.now += 5
        self.stats.heartbeat('alex', 'pc1', True)
        self.assertEqual(self.row()['seconds'], 5)
        self.assertEqual(self.stats.snapshot(self.profiles)['daily'][-1], dict(day='2026-11-15', seconds=5))

    def test_old_file_keeps_totals_without_inventing_plays(self):
        path = Path(self.root.name) / '.listening-statistics.json'
        path.write_text(json.dumps({'since': '2026-01-01T00:00:00+00:00', 'profiles': {'alex': {'2026-10': 7200}}}))
        old = ListeningStats(self.root.name, clock=lambda: self.now, utc=lambda: self.utc)
        row = old.snapshot(self.profiles)['profiles'][0]
        self.assertEqual((row['seconds'], row['qualified_plays'], row['royalty_usd'], row['saved_huf']), (7200, 0, 0, 0))
        self.assertIsNone(row['spotify_subscribed'])
        old.sync('alex', 'a' * 32, [dict(day='2026-11-14', seconds=60, plays=1)])
        saved = json.loads(path.read_text())
        self.assertEqual(saved['profiles']['alex'], {'2026-10': 7200, '2026-11': 60})
        self.assertEqual(saved['since'], '2026-01-01T00:00:00+00:00')
