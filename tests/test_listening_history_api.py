"""Authenticated API tests use the existing offline Flask fixture."""
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import test_family_profiles as family
from test_music_intake import fake_item, mi
from test_music_web import Base
from test_listening_history import HistoryStoreTests


class HistoryApiTests(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a']}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def test_identity_access_pause_clear_and_csrf(self):
        admin, token = self.select()
        other, other_token = self.select('sample-b')
        fixture = HistoryStoreTests(); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        from datetime import datetime, timezone
        fixture.now = datetime.now(timezone.utc)
        event = fixture.event()
        response = self.post(other, other_token, '/api/listening/events', json={'events': [event]})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['added'], 1)
        self.assertEqual(self.post(other, other_token, '/api/listening/events', json={'events': [event]}).json['added'], 0)
        self.assertEqual(self.go(admin, 'GET', '/api/listening/summary').json['recent_history'], [])
        self.assertEqual(self.go(admin, 'GET', '/api/listening/summary?profile=sample-b').json['recent_history'], ['abcdefghijk'])
        self.assertEqual(len(self.go(admin, 'GET', '/api/listening/events?profile=sample-b').json['events']), 1)
        self.assertEqual(self.go(other, 'GET', '/api/listening/summary?profile=sample-a').status_code, 403)
        self.assertEqual(self.go(other, 'GET', '/api/listening/events?profile=sample-a').status_code, 403)
        self.assertEqual(self.go(other, 'GET', '/api/listening/events').status_code, 403)
        self.assertEqual(self.go(other, 'POST', '/api/listening/events', json={'events': [event]}).status_code, 400)
        self.assertEqual(self.post(other, other_token, '/api/listening/events', json={'events': [event], 'profile': 'sample-a'}).status_code, 400)
        paused = self.go(other, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': True}, headers={'X-CSRFToken': other_token})
        self.assertEqual(paused.status_code, 200)
        result = self.post(other, other_token, '/api/listening/events', json={'events': [fixture.event()]}).json
        self.assertTrue(result['paused']); self.assertEqual(result['added'], 0)
        self.assertEqual(self.go(other, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': 1}, headers={'X-CSRFToken': other_token}).status_code, 400)
        self.assertEqual(self.go(other, 'DELETE', '/api/listening/history?profile=sample-a', headers={'X-CSRFToken': other_token}).status_code, 200)
        self.assertEqual(self.go(other, 'GET', '/api/listening/summary').json['recent_history'], [])
        self.assertEqual(self.go(self.app.test_client(), 'GET', '/api/listening/summary').status_code, 401)

    def test_yearly_and_family_visibility_with_owned_library_adds(self):
        alice, alice_token = self.select()
        bob, bob_token = self.select('sample-b')
        fixture = HistoryStoreTests()
        fixture.now = datetime.now(timezone.utc)
        event = fixture.event()
        stats = '/api/activity/stats'
        wrapped = '/api/listening/wrapped'
        chart = {'artists': {'data': [{'name': 'Artist'}]},
                 'tracks': {'data': [{'title': 'Song', 'artist': {'name': 'Artist'}}]}}
        read = self.enterContext(mock.patch('music_web.wrapped._deezer', return_value=chart))
        item = fake_item(Path(self.ws))
        with mock.patch.object(mi, 'tag_copy', side_effect=lambda source, target, tags: Path(target).write_bytes(Path(source).read_bytes())):
            args = SimpleNamespace(item=str(item), library=self.lib, artist='Artist', title='Song', album='Album', track=None, added_by='sample-b')
            saved = mi.cmd_import(args)['manifest']['import']
            args.added_by = 'sample-a'
            self.assertEqual(mi.cmd_import(args)['manifest']['import'], saved)
            legacy = fake_item(Path(self.ws), data=b'unknown ownership')
            args.item, args.title, args.added_by = str(legacy), 'Legacy', None
            mi.cmd_import(args)
            _, manifest = mi.read_manifest(str(legacy))
            del manifest['import']['added_at']
            mi.write_manifest(str(legacy), manifest)
            args.added_by = 'sample-a'
            self.assertNotIn('added_by', mi.cmd_import(args)['manifest']['import'])
        self.assertEqual(saved['added_by'], 'sample-b')
        event['recording_id'] = item.name
        self.assertEqual(self.post(bob, bob_token, '/api/listening/events', json={'events': [event]}).json['added'], 1)
        private = self.go(bob, 'GET', wrapped).json
        self.assertEqual(private['songs_added'], 1)
        self.assertEqual(private['favourite_artist'], 'Artist')
        self.assertEqual(private['mainstream_score'], 1)
        self.assertEqual(private['early_listeners'], [])
        self.assertEqual(self.go(alice, 'GET', wrapped + '?profile=sample-b').json['total_minutes'], 0)
        self.assertEqual(self.go(alice, 'GET', wrapped).json['songs_added'], 0)
        self.assertEqual(self.go(alice, 'GET', wrapped + '?year=bad').status_code, 400)

        store = self.app.extensions['listening_history']
        with mock.patch.object(store, 'events', side_effect=AssertionError('Leaderboard read raw history')):
            rows = {row['id']: row['wrapped'] for row in self.go(alice, 'GET', stats).json['profiles']}
        self.assertEqual(rows['sample-b']['most_replayed_song'], None)
        self.assertEqual(rows['sample-b']['songs_added'], 1)
        self.assertNotIn('first_listened_per_artist', rows['sample-b'])
        counter = dict(device_id='b' * 32, playing=True, counters=[dict(day=fixture.now.date().isoformat(), seconds=60, plays=1)])
        activity = '/api/playback/activity'
        self.assertEqual(self.post(bob, bob_token, activity, json=counter).status_code, 200)
        board = self.go(alice, 'GET', stats).json
        self.assertEqual(board['total_seconds'], 60)
        family_wrapped = next(row['wrapped'] for row in board['profiles'] if row['id'] == 'sample-b')
        private = self.go(bob, 'GET', wrapped).json
        self.assertEqual(family_wrapped['total_minutes'], private['total_minutes'])
        self.assertEqual(private['total_minutes'], 1)
        self.assertEqual(private['monthly_minutes'][fixture.now.month - 1], 1)
        self.assertEqual(private['top_songs'][0]['seconds'], event['listened_seconds'])
        self.assertEqual(self.go(bob, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': True},
                                 headers={'X-CSRFToken': bob_token}).status_code, 200)
        self.assertEqual([row['id'] for row in self.go(alice, 'GET', stats).json['profiles']], ['sample-a'])
        self.assertTrue(self.go(bob, 'GET', wrapped).json['paused'])
        counter['counters'][0]['seconds'] = 120
        self.assertTrue(self.post(bob, bob_token, activity, json=counter).json['counters_accepted'])
        self.assertEqual(self.go(bob, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': False},
                                 headers={'X-CSRFToken': bob_token}).status_code, 200)
        self.assertEqual(self.post(bob, bob_token, '/api/listening/events', json={'events': [fixture.event()]}).json['added'], 0)
        self.assertEqual(self.post(bob, bob_token, activity, json=counter).status_code, 200)
        self.assertEqual(self.go(alice, 'GET', stats).json['total_seconds'], 60)
        self.assertEqual(self.go(bob, 'DELETE', '/api/listening/history', headers={'X-CSRFToken': bob_token}).status_code, 200)
        self.assertEqual(self.post(bob, bob_token, activity, json=counter).status_code, 200)
        self.assertEqual(self.go(alice, 'GET', stats).json['total_seconds'], 0)
        cleared = self.go(bob, 'GET', wrapped).json
        self.assertEqual((cleared['total_minutes'], cleared['songs_added']), (0, 1))
        read.assert_called_once_with('chart?limit=50', timeout=4, max_wait=1)
