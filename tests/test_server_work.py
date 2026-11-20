import unittest
import threading
import time
from unittest.mock import patch
from test_music_web import Base
from music_web.playlists import PlaylistStore
from music_web.playlist_preparation import _PlaylistOperation
from music_web import mobile_audio
from music_web.worker_activity import WorkerActivity


class WorkerActivityTests(unittest.TestCase):
    def test_slots_keep_identity_report_concurrency_and_release_on_failure(self):
        activity = WorkerActivity('test', 'Test', 2)
        ids = [row['id'] for row in activity.snapshot()]
        with activity.track('First'):
            with self.assertRaisesRegex(ValueError, 'failed'):
                with activity.track('Second'):
                    rows = activity.snapshot()
                    self.assertEqual([r['current_title'] for r in rows], ['First', 'Second'])
                    self.assertEqual([r['state'] for r in rows], ['working', 'working'])
                    raise ValueError('failed')
            self.assertEqual([r['state'] for r in activity.snapshot()], ['working', 'idle'])
        self.assertEqual([r['id'] for r in activity.snapshot()], ids)
        self.assertEqual([r['state'] for r in activity.snapshot(True, 'Playback')], ['paused', 'paused'])

class WorkerCapacityTests(Base):
    extra = {'BACKGROUND_WORKERS': 6}

    def test_acquisition_capacity_uses_the_configured_pool_limit(self):
        client, _ = self.signed_in()
        payload = self.go(client, 'GET', '/api/server/stats').json
        rows = payload['workers']
        self.assertEqual(len([r for r in rows if r['id'].startswith('acquisition-')]), 11)
        self.assertFalse(any(r['id'].startswith(('tagging-', 'song-analysis-', 'source-quality-', 'genre-')) for r in rows))
        self.assertFalse(payload['catalogue_workers']['metadata'])
        self.assertFalse(payload['catalogue_workers']['source_scan'])


class EnabledWorkerTests(Base):
    extra = dict(SOURCE_QUALITY_SCAN=True, SOURCE_AUTO_REPLACE=False, SONG_ANALYSIS_SCAN=True, METADATA_LOOKUP=True,
                 GENRE_LOOKUP=True, AUTO_PLAYLIST_DOWNLOADS=True)

    def setUp(self):
        # Inspect configured capacity without starting scans or external lookups.
        with patch('threading.Thread.start'):
            super().setUp()

    def test_enabled_slots_report_scans_and_tagger_then_return_to_idle(self):
        client, _ = self.signed_in()
        def slots():
            return {row['id']: row for row in self.go(client, 'GET', '/api/server/stats').json['workers']}
        initial = slots()
        settings = self.go(client, 'GET', '/api/server/stats').json['catalogue_workers']
        self.assertTrue(settings['source_scan'])
        self.assertTrue(settings['metadata'])
        self.assertTrue(settings['playlist_matching'])
        self.assertFalse(settings['source_auto_replace'])
        self.assertEqual(settings['automatic_attempts_per_hour'], self.state.catalogue_review.automatic_limit)
        self.assertEqual(len(initial), 24)
        self.assertTrue(all(initial[key]['state'] == 'idle' for key in
                            ('source-quality-0', 'song-analysis-0', 'tagging-0', 'genre-0', 'playlist-queue-0')))
        with self.state.source_quality.activity.track('Source song'), self.state.song_analysis.activity.track('Analysis song'):
            active = slots()
            self.assertEqual((active['source-quality-0']['state'], active['source-quality-0']['current_title']),
                             ('working', 'Source song'))
            self.assertEqual((active['song-analysis-0']['state'], active['song-analysis-0']['current_title']),
                             ('working', 'Analysis song'))
        review = self.state.catalogue_review
        review.observe(dict(id='abcdefghijk', title='Song', channel='Artist', duration=180), {}, 'a' * 64)
        def resolve(row):
            self.assertEqual((slots()['tagging-0']['state'], slots()['tagging-0']['current_title']), ('working', 'Song'))
            return dict(values={})
        review.process_one(lambda: True, resolve)
        self.assertEqual(slots()['tagging-0']['state'], 'idle')
        self.assertEqual(list(slots()), list(initial))
        self.state.resources.room('fixture', time.monotonic() + 30)
        paused = slots()
        self.assertEqual(paused['source-quality-0']['state'], 'paused')
        self.assertEqual(paused['song-analysis-0']['state'], 'paused')


