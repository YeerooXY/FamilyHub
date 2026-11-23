"""Movie sessions use the selected FamilyHub profile and ordinary Jellyfin accounts."""
import io
import json
import urllib.error
import urllib.parse
from unittest.mock import patch
from test_music_web import Base


class MovieSessions(Base):
    extra = {'FAMILY_PROFILES': True, 'JELLYFIN_PUBLIC_URL': 'https://movies.test',
             'JELLYFIN_PROFILES': {'sample-a': {'username': 'viewer', 'password': 'fixture'}}}

    def select(self, name):
        client = self.app.test_client()
        bootstrap = self.go(client, 'GET', '/api/connect').json
        response = self.post(client, bootstrap['csrf_token'], '/api/profile/select', json={'profile_id': name})
        return client, response.json

    def launch(self, client, selection, **extra):
        return self.post(client, selection['csrf_token'], '/api/movies/session',
                         json={'device': '1' * 32, **extra})

    @patch('music_web.movies.urllib.request.build_opener')
    def test_movie_health_is_scoped_and_independent_of_music(self, opener):
        client, _ = self.select('sample-b')
        self.assertEqual(self.go(client, 'GET', '/api/movies/health').status_code, 404)
        opener.assert_not_called()
        client, _ = self.select('sample-a')
        opener.return_value.open.side_effect = [io.BytesIO(b'Healthy'), TimeoutError()]
        for expected in (True, False):
            self.assertEqual(self.go(client, 'GET', '/api/movies/health').json, {'healthy': expected})
        self.assertEqual(self.go(client, 'GET', '/api/connect').status_code, 200)

    @patch('music_web.movies.urllib.request.build_opener')
    def test_unlinked_profile_cannot_select_another_viewer(self, opener):
        client, selection = self.select('sample-b')
        self.assertFalse(selection['movies_enabled'])
        self.assertEqual(self.launch(client, selection, profile_id='sample-a').status_code, 503)
        opener.assert_not_called()

    @patch('music_web.movies.urllib.request.build_opener')
    def test_regular_session_and_admin_rejection(self, opener):
        client, selection = self.select('sample-a')
        self.assertTrue(selection['movies_enabled'])
        for admin in (False, True):
            data = dict(User={'Id':'viewer-id', 'Name':'viewer', 'Policy':{'IsAdministrator':admin}}, AccessToken='test-token')
            opener.return_value.open.side_effect = [io.BytesIO(json.dumps(data).encode()), io.BytesIO()]
            reply = self.launch(client, selection)
            self.assertEqual(reply.status_code, 403 if admin else 200)
            if admin:
                self.assertNotIn('token', reply.json)
                self.assertTrue(opener.return_value.open.call_args.args[0].full_url.endswith('/Sessions/Logout'))
            else:
                self.assertEqual(reply.json['user'], 'viewer-id')
                self.assertEqual(reply.headers['Cache-Control'], 'no-store')
                self.assertNotIn('password', reply.json)

    def test_client_reports_are_logged_with_fixed_labels_only(self):
        client, selection = self.select('sample-a')
        send = lambda **data: self.post(client, selection['csrf_token'], '/api/movies/report', json=data)
        with self.assertLogs('music_web.movies', 'WARNING') as logs:
            self.assertEqual(send(kind='playback-error', method='Transcode').status_code, 204)
        self.assertIn('playback-error profile=sample-a method=Transcode', logs.output[0])
        # Free text, titles or URLs are rejected, so they cannot reach the log.
        self.assertEqual(send(kind='Two Languages https://x?token=abc').status_code, 400)
        self.assertEqual(send(kind='open-failed', method='file:///secret').status_code, 400)
        other, other_selection = self.select('sample-b')
        reply = self.post(other, other_selection['csrf_token'], '/api/movies/report', json={'kind': 'open-failed'})
        self.assertEqual(reply.status_code, 404)

    @patch('music_web.movies.urllib.request.build_opener')
    def test_failed_session_logs_the_cause_without_credentials(self, opener):
        client, selection = self.select('sample-a')
        opener.return_value.open.side_effect = TimeoutError()
        with self.assertLogs('music_web.movies', 'WARNING') as logs:
            self.assertEqual(self.launch(client, selection).status_code, 503)
        text = '\n'.join(logs.output)
        self.assertIn('TimeoutError', text)
        for secret in ('fixture', 'viewer', 'movies.test'):
            self.assertNotIn(secret, text)

    def test_start_and_stop_reports_name_the_title_in_the_activity_log(self):
        client, selection = self.select('sample-a')
        send = lambda **data: self.post(client, selection['csrf_token'], '/api/movies/report', json=data)
        self.assertEqual(send(kind='started', method='DirectPlay', title='Harbour Lights', minutes=12).status_code, 204)
        self.assertEqual(send(kind='started', title='x' * 201).status_code, 400)
        self.assertEqual(send(kind='stopped', minutes=-3).status_code, 400)


