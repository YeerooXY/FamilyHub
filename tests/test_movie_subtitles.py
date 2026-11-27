"""OpenSubtitles fallback tests with local files and a fake HTTP client."""
import base64
import io
import json
import os
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from music_web import audio_tracks, movie_subtitle_import, movie_subtitles as subtitles, subtitle_sync
from test_music_web import Base


ITEM = 'a' * 32
SERIES = 'b' * 32
LINK = 'https://dl.opensubtitles.com/download/example/subfile/Film.en.srt'
ROUTE = '/api/movies/subtitle'
SYNC = ROUTE + '/sync'
CUE = '1\n00:00:01,000 --> 00:00:02,000\nCafé\n'
CONFIG = {'OPENSUBTITLES_' + name: 'fixture-' + str(index)
          for index, name in enumerate(('API_KEY', 'USERNAME', 'PASSWORD'))}


def response(value):
    return io.BytesIO(json.dumps(value).encode())


def login(expiry=4102444800):
    claims = base64.urlsafe_b64encode(json.dumps({'exp': expiry}).encode()).rstrip(b'=').decode()
    return response({'token': f'fixture.{claims}.fixture'})


def failure(code, payload=None, **headers):
    fields = Message()
    for name, value in headers.items():
        fields[name.replace('_', '-')] = value
    return HTTPError(subtitles.API, code, 'Fixture failure', fields, response(payload))


def result(file_id, release='Different.Release', hearing_impaired=False, downloads=1, name='Other.en.srt'):
    return {'attributes': {'language': 'en', 'release': release, 'hearing_impaired': hearing_impaired,
                           'download_count': downloads, 'files': [{'file_id': file_id, 'file_name': name}]}}


