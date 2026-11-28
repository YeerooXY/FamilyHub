"""Home activity: who is online and doing what, watch-time counting and the leaderboard periods."""
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

import test_family_profiles as family
from test_music_web import Base
from music_web.activity import Activity, describe, merge, played_seconds
from music_web.listening_stats import ListeningStats

ITEM = 'a' * 32
TICKS = 10_000_000
FILM = {'Type': 'Movie', 'Id': ITEM, 'Name': 'Big Film', 'ImageTags': {'Primary': 'tag1'}, 'RunTimeTicks': 5400 * TICKS}
EPISODE = {'Type': 'Episode', 'Name': 'Pilot', 'SeriesName': 'The Show', 'SeriesId': 'b' * 32, 'SeriesPrimaryImageTag': 'tag2',
           'ParentIndexNumber': 2, 'IndexNumber': 5, 'RunTimeTicks': 1800 * TICKS}
PEOPLE = [dict(id='ana', name='Ana'), dict(id='ben', name='Ben'), dict(id='cy', name='Cy'), dict(id='di', name='Di')]


def report(position, paused=False, item=ITEM):
    return {'ItemId': item, 'PositionTicks': int(position * TICKS), 'IsPaused': paused}


class WatchTimeRules(unittest.TestCase):
    def setUp(self):
        self.now, self.credits, self.paused = 1000.0, [], set()
        self.activity = Activity(credit=lambda user, seconds: self.credits.append((user, seconds)),
                                 history_paused=lambda user: user in self.paused, clock=lambda: self.now)

    def play(self, action, position, paused=False, item=FILM, user='ana'):
        self.activity.report(user, action, report(position, paused), lambda ident: item)

    def test_played_seconds_never_exceed_the_clock(self):
        playing = dict(position=10, at=100, playing=True)
        self.assertEqual(played_seconds(playing, 20, 110), 10)
        self.assertEqual(played_seconds(playing, 22.5, 110), 10)  # faster playback is capped by the clock
        self.assertEqual(played_seconds(playing, 40, 110), 0)  # skipped ahead
        self.assertEqual(played_seconds(playing, 5, 110), 0)  # skipped back
        self.assertEqual(played_seconds(playing, 130, 250), 0)  # silent for over two minutes
        self.assertEqual(played_seconds(dict(playing, playing=False), 20, 110), 0)
        self.assertEqual(played_seconds(None, 20, 110), 0)

    def test_progress_counts_played_time_and_ignores_seeks_and_pauses(self):
        self.play('start', 0)
        for position, paused in [(10, False), (20, True), (30, False), (200, False), (210, False)]:
            self.now += 10
            self.play('progress', position, paused)
        # Played: 0 to 10 and 10 to 20 (the second report is the pause). 20 to 30 began paused, 30 to 200 is a seek, 200 to 210 played.
        self.assertEqual(self.credits, [('ana', 10)] * 3)
        self.now += 5
        self.play('stopped', 215)
        self.assertEqual(sum(seconds for _, seconds in self.credits), 35)

    def test_clips_under_two_minutes_and_paused_history_record_nothing(self):
        clip = {**FILM, 'RunTimeTicks': 119 * TICKS}
        self.play('start', 0, item=clip)
        self.now += 10
        self.play('progress', 10, item=clip)
        self.assertEqual(self.credits, [])
        self.activity.report('ben', 'start', report(0), lambda ident: FILM)
        self.paused.add('ben')
        self.now += 10
        self.activity.report('ben', 'progress', report(10), lambda ident: FILM)
        self.assertEqual(self.credits, [])
        self.paused.clear()
        self.now += 10
        self.activity.report('ben', 'progress', report(20), lambda ident: FILM)
        self.assertEqual(self.credits, [('ben', 10)])

    def test_bad_reports_and_failed_lookups_are_logged_and_never_raise(self):
        with self.assertLogs('music_web.activity', 'WARNING') as logs:
            self.activity.report('ana', 'progress', {'ItemId': '../x', 'PositionTicks': 1, 'IsPaused': False}, lambda i: FILM)
            self.activity.report('ana', 'progress', {'ItemId': ITEM, 'PositionTicks': -1, 'IsPaused': False}, lambda i: FILM)
            self.activity.report('ana', 'progress', None, lambda i: FILM)
            self.activity.report('ana', 'start', report(0), mock.Mock(side_effect=OSError))
        self.assertEqual(sum('cause=invalid_report' in line for line in logs.output), 3)
        self.assertIn('lookup failed: profile=ana cause=OSError', logs.output[-1])
        self.now += 10
        self.activity.report('ana', 'progress', report(10), mock.Mock(side_effect=AssertionError('looked up twice')))
        self.assertEqual(self.credits, [('ana', 10)])  # a play with no known length still counts
        self.activity = Activity(credit=mock.Mock(side_effect=OSError), clock=lambda: self.now)
        self.play('start', 0)
        self.now += 10
        with self.assertLogs('music_web.activity', 'WARNING') as logs:
            self.play('progress', 10)
        self.assertIn('watch time not saved: profile=ana cause=OSError', logs.output[0])

    def test_watching_shows_until_stopped_or_silent(self):
        self.play('start', 600, item=EPISODE)
        row = self.activity.members(PEOPLE, {}, set(), set())[0]
        self.assertEqual((row['kind'], row['title'], row['subtitle']), ('watching', 'The Show', 'Season 2, episode 5'))
        self.assertEqual(row['progress'], round(600 / 1800, 3))
        self.assertTrue(row['poster'].startswith('Items/' + 'b' * 32 + '/Images/Primary?tag=tag2'))
        self.now += 46
        self.assertEqual(self.activity.members(PEOPLE, {}, set(), set()), [])
        self.play('start', 0)
        self.play('stopped', 5)
        self.assertEqual(self.activity.members(PEOPLE, {}, set(), set()), [])