class MovieRequests(Base):
    extra = {**MovieSessions.extra, 'MOVIE_REQUESTS': {
        'enabled': True, 'url': 'http://127.0.0.1:5055', 'api_key': 'fixture-key', 'profiles': {'sample-a': 7}}}
    select = MovieSessions.select

    @patch('music_web.movies.urllib.request.build_opener')
    def test_hungarian_trinity_title_and_sequel_keep_distinct_movie_ids(self, opener):
        title = 'Az ördög jobb és bal keze'
        search = io.BytesIO(json.dumps({'results': [
            dict(mediaType='movie', id=9394, title='They Call Me Trinity', releaseDate='1970-12-22'),
            dict(mediaType='movie', id=11829, title='Trinity Is Still My Name', releaseDate='1971-10-21'),
        ]}).encode())
        search.status = 200
        accepted = io.BytesIO(b'{"id":1,"status":2}')
        accepted.status = 201
        opener.return_value.open.side_effect = [search, accepted]
        client, selection = self.select('sample-a')
        token = selection['csrf_token']

        reply = self.post(client, token, '/api/movies/request-search', json={'query': title})
        self.assertEqual(reply.status_code, 200)
        query = urllib.parse.urlsplit(opener.return_value.open.call_args.args[0].full_url).query
        self.assertEqual(urllib.parse.parse_qs(query)['query'], [title])
        self.assertEqual([(item['id'], item['year']) for item in reply.json['results']], [(9394, '1970'), (11829, '1971')])

        reply = self.post(client, token, '/api/movies/request', json={'kind': 'movie', 'id': 9394})
        self.assertEqual(reply.json, {'state': 'approved'})
        self.assertEqual(json.loads(opener.return_value.open.call_args.args[0].data),
                         {'mediaType': 'movie', 'mediaId': 9394, 'is4k': False})

    @patch('music_web.movies.urllib.request.build_opener')
    def test_search_and_series_request_use_the_mapped_user(self, opener):
        client, selection = self.select('sample-a')
        send = lambda route, **data: self.post(client, selection['csrf_token'], '/api/movies/' + route, json=data)
        search = io.BytesIO(json.dumps({'results': [
            {'mediaType': 'tv', 'id': 12, 'name': 'The Gentlemen', 'firstAirDate': '2024-03-07', 'mediaInfo': {'status': 4}},
            {'mediaType': 'person', 'id': 32, 'name': 'A person'},
            {'mediaType': 'movie', 'id': 11, 'title': 'The Gentlemen', 'releaseDate': '2019-12-03'},
        ]}).encode())
        search.status = 200
        created = io.BytesIO(b'{"id":8,"status":2}')
        created.status = 201
        opener.return_value.open.side_effect = [search, created, urllib.error.HTTPError('', 409, '', None, None)]
        reply = send('request-search', query=' The Gentlemen ', userId=1)
        self.assertEqual(reply.json, {'results': [
            dict(kind='tv', id=12, title='The Gentlemen', year='2024', status=4),
            dict(kind='movie', id=11, title='The Gentlemen', year='2019', status=None),
        ]})
        request = opener.return_value.open.call_args.args[0]
        self.assertTrue(request.full_url.endswith('/api/v1/search?query=The+Gentlemen&page=1'))
        self.assertEqual(request.get_header('X-api-user'), '7')
        self.assertEqual(send('request', kind='tv', id=True).status_code, 400)
        self.assertEqual(send('request', kind='tv', id=12, seasons=[0], userId=1).json, {'state': 'approved'})
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(json.loads(request.data), {'mediaType': 'tv', 'mediaId': 12, 'is4k': False, 'seasons': 'all'})
        self.assertEqual(send('request', kind='movie', id=11).json, {'state': 'existing'})
        self.assertEqual(json.loads(opener.return_value.open.call_args.args[0].data), {'mediaType': 'movie', 'mediaId': 11, 'is4k': False})

    @patch('music_web.movies.urllib.request.build_opener')
    def test_unmapped_profile_cannot_submit_a_request(self, opener):
        client, selection = self.select('sample-b')
        reply = self.post(client, selection['csrf_token'], '/api/movies/request', json={'kind': 'movie', 'id': 12})
        self.assertEqual(reply.status_code, 404)
        opener.assert_not_called()

    @patch('music_web.movies.urllib.request.build_opener')
    def test_numbered_season_search_and_request_keep_the_selected_season(self, opener):
        search = io.BytesIO(json.dumps({'results': [
            dict(mediaType='movie', id=11, title='The Gentlemen'),
            dict(mediaType='tv', id=12, name='The Gentlemen'),
        ]}).encode())
        search.status = 200
        accepted = io.BytesIO(b'{"id":8,"status":2}')
        accepted.status = 201
        opener.return_value.open.side_effect = [search, accepted]
        client, selection = self.select('sample-a')
        token = selection['csrf_token']
        reply = self.post(client, token, '/api/movies/request-search', json={'query': 'The Gentlemen S2'})
        self.assertEqual(reply.json['season'], 2)
        self.assertEqual([item['id'] for item in reply.json['results']], [12])
        request = opener.return_value.open.call_args.args[0]
        self.assertIn('query=The+Gentlemen&', request.full_url)

        reply = self.post(client, token, '/api/movies/request', json={'kind': 'tv', 'id': 12, 'season': 2})
        self.assertEqual(reply.json, {'state': 'approved'})
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(json.loads(request.data)['seasons'], [2])
        reply = self.post(client, token, '/api/movies/request', json={'kind': 'movie', 'id': 11, 'season': 2})
        self.assertEqual(reply.status_code, 400)


