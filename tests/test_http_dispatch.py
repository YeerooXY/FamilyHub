"""Exercise the production HTTP dispatcher with occupied long-lived watches."""
import http.client
import json
import threading
import time
import unittest
from unittest import mock

from waitress import create_server
from music_web.http_dispatch import RequestDispatcher, ThreadedTaskDispatcher
from tests.test_music_web import Base, URL


class QueueWarningsTests(unittest.TestCase):
    def test_thread_override_queue_detection_and_shared_warning_limit(self):
        with mock.patch.object(ThreadedTaskDispatcher, 'set_thread_count') as sizing:
            dispatcher = RequestDispatcher(16)
        self.assertEqual(sizing.call_args_list, [
            mock.call(16 if lane == 'ordinary' else count)
            for lane, count in RequestDispatcher.LIMITS.items()
        ])
        background = mock.Mock(requests=[mock.Mock(headers={'X_FAMILYHUB_ACTIVITY': 'background'})])
        interactive = mock.Mock(requests=[mock.Mock(headers={})])
        with mock.patch('music_web.http_dispatch.monotonic', side_effect=[100, 101, 160]), \
                self.assertLogs('music_web.http_dispatch', level='WARNING') as messages:
            dispatcher.pools['ordinary'].add_task(background)
            self.assertFalse(dispatcher.interactive_queued())
            dispatcher.pools['control'].add_task(interactive)
            self.assertTrue(dispatcher.interactive_queued())
            dispatcher.pools['ordinary'].add_task(interactive)
        self.assertEqual([line.rsplit(' ', 1)[-1] for line in messages.output], ['1', '2'])


class HttpCapacityTests(Base):
    extra = {'STATUS_SNAPSHOTS': True}

    def test_backlogged_watches_cannot_starve_play_status_or_server_work(self):
        client, token = self.signed_in()
        with mock.patch('threading.Thread.start'):
            job = self.post(client, token, '/api/jobs', json={'url': URL}).json['job']
        self.state.worker = None
        dispatcher = RequestDispatcher()
        server = create_server(self.app, host='127.0.0.1', port=0, _dispatcher=dispatcher)
        serving = threading.Thread(target=server.run, daemon=True)
        serving.start()
        cookie = client.get_cookie('familyhub_music', domain='music.test').value
        responses, errors = [], []
        def get(path, background=False):
            connection = http.client.HTTPConnection('127.0.0.1', server.effective_port, timeout=5)
            try:
                connection.request('GET', path, headers={'Host': 'music.test', 'Cookie': 'familyhub_music=' + cookie,
                    'X-FamilyHub-Activity': 'background' if background else 'foreground'})
                response = connection.getresponse()
                payload = response.read()
                self.assertEqual(response.status, 200, payload)
                return payload
            finally:
                connection.close()
        def watch():
            try:
                responses.append(get('/api/jobs/' + job['id'] + '?watch=1', True))
            except Exception as error:
                errors.append(error)
        watches = [threading.Thread(target=watch) for _ in range(12)]
        try:
            for thread in watches:
                thread.start()
            deadline = time.monotonic() + 2
            pool = dispatcher.pools['watch']
            while time.monotonic() < deadline:
                with pool.lock:
                    if pool.active_count == 4 and len(pool.queue) == 8:
                        break
                time.sleep(.01)
            self.assertEqual(len(pool.queue), 8)
            for path in ('/api/server/stats', '/api/catalogue/review', '/api/jobs/' + job['id']):
                start = time.monotonic()
                result = json.loads(get(path, True))
                self.assertLess(time.monotonic() - start, .7, path)
                self.assertTrue(result)
        finally:
            self.post(client, token, '/api/jobs/' + job['id'] + '/cancel', json={})
            for thread in watches:
                thread.join(6)
            server.close()
            dispatcher.shutdown(timeout=1)
        self.assertFalse(errors, errors)
        self.assertEqual(len(responses), 12)
