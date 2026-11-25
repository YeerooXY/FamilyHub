"""Listener admission must survive occupied background lanes."""
import threading
import time
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

from tests.test_music_web import Base, URL
from flask import g
from music_web import ApiError
from music_web.resources import ResourceGovernor, TransferResources


class ListenerAdmissionTests(Base):
    def test_repeated_play_reuses_job_and_original_is_offered_during_purification(self):
        from tests.test_native_music_api import NativeMusicApi

        client, token = self.signed_in()
        other, _ = self.signed_in('sample-b')
        downloading, source_ready = threading.Event(), threading.Event()
        purifying, finish = threading.Event(), threading.Event()
        action = 'c' * 32
        recording = {}

        def fetch(_args):
            downloading.set()
            if not source_ready.wait(5):
                raise RuntimeError('test did not release the fetch')
            item, _, manifest, audio = NativeMusicApi.recording(self)
            recording.update(manifest=manifest, audio=audio)
            return {'item': str(item), 'manifest': manifest}

        def purify(*_args, **_kwargs):
            purifying.set()
            if not finish.wait(5):
                raise RuntimeError('test did not release purification')

        with (mock.patch.object(self.intake, 'cmd_fetch', side_effect=fetch) as acquire,
              mock.patch.object(self.intake, 'cmd_preview', side_effect=self.intake.IntakeError('fixture has no preview')),
              mock.patch('music_web.prepare_record', side_effect=purify),
              self.assertLogs('music_web.playback', 'INFO') as logs):
            data = {'url': URL, 'play_action': action}
            job_id = self.post(client, token, '/api/jobs', json=data).json['job']['id']
            path = f'/api/jobs/{job_id}'
            try:
                self.assertTrue(downloading.wait(3))
                duplicate = self.post(client, token, '/api/jobs', json=data)
                self.assertEqual(duplicate.json['job']['id'], job_id)
                acquire.assert_called_once()
                for asset in ('source', 'index.m3u8', 'init.mp4', 'seg00000.m4s'):
                    url = f'{path}/media/{asset}'
                    response = self.go(client, 'HEAD', url)
                    self.assertEqual((response.status_code, response.headers['Retry-After']), (503, '0'))
                    self.assertEqual(self.go(other, 'HEAD', url).status_code, 404)
                source_ready.set()
                self.assertTrue(purifying.wait(3))
                job = self.go(client, 'GET', path).json['job']
                self.assertEqual((job['state'], job['phase']), ('running', 'prepare'))
                self.assertNotIn('stream_url', job)
                stream = job['fallback_stream_url']
                with self.go(self.app.test_client(), 'GET', stream, headers={'Range': 'bytes=0-15'}) as response:
                    self.assertEqual((response.status_code, response.data), (206, recording['audio'][:16]))
                self.assertEqual(self.go(client, 'GET', path).json['job']['id'], job_id)
                finish.set()
                self.assertEqual(self.wait(client, job_id)['state'], 'done')
            finally:
                source_ready.set()
                finish.set()
        lines = '\n'.join(logs.output)
        for stage in ('job_accepted', 'source_stream_offered', 'purification_started', 'purification_finished'):
            self.assertIn(f'stage={stage} ', lines)
        self.assertEqual(lines.count('stage=source_stream_offered '), 1)
        self.assertNotIn('sample-a', lines)
        self.assertNotIn(URL, lines)
        self.assertNotIn(recording['manifest']['import']['title'], lines)

    def test_windows_preview_waits_for_two_segments_or_endlist(self):
        client, token = self.signed_in()
        publications = []
        published = threading.Event()
        release = threading.Event()

        def fetch(args):
            root = Path(args.preview)
            root.mkdir()
            for asset in ("init.mp4", "seg00000.m4s", "seg00001.m4s"):
                (root / asset).write_bytes(b"media")
            playlist = root / "index.m3u8"
            for extra in publications:
                playlist.write_text("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1,\nseg00000.m4s\n" + extra,
                                    encoding="utf-8")
                args.notify()
                published.set()
                if not release.wait(3):
                    raise RuntimeError("publication check did not finish")
                release.clear()
            return {"item": "fixture"}

        cases = (("#EXTINF:1,\nseg00001.m4s\n", False), ("#EXT-X-ENDLIST\n", True))
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), mock.patch.object(self.intake, "cmd_import"):
            for index, (ready_manifest, single_segment) in enumerate(cases):
                with self.subTest(single_segment=single_segment):
                    action = str(index + 1) * 32
                    publications[:] = ["", ready_manifest, ready_manifest]
                    url = self.intake.WATCH + f'{index:011x}'
                    response = self.post(client, token, "/api/jobs", json={"url": url, "play_action": action})
                    path = "/api/jobs/" + response.json["job"]["id"]
                    try:
                        for ready in (False, True, True):
                            self.assertTrue(published.wait(3))
                            published.clear()
                            job = self.go(client, "GET", path).json["job"]
                            self.assertIn("stream_url", job)
                            self.assertIs(job["windows_preview_ready"], ready)
                            release.set()
                        self.wait(client, response.json["job"]["id"])
                    finally:
                        release.set()
                    rows = self.go(client, "GET", "/api/playback/diagnostics").json["actions"]
                    stages = [event["stage"] for row in rows if row["action"] == action for event in row["events"]]
                    self.assertEqual(stages.count("windows_preview_ready"), 1)

    def test_playback_diagnostics_correlate_stages_and_exclude_track_data(self):
        client, token = self.signed_in()
        other, _ = self.signed_in('sample-b')
        endpoint = '/api/playback/diagnostics'
        action = 'a' * 32
        self.assertEqual(self.post(client, token, endpoint, json={
            'action': action, 'stage': 'play', 'elapsed_ms': 0, 'url': URL}).status_code, 200)
        with mock.patch('threading.Thread.start'):
            response = self.post(client, token, '/api/jobs', json={'url': URL, 'play_action': action})
        self.state.worker = None
        self.assertEqual(response.status_code, 202)
        for stage, elapsed in [('ready', 101), ('playing', 180), ('position_advanced', 300), ('position_advanced', 400)]:
            self.assertEqual(self.post(client, token, endpoint, json={
                'action': action, 'stage': stage, 'elapsed_ms': elapsed}).status_code, 200)
        rows = self.go(client, 'GET', endpoint).json['actions']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['action'], action)
        events = {event['stage']: event for event in rows[0]['events']}
        self.assertIn('server_ms', events['job_accepted'])
        self.assertEqual(events['client_ready']['client_ms'], 101)
        self.assertEqual(events['client_playing']['client_ms'], 180)
        self.assertEqual(events['client_position_advanced']['client_ms'], 300)
        self.assertNotIn(URL, str(rows))
        self.assertNotIn('sample-a', str(rows))
        self.assertEqual(self.go(other, 'GET', endpoint).json['actions'], [])
        self.assertEqual(self.post(client, token, endpoint, json={
            'action': action, 'stage': URL, 'elapsed_ms': 0}).status_code, 400)
        self.assertEqual(self.post(client, token, endpoint, json={
            'action': action, 'stage': 'play', 'elapsed_ms': -1}).status_code, 400)
        self.assertEqual(self.go(client, 'POST', endpoint, json={
            'action': action, 'stage': 'play', 'elapsed_ms': 0}).status_code, 400)
        for n in range(40):
            self.assertEqual(self.post(client, token, endpoint, json={
                'action': f'{n:032x}', 'stage': 'play', 'elapsed_ms': 0}).status_code, 200)
        self.assertEqual(len(self.go(client, 'GET', endpoint).json['actions']), 32)

    def test_native_playback_observations_keep_recent_positions_and_known_reasons(self):
        client, token = self.signed_in()
        other, _ = self.signed_in('sample-b')
        endpoint = '/api/playback/diagnostics'
        action = 'a' * 32

        def report(stage, elapsed=0, **fields):
            return self.post(client, token, endpoint, json={
                'action': action, 'stage': stage, 'elapsed_ms': elapsed, **fields})

        self.assertEqual(report('play').status_code, 200)
        for elapsed in range(33):
            self.assertEqual(report('native_buffering', elapsed, position_ms=49000 + elapsed).status_code, 200)
        self.assertEqual(report('native_error', 50, position_ms=49050, reason='ERROR_CODE_TIMEOUT').status_code, 200)
        self.assertEqual(report('native_error', 51, position_ms=49051, reason=URL).status_code, 200)
        self.assertEqual(report('native_buffering', position_ms=True).status_code, 400)
        self.assertEqual(report('native_buffering', position_ms=-1).status_code, 400)
        self.assertEqual(report('native_buffering', position_ms=86400001).status_code, 400)

        events = self.go(client, 'GET', endpoint).json['actions'][0]['events']
        self.assertEqual(len(events), 33)
        self.assertEqual(events[0], {'stage': 'client_play', 'client_ms': 0})
        self.assertEqual(events[1], {'stage': 'client_native_buffering', 'client_ms': 3, 'position_ms': 49003})
        self.assertEqual(events[-2], {'stage': 'client_native_error', 'client_ms': 50, 'position_ms': 49050,
                                      'reason': 'ERROR_CODE_TIMEOUT'})
        self.assertEqual(events[-1], {'stage': 'client_native_error', 'client_ms': 51, 'position_ms': 49051})
        for stage in ('resume_seek', 'resume_failed', 'resume_applied', 'screen_off', 'screen_on',
                      'next_warmup_start', 'next_warmup_finish', 'next_warmup_failed'):
            self.assertEqual(report(stage, 750, position_ms=50400).status_code, 200)
            latest = self.go(client, 'GET', endpoint).json['actions'][0]['events'][-1]
            self.assertEqual(latest, {'stage': 'client_' + stage, 'client_ms': 750, 'position_ms': 50400})
        self.assertEqual(self.go(other, 'GET', endpoint).json['actions'], [])

    def test_background_download_promotes_a_completed_preview_to_an_import(self):
        client, token = self.signed_in()
        with mock.patch('threading.Thread.start'):
            response = self.post(client, token, '/api/queue', json={'tracks': [{'url': URL}], 'allow_new': True})
            self.assertEqual(response.status_code, 200)
            job = next(iter(self.state.jobs.values()))
            job.update(state='done', message='Prepared', item='fixture')
            response = self.post(client, token, '/api/jobs', json={'url': URL, 'prefetch': True})
        self.state.worker = None
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json['job']['id'], job['id'])
        self.assertEqual(job['state'], 'queued')
        self.assertTrue(job['save'])

    def test_listener_starts_ahead_of_24_queued_downloads_without_cancelling_them(self):
        client, token = self.signed_in()
        background = []
        with mock.patch('threading.Thread.start'):
            for index in range(24):
                response = self.post(client, token, '/api/jobs', json={
                    'url': self.intake.WATCH + f'{index:011d}', 'prefetch': True})
                self.assertEqual(response.status_code, 202)
                background.append(self.state.jobs[response.json['job']['id']])
        self.state.worker = None
        entered = threading.Event()
        release = threading.Event()
        def fetch(args):
            if args.url == URL:
                entered.set()
            release.wait(3)
            return {'item': 'fixture'}
        with mock.patch.object(self.intake, 'cmd_fetch', side_effect=fetch), mock.patch.object(self.intake, 'cmd_preview', return_value={'assets': []}), mock.patch.object(self.intake, 'cmd_import'):
            try:
                response = self.post(client, token, '/api/jobs', json={'url': URL})
                self.assertEqual(response.status_code, 202)
                self.assertTrue(entered.wait(.7), 'listener waited behind queued downloads')
                self.assertTrue(all(not job['cancel'].is_set() for job in background))
            finally:
                release.set()
                self.stop_worker()

    def test_native_prefetch_does_not_replace_or_cancel_explicit_play(self):
        client, token = self.signed_in()
        with mock.patch('threading.Thread.start'):
            first = self.post(client, token, '/api/jobs', json={'url': URL}).json['job']
            next_song = self.post(client, token, '/api/jobs', json={
                'url': self.intake.WATCH + 'abcdefghijk', 'prefetch': True},
                headers={'X-FamilyHub-Activity': 'background'}).json['job']
        self.state.worker = None
        playing = self.state.jobs[first['id']]
        upcoming = self.state.jobs[next_song['id']]
        self.assertFalse(playing['cancel'].is_set())
        self.assertTrue(playing['current'])
        self.assertFalse(upcoming['current'])
        self.assertGreater(upcoming['priority'], playing['priority'])

    def test_listener_metadata_does_not_wait_for_background_lookup(self):
        gate = self.intake.YOUTUBE
        gate.spacing = 0
        entered = threading.Event()
        def listen():
            with gate.request('fetch'):
                entered.set()
        with gate.request('matching', background=True):
            thread = threading.Thread(target=listen)
            thread.start()
            ready = entered.wait(.4)
        thread.join(2)
        self.assertTrue(ready, 'listener metadata waited behind a background provider request')

    def test_listener_transfer_starts_with_every_idle_transfer_occupied(self):
        governor = ResourceGovernor()
        transfers = TransferResources(4, lambda: 1 << 30, governor)
        entered = threading.Event()
        def listen():
            with transfers.lease(background=lambda: False, cancelled=lambda: False, error=ValueError):
                entered.set()
        with ExitStack() as occupied:
            for _ in range(transfers.idle_capacity):
                occupied.enter_context(transfers.lease(background=lambda: True, cancelled=lambda: False, error=ValueError))
            thread = threading.Thread(target=listen)
            thread.start()
            ready = entered.wait(.4)
        thread.join(2)
        self.assertTrue(ready, 'idle transfers consumed the listener reservation')

    def test_scratch_headroom_is_kept_for_a_listener(self):
        transfers = TransferResources(4, lambda: 10, listener_scratch=4)
        with ExitStack() as occupied:
            for _ in range(3):
                occupied.enter_context(transfers.lease(size=2, background=lambda: True, cancelled=lambda: False, error=ValueError))
            with transfers.lease(size=4, background=lambda: False, cancelled=lambda: False, error=ValueError):
                self.assertEqual(transfers.reserved, 10)

    def test_saved_stream_does_not_wait_for_an_optional_encode(self):
        from tests.test_native_music_api import NativeMusicApi, FIRST
        NativeMusicApi.recording(self)
        client, _ = self.signed_in()
        with mock.patch('music_web.mobile_audio.prepare', side_effect=AssertionError('listener waited for an encode')):
            response = self.go(client, 'GET', f'/api/library/{FIRST}/playback-info?quality=normal&stream=1')
        self.assertEqual(response.status_code, 200)
        self.assertIn('ticket=', response.json['stream_url'])
        self.assertEqual(response.json['download_url'], f'/api/library/{FIRST}/download')

    def test_review_read_does_not_flush_worker_state_to_disk(self):
        client, _ = self.signed_in()
        review = self.state.catalogue_review
        with mock.patch.object(review, 'flush', side_effect=AssertionError('request performed disk write')):
            response = self.go(client, 'GET', '/api/catalogue/review')
        self.assertEqual(response.status_code, 200)