class OpenSubtitlesTests(unittest.TestCase):
    def setUp(self):
        self.http = Mock()
        self.provider = subtitles.OpenSubtitles(CONFIG, self.http)
        self.params = {'tmdb_id': 123, 'languages': 'en'}

    def test_login_failure_can_retry_without_exposing_provider_reply(self):
        self.http.open.side_effect = [failure(401, {'error': 'upstream details'}), login(), response({'data': []})]
        with self.assertRaisesRegex(subtitles.SubtitleError, 'could not sign in'):
            self.provider.fetch(self.params, 'Film')
        with self.assertRaisesRegex(subtitles.SubtitleError, 'No subtitles found for this title and language'):
            self.provider.fetch(self.params, 'Film')
        self.assertEqual([urlsplit(call.args[0].full_url).path.rsplit('/', 1)[1]
                          for call in self.http.open.call_args_list], ['login', 'login', 'subtitles'])

    def test_best_srt_and_legacy_encoding(self):
        candidates = [result(1, downloads=900), result(2, 'Film.1080p', True, 800),
                      result(3, 'Film 1080p', downloads=10), result(4, 'Film.1080p', downloads=20),
                      result(5, 'Film.1080p', downloads=100, name='Film.ass')]
        self.http.open.side_effect = [login(), response({'data': candidates}), response({'link': LINK}),
                                      io.BytesIO(CUE.replace('\n', '\r\n').encode('cp1252')), response({'data': []})]
        self.assertEqual(self.provider.fetch(self.params, 'Film.1080p'), CUE.encode('utf-8'))
        login_request, search, download, file = [call.args[0] for call in self.http.open.call_args_list]
        self.assertEqual(login_request.full_url, subtitles.API + '/login')
        self.assertEqual(parse_qs(urlsplit(search.full_url).query), {'tmdb_id': ['123'], 'languages': ['en']})
        self.assertEqual(json.loads(download.data), {'file_id': 4, 'sub_format': 'srt'})
        self.assertTrue(download.get_header('Authorization').startswith('Bearer '))
        self.assertTrue(download.has_header('Api-key'))
        self.assertEqual(file.header_items(), [('User-agent', subtitles.USER_AGENT)])
        with self.assertRaisesRegex(subtitles.SubtitleError, 'No subtitles found'):
            self.provider.fetch(self.params, 'Film.1080p')
        self.assertEqual(self.http.open.call_count, 5)
        with self.assertRaisesRegex(subtitles.SubtitleError, 'unreadable subtitle'):
            subtitles.subtitle_bytes(b'<html>Invalid data</html>', 'en')

    def test_moviehash_and_exact_match_rank(self):
        data = bytes(range(256)) * 600 + b'end'
        chunk = 1 << 16
        expected = len(data)
        for piece in (data[:chunk], data[-chunk:]):
            for index in range(0, chunk, 8):
                expected += int.from_bytes(piece[index:index + 8], 'little')
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'Film.mkv'
            path.write_bytes(data)
            with path.open('rb') as file:
                hashed = subtitles.moviehash(file)
            self.assertEqual(hashed, f'{expected % (1 << 64):016x}')
            path.write_bytes(data[:chunk - 1])
            with path.open('rb') as file:
                self.assertIsNone(subtitles.moviehash(file))
        self.assertEqual(subtitles.search_parameters({'ProviderIds': {'Tmdb': '123'}}, None, 'en', hashed),
                         {'languages': 'en', 'type': 'movie', 'tmdb_id': 123, 'moviehash': hashed})
        matched = result(2, hearing_impaired=True)
        matched['attributes']['moviehash_match'] = True
        self.assertEqual(subtitles.best_file([result(1, 'Film', downloads=900), matched], 'Film', 'en'), 2)

    def test_expired_token_is_replaced_and_vip_api_host_is_used(self):
        vip = json.load(login())
        vip['base_url'] = 'vip-api.opensubtitles.com'
        self.http.open.side_effect = [login(expiry=1), response({'data': []}), response(vip), response({'data': []})]
        for _ in range(2):
            with self.assertRaisesRegex(subtitles.SubtitleError, 'No subtitles found'):
                self.provider.fetch(self.params, 'Film')
        self.assertTrue(self.http.open.call_args.args[0].full_url.startswith('https://vip-api.opensubtitles.com/api/v1/'))

    def test_daily_quota_is_cached_with_reset_time(self):
        self.http.open.side_effect = [
            login(), response({'data': [result(1)]}), failure(406, {'reset_time_utc': '2099-12-31T10:15:00Z'}),
        ]
        for _ in range(2):
            with self.assertRaisesRegex(subtitles.SubtitleError, r'Daily subtitle limit reached.*2099-12-31 10:15 UTC'):
                self.provider.fetch(self.params, 'Film')
        self.assertEqual(self.http.open.call_count, 3)

    def test_last_download_succeeds_and_later_attempts_respect_quota(self):
        self.http.open.side_effect = [login(), response({'data': [result(1)]}),
                                      response({'link': LINK, 'remaining': 0, 'reset_time': '2 hours and 5 minutes'}),
                                      io.BytesIO(CUE.encode())]
        self.assertEqual(self.provider.fetch(self.params, 'Film'), CUE.encode())
        with self.assertRaisesRegex(subtitles.SubtitleError, 'resets in 2 hours and 5 minutes'):
            self.provider.fetch(self.params, 'Film')
        self.assertEqual(self.http.open.call_count, 4)

    def test_import_uses_key_only_and_records_attempts_even_during_quota(self):
        provider = subtitles.OpenSubtitles({'OPENSUBTITLES_API_KEY': CONFIG['OPENSUBTITLES_API_KEY']}, self.http)
        self.http.open.side_effect = [response({'data': [result(1)]}), failure(406, {'reset_time': '2 hours'})]
        tried = set()

        def mark(language):
            if language in tried:
                return False
            tried.add(language)
            return True

        for language in ('en', 'hu', 'en'):
            self.assertIsNone(subtitles.fetch_for_import(provider, Lock(), mark, 'Film', '2024', (1, 2),
                                                         Path('Film.S01E02.mkv'), language))
        self.assertEqual(tried, {'en', 'hu'})
        self.assertEqual(self.http.open.call_count, 2)
        search, download = [call.args[0] for call in self.http.open.call_args_list]
        self.assertEqual(parse_qs(urlsplit(search.full_url).query), {'query': ['Film'], 'type': ['episode'],
            'year': ['2024'], 'languages': ['en'], 'season_number': ['1'], 'episode_number': ['2']})
        self.assertTrue(download.has_header('Api-key'))
        self.assertFalse(download.has_header('Authorization'))
        provider.quota_until = 0
        self.assertIsNone(subtitles.fetch_for_import(provider, Lock(), mark, 'Film', None, None, Path('Film.mkv'), 'en'))
        self.assertEqual(self.http.open.call_count, 2)

    def test_retry_after_short_circuits_and_file_host_is_restricted(self):
        self.http.open.side_effect = [
            login(), failure(429, Retry_After='15'), response({'data': [result(1)]}),
            response({'link': 'https://dl.opensubtitles.com@outside.test/download/example.srt'}),
        ]
        for _ in range(2):
            with self.assertRaises(subtitles.SubtitleError) as error:
                self.provider.fetch(self.params, 'Film')
            self.assertEqual(error.exception.status, 429)
            self.assertGreaterEqual(error.exception.retry_after, 1)
        self.assertEqual(self.http.open.call_count, 2)
        self.provider.rate_until = 0
        with self.assertRaisesRegex(subtitles.SubtitleError, 'provider is unreachable'):
            self.provider.fetch(self.params, 'Film')
        self.assertEqual(self.http.open.call_count, 4)


