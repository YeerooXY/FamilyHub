"""YouTube Movies tests with a local Flask client and a mocked yt-dlp."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import Mock, patch

from music_web import movie_search
from music_web.movie_youtube_downloads import YouTubeDownloads
import test_movies
from test_music_web import Base

ID = 'abcABC123_-'
URL = movie_search.video_url(ID)


class YouTubeMetadata(unittest.TestCase):
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
        with tempfile.TemporaryDirectory() as root, patch('music_web.movie_youtube_downloads.subprocess.Popen') as popen:
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
                    queue.enqueue('yt-dlp', 'b' * 11, 'Next video', None)
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
            self.assertEqual(args[-2:], ['--', URL])
            self.assertEqual(snapshots, [dict(name='../A $TITLE', progress=.47, state='Downloading'),
                                         dict(name='../A $TITLE', progress=.99, state='Almost done')])
            self.assertEqual(queue.items(), [dict(name='Next video', progress=0, state='Problem'),
                                             dict(name='../A $TITLE', progress=1, state='Finished')])


class YouTubeEndpoints(Base):
    extra = {**test_movies.MovieSessions.extra, 'MOVIE_DOWNLOADS': {'profiles': ['sample-a'], 'youtube_dir': 'fixture-youtube'}}
    select = test_movies.MovieSessions.select

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
        reply = self.post(allowed, selection['csrf_token'], endpoint, json={'ids': [ID]})
        self.assertEqual(reply.json, {'results': {ID: {'height': 1080}}})
        enrich.assert_called_once()
