"""Real Waitress transport under phone playlist load; no external services.

Run with PYTHONPATH=tests. FAMILYHUB_PRIORITY_REPORT_ONLY=1 records a baseline
without enforcing the latency target. The encoder delay is deterministic, not
a claim about hardware FFmpeg throughput.
"""
import concurrent.futures
import http.client
import json
import logging
import os
import threading
import time
from pathlib import Path
from unittest import mock

from waitress import create_server
from music_web import mobile_audio
from music_web.http_dispatch import RequestDispatcher
from music_web.playlists import PlaylistStore
from test_music_web import Base
import test_native_music_api as native


class ServerPriority(Base):
    extra = {'STATUS_SNAPSHOTS': True}

    def test_phone_playlist_load_keeps_connect_and_snapshots_responsive(self):
        ids = [f'{i:011d}' for i in range(48)]
        for identifier in ids:
            native.NativeMusicApi.recording(self, source_id=identifier)
        PlaylistStore(self.ws).save('sample-a', dict(id='p' * 22, name='Phone load', revision=1,
            tracks=[dict(source_id=i, state='saved', title=i, artist='Artist', duration=.02) for i in ids]))
        client, csrf = self.signed_in()
        cookie = client.get_cookie('familyhub_music', domain='music.test').value
        dispatcher = RequestDispatcher()
        server = create_server(self.app, host='127.0.0.1', port=0, _dispatcher=dispatcher)
        threading.Thread(target=server.run, daemon=True).start()
        self.addCleanup(dispatcher.shutdown, timeout=1)
        self.addCleanup(server.close)
        logging.getLogger('waitress.queue').setLevel(logging.ERROR)

        def call(path, data=None, background=False, audio=False):
            connection = http.client.HTTPConnection('127.0.0.1', server.effective_port, timeout=15)
            try:
                headers = {'Host': 'music.test', 'Cookie': 'familyhub_music=' + cookie,
                           'Origin': 'https://music.test', 'X-CSRFToken': csrf,
                           'Content-Type': 'application/json',
                           'X-FamilyHub-Activity': 'background' if background else 'foreground'}
                connection.request('POST' if data is not None else 'GET', path,
                                   json.dumps(data) if data is not None else None, headers)
                response = connection.getresponse()
                payload = response.read()
                return response.status, payload if audio else json.loads(payload)
            finally:
                connection.close()

        def heartbeat(device, playing=False):
            return call('/api/playback/activity', dict(device_id=device, playing=playing,
                track=dict(id=ids[0], title='First', channel='Artist'), position=0,
                device_info=dict(name=device[0], kind='android', queue=dict(track_ids=ids, index=0))), True)

        self.assertEqual(heartbeat('a' * 32, True)[0], 200)
        self.assertEqual(heartbeat('b' * 32)[0], 200)
        call('/api/server/stats')  # prime the bounded snapshot
        stop = threading.Event()
        entered = threading.Event()
        counts = {'ok': 0, 'busy': 0}

        def encode(intake, source, path, kbps):
            entered.set()
            time.sleep(.35)
            # A larger copy makes mobile_record deliver the intact fixture source.
            Path(path).write_bytes(b'fixture' * 100)

        original_hash = self.intake.sha256_file

        def cold_hash(path):
            # Cold library verification on a contended disk (three reads per song).
            time.sleep(.08)
            return original_hash(path)

        def download(worker):
            number = worker
            while not stop.is_set():
                status, track = call('/api/library/' + ids[number % len(ids)] + '/playback-info', background=True)
                if status == 200:
                    status, content = call(track['download_url'], background=True, audio=True)
                    if status != 200 or not content:
                        raise AssertionError(('audio download', status))
                    counts['ok'] += 1
                elif status == 503:
                    counts['busy'] += 1
                else:
                    raise AssertionError(status)
                number += 12
                time.sleep(.01)

        timings = {key: [] for key in ('devices', 'handoff', 'heartbeat', 'handoff_ready', 'snapshot')}
        with mock.patch.object(mobile_audio, '_encode', side_effect=encode), \
                mock.patch.object(self.intake, 'sha256_file', side_effect=cold_hash), \
                concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            futures = [pool.submit(download, worker) for worker in range(12)]
            try:
                self.assertTrue(entered.wait(5))
                source, target = 'a' * 32, 'b' * 32
                for _ in range(30):
                    for label, operation in (
                        ('devices', lambda: call('/api/playback/devices')),
                        ('handoff', lambda: call('/api/playback/transfer', dict(
                            **{'from': source, 'to': target}, playing=True,
                            resume=dict(track_ids=ids, index=0, position=0)))),
                        ('heartbeat', lambda: heartbeat(target, True)),
                        ('snapshot', lambda: call('/api/server/stats'))):
                        start = time.perf_counter()
                        status, result = operation()
                        timings[label].append((time.perf_counter() - start) * 1000)
                        self.assertIn(status, (200, 202), (label, result))
                        if label == 'handoff':
                            handoff_id = result['id']
                    start = time.perf_counter()
                    self.assertEqual(heartbeat(target, True)[0], 200)
                    self.assertEqual(call('/api/playback/handoff/' + handoff_id)[1]['state'], 'ready')
                    timings['handoff_ready'].append((time.perf_counter() - start) * 1000)
                    self.assertEqual(heartbeat(source, False)[0], 200)
                    source, target = target, source
                    time.sleep(.01)
            finally:
                stop.set()
                for future in futures:
                    future.result(15)
        p95 = {label: round(sorted(values)[int(len(values) * .95)], 1) for label, values in timings.items()}
        print('PRIORITY_LOAD ' + json.dumps(dict(samples=30, songs=48, clients=12, p95_ms=p95, downloads=counts)), flush=True)
        self.assertGreater(counts['ok'], 0)
        if not os.environ.get('FAMILYHUB_PRIORITY_REPORT_ONLY'):
            for label, value in p95.items():
                self.assertLess(value, 300, label)