class SubtitleGateway(Base):
    extra = {'FAMILY_PROFILES': True, 'JELLYFIN_PUBLIC_URL': 'https://movies.test',
             'JELLYFIN_PROFILES': {'sample-a': {'username': 'viewer', 'password': 'fixture'}}}

    def setUp(self):
        self.http = Mock()
        self.jellyfin = Mock(side_effect=self.library)
        self.item = {'Id': ITEM, 'Type': 'Movie', 'Path': '/data/movies/Film.mkv', 'ProviderIds': {'Tmdb': '123'}}
        self.root = Path(self.enterContext(TemporaryDirectory()))
        self.enterContext(patch.object(audio_tracks, 'LIBRARIES', {'movies': self.root, 'tv': self.root}))
        register = subtitles.register
        self.enterContext(patch.object(subtitles, 'register', side_effect=lambda *args: register(*args, http=self.http)))
        super().setUp()
        self.enterContext(patch('music_web.movie_media.urllib.request.build_opener',
                                return_value=Mock(open=self.jellyfin)))
        self.client, self.csrf = self.select('sample-a')
        self.ticket = self.post(self.client, self.csrf, '/api/movies/session',
                                json={'device': 'd' * 32}).json['media_ticket']

    def select(self, profile):
        client = self.app.test_client()
        token = self.go(client, 'GET', '/api/connect').json['csrf_token']
        selection = self.post(client, token, '/api/profile/select', json=self.profile_credentials(profile))
        return client, selection.json['csrf_token']

    def library(self, req, timeout):
        path = urlsplit(req.full_url).path
        if path.endswith('/AuthenticateByName'):
            return response({'User': {'Id': 'viewer', 'Name': 'viewer', 'Policy': {'IsAdministrator': False}},
                             'AccessToken': 'jellyfin-viewer'})
        if path == '/Items/' + ITEM:
            return response(self.item)
        if path == '/Items/' + SERIES:
            return response({'Type': 'Series', 'ProviderIds': {'Imdb': 'tt0012345'}})
        if path == f'/Items/{ITEM}/Refresh':
            return io.BytesIO()
        self.fail(path)

    def fetch(self, **overrides):
        return self.post(self.client, self.csrf, ROUTE, json={'item': ITEM, 'ticket': self.ticket, **overrides})


class SubtitleGatewayTests(SubtitleGateway):
    def test_missing_config_and_request_gates(self):
        self.assertEqual(self.fetch().json['error'], 'Subtitle provider is not set up')
        self.assertEqual(self.fetch(language='../en').status_code, 400)
        self.assertEqual(self.fetch(language='xx').status_code, 400)
        self.assertEqual(self.fetch(language='de').status_code, 400)
        self.assertEqual(self.fetch(item='../Film').status_code, 400)
        self.assertEqual(self.go(self.client, 'POST', ROUTE, json={}).status_code, 400)
        other, csrf = self.select('sample-a')
        self.assertEqual(self.post(other, csrf, ROUTE, json={'item': ITEM, 'ticket': self.ticket}).status_code, 404)
        other, csrf = self.select('sample-b')
        self.assertEqual(self.post(other, csrf, ROUTE, json={'item': ITEM, 'ticket': self.ticket}).status_code, 403)
        self.http.open.assert_not_called()

    def test_sync_requires_csrf_and_bound_grants(self):
        payload = {'item': ITEM, 'language': 'en', 'ticket': self.ticket}
        self.assertEqual(self.go(self.client, 'POST', SYNC, json=payload).status_code, 400)
        self.assertEqual(self.post(self.client, self.csrf, SYNC, json={**payload, 'language': '../en'}).status_code, 400)
        other, csrf = self.select('sample-a')
        self.assertEqual(self.post(other, csrf, SYNC, json=payload).status_code, 404)
        self.assertEqual(self.go(other, 'GET', SYNC + '?item=' + ITEM).status_code, 404)