class MovieReleaseSearch(Base):
    extra = {**MovieSessions.extra, 'MOVIE_RELEASE_SEARCH': {
        'api_key': 'fixture-key', 'profiles': ['sample-a'], 'indexer_ids': [1, 3]}}
    select = MovieSessions.select

    @patch('music_web.movies.urllib.request.build_opener')
    def test_profiles_partial_results_and_private_download_links(self, opener):
        def lookup(req, timeout):
            self.assertEqual(req.get_method(), 'GET')
            self.assertEqual(req.get_header('X-api-key'), 'fixture-key')
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
            self.assertEqual(query['query'], ['Regular Show S01'])
            if query['indexerIds'] == ['1']:
                raise TimeoutError()
            self.assertEqual(query['indexerIds'], ['3'])
            return io.BytesIO(json.dumps([dict(title='Regular Show S01', indexer='The Pirate Bay', size=123,
                seeders=82, leechers=14, magnetUrl='magnet:fixture', downloadUrl='https://private.test')]).encode())

        opener.return_value.open.side_effect = lookup
        for profile, status in [('sample-b', 404), ('sample-a', 200)]:
            client, selected = self.select(profile)
            reply = self.post(client, selected['csrf_token'], '/api/movies/releases',
                              json={'query': 'Regular Show Season 1', 'indexerIds': [99]})
            self.assertEqual(reply.status_code, status)
        self.assertEqual(reply.json, {'unavailable': 1, 'results': [dict(
            title='Regular Show S01', source='The Pirate Bay', size=123, seeders=82, leechers=14)]})

    @patch('music_web.movies.urllib.request.build_opener')
    def test_season_search_falls_back_to_title_without_mixing_seasons_or_episodes(self, opener):
        wanted = 'The.Gentlemen.S02.1080p.NF.WEB-DL.DDP5.1.ENG.Atmos.ITA.H265-TBK'
        other = ['The.Gentlemen.2024.S01.COMPLETE.1080p', 'The.Gentlemen.S02E01.1080p',
                 'The Gentlemen S01-S02 Complete', 'Gentlemen Jack S02', 'The Gentlemen S02 & 3']

        def lookup(req, timeout):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
            titles = other if query['query'] == ['The Gentlemen S02'] else [*other, wanted]
            self.assertIn(query['query'], (['The Gentlemen S02'], ['The Gentlemen']))
            return io.BytesIO(json.dumps([dict(title=title, indexer='The Pirate Bay') for title in titles]).encode())

        opener.return_value.open.side_effect = lookup
        client, selected = self.select('sample-a')
        reply = self.post(client, selected['csrf_token'], '/api/movies/releases', json={'query': 'The Gentlemen S2'})
        self.assertEqual(reply.status_code, 200)
        self.assertEqual({row['title'] for row in reply.json['results']}, {wanted})
        self.assertEqual(opener.return_value.open.call_count, 4)