class ActivityMerge(unittest.TestCase):
    def test_one_row_per_online_profile_with_the_strongest_activity(self):
        song = dict(id='abcdefghijk', title='Song', channel='Artist')
        film = dict(describe(FILM), position=2700)
        rows = merge(PEOPLE, {'ana': song, 'ben': None}, {'ben', 'cy'}, {'ana': film, 'cy': film}, {'ben', 'cy', 'di'}, set())
        self.assertEqual([(row['id'], row['kind']) for row in rows],
                         [('ana', 'listening'), ('cy', 'watching'), ('ben', 'wordle'), ('di', 'wordle')])
        self.assertEqual(rows[0], dict(id='ana', name='Ana', kind='listening', title='Song', subtitle='Artist', cover='abcdefghijk'))
        self.assertEqual((rows[1]['title'], rows[1]['progress']), ('Big Film', 0.5))
        self.assertEqual(merge(PEOPLE, {}, set(), {}, set(), set()), [])
        self.assertEqual(merge(PEOPLE, {'ben': None}, set(), {}, set(), set()), [dict(id='ben', name='Ben', kind='online')])

    def test_paused_history_is_online_without_details(self):
        song = dict(id='abcdefghijk', title='Song', channel='Artist')
        rows = merge(PEOPLE, {'ana': song}, {'ben'}, {'ben': describe(FILM)}, {'ana'}, {'ana', 'ben'})
        self.assertEqual(rows, [dict(id='ana', name='Ana', kind='online'), dict(id='ben', name='Ben', kind='online')])

    def test_describe_ignores_unsafe_artwork_and_text(self):
        bad = {**EPISODE, 'SeriesId': '../x', 'SeriesName': 'line\nbreak', 'ParentIndexNumber': None}
        self.assertEqual((describe(bad)['poster'], describe(bad)['title'], describe(bad)['episode']), ('', '', 'Pilot'))
        self.assertEqual(describe('nope'), {})