@unittest.skipUnless(hasattr(os, 'O_PATH') and hasattr(os, 'O_NOFOLLOW'), 'Linux media paths')
class SubtitleSidecarTests(SubtitleGateway):
    extra = {**SubtitleGateway.extra, **CONFIG, 'JELLYFIN_API_KEY': 'jellyfin-refresh'}

    def fixture_download(self):
        self.enterContext(patch.object(subtitle_sync, 'start_job', return_value=True))
        self.http.open.side_effect = [login(), response({'data': [result(1)]}), response({'link': LINK}),
                                      io.BytesIO(CUE.encode('cp1252'))]

    def test_atomic_sidecar_refresh_and_retry_without_another_download(self):
        video = self.root / 'Film.mkv'
        video.touch()
        self.fixture_download()
        original_link = os.link

        def publish(source, name, **options):
            self.assertFalse((self.root / name).exists())
            if name.endswith('.srt'):
                self.assertEqual(Path(source).read_bytes(), CUE.encode())
            return original_link(source, name, **options)

        with patch.object(subtitles.os, 'link', side_effect=publish):
            self.assertEqual(self.fetch().json, {'added': True, 'existing': False, 'refresh_pending': False})
        output = video.with_suffix('.en.srt')
        self.assertEqual(output.read_bytes(), CUE.encode())
        self.assertEqual(output.stat().st_mode & 0o777, 0o660)
        self.assertEqual((output.stat().st_uid, output.stat().st_gid), (video.stat().st_uid, video.stat().st_gid))
        requests = [call.args[0] for call in self.jellyfin.call_args_list]
        self.assertIn('Token="jellyfin-viewer"', requests[-2].get_header('Authorization'))
        refresh = requests[-1]
        self.assertTrue(refresh.full_url.endswith(f'/Items/{ITEM}/Refresh?MetadataRefreshMode=FullRefresh&userId=viewer'))
        self.assertEqual(refresh.get_method(), 'POST')
        self.assertEqual(refresh.get_header('Authorization'), 'MediaBrowser Token="jellyfin-refresh"')
        self.assertTrue(self.fetch().json['existing'])
        self.assertEqual(self.http.open.call_count, 4)
        timing = self.root / subtitle_sync.METADATA
        self.assertEqual(json.loads(timing.read_bytes())[output.name]['method'], 'pending')
        self.assertEqual(set(self.root.iterdir()), {video, output, timing})

    def test_sync_busy_then_replaces_sidecar_and_reports_timing(self):
        video = self.root / 'Film.mkv'
        video.touch()
        output = video.with_suffix('.en.srt')
        output.write_bytes(CUE.encode())
        payload = {'item': ITEM, 'language': 'en'}
        with subtitle_sync.SYNC_SLOT:
            busy = self.post(self.client, self.csrf, SYNC, json=payload)
        self.assertEqual(busy.status_code, 409)
        self.assertEqual(busy.json, {'error': subtitle_sync.BUSY})
        self.assertEqual(output.read_bytes(), CUE.encode())
        aligned = CUE.replace('00:00:01,000', '00:00:00,500').encode()
        with patch.object(movie_subtitle_import, 'time_subtitle', return_value=(aligned, 'audio')), \
                patch.object(subtitle_sync, 'Thread') as thread, output.open('rb') as before:
            self.assertEqual(self.post(self.client, self.csrf, SYNC, json=payload).status_code, 202)
            poll = SYNC + '?item=' + ITEM
            self.assertEqual(self.go(self.client, 'GET', poll).json, {'en': {'method': 'unknown', 'state': 'running'}})
            self.assertEqual(self.post(self.client, self.csrf, SYNC, json=payload).status_code, 409)
            thread.call_args.kwargs['target']()
            self.assertEqual(before.read(), CUE.encode())
        self.assertEqual(output.read_bytes(), aligned)
        self.assertEqual(self.go(self.client, 'GET', poll).json, {'en': {'method': 'audio', 'state': 'idle'}})
        self.http.open.assert_not_called()

    def test_library_reports_on_demand_sidecar_timing_without_paths(self):
        video = self.root / 'Film.mkv'
        video.touch()
        output = video.with_suffix('.en.srt')
        output.write_bytes(CUE.encode())
        with audio_tracks.opened(self.root, directory=True) as folder:
            subtitle_sync.record_timing(video, folder, video.stat(), output.name, 'audio')
        external = {'Type': 'Subtitle', 'IsExternal': True, 'Language': 'eng'}
        self.item['MediaSources'] = [{'Id': ITEM, 'Path': self.item['Path'], 'MediaStreams': [
            {**external, 'Path': '/data/movies/Film.en.srt'},
            {**external, 'Path': '/config/Film.en.srt'},
        ]}]
        reply = self.post(self.client, self.csrf, '/api/movies/library', json={
            'ticket': self.ticket, 'path': f'Items/{ITEM}', 'query': '',
        })
        self.assertEqual(reply.status_code, 200)
        local, unrelated = reply.json['result']['MediaSources'][0]['MediaStreams']
        self.assertIs(local['FamilyHubSubtitleSidecar'], True)
        self.assertEqual(local['FamilyHubSubtitleTiming'], {'method': 'audio', 'state': 'idle'})
        self.assertNotIn('FamilyHubSubtitleTiming', unrelated)
        self.assertNotIn('Path', local)

    def test_rejects_traversal_and_links_before_provider_calls(self):
        outside = self.root / 'Elsewhere.mkv'
        outside.touch()
        (self.root / 'Film.mkv').symlink_to(outside)
        self.assertEqual(self.fetch().status_code, 409)
        self.item['Path'] = '/data/movies/../Elsewhere.mkv'
        self.assertEqual(self.fetch().status_code, 409)
        self.item['Path'] = '/outside/Film.mkv'
        self.assertEqual(self.fetch().status_code, 409)
        self.item['Path'] = '/data/movies/Local.mkv'
        (self.root / 'Local.mkv').touch()
        (self.root / 'Local.en.srt').symlink_to(outside)
        self.assertEqual(self.fetch().status_code, 409)
        self.http.open.assert_not_called()

    def test_refresh_failure_preserves_the_sidecar(self):
        video = self.root / 'Film.mkv'
        video.touch()
        self.fixture_download()

        def unavailable(req, timeout):
            if urlsplit(req.full_url).path.endswith('/Refresh'):
                raise TimeoutError()
            return self.library(req, timeout)

        with patch.object(self.jellyfin, 'side_effect', unavailable):
            self.assertEqual(self.fetch().json, {'added': True, 'existing': False, 'refresh_pending': True})
        self.assertEqual(video.with_suffix('.en.srt').read_bytes(), CUE.encode())
        self.assertEqual(self.fetch().json, {'added': True, 'existing': True, 'refresh_pending': False})
        self.assertEqual(self.http.open.call_count, 4)

    def test_episode_uses_parent_id_and_numbers(self):
        self.item = {'Id': ITEM, 'Type': 'Episode', 'Path': '/data/tv/Show.S02E03.mkv',
                     'SeriesId': SERIES, 'ParentIndexNumber': 2, 'IndexNumber': 3}
        (self.root / 'Show.S02E03.mkv').touch()
        self.fixture_download()
        self.assertTrue(self.fetch().json['added'])
        self.assertTrue((self.root / 'Show.S02E03.en.srt').is_file())
        search = self.http.open.call_args_list[1].args[0]
        self.assertEqual(parse_qs(urlsplit(search.full_url).query),
                         {'languages': ['en'], 'type': ['episode'], 'season_number': ['2'], 'episode_number': ['3'],
                          'parent_imdb_id': ['12345']})