class MovieDownloads(Base):
    extra = {**MovieReleaseSearch.extra, 'MOVIE_DOWNLOADS': {
        'profiles': ['sample-a'],
        'qbittorrent': {'url': 'http://downloads.test', 'user': 'fixture-user', 'password': 'fixture-password'}}}
    select = MovieSessions.select
    guid = 'https://private-indexer.test/download?key=private-indexer-key'

    @patch('music_web.movies.urllib.request.build_opener')
    def test_search_and_grab_require_permission_and_keep_indexer_links_private(self, opener):
        def upstream(req, timeout):
            if req.get_method() == 'POST':
                return io.BytesIO(b'{"downloadUrl":"https://private-indexer.test"}')
            indexer = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)['indexerIds'][0]
            rows = [dict(title='Sample Release', indexerId=1, guid=self.guid,
                         magnetUrl='magnet:fixture', downloadUrl=self.guid)] if indexer == '1' else []
            return io.BytesIO(json.dumps(rows).encode())

        opener.return_value.open.side_effect = upstream
        client, profile = self.select('sample-a')
        search = self.post(client, profile['csrf_token'], '/api/movies/releases', json={'query': 'Sample Release'})
        row, = search.json['results']
        self.assertEqual(row['indexerId'], 1)
        self.assertNotIn(self.guid, search.get_data(as_text=True))
        self.assertNotIn('magnet:', search.get_data(as_text=True))
        payload = dict(guid=row['guid'], indexer_id=1, title=row['title'])
        other, selected = self.select('sample-b')
        denied = self.post(other, selected['csrf_token'], '/api/movies/download', json=payload)
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(opener.return_value.open.call_count, 2)
        mismatched = self.post(client, profile['csrf_token'], '/api/movies/download', json={**payload, 'indexer_id': 3})
        self.assertEqual(mismatched.status_code, 404)
        reply = self.post(client, profile['csrf_token'], '/api/movies/download', json=payload)
        self.assertEqual(reply.json, {'state': 'sent'})
        req = opener.return_value.open.call_args.args[0]
        self.assertTrue(req.full_url.endswith('/api/v1/search'))
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.get_header('X-api-key'), 'fixture-key')
        self.assertEqual(json.loads(req.data), [{'guid': self.guid, 'indexerId': 1}])

    @patch('music_web.movies.urllib.request.build_opener')
    def test_grab_uses_single_release_if_array_binding_fails_and_sanitizes_errors(self, opener):
        def upstream_error(code, detail):
            return urllib.error.HTTPError('http://prowlarr.test', code, 'fixture', {}, io.BytesIO(detail))

        def upstream(req, timeout):
            if req.get_method() == 'GET':
                indexer = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)['indexerIds'][0]
                return io.BytesIO(json.dumps([dict(title='Sample Release', guid=self.guid)] if indexer == '1' else []).encode())
            payload = json.loads(req.data)
            if isinstance(payload, list):
                raise upstream_error(400, b'{"errors":{"$":["could not be converted to ReleaseResource"]}}')
            self.assertEqual(payload, {'guid': self.guid, 'indexerId': 1})
            raise next(errors)

        errors = iter([upstream_error(500, b"Download client isn't configured yet fixture-key"),
                       upstream_error(404, self.guid.encode())])
        opener.return_value.open.side_effect = upstream
        client, profile = self.select('sample-a')
        csrf = profile['csrf_token']
        search = self.post(client, csrf, '/api/movies/releases', json={'query': 'Sample Release'})
        row, = search.json['results']
        with self.assertNoLogs('music_web.movies', 'WARNING'):
            for status, error in [(503, 'Prowlarr has no download client set up for this release.'),
                                  (404, 'This release is no longer available. Search again.')]:
                reply = self.post(client, csrf, '/api/movies/download',
                                  json=dict(guid=row['guid'], indexer_id=1, title=row['title']))
                self.assertEqual((reply.status_code, reply.json), (status, {'error': error}))

    @patch('music_web.movies.urllib.request.build_opener')
    def test_queue_mapping_cache_and_private_login(self, opener):
        states = [('queuedDL', 0, 'Waiting'), ('downloading', .4, 'Downloading'),
                  ('forcedDL', .95, 'Almost done'), ('stalledUP', 2, 'Finished'),
                  ('stalledDL', .2, 'Stalled'), ('stoppedDL', .2, 'Paused'), ('missingFiles', 1, 'Problem'),
                  ('moving', 1, 'Almost done')]
        rows = [dict(name=state, progress=progress, size=200, state=state, dlspeed=10,
                     eta=8640000 if index == 0 else 65, tracker=self.guid)
                for index, (state, progress, _) in enumerate(states)]
        opener.return_value.open.side_effect = [io.BytesIO(b'Ok.'), io.BytesIO(json.dumps(rows).encode()),
                                                 TimeoutError('fixture-password')]
        anon = self.go(self.app.test_client(), 'GET', '/api/movies/downloads')
        self.assertEqual(anon.status_code, 401)
        first, _ = self.select('sample-b')
        other, _ = self.select('sample-a')
        with patch('music_web.movies.monotonic', side_effect=[10, 10, 12.99, 13, 13]):
            with self.assertNoLogs('music_web.movies', 'WARNING'):
                reply = self.go(first, 'GET', '/api/movies/downloads')
                self.assertEqual(reply.headers['Cache-Control'], 'no-store')
                self.assertEqual(reply.json, dict(available=True, items=[
                    dict(name=state, progress=min(1, progress), size=200, state=label,
                         eta=None if index == 0 else 65, speed=10)
                    for index, (state, progress, label) in enumerate(states)]))
                self.assertEqual(self.go(other, 'GET', '/api/movies/downloads').json, reply.json)
                self.assertEqual(self.go(other, 'GET', '/api/movies/downloads').json,
                                 dict(available=False, reason='The download server is unavailable.'))
        login, info, _ = opener.return_value.open.call_args_list
        self.assertEqual(login.args[0].full_url, 'http://downloads.test/api/v2/auth/login')
        self.assertEqual(urllib.parse.parse_qs(login.args[0].data.decode()),
                         {'username': ['fixture-user'], 'password': ['fixture-password']})
        self.assertEqual(info.args[0], 'http://downloads.test/api/v2/torrents/info?category=familyhub')
        self.assertEqual([login.kwargs['timeout'], info.kwargs['timeout']], [2, 2])


