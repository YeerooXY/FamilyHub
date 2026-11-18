"""Profile playback checkpoints are bounded and scoped to the selected listener."""
import test_family_profiles as family
from test_music_web import Base

class PlaybackResume(Base):
    extra={'FAMILY_PROFILES':True}
    bootstrap=family.FamilyProfiles.bootstrap
    select=family.FamilyProfiles.select

    def test_checkpoint_survives_new_client_and_stays_in_profile(self):
        client,token=self.select()
        self.assertIsNone(self.go(client,'GET','/api/profile/playback').json['playback'])
        state={'track_ids':['abcdefghijk','lmnopqrstuv','abcdefghijk'],'index':2,'position':37.5}
        response=self.go(client,'PUT','/api/profile/playback',json={'profile_id':'sample-a','playback':state},headers={'X-CSRFToken':token})
        self.assertEqual(response.status_code,200)
        self.assertGreater(response.json['playback']['updated_at'],0)
        second,_=self.select()
        self.assertEqual(self.go(second,'GET','/api/profile/playback').json['playback']['index'],2)
        other,other_token=self.select('sample-b')
        self.assertIsNone(self.go(other,'GET','/api/profile/playback').json['playback'])
        self.assertEqual(self.go(other,'PUT','/api/profile/playback',json={'profile_id':'sample-a','playback':state},headers={'X-CSRFToken':other_token}).status_code,409)

    def test_validation_and_csrf(self):
        client,token=self.select();base={'track_ids':['abcdefghijk'],'index':0,'position':12}
        for change in [{'track_ids':[]},{'track_ids':['../anything']},{'index':True},{'index':1},{'position':float('nan')},{'position':-1},{'track_ids':['abcdefghijk']*1001}]:
            self.assertEqual(self.go(client,'PUT','/api/profile/playback',json={'profile_id':'sample-a','playback':{**base,**change}},headers={'X-CSRFToken':token}).status_code,400)
        self.assertEqual(self.go(client,'PUT','/api/profile/playback',json={'profile_id':'sample-a','playback':base}).status_code,400)

    def test_lightweight_checkpoint_retains_queue_and_rejects_stale_track(self):
        client, token = self.select()
        state = dict(track_ids=['abcdefghijk', 'lmnopqrstuv'], index=1, position=1)
        headers = {'X-CSRFToken': token}
        self.go(client, 'PUT', '/api/profile/playback', json=dict(profile_id='sample-a', playback=state), headers=headers)
        result = self.go(client, 'PATCH', '/api/profile/playback', json=dict(profile_id='sample-a', playback=dict(track_id='lmnopqrstuv', position=42.5)), headers=headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['playback']['track_ids'], state['track_ids'])
        self.assertEqual(result.json['playback']['position'], 42.5)
        advanced = self.go(client, 'PATCH', '/api/profile/playback', json=dict(profile_id='sample-a', playback=dict(track_id='abcdefghijk', index=0, position=3)), headers=headers)
        self.assertEqual(advanced.status_code, 200)
        self.assertEqual(advanced.json['playback']['index'], 0)
        for payload in [dict(track_id='lmnopqrstuv', position=2), dict(track_id='lmnopqrstuv', position=-1), dict(track_id='lmnopqrstuv', position=True)]:
            result = self.go(client, 'PATCH', '/api/profile/playback', json=dict(profile_id='sample-a', playback=payload), headers=headers)
            self.assertIn(result.status_code, (400, 409))
