import test_family_profiles as family
from test_music_web import Base

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