class MovieWebSearch(MovieSessions):
    FULL = {'id': 'aaaaaaaaaaa', 'title': 'Az ördög jobb és bal keze 2 | Teljes Film Magyarul', 'channel': 'Film', 'seconds': 6600, 'views': 9000, 'url': 'https://www.youtube.com/watch?v=aaaaaaaaaaa'}
    TRAILER = {'id': 'bbbbbbbbbbb', 'title': 'Az ördög jobb és bal keze 2 előzetes', 'channel': 'Film', 'seconds': 100, 'views': 50, 'url': 'https://www.youtube.com/watch?v=bbbbbbbbbbb'}

    def find(self, client, selection, query='Az ördög jobb és bal keze 2'):
        return self.post(client, selection['csrf_token'], '/api/movies/find', json={'query': query})

    @patch('music_web.movie_search.youtube_candidates')
    def test_basic_ranking_puts_the_full_film_first_and_labels_the_trailer(self, candidates):
        candidates.return_value = [self.TRAILER, self.FULL]
        client, selection = self.select('sample-a')
        reply = self.find(client, selection)
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json['ranking'], 'basic')
        self.assertEqual([(r['id'][0], r['label']) for r in reply.json['results']], [('a', 'full film'), ('b', 'trailer')])

    @patch('music_web.movie_search.youtube_candidates')
    def test_model_cannot_add_links_or_unknown_labels(self, candidates):
        from music_web import movie_search
        candidates.return_value = [self.TRAILER, self.FULL]
        reply = {'results': [{'id': 'zzzzzzzzzzz', 'label': 'full film', 'reason': 'invented'},
                             {'id': 'aaaaaaaaaaa', 'label': 'masterpiece', 'reason': 'Best match https://evil.test/x for sure'},
                             {'id': 'aaaaaaaaaaa', 'label': 'full film', 'reason': 'again'}]}
        ranked = movie_search.validate_model(reply, [self.TRAILER, self.FULL])
        self.assertEqual([r['id'] for r in ranked], ['aaaaaaaaaaa'])
        self.assertEqual(ranked[0]['label'], 'other')
        self.assertNotIn('evil.test', ranked[0]['reason'])
        self.assertEqual(ranked[0]['url'], self.FULL['url'])
        self.assertIsNone(movie_search.validate_model({'results': [{'id': 'zzzzzzzzzzz'}]}, [self.FULL]))
        self.assertIsNone(movie_search.validate_model('not json', [self.FULL]))

    @patch('music_web.movie_search.youtube_candidates')
    def test_the_search_text_is_never_logged(self, candidates):
        candidates.return_value = [self.FULL]
        client, selection = self.select('sample-a')
        with self.assertLogs('music_web.movies', 'INFO') as logs:
            reply = self.find(client, selection)
        self.assertEqual(reply.json['ranking'], 'basic')
        self.assertNotIn('ördög', '|'.join(logs.output))

    def test_model_failure_and_success_paths(self):
        from music_web import movie_search
        both = [self.TRAILER, self.FULL]
        key = {'GEMINI_API_KEY': 'k'}
        self.assertEqual(movie_search.find('q', key, lambda q: both, lambda *a: None)['ranking'], 'basic')
        ranked = [dict(self.FULL, label='full film', reason='Complete film')]
        self.assertEqual(movie_search.find('q', key, lambda q: both, lambda *a: ranked)['ranking'], 'model')
        self.assertEqual(movie_search.find('q', {}, lambda q: both, lambda *a: ranked)['ranking'], 'basic')

    def test_input_limits_and_unlinked_profile(self):
        client, selection = self.select('sample-a')
        self.assertEqual(self.find(client, selection, 'x').status_code, 400)
        self.assertEqual(self.find(client, selection, 'y' * 121).status_code, 400)
        other, other_selection = self.select('sample-b')
        self.assertEqual(self.find(other, other_selection).status_code, 404)

    @patch('music_web.movie_search.youtube_candidates', side_effect=LookupError('yt-dlp is not installed'))
    def test_missing_search_tool_is_a_plain_message(self, candidates):
        client, selection = self.select('sample-a')
        reply = self.find(client, selection)
        self.assertEqual(reply.status_code, 503)
        self.assertNotIn('yt-dlp', reply.json['error'])

    @patch('music_web.movie_search.youtube_candidates', return_value=[])
    def test_search_is_rate_limited(self, candidates):
        client, selection = self.select('sample-a')
        codes = [self.find(client, selection).status_code for _ in range(8)]
        self.assertEqual(codes[:6], [200] * 6)
        self.assertEqual(codes[6:], [429, 429])