class WatchLeaderboard(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.utc = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
        self.stats = ListeningStats(self.root.name, clock=lambda: 100, utc=lambda: self.utc)
        self.people = [dict(id='ana', name='Ana'), dict(id='ben', name='Ben')]

    def credit(self, day, seconds):
        self.utc = datetime.fromisoformat(day + 'T12:00:00+00:00')
        self.stats.add_watch('ana', seconds)

    def test_periods_and_persistence(self):
        for day, seconds in [('2026-10-20', 600), ('2026-11-02', 300), ('2026-11-09', 120), ('2026-11-15', 60)]:
            self.credit(day, seconds)
        self.utc = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
        self.stats.add_watch('ana', 0)
        self.stats.add_watch('ana', float('nan'))
        self.stats.flush()
        for stats in (self.stats, ListeningStats(self.root.name, clock=lambda: 100, utc=lambda: self.utc)):
            row = stats.snapshot(self.people)['profiles'][0]
            # Week: the last 7 days from 9 Nov, month: November, all time.
            self.assertEqual((row['week_watch_seconds'], row['month_watch_seconds'], row['watch_seconds']), (180, 480, 1080))
            self.assertEqual(stats.snapshot(self.people)['profiles'][1]['watch_seconds'], 0)

    def test_hidden_profiles_show_no_watch_time_and_clear_removes_it(self):
        self.credit('2026-11-15', 90)
        self.assertEqual(self.stats.snapshot(self.people, hidden={'ana'})['profiles'][0]['watch_seconds'], 0)
        self.stats.clear('ana')
        self.assertEqual(self.stats.snapshot(self.people)['profiles'][0]['watch_seconds'], 0)

    def test_music_time_sits_next_to_watch_time_and_presence_lists_idle_players(self):
        self.stats.heartbeat('ana', 'pc', True)
        self.assertIn('month_seconds', self.stats.snapshot(self.people)['profiles'][0])
        self.assertEqual(self.stats.presence(), {'ana': None})
        self.stats.heartbeat('ana', 'pc', True, track=dict(id='abcdefghijk', title='Song', channel='Artist'))
        self.assertEqual(self.stats.presence()['ana']['title'], 'Song')


class OnlineEndpoint(Base):
    extra = {'FAMILY_PROFILES': True}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def members(self, client):
        return {row['id']: row for row in self.go(client, 'GET', '/api/activity/online').json['members']}

    def test_listening_wordle_online_and_paused_history(self):
        alice, _ = self.select()
        bob, token = self.select('sample-b')
        song = dict(id='abcdefghijk', title='Song', channel='Artist')
        self.assertEqual(self.post(bob, token, '/api/playback/activity', json=dict(device_id='b' * 32, playing=True, track=song)).status_code, 200)
        rows = self.members(alice)
        self.assertEqual(rows['sample-a']['kind'], 'online')
        self.assertEqual({key: rows['sample-b'][key] for key in ('kind', 'title', 'subtitle', 'cover')},
                         dict(kind='listening', title='Song', subtitle='Artist', cover='abcdefghijk'))
        self.assertEqual(self.post(bob, token, '/api/playback/activity', json=dict(device_id='b' * 32, playing=False)).status_code, 200)
        self.assertEqual(self.go(bob, 'GET', '/api/wordle/today').status_code, 200)
        self.assertEqual(self.members(alice)['sample-b']['kind'], 'wordle')
        self.assertEqual(self.go(bob, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': True},
                                 headers={'X-CSRFToken': token}).status_code, 200)
        self.assertEqual(self.members(alice)['sample-b'], dict(id='sample-b', name=rows['sample-b']['name'], kind='online'))
        self.assertEqual(self.go(self.app.test_client(), 'GET', '/api/activity/online').status_code, 401)

    def test_background_requests_do_not_mark_a_profile_online(self):
        alice, _ = self.select()
        self.go(alice, 'GET', '/api/activity/online', headers={'X-FamilyHub-Activity': 'background'})
        self.assertEqual(self.app.extensions['activity'].seen_until, {})
        self.go(alice, 'GET', '/api/activity/online')
        self.assertEqual(set(self.app.extensions['activity'].seen_until), {'sample-a'})


if __name__ == '__main__':
    unittest.main()
