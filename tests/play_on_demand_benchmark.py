"""Offline loopback reproduction; real HTTP and FFmpeg, paced local media instead of YouTube."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from unittest import mock

from waitress import create_server
from tests.test_music_web import Base, URL
from music_web.resources import TransferResources


def main():
    fixture = Base()
    fixture.setUp()
    client, token = fixture.signed_in()
    cookie = client.get_cookie('familyhub_music', domain='music.test').value
    options = {}
    try:
        from music_web.http_dispatch import RequestDispatcher
        options['_dispatcher'] = RequestDispatcher()
    except ImportError:
        pass
    server = create_server(fixture.app, host='127.0.0.1', port=0, threads=12, **options)
    serving = threading.Thread(target=server.run, daemon=True)
    serving.start()
    def request(method, path, data=None):
        connection = http.client.HTTPConnection('127.0.0.1', server.effective_port, timeout=15)
        connection.request(method, path, json.dumps(data) if data is not None else None,
                           {'Host': 'music.test', 'Origin': 'https://music.test',
                            'Cookie': 'familyhub_music=' + cookie, 'X-CSRFToken': token,
                            'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        if response.status >= 400:
            raise RuntimeError((path, response.status, body[:200]))
        return body

    source = Path(fixture.ws) / 'fixture.webm'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=40',
                    '-c:a', 'libopus', str(source)], check=True)
    intake = fixture.intake
    release = threading.Event()
    occupied = threading.Event()
    stages = {}
    original_pump = intake.pump_preview
    transfers = TransferResources(4, lambda: 1 << 40, fixture.state.resources)
    def backlog():
        from contextlib import ExitStack
        with ExitStack() as stack:
            for _ in range(transfers.idle_capacity):
                stack.enter_context(transfers.lease(background=lambda: True, cancelled=lambda: False, error=ValueError))
            stack.enter_context(intake.YOUTUBE.request('matching', background=True))
            occupied.set()
            release.wait(10)
    busy = threading.Thread(target=backlog)
    busy.start()
    occupied.wait(3)
    def pump(command, *args, **kwargs):
        return original_pump([sys.executable, '-c',
            'import sys,time; d=open(sys.argv[1],"rb").read(); sys.stdout.buffer.write(d[:len(d)//2]); sys.stdout.buffer.flush(); time.sleep(2); sys.stdout.buffer.write(d[len(d)//2:])',
            str(source)], *args, **kwargs)
    def fetch(args):
        stages['dispatch'] = time.perf_counter()
        with intake.YOUTUBE.request('fetch'):
            stages['metadata'] = time.perf_counter()
        with transfers.lease(background=lambda: False, cancelled=args.cancel.is_set, error=ValueError):
            stages['transfer'] = time.perf_counter()
            return intake.progressive_fetch(args, {'id': 'dQw4w9WgXcQ', 'format_id': '251', 'duration': 40},
                {'kind': 'youtube', 'id': 'dQw4w9WgXcQ', 'url': URL, 'lossy': True})
    timer = threading.Timer(3, release.set)
    try:
        with mock.patch.object(intake, 'cmd_fetch', side_effect=fetch), mock.patch.object(intake, 'pump_preview', side_effect=pump), mock.patch.object(intake, 'tool', side_effect=lambda name: sys.executable if name == 'yt-dlp' else name), mock.patch.object(intake, 'cmd_import'):
            action = 'a' * 32
            start = time.perf_counter()
            timer.start()
            job = json.loads(request('POST', '/api/jobs', {'url': URL, 'play_action': action}))['job']
            submitted = time.perf_counter()
            while 'media_url' not in job:
                time.sleep(.02)
                job = json.loads(request('GET', '/api/jobs/' + job['id']))['job']
                if time.perf_counter() - start > 12:
                    raise RuntimeError(job)
            base = job['media_url'].rsplit('/', 1)[0]
            audio = request('GET', base + '/init.mp4') + request('GET', base + '/seg00000.m4s')
            first_segment = time.perf_counter()
            decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-'], input=audio, capture_output=True, check=True)
            decoded_at = time.perf_counter()
            assert len(decoded.stdout) > 1000
            events = json.loads(request('GET', '/api/playback/diagnostics'))['actions'][0]['events']
            assert {'job_accepted', 'worker_started', 'preview_ready', 'preview_segment_response_ready'} <= {row['stage'] for row in events}
            print(json.dumps(dict(post_ms=round((submitted-start)*1000), first_segment_ms=round((first_segment-start)*1000),
                                  decoded_audio_ms=round((decoded_at-start)*1000),
                                  segment_before_backlog_release=first_segment < start + 3, server_events=events,
                                  **{k+'_ms': round((v-start)*1000) for k,v in stages.items()})), flush=True)
            release.set()
            fixture.wait(client, job['id'])
    finally:
        release.set()
        timer.cancel()
        busy.join(5)
        fixture.doCleanups()
        server.close()
        server.task_dispatcher.shutdown()


if __name__ == '__main__':
    main()
