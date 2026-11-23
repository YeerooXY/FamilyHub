"""Exercise the production HTTP dispatcher with occupied long-lived watches."""
import http.client
import json
import threading
import time
from unittest import mock

from waitress import create_server
from music_web.http_dispatch import RequestDispatcher
from tests.test_music_web import Base, URL


class HttpCapacityTests(Base):
    extra = {'STATUS_SNAPSHOTS': True, 'ADMIN_USERS': ['sample-a']}

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
