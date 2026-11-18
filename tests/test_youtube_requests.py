"""Offline cache, request scheduling and refusal accounting tests."""
import importlib.util
import json
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('youtube_intake', Path(__file__).resolve().parents[1] / 'scripts/music-intake.py')
mi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mi)


class YouTubeTests(unittest.TestCase):
    def setUp(self):
        mi.SEARCH_CACHE.clear()
        mi.YOUTUBE = mi.YouTubeGate()
        mi.YOUTUBE.spacing = 0
        self.tool = mock.patch.object(mi, 'tool', return_value='yt-dlp')
        self.tool.start()
        self.addCleanup(self.tool.stop)

    def search(self, offset=0, query='Artist official audio', **kw):
        return mi.cmd_search(SimpleNamespace(query=query, offset=offset, limit=30, **kw))

    def runner(self, command, *args):
        depth = int(command[-1].split(':')[0].removeprefix('ytsearch'))
        return 0, json.dumps({'entries': [dict(id=f'{i:011d}', title=f'Song {i}', channel='Artist - Topic', duration=200) for i in range(depth)]}).encode(), ''

    def test_covered_offset_and_deeper_extension(self):
        with mock.patch.object(mi, 'run', side_effect=self.runner) as run:
            first = self.search()
            self.assertEqual(first, self.search(query='ARTIST official audio') | {'query': first['query']})
            self.assertEqual(run.call_count, 1)
            deeper = self.search(30)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(deeper, self.search(30))
            self.assertEqual(first, self.search())
            self.assertEqual(run.call_count, 2)
            self.assertEqual(deeper['results'][0]['id'], '00000000030')

    def test_art_tracks_cached_with_query(self):
        with mock.patch.object(mi, 'run', return_value=(0, b'{"entries":[]}', '')) as run:
            self.search(query='Artist Song')
            self.search(query='Artist Song')
            self.assertEqual(run.call_count, 2)

    def test_background_cooldown_user_bypasses_same_query(self):
        mi.YOUTUBE.result('quality', 1, 'HTTP Error 403: Forbidden')
        done = threading.Event()
        with mock.patch.object(mi, 'run', side_effect=self.runner) as run:
            worker = threading.Thread(target=lambda: (self.search(youtube_caller='quality'), done.set()), daemon=True)
            worker.start()
            self.assertFalse(done.wait(.05))
            self.assertEqual(run.call_count, 0)
            self.search()
            self.assertTrue(done.wait(2))
            worker.join(2)
            self.assertEqual(mi.YOUTUBE.until, 0)
            self.assertEqual(mi.YOUTUBE.refusals['quality'], 1)

    def test_counters_and_exponential_backoff(self):
        with mock.patch.object(mi, 'run', return_value=(1, b'', 'HTTP Error 429')):
            with self.assertRaises(mi.IntakeError):
                self.search()
        self.assertEqual(mi.YOUTUBE.counts['search'], 1)
        self.assertEqual(mi.YOUTUBE.refusals['search'], 1)
        self.assertEqual(mi.YOUTUBE.backoff, 300)
        for _ in range(4):
            mi.YOUTUBE.result('matching', 1, 'HTTP Error 403')
        self.assertEqual(mi.YOUTUBE.backoff, 1800)
        mi.YOUTUBE.result('fetch', 0, '')
        self.assertEqual(mi.YOUTUBE.backoff, 0)

    def test_foreground_passes_queued_background_and_calls_serialize(self):
        order = []
        def request(caller, background):
            with mi.YOUTUBE.request(caller, background):
                order.append(caller)
        with mi.YOUTUBE.request('fetch'):
            bg = threading.Thread(target=request, args=('quality', True))
            fg = threading.Thread(target=request, args=('search', False))
            bg.start()
            fg.start()
            deadline = time.monotonic() + 2
            while not mi.YOUTUBE.users and time.monotonic() < deadline:
                time.sleep(.001)
        fg.join(2)
        bg.join(2)
        self.assertEqual(order, ['search', 'quality'])

    def test_summary_at_most_once_per_ten_minutes(self):
        with mock.patch.object(mi.logging.getLogger(mi.__name__), 'info') as log:
            mi.YOUTUBE.reported -= 601
            with mi.YOUTUBE.request('fetch'):
                pass
            with mi.YOUTUBE.request('matching', True):
                pass
            self.assertEqual(log.call_count, 1)
            self.assertEqual(mi.YOUTUBE.counts, {'matching': 1})

    def test_expiry_and_lru_bound(self):
        with mock.patch.object(mi, 'run', side_effect=self.runner) as run:
            self.search()
            next(iter(mi.SEARCH_CACHE.values()))['created'] -= mi.SEARCH_CACHE_TTL
            self.search()
            self.assertEqual(run.call_count, 2)
            for i in range(205):
                self.search(query=f'Artist {i} official audio')
            self.assertEqual(len(mi.SEARCH_CACHE), 200)

    def test_background_refusal_retries_after_user_success(self):
        refused = threading.Event()
        done = threading.Event()
        attempts = []
        def runner(command, *args):
            attempts.append(command)
            if len(attempts) == 1:
                refused.set()
                return 1, b'', 'HTTP Error 403: Forbidden'
            return self.runner(command, *args)
        with mock.patch.object(mi, 'run', side_effect=runner):
            bg = threading.Thread(target=lambda: (self.search(youtube_caller='matching'), done.set()), daemon=True)
            bg.start()
            self.assertTrue(refused.wait(2))
            self.assertFalse(done.wait(.05))
            self.search()
            self.assertTrue(done.wait(2))
            bg.join(2)
            self.assertEqual(len(attempts), 2)
            self.assertEqual(mi.YOUTUBE.refusals['matching'], 1)

    def test_spacing(self):
        mi.YOUTUBE.spacing = .03
        with mi.YOUTUBE.request('search'):
            first = time.monotonic()
        with mi.YOUTUBE.request('search'):
            self.assertGreaterEqual(time.monotonic() - first, .03)

    def test_search_proceeds_during_media_transfer(self):
        for preview in (False, True):
            with self.subTest(preview=preview):
                started, release, searched = threading.Event(), threading.Event(), threading.Event()
                def transfer(*args, **kwargs):
                    started.set()
                    release.wait(2)
                    return None if preview else (0, b'', '')
                def run(command, *args):
                    if command == ['download']:
                        return transfer()
                    searched.set()
                    return self.runner(command, *args)
                def media():
                    if preview:
                        mi.pump_preview(['download'], 'unused-spool', 'unused-root')
                    else:
                        mi.youtube_run(['download'], 1800, 'download', media=True)
                with mock.patch.object(mi, 'run', side_effect=run), mock.patch.object(mi, '_pump_preview', side_effect=transfer):
                    worker = threading.Thread(target=media, daemon=True)
                    worker.start()
                    try:
                        self.assertTrue(started.wait(2))
                        search = threading.Thread(target=self.search, kwargs={'query': f'new query {preview}'}, daemon=True)
                        search.start()
                        self.assertTrue(searched.wait(.5))
                        search.join(2)
                        self.assertFalse(search.is_alive())
                        self.assertEqual(mi.YOUTUBE.counts['fetch'], 1 if not preview else 2)
                    finally:
                        release.set()
                        worker.join(2)

    def test_concurrent_same_query_fetches_once(self):
        started, release = threading.Event(), threading.Event()
        errors = []
        def runner(command, *args):
            started.set()
            release.wait(2)
            return self.runner(command, *args)
        def search():
            try:
                self.search()
            except Exception as error:
                errors.append(error)
        with mock.patch.object(mi, 'run', side_effect=runner) as run:
            threads = [threading.Thread(target=search) for _ in range(2)]
            threads[0].start()
            self.assertTrue(started.wait(2))
            threads[1].start()
            release.set()
            for thread in threads:
                thread.join(2)
                self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(run.call_count, 1)
