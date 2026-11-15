import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from music_web.listening_stats import ListeningStats
from music_web.profiles import ProfileError, ProfileStore


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


class SubscriptionSavingsTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.when = utc(2026, 11, 15, 12)
        self.store = ProfileStore(self.root.name, ['alex', 'sam'], clock=lambda: self.when.timestamp())
        self.stats = self.open_stats()

    def open_stats(self):
        return ListeningStats(self.root.name, clock=lambda: 100, utc=lambda: self.when)

    def view(self, stats=None, profiles=None):
        return (stats or self.stats).snapshot(profiles or self.store.list(), self.store.subscription_history())

    def answer(self, subscribed, user='alex'):
        self.store.preferences(user, {'spotify_subscribed': subscribed})

    def test_preference_history_is_durable_and_only_records_changes(self):
        self.assertIsNone(self.store.preferences('alex')['spotify_subscribed'])
        self.assertEqual(self.store.subscription_history(), {})
        self.answer(False)
        self.answer(False)
        self.store.preferences('alex', {'volume': 0.5})
        self.when = utc(2026, 12, 1)
        self.answer(True)
        self.answer(False)
        self.assertEqual(self.store.subscription_history(), {'alex': [
            {'at': int(utc(2026, 11, 15, 12).timestamp() * 1000), 'subscribed': False},
            {'at': int(utc(2026, 12, 1).timestamp() * 1000), 'subscribed': True},
            {'at': int(utc(2026, 12, 1).timestamp() * 1000), 'subscribed': False}]})
        self.assertIs(ProfileStore(self.root.name, []).preferences('alex')['spotify_subscribed'], False)
        before = self.store.subscription_history()
        for bad in (None, 1, 'yes'):
            with self.assertRaises(ProfileError):
                self.answer(bad)
        with self.assertRaises(ProfileError):
            self.store.preferences('alex', {'spotify_subscribed': True, 'unknown': 1})
        self.assertEqual(self.store.subscription_history(), before)
        self.assertEqual(self.store.preferences('sam')['volume'], 1)

    def test_unknown_status_never_earns_credit(self):
        self.when = utc(2027, 3, 2)
        snapshot = self.view()
        self.assertEqual((snapshot['saved_huf'], snapshot['monthly_saved_huf']), (0, 0))
        self.assertTrue(all(row['spotify_subscribed'] is None for row in snapshot['profiles']))
        self.assertEqual(snapshot['total_seconds'], 0)

    def test_current_month_is_included_and_each_month_is_credited_once(self):
        self.answer(False)
        snapshot = self.view()
        self.assertEqual((snapshot['saved_huf'], snapshot['monthly_saved_huf']), (2190, 2190))
        self.assertEqual([r['monthly_saved_huf'] for r in snapshot['profiles']], [2190, 0])
        self.assertEqual(self.view()['saved_huf'], 2190)
        self.when = utc(2026, 11, 30, 22, 59)
        self.assertEqual(self.view()['saved_huf'], 2190)
        self.when = utc(2026, 11, 30, 23, 0)  # 1 Dec in Budapest
        self.assertEqual(self.view()['saved_huf'], 4380)
        self.when = utc(2026, 12, 20)
        self.assertEqual(self.view()['saved_huf'], 4380)
        self.when = utc(2027, 1, 15)
        snapshot = self.view()
        self.assertEqual((snapshot['saved_huf'], snapshot['monthly_saved_huf']), (6570, 2190))
        self.assertEqual(snapshot['profiles'][0]['saved_huf'], 6570)
        saved = json.loads((Path(self.root.name) / '.listening-statistics.json').read_text())
        self.assertEqual(saved['savings'], {'alex': {'2026-11': 2190, '2026-12': 2190, '2027-01': 2190}})

    def test_switch_to_spotify_stops_credits_at_the_boundary(self):
        self.answer(False)
        self.when = utc(2026, 12, 10)
        self.answer(True)
        self.when = utc(2027, 1, 15)  # December was never viewed; the ledger catches up lazily
        snapshot = self.view()
        self.assertEqual((snapshot['saved_huf'], snapshot['monthly_saved_huf']), (4380, 0))
        self.assertIs(snapshot['profiles'][0]['spotify_subscribed'], True)
        self.when = utc(2027, 2, 10)
        self.answer(False)
        self.when = utc(2027, 3, 2)
        snapshot = self.view()
        self.assertEqual((snapshot['saved_huf'], snapshot['monthly_saved_huf']), (8760, 2190))

    def test_answer_just_before_boundary_wins(self):
        self.answer(False)
        self.when = utc(2026, 11, 30, 22, 59)
        self.answer(True)
        self.when = utc(2026, 12, 5)
        self.assertEqual(self.view()['saved_huf'], 2190)

    def test_catch_up_after_restart_and_persistence(self):
        self.answer(False)
        self.when = utc(2026, 12, 2)
        self.assertEqual(self.view()['saved_huf'], 4380)
        self.when = utc(2027, 3, 2)  # server was off for months
        restarted = self.open_stats()
        self.assertEqual(self.view(restarted)['saved_huf'], 5 * 2190)
        stored = self.open_stats().snapshot(self.store.list())  # no history needed to read earned credits
        self.assertEqual((stored['saved_huf'], stored['monthly_saved_huf']), (5 * 2190, 0))

    def test_only_current_profiles_are_visible_but_credits_are_kept(self):
        self.answer(False)
        self.answer(False, 'sam')
        self.when = utc(2026, 12, 2)
        self.assertEqual(self.view()['saved_huf'], 8760)
        alex = [p for p in self.store.list() if p['id'] == 'alex']
        snapshot = self.view(profiles=alex)
        self.assertEqual((snapshot['saved_huf'], snapshot['monthly_saved_huf']), (4380, 2190))
        self.assertEqual(self.view()['saved_huf'], 8760)

    def test_old_profiles_without_history_and_listening_do_not_matter(self):
        self.stats.sync('alex', 'a' * 32, [dict(day='2026-11-14', seconds=3600, plays=10)])
        self.answer(False, 'sam')
        self.when = utc(2026, 12, 2)
        snapshot = self.view()
        self.assertEqual([r['saved_huf'] for r in snapshot['profiles']], [0, 4380])
        self.assertEqual(snapshot['total_qualified_plays'], 10)
        self.assertEqual(snapshot['monthly_saved_huf'], 2190)
