"""Movie sessions use the selected FamilyHub profile and ordinary Jellyfin accounts."""
import io
import json
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
