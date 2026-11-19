import json
import threading
import time
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock

from music_web import catalog_search, finished_audio
from music_web.http_dispatch import RequestDispatcher
from music_web.listening_stats import ListeningStats
from music_web.playlists import PlaylistError
from test_music_web import Base
import test_native_music_api as native


class PriorityRoutes(Base):
    extra = {'STATUS_SNAPSHOTS': True}

    def test_catalogue_transaction_does_not_block_connect_or_saved_playback(self):
        native.NativeMusicApi.recording(self)
        client, token = self.signed_in()
        track = dict(id=native.FIRST, title='First', channel='Artist')
        for device in ('a' * 32, 'b' * 32):
            self.post(client, token, '/api/playback/activity', json=dict(device_id=device, playing=False,
                track=track, device_info=dict(name=device, queue=dict(track_ids=[native.FIRST], index=0))))
        blocked, release = threading.Event(), threading.Event()
        def writer():
            with self.state.playlist_preparation.lock, self.app.extensions['listening_history'].lock:
                blocked.set()
                release.wait(3)
        thread = threading.Thread(target=writer)
        thread.start()
        try:
            self.assertTrue(blocked.wait(1))
            for path in ('/api/playback/devices', '/api/jobs', f'/api/library/{native.FIRST}/playback-info?stream=1'):
                start = time.monotonic()
                response = self.go(client, 'GET', path)
                self.assertLess(time.monotonic() - start, .3, path)
                self.assertEqual(response.status_code, 200, response.data)
            start = time.monotonic()
            result = self.post(client, token, '/api/playback/activity', json=dict(device_id='b' * 32, playing=False,
                device_info=dict(name='Phone'), counters=[]))
            self.assertLess(time.monotonic() - start, .3)
            self.assertFalse(result.json['counters_accepted'])
        finally:
            release.set()
            thread.join(3)
            # Drain the single statistics writer before removing the fixture directory.
            time.sleep(.1)

    def test_slow_durable_counter_write_does_not_delay_or_ack_connect(self):
        client, token = self.signed_in()
        entered, release, done = threading.Event(), threading.Event(), threading.Event()
        original = ListeningStats._append
        def append(store, *args):
            entered.set()
            release.wait(3)
            try:
                return original(store, *args)
            finally:
                done.set()
        data = dict(device_id='a' * 32, playing=True, device_info=dict(name='Phone'),
                    counters=[dict(day=datetime.now(timezone.utc).date().isoformat(), seconds=12, plays=1)])
        with mock.patch.object(ListeningStats, '_append', append):
            try:
                start = time.monotonic()
                result = self.post(client, token, '/api/playback/activity', json=data)
                self.assertLess(time.monotonic() - start, .3)
                self.assertTrue(entered.wait(1))
                self.assertFalse(result.json['counters_accepted'])
                self.assertEqual(len(self.go(client, 'GET', '/api/playback/devices').json['devices']), 1)
            finally:
                release.set()
                self.assertTrue(done.wait(2))
        time.sleep(.02)
        self.assertTrue(self.post(client, token, '/api/playback/activity', json=data).json['counters_accepted'])
        persisted = ListeningStats(self.ws)
        self.assertEqual(persisted.data['plays']['sample-a'], 1, 'A retried cumulative counter was counted twice')

    def test_empty_recommendation_is_retried_and_provider_error_is_distinct(self):
        client, token = self.signed_in()
        data = dict(query='VALMAR official audio', seed_artist='VALMAR')
        with mock.patch.object(self.intake, 'cmd_search', return_value={'results': []}) as search, \
                mock.patch('music_web.radio.seed', side_effect=PlaylistError('No match')):
            for _ in range(2):
                result = self.post(client, token, '/api/recommendations', json=data)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json['state'], 'empty')
            self.assertEqual(search.call_count, 2, 'An empty catalogue response was cached')
        with mock.patch.object(self.intake, 'cmd_search', side_effect=OSError('HTTP 503')), \
                mock.patch('music_web.radio.seed', side_effect=OSError('HTTP 429')):
            result = self.post(client, token, '/api/recommendations', json=data)
            self.assertEqual(result.status_code, 503)
            self.assertNotIn('HTTP', result.json['error'])
            self.assertIn('library', result.json['error'])

    def test_recommendations_use_library_when_search_fails(self):
        native.NativeMusicApi.recording(self, title='VALMAR - Another song')
        client, token = self.signed_in()
        with mock.patch.object(self.intake, 'cmd_search', side_effect=OSError('offline')), \
                mock.patch('music_web.radio.seed', side_effect=AssertionError('Library should be enough')):
            result = self.post(client, token, '/api/recommendations', json=dict(query='anything', seed_artist='VALMAR ft. Sofi'))
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json['results'][0]['id'], native.FIRST)

    def test_radio_provider_failure_uses_saved_library_without_starting_downloads(self):
        native.NativeMusicApi.recording(self, title='VALMAR - Another song')
        client, token = self.signed_in()
        with mock.patch('music_web.radio.seed', side_effect=OSError('offline')):
            result = self.post(client, token, '/api/radio', json=dict(
                artist='VALMAR ft. Nemazalany & Sofi', title='Almatlan estek (Official Music Video)'))
        self.assertEqual(result.status_code, 201, result.json)
        playlist = result.json['playlist']
        self.assertEqual(playlist['tracks'][0]['source_id'], native.FIRST)
        self.assertEqual(playlist['tracks'][0]['state'], 'saved')
        status = self.go(client, 'GET', '/api/playlists/' + playlist['id'] + '/prepare')
        self.assertEqual(status.json['state'], 'idle')
        self.assertEqual(self.state.jobs, {})


