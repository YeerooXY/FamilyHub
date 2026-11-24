"""YouTube Movies tests with a local Flask client and a mocked yt-dlp."""
import json
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import Mock, patch

from music_web import movie_search
from music_web.movie_youtube_downloads import MAX_PENDING, YouTubeDownloads
import test_movies
from test_music_web import Base

ID = 'abcABC123_-'
URL = movie_search.video_url(ID)
VIDEA_ID = 'Abcdef0123456789'
VIDEA_URL = f'https://videa.hu/videok/film-animacio/example-s02e03-{VIDEA_ID}'
VIDEA_SEED = VIDEA_URL.replace('s02e03', 's02e01').replace(VIDEA_ID, 'a' * 16)


class YouTubeMetadata(unittest.TestCase):
    def test_season_capacity_and_queue_summary(self):
        queue = YouTubeDownloads('unused')
        queue.running = True
        videos = [(str(number), f'Episode {number}', None, f'https://videa.hu/player?v={number}') for number in range(10)]
        queue.enqueue_many('yt-dlp', [(str(100 + number), f'Video {number}', None, URL)
                                      for number in range(MAX_PENDING - 9)])
        self.assertFalse(queue.enqueue_many('yt-dlp', videos, 'Season 2'))
        self.assertFalse(any(ident in queue.jobs for ident, *_ in videos))
        queue.pending.popleft()
        self.assertTrue(queue.enqueue_many('yt-dlp', videos, 'Season 2'))
        self.assertTrue(queue.enqueue_many('yt-dlp', videos, 'Season 2'))
        self.assertEqual(len(queue.pending), MAX_PENDING)
        queue.jobs['0'].update(state='Finished', progress=1)
        queue.jobs['1'].update(state='Downloading', progress=.5)
        self.assertEqual(queue.items()[0], dict(name='Season 2', progress=.15, state='Downloading'))
        self.assertFalse(any(row['name'].startswith('Episode') for row in queue.items()))
        queue.pending.clear()
        for ident, *_ in videos:
            queue.jobs[ident].update(state='Finished', progress=1)
        queue.jobs['1'].update(state='Problem', progress=0)
        self.assertEqual(queue.items()[0]['state'], 'Problem')
        self.assertTrue(queue.enqueue_many('yt-dlp', videos, 'Season 2'))
        self.assertEqual([item[1] for item in queue.pending], ['1'])

    def test_only_single_video_urls_are_accepted(self):
        for url in (URL, f'https://youtu.be/{ID}?si=tracking', f'https://m.youtube.com/shorts/{ID}'):
            self.assertEqual(movie_search.video_id(url), ID)
        for url in (None, 'file:///tmp/test', f'https://other.test/watch?v={ID}',
                    f'https://www.youtube.com.other.test/watch?v={ID}', f'https://www.youtube.com@other.test/watch?v={ID}',
                    f'https://other.test@www.youtube.com/watch?v={ID}', f'https://www.youtube.com/playlist?list={ID}',
                    f'{URL}&list=some-playlist', f'https://youtu.be/{ID}?list=some-playlist',
                    f'{URL}&v={ID}', f'{URL}\n--exec', f'https://youtu.be/{ID}/extra'):
            with self.subTest(url=url):
                self.assertIsNone(movie_search.video_id(url))

    def test_candidates_then_metadata_no_media_download_and_six_hour_cache(self):
        entry = dict(id=ID, title='Local fixture', channel='Channel', duration=5340,
                     view_count=1203, upload_date='20261123', uploader='Uploader',
                     thumbnail='https://i.ytimg.com/example.jpg',
                     subtitles={'en': [{}]}, automatic_captions={'hu': [{}], 'live_chat': [{}]},
                     formats=[dict(height=2160, vcodec='none'), dict(height=720, fps=24, vcodec='av1'),
                              dict(height=1080, fps=30, vcodec='av1'), dict(height=1080, fps=60, vcodec='vp9')])
        flat = {key: entry[key] for key in ('id', 'title', 'channel', 'duration')}
        run = Mock(side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps({'entries': [flat]})),
            subprocess.CompletedProcess([], 0, json.dumps({'entries': [flat]})),
            subprocess.CompletedProcess([], 0, json.dumps(entry)),
        ])
        which = Mock(return_value='yt-dlp')
        with patch.dict(movie_search.metadata_cache, clear=True), patch('music_web.movie_search.monotonic', return_value=100) as clock:
            candidate, = movie_search.youtube_candidates('fixture', run=run, which=which)
            self.assertIsNone(candidate['height'])
            self.assertEqual(candidate['duration'], 5340)
            self.assertTrue(all('--flat-playlist' in call.args[0] for call in run.call_args_list))
            details = movie_search.enrich([ID], run=run, which=which)[ID]
            self.assertEqual(details, dict(duration=5340, height=1080, fps=60, thumbnail=entry['thumbnail'],
                                          uploader='Uploader', view_count=1203, upload_date='20261123',
                                          webpage_url=URL, has_subtitles=True, subtitle_langs=['en', 'hu']))
            self.assertEqual(run.call_args.args[0][-2:], ['--', URL])
            self.assertIn('--skip-download', run.call_args.args[0])
            self.assertNotIn('--flat-playlist', run.call_args.args[0])
            self.assertLessEqual(run.call_args.kwargs['timeout'], 4)
            clock.return_value += 6 * 3600 - 1
            self.assertEqual(movie_search.enrich([ID], run=run, which=which), {ID: details})
            self.assertEqual(run.call_count, 3)
            clock.return_value += 1
            self.assertIsNone(movie_search.cached_metadata(ID))

    def test_progress_states_and_path(self):
        with (tempfile.TemporaryDirectory() as root, patch('music_web.movie_youtube_downloads.subprocess.Popen') as popen,
              patch('music_web.movie_youtube_downloads.FREE_RESERVE', 0)):
            queue = YouTubeDownloads(root)
            done, extracting, release = Event(), Event(), Event()
            snapshots = []
            process = popen.return_value.__enter__.return_value

            def output():
                extracting.set()
                if not release.wait(3):
                    raise RuntimeError()
                yield 'familyhub-progress: 50.0%\n'
                snapshots.append(queue.items()[-1])
                yield 'familyhub-postprocess\n'
                snapshots.append(queue.items()[-1])
                directory = Path(popen.call_args.args[0][popen.call_args.args[0].index('-P') + 1])
                (directory / f'{ID}.mp4').touch()

            process.stdout = output()
            process.wait.return_value = 0
            work = queue._work

            def run():
                try:
                    work()
                finally:
                    done.set()

            with patch.object(queue, '_work', side_effect=run):
                queue.enqueue('yt-dlp', ID, '../A $TITLE', 1080)
                try:
                    self.assertTrue(extracting.wait(3))
                    queue.enqueue('yt-dlp', VIDEA_ID, 'Next video', None, url=f'https://videa.hu/player?v={VIDEA_ID}')
                    self.assertEqual([row['state'] for row in queue.items()], ['Waiting', 'Downloading'])
                    self.assertEqual(popen.call_count, 1)
                finally:
                    release.set()
                self.assertTrue(done.wait(3))
            args = popen.call_args_list[0].args[0]
            directory = Path(args[args.index('-P') + 1])
            self.assertEqual(directory.parent, Path(root).resolve())
            self.assertNotIn('$', directory.name)
            self.assertIn('bv*[height<=1080]+ba/b[height<=1080]', args)
            self.assertIn('--max-filesize', args)
            self.assertFalse(directory.exists())
            self.assertEqual(args[-2:], ['--', URL])
            self.assertEqual(popen.call_args_list[1].args[0][-2:], ['--', f'https://videa.hu/player?v={VIDEA_ID}'])
            self.assertEqual(snapshots, [dict(name='../A $TITLE', progress=.47, state='Downloading'),
                                         dict(name='../A $TITLE', progress=.99, state='Almost done')])
            self.assertEqual(queue.items(), [dict(name='Next video', progress=0, state='Problem'),
                                             dict(name='../A $TITLE', progress=1, state='Finished')])

    def test_transfer_monitor_stops_a_job_when_disk_reserve_is_exhausted(self):
        stop = Mock()
        process, finished, interrupted = Mock(), Mock(), Event()
        finished.wait.return_value = False
        with tempfile.TemporaryDirectory() as root, patch('music_web.movie_youtube_downloads.FREE_RESERVE', 1 << 80):
            YouTubeDownloads(root, stop=stop)._watch_transfer(process, Path(root), finished, interrupted)
        self.assertTrue(interrupted.is_set())
        stop.assert_called_once_with(process)


