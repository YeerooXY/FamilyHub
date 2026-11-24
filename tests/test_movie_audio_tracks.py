from array import array
import io
import json
import math
import os
import random
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import Mock, patch

from music_web import audio_tracks as audio
from test_music_web import Base


class AudioSyncTests(unittest.TestCase):
    def signals(self, speed=1., intercept=0.):
        rng = random.Random(13)
        amplitudes = [rng.uniform(.05, 1) for _ in range(1000)]
        target = array('h', (int(11000 * amplitudes[i // 800] *
                                 (.6 * math.sin(2 * math.pi * 370 * i / 8000) + .4 * rng.uniform(-1, 1)))
                             for i in range(100 * 8000)))
        def sample(i):
            position = (i - intercept * 8000) / speed
            if not 0 <= position < len(target) - 1:
                return 0
            index = int(position)
            return int(target[index] + (position - index) * (target[index + 1] - target[index]))
        source = array('h', (sample(i) for i in range(round((100 * speed + max(0, intercept)) * 8000))))
        return target, source

    def test_known_offset_and_pal_speed(self):
        speed = 25 * 1001 / 24000
        for ratio in (1., speed, 1 / speed):
            with self.subTest(speed=ratio):
                result = audio.estimate_sync(*self.signals(ratio, 1.2 * ratio))
                self.assertAlmostEqual(result['speed_ratio'], ratio, delta=.0003)
                self.assertAlmostEqual(result['offset_ms'], -1200, delta=25)
                self.assertEqual(result['confidence'], 'high')
                self.assertFalse(result['cut_warning'])

    def test_loudness_match_does_not_claim_high_confidence(self):
        result = audio.estimate_sync(*self.signals(intercept=-1.2), less_certain=True)
        self.assertTrue(result['less_certain'])
        self.assertTrue(result['matched'])
        self.assertEqual(result['confidence'], 'medium')
        self.assertAlmostEqual(result['offset_ms'], 1200, delta=30)

    def test_cut_differences(self):
        target, _ = self.signals()
        cut = target[:50 * 8000] + array('h', [0]) * 8000 + target[50 * 8000:]
        result = audio.estimate_sync(target, cut)
        self.assertTrue(result['cut_warning'])
        self.assertGreater(result['deviation_ms'], 300)
        self.assertEqual(result['confidence'], 'low')

    def test_batch_matches_season_and_episode_numbers(self):
        root = Path('/imports')
        folder = root / 'Series'
        videos = [folder / name for name in ('Show.S02E03.mkv', 'Show.S02E04.mkv', 'Show.S01E04.mkv')]
        episodes = [{'IndexNumber': 3, 'ParentIndexNumber': 2}, {'IndexNumber': 4, 'ParentIndexNumber': 2},
                    {'IndexNumber': 5, 'ParentIndexNumber': 2}, {'IndexNumber': 4, 'ParentIndexNumber': 1}]
        library = Mock(return_value={'Items': list(reversed(episodes))})
        show = 'a' * 32
        item = {'Type': 'Episode', 'SeriesId': show, 'ParentIndexNumber': 2, 'IndexNumber': 3}
        choice = (root, folder, True)
        rows = [(root, video, False) for video in videos]
        results = audio.episode_pairs(library, item, choice, rows)
        self.assertEqual(results, [(episodes[1], root, videos[1]), (episodes[0], root, videos[0])])
        library.assert_called_once_with(f'Shows/{show}/Episodes', dict(season=2, fields='Path', limit=101))


@unittest.skipUnless(os.name == 'posix', 'Linux media paths')
class AudioMediaTests(unittest.TestCase):
    def test_paths_and_real_sidecar(self):
        ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            self.skipTest('FFmpeg and FFprobe are required')
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            imports, library = root / 'imports', root / 'movies'
            imports.mkdir()
            library.mkdir()
            video, dub = library / 'Film.mkv', imports / 'Dub.mka'
            for path, frequency in ((video, 400), (dub, 500)):
                subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', f'sine=frequency={frequency}:duration=3',
                                '-c:a', 'ac3', '-metadata:s:a:0', 'language=eng', str(path)], check=True, timeout=20)
            streams = audio.probe_audio(ffprobe, dub)
            self.assertEqual(streams[0]['codec'], 'ac3')
            with patch.object(audio, 'SOURCES', (imports,)):
                (imports / 'linked.mka').symlink_to(video)
                (imports / '-unsafe.mka').touch()
                self.assertEqual([path for _, path, _ in audio.candidates()], [dub])
                with self.assertRaises(OSError), audio.opened(imports / 'linked.mka'):
                    self.fail('Link opened')
            report = dict(speed_ratio=1., offset_ms=0)
            out, stamp = audio.write_sidecar(ffmpeg, ffprobe, dub, video, streams[0], 'hu', 'Hungarian', report)
            self.assertEqual(out.name, 'Film.hu.mka')
            self.assertEqual(out.stat().st_mode & 0o777, 0o660)
            self.assertEqual(audio.fingerprint(out.stat()), stamp)
            self.assertEqual(audio.probe_audio(ffprobe, out)[0]['language'], 'hun')
            self.assertEqual(audio.probe_audio(ffprobe, out)[0]['codec'], 'ac3')
            with self.assertRaises(FileExistsError):
                audio.write_sidecar(ffmpeg, ffprobe, dub, video, streams[0], 'hu', 'Hungarian', report)
            adjusted, _ = audio.write_sidecar(ffmpeg, ffprobe, dub, video, streams[0], 'de', 'German',
                                               dict(speed_ratio=1.0427, offset_ms=100))
            self.assertEqual(audio.probe_audio(ffprobe, adjusted)[0]['codec'], 'eac3')


