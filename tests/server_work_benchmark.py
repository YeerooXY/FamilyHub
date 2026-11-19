"""Compare the old 12-thread HTTP pool with reserved lanes under 12 status watches."""
import http.client
import json
import sys
import threading
import time
from unittest import mock

from waitress import create_server
from music_web.http_dispatch import RequestDispatcher
from tests.test_music_web import Base, URL


def main():
    fixture = Base()
    fixture.extra = {'STATUS_SNAPSHOTS': True}
    fixture.setUp()
    client, token = fixture.signed_in()
    with mock.patch('threading.Thread.start'):
        job = fixture.post(client, token, '/api/jobs', json={'url': URL}).json['job']
    fixture.state.worker = None
    legacy = '--legacy-http' in sys.argv
    server = create_server(fixture.app, host='127.0.0.1', port=0, threads=12,
                           **({} if legacy else {'_dispatcher': RequestDispatcher()}))
    threading.Thread(target=server.run, daemon=True).start()
    cookie = client.get_cookie('familyhub_music', domain='music.test').value
    def get(path):
        connection = http.client.HTTPConnection('127.0.0.1', server.effective_port, timeout=10)
        connection.request('GET', path, headers={'Host': 'music.test', 'Cookie': 'familyhub_music=' + cookie})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        assert response.status == 200, (response.status, data)
        return data
    watches = [threading.Thread(target=get, args=('/api/jobs/' + job['id'] + '?watch=1',)) for _ in range(12)]
    release = lambda: fixture.post(client, token, '/api/jobs/' + job['id'] + '/cancel', json={})
    timer = threading.Timer(2, release)
    try:
        for thread in watches:
            thread.start()
        pool = server.task_dispatcher if legacy else server.task_dispatcher.pools['watch']
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with pool.lock:
                if pool.active_count == (12 if legacy else 4) and len(pool.queue) == (0 if legacy else 8):
                    break
            time.sleep(.01)
        timer.start()
        start = time.perf_counter()
        result = json.loads(get('/api/server/stats'))
        elapsed = time.perf_counter() - start
        print(json.dumps(dict(http='legacy-12' if legacy else 'reserved', stats_ms=round(elapsed*1000), workers=len(result['workers']))), flush=True)
    finally:
        release()
        timer.cancel()
        for thread in watches:
            thread.join(3)
        server.close()
        server.task_dispatcher.shutdown(timeout=1)
        fixture.doCleanups()


if __name__ == '__main__':
    main()