class LaneRouting(unittest.TestCase):
    def test_control_background_heartbeats_and_downloads_have_distinct_capacity(self):
        dispatcher = RequestDispatcher.__new__(RequestDispatcher)
        dispatcher.pools = {name: mock.Mock() for name in RequestDispatcher.LIMITS}
        for path, query, background, expected in (
            ('/api/playback/activity', '', True, 'control'),
            ('/api/playback/takeover', '', False, 'control'),
            ('/api/profile/playback', '', True, 'control'),
            ('/api/server/stats', '', True, 'snapshot'),
            ('/api/library/abcdefghijk/playback-info', '', True, 'download'),
            ('/api/library/abcdefghijk/playback-info', 'lead=120', False, 'download'),
            ('/api/library/abcdefghijk/playback-info', 'stream=1', False, 'listener'),
            ('/api/library/abcdefghijk/download', 'ticket=x', False, 'media'),
            ('/api/transition', '', False, 'listener'),
            ('/api/playlists/owner/playlist/artwork/cover.jpg', '', True, 'artwork'),
            ('/api/jobs/job', 'watch=1', True, 'watch')):
            channel = SimpleNamespace(requests=[SimpleNamespace(path=path, query=query, command='GET',
                headers={'X_FAMILYHUB_ACTIVITY': 'background' if background else 'foreground'})])
            dispatcher.add_task(channel)
            dispatcher.pools[expected].add_task.assert_called_once_with(channel)
            for pool in dispatcher.pools.values():
                pool.reset_mock()
        for path in ('/api/uploads', '/api/library/additions', '/api/playlists/playlist/prepare'):
            channel = SimpleNamespace(requests=[SimpleNamespace(path=path, query='', command='POST', headers={})])
            dispatcher.add_task(channel)
            dispatcher.pools['download'].add_task.assert_called_once_with(channel)
            dispatcher.pools['download'].reset_mock()

    def test_cached_finished_audio_bypasses_busy_bulk_render(self):
        store = finished_audio.FinishedAudio('unused', None)
        result = ({'sha256': 'a' * 64}, 'ready.flac')
        with finished_audio._encoding.turn(), mock.patch.object(store, 'select', return_value=result):
            self.assertEqual(store.prepare('source', 'a' * 64, background=lambda: True), result)

    def test_catalogue_errors_cannot_become_successful_empty_results(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'error': {'code': 4}}).encode()
        with mock.patch('music_web.catalog_search.urllib.request.build_opener') as opener:
            opener.return_value.open.return_value = response
            with self.assertRaises(ValueError):
                catalog_search._get('deezer', 'https://api.deezer.com/search')