@unittest.skipUnless(os.name == 'posix', 'Linux media paths')
class AudioGatewayTests(Base):
    def setUp(self):
        root = Path(self.enterContext(TemporaryDirectory()))
        self.imports, self.movies = root / 'imports', root / 'movies'
        self.imports.mkdir()
        self.movies.mkdir()
        self.enterContext(patch.object(audio, 'SOURCES', (self.imports,)))
        self.enterContext(patch.object(audio, 'LIBRARIES', {'movies': self.movies}))
        self.extra = {'FAMILY_PROFILES': True, 'STATE_DIR': str(root / 'state'),
                      'JELLYFIN_PUBLIC_URL': 'https://movies.test',
                      'JELLYFIN_PROFILES': {'sample-a': {'username': 'owner', 'password': 'fixture'},
                                            'sample-b': {'username': 'member', 'password': 'fixture'}},
                      'ADMIN_USERS': ['sample-a'], 'MOVIE_DOWNLOADS': {'profiles': ['sample-a', 'sample-b']}}
        super().setUp()

    def sign_in_movie(self, profile):
        client = self.app.test_client()
        bootstrap = self.go(client, 'GET', '/api/connect').json
        selection = self.post(client, bootstrap['csrf_token'], '/api/profile/select',
                              json=self.profile_credentials(profile))
        self.assertEqual(selection.status_code, 200)
        return client, selection.json['csrf_token']

    def test_gate_job_refresh_and_verified_delete(self):
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg and FFprobe are required')
        ident = 'a' * 32
        source, video = self.imports / 'Dub.mka', self.movies / 'Film.mkv'
        for path, language in ((source, 'hun'), (video, 'eng')):
            subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=9', '-c:a', 'ac3',
                            '-metadata:s:a:0', 'language=' + language, str(path)], timeout=20, check=True)

        def jellyfin(req, timeout):
            path = req.full_url.split('?')[0]
            if path.endswith('/AuthenticateByName'):
                data = dict(User={'Id': 'viewer', 'Name': 'owner', 'Policy': {'IsAdministrator': False}},
                            AccessToken='fixture-token')
            else:
                self.assertIn('Token="fixture-token"', req.headers['Authorization'])
                if path.endswith('/Refresh'):
                    self.assertEqual(req.get_method(), 'POST')
                    self.assertIn('MetadataRefreshMode=FullRefresh', req.full_url)
                    return io.BytesIO()
                self.assertTrue(path.endswith('/Items/' + ident))
                data = {'Id': ident, 'Name': 'Film', 'Type': 'Movie', 'Path': '/data/movies/Film.mkv'}
            return io.BytesIO(json.dumps(data).encode())

        sources = '/api/movies/audio-sources?item=' + ident
        route = '/api/movies/audio-track'
        get_jobs = lambda: self.go(owner, 'GET', '/api/movies/downloads').json.get('items', [])
        owner, csrf = self.sign_in_movie('sample-a')
        member, member_csrf = self.sign_in_movie('sample-b')
        self.assertEqual(self.go(member, 'GET', sources).status_code, 403)
        self.assertEqual(self.post(member, member_csrf, route, json={}).status_code, 403)
        self.assertNotEqual(self.go(self.app.test_client(), 'GET', sources).status_code, 200)
        self.assertEqual(self.go(owner, 'POST', route, json={}).status_code, 400)
        with patch('music_web.movies.urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect = jellyfin
            session = self.post(owner, csrf, '/api/movies/session', json={'device': 'd' * 32}).json
            listing = self.go(owner, 'GET', sources).json['sources']
            self.assertEqual(listing[0]['name'], 'Dub.mka')
            self.assertNotIn(str(self.imports), json.dumps(listing))
            data = dict(item=ident, source=listing[0]['id'], stream_index=0, ticket=session['media_ticket'])
            self.assertEqual(self.post(owner, csrf, route, json=dict(data, source=str(source))).status_code, 400)
            other, other_csrf = self.sign_in_movie('sample-a')
            self.assertEqual(self.post(other, other_csrf, route, json=data).status_code, 404)
            reply = self.post(owner, csrf, route, json=data)
            self.assertEqual(reply.status_code, 202)
            for _ in range(200):
                job = get_jobs()[0]
                if job['state'] not in ('Waiting', 'Matching audio', 'Writing audio'):
                    break
                time.sleep(.025)
            self.assertEqual(job['state'], 'Added', job)
            result = job['results'][0]
            self.assertFalse(result['refresh_pending'])
            self.assertTrue(result['can_delete'])
            self.assertNotIn('files', job)
            self.assertTrue(audio.state_path(self.extra, '.movie-audio-jobs.json').exists())
            delete = route + '/' + job['id'] + '/delete-source'
            sidecar = video.with_name('Film.hu.mka')
            old_stat, contents = sidecar.stat(), sidecar.read_bytes()
            sidecar.write_bytes(b'Corrupt')
            self.assertEqual(self.post(owner, csrf, delete, json={'result': result['id']}).status_code, 409)
            self.assertTrue(source.exists())
            sidecar.write_bytes(contents)
            os.utime(sidecar, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
            self.assertEqual(self.post(owner, csrf, delete, json={'result': result['id']}).status_code, 200)
            self.assertFalse(source.exists())
            self.assertTrue(sidecar.is_file())
