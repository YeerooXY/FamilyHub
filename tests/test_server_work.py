import unittest
from test_music_web import Base
from music_web.playlists import PlaylistStore
from music_web.playlist_preparation import _PlaylistOperation

class ServerWorkTests(Base):
    extra={'FAMILY_PROFILES':True}

    def test_playlist_operation_is_one_entry_with_requester_counts_and_file_action(self):
        client=self.app.test_client();token=self.go(client,'GET','/api/connect').json['csrf_token']
        token=self.post(client,token,'/api/profile/select',json={'profile_id':'sample-a'}).json['csrf_token']
        pid='p'*22;status=_PlaylistOperation._status('download',4)
        status.update(processed=1,title='Current song',message='Downloading',active_downloads=[dict(index=2,title='Current song',message='Purifying audio',download_bytes=20,download_total_bytes=40)])
        PlaylistStore(self.ws).save('sample-a',dict(id=pid,name='Requested playlist',revision=1,shared=True,tracks=[],preparation=status))
        coordinator=self.state.playlist_preparation;operation=coordinator._operation('sample-a',pid);operation.active=('sample-a',pid)
        self.state.jobs['file']=dict(owner='sample-a',title='Current song',state='running',phase='fetch',message='Downloading',playlist_id=pid)
        try:
            result=self.go(client,'GET','/api/server/stats')
            self.assertEqual(result.status_code,200,result.json);jobs=result.json['jobs'];self.assertEqual(len(jobs),1)
            row=jobs[0]
            self.assertEqual((row['owner'],row['title'],row['kind']),('sample-a','Requested playlist','playlist_download'))
            self.assertEqual((row['processed'],row['total'],row['remaining']),(1,4,3))
            self.assertEqual(row['current_title'],'Current song')
            self.assertEqual(row['files'][0]['message'],'Purifying audio')
            self.state.jobs['file']['current']=True
            jobs=self.go(client,'GET','/api/server/stats').json['jobs']
            self.assertEqual({j['kind'] for j in jobs},{'listening','playlist_download'})
        finally:operation.active=None

    def test_single_listening_request_has_requester_and_distinct_kind(self):
        client=self.app.test_client();token=self.go(client,'GET','/api/connect').json['csrf_token']
        self.post(client,token,'/api/profile/select',json={'profile_id':'sample-a'})
        self.state.jobs['single']=dict(owner='sample-a',title='Single',state='queued',phase='fetch',message='Preparing song',current=True)
        row=self.go(client,'GET','/api/server/stats').json['jobs'][0]
        self.assertEqual((row['owner'],row['kind'],row['title']),('sample-a','listening','Single'))

    def test_existing_playback_does_not_block_bulk_but_real_preparation_does(self):
        client=self.app.test_client();token=self.go(client,'GET','/api/connect').json['csrf_token']
        token=self.post(client,token,'/api/profile/select',json={'profile_id':'sample-a'}).json['csrf_token']
        response=self.post(client,token,'/api/playback/activity',json=dict(device_id='a'*32,playing=True,counters=[]))
        self.assertEqual(response.status_code,200,response.json)
        self.assertFalse(self.go(client,'GET','/api/server/stats').json['catalogue_paused'])
        coordinator=self.state.playlist_preparation
        self.assertTrue(coordinator.allow_background())
        self.state.jobs['urgent']=dict(owner='sample-a',title='Needed song',state='running',phase='fetch',message='Downloading',current=True)
        self.assertTrue(self.go(client,'GET','/api/server/stats').json['catalogue_paused'])
        self.assertFalse(coordinator.allow_background())
        self.state.jobs['urgent']['state']='done'
        self.assertTrue(coordinator.allow_background())
        self.assertFalse(self.go(client,'GET','/api/server/stats').json['catalogue_paused'])
        self.state.jobs['next']=dict(owner='sample-a',title='Next song',state='queued',phase='fetch',message='Preparing',priority=1)
        self.assertFalse(coordinator.allow_background())
        self.state.jobs['next']['search_preview']=True
        self.assertTrue(coordinator.allow_background())