class ServerSnapshotTests(Base):
    extra = {'STATUS_SNAPSHOTS': True, 'ADMIN_USERS': ['sample-a']}

    def test_reports_writes_are_not_cached_or_run_in_a_snapshot_worker(self):
        from tests.test_native_music_api import NativeMusicApi, FIRST
        NativeMusicApi.recording(self)
        client, token = self.signed_in()
        with mock.patch.object(self.state.catalogue_review, 'report_song', return_value={}) as report:
            for reason in ('bad_quality', 'wrong_source'):
                response = self.post(client, token, '/api/catalogue/reports', json={'id': FIRST, 'reason': reason})
                self.assertEqual(response.status_code, 201)
        self.assertEqual(report.call_count, 2)

    def test_cold_review_times_out_then_retry_recovers_and_warm_snapshot_survives_lock(self):
        client, _ = self.signed_in()
        review = self.state.catalogue_review
        with review.lock:
            start = time.monotonic()
            response = self.go(client, 'GET', '/api/catalogue/review')
            self.assertLess(time.monotonic() - start, .7)
            self.assertEqual(response.status_code, 503)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            response = self.go(client, 'GET', '/api/catalogue/review')
            if response.status_code == 200:
                break
            time.sleep(.01)
        self.assertEqual(response.status_code, 200)
        time.sleep(1.05)
        with review.lock:
            start = time.monotonic()
            response = self.go(client, 'GET', '/api/catalogue/review')
            self.assertEqual(response.status_code, 200)
            self.assertLess(time.monotonic() - start, .2)

    def test_snapshot_does_not_share_admin_permissions_between_profiles(self):
        first, _ = self.signed_in()
        second, _ = self.signed_in('sample-b')
        with mock.patch.object(self.state.catalogue_review, 'snapshot', return_value={'metadata': [], 'trimming': []}):
            a = self.go(first, 'GET', '/api/catalogue/review')
            b = self.go(second, 'GET', '/api/catalogue/review')
        self.assertEqual((a.status_code, b.status_code), (200, 200))
        self.assertTrue(a.json['can_edit'])
        self.assertFalse(b.json['can_edit'])
        self.assertNotIn('Set-Cookie', b.headers)

    def test_leaderboard_keeps_snapshot_through_delayed_refresh_failure(self):
        first, _ = self.signed_in()
        second, _ = self.signed_in('sample-b')
        path = '/api/activity/stats'
        refreshing, release = threading.Event(), threading.Event()
        workers = []
        responses = iter([10, 503, 20, 403])

        def stats(*args, **kwargs):
            if g.user == 'sample-b':
                raise ApiError('Try again.', 503)
            total = next(responses)
            if total == 503:
                refreshing.set()
                if not release.wait(5):
                    raise RuntimeError('test did not release the refresh')
            if total in (503, 403):
                raise ApiError('Snapshot unavailable.', total)
            return {'total_seconds': total}

        def record_worker(**kwargs):
            worker = threading.Thread(**kwargs)
            workers.append(worker)
            return worker

        def join_refresh():
            workers[-1].join(2)
            self.assertFalse(workers[-1].is_alive())

        with (mock.patch('music_web.snapshots.time') as clock,
              mock.patch('music_web.snapshots.threading', wraps=threading) as threads,
              mock.patch('music_web.ListeningStats.snapshot', side_effect=stats) as read):
            threads.Thread.side_effect = record_worker
            clock.monotonic.return_value = 100
            self.assertEqual(self.go(first, 'GET', path).json, {'total_seconds': 10, 'snapshot_age_seconds': 0})
            join_refresh()
            clock.monotonic.return_value = 102
            try:
                self.assertEqual(self.go(first, 'GET', path).json, {'total_seconds': 10, 'snapshot_age_seconds': 2})
                self.assertTrue(refreshing.wait(2))
                self.assertEqual(self.go(first, 'GET', path).json['total_seconds'], 10)
                self.assertEqual(self.go(self.app.test_client(), 'GET', path).status_code, 401)
                # The other refresh may wait for the catalogue lock held by the first.
                self.assertEqual(self.go(second, 'GET', path).status_code, 503)
            finally:
                release.set()
                for worker in workers:
                    worker.join(2)
                    self.assertFalse(worker.is_alive())

            clock.monotonic.return_value = 102.5
            self.assertEqual(self.go(first, 'GET', path).json, {'total_seconds': 10, 'snapshot_age_seconds': 2})
            self.assertEqual(self.go(second, 'GET', path).status_code, 503)
            self.assertEqual(read.call_count, 3)
            clock.monotonic.return_value = 105
            self.assertEqual(self.go(first, 'GET', path).json['snapshot_age_seconds'], 5)
            join_refresh()
            self.assertEqual(self.go(first, 'GET', path).json, {'total_seconds': 20, 'snapshot_age_seconds': 0})
            self.assertEqual(self.go(second, 'GET', path).status_code, 503)
            join_refresh()
            clock.monotonic.return_value = 106
            self.assertEqual(self.go(first, 'GET', path).status_code, 200)
            join_refresh()
            self.assertEqual(self.go(first, 'GET', path).status_code, 403)