class YouTubeEndpoints(Base):
    extra = {**test_movies.MovieSessions.extra, 'ADMIN_USERS': ['sample-a'], 'MOVIE_DOWNLOADS': {'profiles': ['sample-a'], 'youtube_dir': 'fixture-youtube',
                                                                  'videa_seeds': {'Example & Friends': VIDEA_SEED}}}
    select = test_movies.MovieSessions.select

    @patch('music_web.movies.shutil.which', return_value='yt-dlp')
    @patch('music_web.movies.YouTubeDownloads.enqueue', return_value=True)
    def test_videa_uses_same_queue_and_fixed_upstream(self, enqueue, which):
        endpoint = '/api/movies/videa-download'
        payload = dict(url=VIDEA_URL, title=' Example  S02E03 ')
        denied, selection = self.select('sample-b')
        self.assertEqual(self.post(denied, selection['csrf_token'], endpoint, json=payload).status_code, 403)
        allowed, selection = self.select('sample-a')
        csrf = selection['csrf_token']
        for url in (VIDEA_URL.replace('videa.hu', 'videa.hu.evil.test'), VIDEA_URL + '?next=other', URL):
            self.assertEqual(self.post(allowed, csrf, endpoint, json={**payload, 'url': url}).status_code, 400)
        which.assert_not_called()
        reply = self.post(allowed, csrf, endpoint, json=payload)
        self.assertEqual((reply.status_code, reply.json), (202, {'state': 'sent'}))
        enqueue.assert_called_once_with('yt-dlp', VIDEA_ID, 'Example S02E03', None, url=f'https://videa.hu/player?v={VIDEA_ID}')

    @patch('music_web.movie_search.enrich', return_value={VIDEA_ID: {'height': 720}})
    @patch('music_web.movies.urllib.request.build_opener')
    def test_videa_search_keeps_the_requested_episode(self, opener, enrich):
        listed_title = 'Example &amp; Friends S02E03 HUN 1080p'
        rows = [(VIDEA_URL, listed_title), (VIDEA_URL, listed_title),
                (VIDEA_URL.replace('videa.hu', 'videa.hu.evil.test'), listed_title),
                (VIDEA_URL.replace(VIDEA_ID, 'a' * 16), 'Example &amp; Friends S02E02 1080p')]
        opener.return_value.open.return_value.__enter__.return_value.read.return_value = ''.join(
            f'<h2 class="title"><a href="{url}" title="Video">{title}</a></h2>' for url, title in rows).encode()
        allowed, selection = self.select('sample-a')
        reply = self.post(allowed, selection['csrf_token'], '/api/movies/videa-search', json={'query': 'Example & Friends S02E03'})
        self.assertEqual(reply.json, {'results': [{'url': VIDEA_URL, 'title': 'Example & Friends S02E03 HUN 1080p', 'height': 720}]})
        opener.return_value.open.assert_called_once_with('https://videa.hu/kereses/Example%20%26%20Friends%20S02E03', timeout=4)
        self.assertEqual(list(enrich.call_args.args[0]), [VIDEA_ID])

    @patch('music_web.movie_search.enrich', return_value={})
    @patch('music_web.movies.urllib.request.build_opener')
    def test_videa_uses_one_fallback_and_checks_episode_number(self, opener, enrich):
        client, selection = self.select('sample-a')
        open_page = opener.return_value.open
        for query, fallback, title in [
            ('Example & Friends 2x03', VIDEA_SEED, 'Example &amp; Friends S02E03 HUN'),
            ('Example S2E3', 'https://videa.hu/kereses/example%20s02e03', 'Example 2. évad 3. rész'),
        ]:
            with self.subTest(query=query):
                open_page.reset_mock()
                page = f'<h2 class="title"><a href="{VIDEA_URL}">{title}</a></h2>'
                wrong_episode = f'<h2 class="title"><a href="{VIDEA_SEED}">Example &amp; Friends S02E01</a></h2>'
                open_page.side_effect = [io.BytesIO(wrong_episode.encode()), io.BytesIO((wrong_episode + page).encode())]
                result = self.post(client, selection['csrf_token'], '/api/movies/videa-search', json={'query': query})
                self.assertEqual(result.status_code, 200)
                self.assertEqual([row['url'] for row in result.json['results']], [VIDEA_URL])
                self.assertEqual(open_page.call_count, 2)
                self.assertEqual(open_page.call_args.args[0], fallback)

    @patch('music_web.movie_search.enrich', return_value={})
    @patch('music_web.movies.urllib.request.build_opener')
    def test_videa_season_search_returns_all_matching_episodes(self, opener, enrich):
        client, selection = self.select('sample-a')
        cards = ['<meta property="og:title" content="Example &amp; Friends S02E01 HUN">']
        for episode in range(2, 11):
            ident = f'{episode:016d}'
            link = f'https://videa.hu/videok/film-animacio/example-s02e{episode:02d}-{ident}'
            cards.append(f'<h2 class="title"><a href="{link}">Example &amp; Friends S02E{episode:02d} HUN</a></h2>')
        cards.append(f'<h2 class="title"><a href="{VIDEA_URL}">Example &amp; Friends S01E03</a></h2>')
        open_page = opener.return_value.open
        open_page.side_effect = [io.BytesIO(b''), io.BytesIO(''.join(cards).encode())]
        result = self.post(client, selection['csrf_token'], '/api/movies/videa-search', json={'query': 'Example & Friends S2'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual([row['title'] for row in result.json['results']],
                         [f'Example & Friends S02E{episode:02d} HUN' for episode in range(1, 11)])
        self.assertEqual(result.json['season'], dict(title='Example & Friends', number=2, height=0, max_height=0,
                                                    episodes=result.json['results']))
        self.assertEqual(open_page.call_args.args[0], VIDEA_SEED)

    @patch('music_web.movies.shutil.which', return_value='yt-dlp')
    @patch('music_web.movies.YouTubeDownloads.enqueue_many', return_value=True)
    def test_season_download_validates_the_entire_batch_before_queueing(self, enqueue, which):
        client, selection = self.select('sample-a')
        payload = {'title': 'Example · Season 2', 'episodes': [dict(url=VIDEA_URL, title='Example S02E03'),
                                                               dict(url=VIDEA_SEED, title='Example S02E01')]}
        bad = {**payload, 'episodes': [*payload['episodes'], {'url': 'https://elsewhere.test', 'title': 'Invalid'}]}
        endpoint = '/api/movies/videa-download'
        self.assertEqual(self.post(client, selection['csrf_token'], endpoint, json=bad).status_code, 400)
        enqueue.assert_not_called()
        reply = self.post(client, selection['csrf_token'], endpoint, json=payload)
        self.assertEqual((reply.status_code, reply.json), (202, {'state': 'sent'}))
        args = enqueue.call_args.args
        self.assertEqual(args[2], payload['title'])
        self.assertEqual([item[0] for item in args[1]], [VIDEA_ID, 'a' * 16])

    @patch('music_web.movies.shutil.which', return_value='yt-dlp')
    @patch('music_web.movies.YouTubeDownloads.enqueue', return_value=True)
    @patch('music_web.movies.YouTubeDownloads.items')
    def test_download_permission_and_queue_without_qbittorrent(self, items, enqueue, which):
        endpoint = '/api/movies/youtube-download'
        payload = dict(url=f'https://youtu.be/{ID}', title='Sample Video')
        denied, selection = self.select('sample-b')
        self.assertEqual(self.post(denied, selection['csrf_token'], endpoint, json=payload).status_code, 403)
        which.assert_not_called()
        enqueue.assert_not_called()
        allowed, selection = self.select('sample-a')
        csrf = selection['csrf_token']
        self.assertEqual(self.post(allowed, csrf, endpoint, json={**payload, 'url': URL + '&list=playlist'}).status_code, 400)
        with patch('music_web.movie_search.cached_metadata', return_value={'height': 720}):
            reply = self.post(allowed, csrf, endpoint, json=payload)
        self.assertEqual((reply.status_code, reply.json), (202, {'state': 'sent'}))
        enqueue.assert_called_once_with('yt-dlp', ID, 'Sample Video', 720)
        items.return_value = [dict(name='Sample Video', progress=.45, state='Downloading')]
        queue = self.go(allowed, 'GET', '/api/movies/downloads')
        self.assertTrue(queue.json['available'])
        self.assertEqual(queue.json['items'], items.return_value)

    @patch('music_web.movie_search.enrich', return_value={ID: {'height': 1080}})
    def test_metadata_endpoint_validates_ids_and_profile(self, enrich):
        endpoint = '/api/movies/youtube-metadata'
        denied, selection = self.select('sample-b')
        self.assertEqual(self.post(denied, selection['csrf_token'], endpoint, json={'ids': [ID]}).status_code, 404)
        allowed, selection = self.select('sample-a')
        self.assertEqual(self.post(allowed, selection['csrf_token'], endpoint, json={'ids': [URL]}).status_code, 400)
        ids = [ID, *(f'video{i:06}' for i in range(10))]
        reply = self.post(allowed, selection['csrf_token'], endpoint, json={'ids': ids})
        self.assertEqual(reply.json, {'results': {ID: {'height': 1080}}})
        self.assertEqual(self.post(allowed, selection['csrf_token'], endpoint, json={'ids': [*ids, 'another0001']}).status_code, 400)
        enrich.assert_called_once_with(dict.fromkeys(ids))