class ServerWorkTests(Base):
    extra={'FAMILY_PROFILES':True}

    def test_worker_api_keeps_real_idle_slots_and_reports_encoder_occupancy(self):
        client=self.app.test_client();token=self.go(client,'GET','/api/connect').json['csrf_token']
        self.post(client,token,'/api/profile/select',json={'profile_id':'sample-a'})
        get=lambda:self.go(client,'GET','/api/server/stats').json
        first=get()
        self.assertEqual(first['playlist_backlog'],
                         {'backlog_pending': 0, 'backlog_backing_off': 0, 'backlog_running': 0})
        slots=first['workers']
        self.assertEqual(len([r for r in slots if r['id'].startswith('acquisition-')]),9)
        self.assertEqual(len([r for r in slots if r['id'].startswith('playlist-')]),6)
        self.assertEqual(len(slots),19)
        self.assertTrue(all(r['state']=='idle' and r['waiting_for'] for r in slots))
        self.assertEqual(first['records'],[])
        with mobile_audio.background_activity.track('Encoding song'):
            active=get()['workers']
            row=next(r for r in active if r['id']=='opus-background-0')
            self.assertEqual((row['state'],row['current_title']),('working','Encoding song'))
        self.assertEqual([r['id'] for r in get()['workers']],[r['id'] for r in slots])
        self.state.resources.room('fixture', time.monotonic() + 30)
        paused=get()['workers']
        self.assertEqual([r['state'] for r in paused if r['id'].startswith('playlist-')],['paused']*6)


    def test_playlist_operation_is_one_entry_with_requester_counts_and_file_action(self):
        client=self.app.test_client();token=self.go(client,'GET','/api/connect').json['csrf_token']
        token=self.post(client,token,'/api/profile/select',json={'profile_id':'sample-a'}).json['csrf_token']
        pid='p'*22;status=_PlaylistOperation._status('download',4)
        status.update(processed=1,title='Current song',message='Downloading',active_downloads=[dict(index=2,title='Current song',message='Purifying audio',download_bytes=20,download_total_bytes=40)])
        PlaylistStore(self.ws).save('sample-a',dict(id=pid,name='Requested playlist',revision=1,shared=True,tracks=[],preparation=status))
        coordinator=self.state.playlist_preparation;operation=coordinator._operation('sample-a',pid);operation.active=('sample-a',pid)
        self.state.jobs['file']=dict(owner='sample-a',title='Current song',state='running',phase='fetch',
                                    message='Downloading',playlist_id=pid,priority=20,created=time.time(),cancel=threading.Event())
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
        self.state.jobs['single']=dict(owner='sample-a',title='Single',state='queued',phase='fetch',
                                      message='Preparing song',current=True,priority=0,created=time.time(),
                                      queued_at=time.monotonic(),cancel=threading.Event())
        row=self.go(client,'GET','/api/server/stats').json['jobs'][0]
        self.assertEqual((row['owner'],row['kind'],row['title']),('sample-a','listening','Single'))

    def test_stage_counts_distinguish_queued_backing_off_and_running(self):
        client = self.app.test_client()
        token = self.go(client, 'GET', '/api/connect').json['csrf_token']
        self.post(client, token, '/api/profile/select', json={'profile_id': 'sample-a'})
        governor = self.state.resources
        self.state.jobs['waiting'] = dict(owner='sample-a', title='Waiting song', state='queued', priority=20,
                                          url=self.intake.WATCH + 'abcdefghijk', created=time.time(),
                                          queued_at=time.monotonic(), cancel=threading.Event())
        with patch.object(governor, 'wake'), patch.object(self.intake.YOUTUBE, 'until', time.monotonic() + 60):
            with governor.track('fetch'), governor.track('fetch', 'Transfer capacity'):
                response = self.go(client, 'GET', '/api/server/stats')
        self.assertEqual(response.status_code, 200, response.json)
        stages = {row['stage']: row for row in response.json['worker_stages']}
        self.assertEqual(stages['fetch'], dict(stage='fetch', queued=1, backing_off=1, running=1))
        self.state.jobs['waiting']['retry_at'] = time.time() + 60
        response = self.go(client, 'GET', '/api/server/stats')
        stages = {row['stage']: row for row in response.json['worker_stages']}
        self.assertEqual(stages['fetch'], dict(stage='fetch', queued=0, backing_off=1, running=0))

    def test_playlist_slot_only_reports_progress_for_current_download_phase(self):
        client = self.app.test_client()
        token = self.go(client, 'GET', '/api/connect').json['csrf_token']
        self.post(client, token, '/api/profile/select', json={'profile_id': 'sample-a'})
        pid = 'p' * 22
        status = _PlaylistOperation._status('download', 1)
        status.update(title='Song', message='Downloading', active_downloads=[dict(
            index=1, title='Song', message='Downloading', file_phase='downloading',
            download_bytes=20, download_total_bytes=40)])
        store = PlaylistStore(self.ws)
        store.save('sample-a', dict(id=pid, name='Playlist', revision=1, shared=True, tracks=[], preparation=status))
        operation = self.state.playlist_preparation._operation('sample-a', pid)
        operation.active = ('sample-a', pid)
        def slot():
            return next(row for row in self.go(client, 'GET', '/api/server/stats').json['workers']
                        if row['id'] == 'playlist-0')
        try:
            with self.state.playlist_preparation.activity.track('Song', owner='sample-a', playlist_id=pid):
                self.assertEqual(slot()['progress'], 50)
                status['active_downloads'][0].update(message='Purifying audio', file_phase='purifying', download_bytes=40)
                data = store.read('sample-a', pid)
                data['preparation'] = status
                store.save('sample-a', data)
                self.assertNotIn('progress', slot())
                self.assertEqual(slot()['phase'], 'Purifying audio')
        finally:
            operation.active = None

    def test_existing_playback_holds_background_admission_until_handback(self):
        client=self.app.test_client();token=self.go(client,'GET','/api/connect').json['csrf_token']
        token=self.post(client,token,'/api/profile/select',json={'profile_id':'sample-a'}).json['csrf_token']
        governor = self.state.resources
        clock = time.monotonic()
        governor.clock = lambda: clock
        self.presence_stub.stop()
        response=self.post(client,token,'/api/playback/activity',json=dict(device_id='a'*32,playing=True,counters=[]))
        self.assertEqual(response.status_code,200,response.json)
        self.assertTrue(self.go(client,'GET','/api/server/stats').json['catalogue_paused'])
        clock += 16
        self.assertFalse(self.go(client,'GET','/api/server/stats').json['catalogue_paused'])
