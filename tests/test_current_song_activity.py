import test_family_profiles as family
from test_music_web import Base
from datetime import timedelta
from unittest import mock

class CurrentSongActivity(Base):
    extra = {'FAMILY_PROFILES': True}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def test_metadata_validation_and_legacy_client(self):
        client, token = self.select()
        data=dict(device_id='a'*32,playing=True,track=dict(id='abcdefghijk',title='Song',channel='Artist'))
        self.assertEqual(self.post(client,token,'/api/playback/activity',json=data).status_code,200)
        row=next(r for r in self.go(client,'GET','/api/server/stats').json['profiles'] if r['id']=='sample-a')
        self.assertEqual(row['current_track'],data['track'])
        for bad in ('song', {}, {**data['track'],'title':'x'*501}, {**data['track'],'channel':'line\nbreak'}):
            self.assertEqual(self.post(client,token,'/api/playback/activity',json={**data,'track':bad}).status_code,400)
        self.assertEqual(self.post(client,token,'/api/playback/activity',json=dict(device_id='a'*32,playing=False)).status_code,200)
        row=next(r for r in self.go(client,'GET','/api/server/stats').json['profiles'] if r['id']=='sample-a')
        self.assertIsNone(row['current_track'])

    def test_oversized_queue_leaves_counters_and_presence_unchanged(self):
        client, token = self.select()
        activity = '/api/playback/activity'
        day = self.app.extensions['listening_history'].utc().date().isoformat()
        data = dict(device_id='a' * 32, playing=True, counters=[dict(day=day, seconds=60, plays=1)])
        oversized = dict(track_ids=['abcdefghijk'] * 1001, index=0)
        for fields in (dict(queue=oversized), dict(device_info=dict(queue=oversized))):
            response = self.post(client, token, activity, json={**data, **fields})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['error'], 'Invalid playback queue.')
        stats = self.go(client, 'GET', '/api/server/stats').json
        self.assertEqual(stats['total_seconds'], 0)
        self.assertFalse(stats['profiles'][0]['online'])

    def test_clear_marker_is_read_once_per_version(self):
        client, token = self.select()
        history = self.app.extensions['listening_history']
        now = history.utc()
        user = 'sample-a'
        with mock.patch.object(history, 'utc', return_value=now - timedelta(days=1)):
            history.clear(user)
        entry = dict(day=now.date().isoformat(), seconds=60, plays=1)
        data = dict(device_id='a' * 32, playing=True, counters=[entry])
        with mock.patch.object(history, 'cleared_at', wraps=history.cleared_at) as read:
            for _ in range(2):
                self.assertEqual(self.post(client, token, '/api/playback/activity', json=data).status_code, 200)
            read.assert_called_once_with(user)
            history.clear(user)
            entry['seconds'] = 120
            self.assertEqual(self.post(client, token, '/api/playback/activity', json=data).status_code, 200)
            self.assertEqual(read.call_count, 2)
        self.assertEqual(self.go(client, 'GET', '/api/server/stats').json['total_seconds'], 60)
