"""Offline MDBList ratings and Trakt link tests. Nothing here reaches MDBList, Trakt or Jellyfin."""
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import test_music_web
from music_web import movie_trakt

UID = '0123456789abcdef0123456789abcdef'
CONFIG = f'/Plugins/{movie_trakt.PLUGIN_ID}/Configuration'


def reply(value):
    return io.BytesIO(json.dumps(value).encode())


class FakeServices:
    """Stands in for urllib's opener: MDBList, the Jellyfin Trakt plugin and nothing else."""

    def __init__(self, users=None, authorized=False, error=None):
        self.config = {'TraktUsers': users if users is not None else []}
        self.authorized, self.error, self.calls, self.posted = authorized, error, [], None

    def open(self, req, timeout=None):
        url = urlsplit(req.full_url)
        self.calls.append((req.get_method(), url.hostname, url.path))
        if self.error:
            raise self.error
        if url.hostname == 'api.mdblist.com':
            return reply({'ratings': [{'source': 'imdb', 'value': 7.8}, {'source': 'tomatoes', 'value': 91},
                                      {'source': 'metacritic', 'value': 74}, {'source': 'letterboxd', 'value': 4}]})
        if url.path == '/Users':
            return reply([{'Id': UID, 'Name': 'Viewer'}, {'Id': 'f' * 32, 'Name': 'someone'}])
        if url.path == CONFIG and req.get_method() == 'POST':
            self.posted = self.config = json.loads(req.data)
            return reply({})
        if url.path == CONFIG:
            return reply(self.config)
        if url.path.endswith('/Authorize'):
            return reply({'userCode': 'ABCD1234', 'verificationUrl': 'https://evil.test/x', 'expiresIn': 600, 'interval': 5})
        if url.path.endswith('/PollAuthorizationStatus'):
            return reply({'isAuthorized': self.authorized})
        if url.path.endswith('/Deauthorize') and req.get_method() == 'POST':
            uid = url.path.split('/')[-2]
            self.config['TraktUsers'] = [user for user in self.config['TraktUsers'] if user.get('LinkedMbUserId') != uid]
            return reply('')
        raise AssertionError(url.path)


class Parsing(test_music_web.unittest.TestCase):
    def test_keeps_known_sources_in_order_and_formats_values(self):
        rows = [{'source': 'metacritic', 'value': 74}, {'source': 'imdb', 'value': 7.8}, {'source': 'tomatoes', 'value': 91},
                {'source': 'tomatoes', 'value': 12}, {'source': 'trakt', 'value': 80}]
        self.assertEqual(movie_trakt.parse({'ratings': rows}), [
            {'source': 'imdb', 'name': 'IMDb', 'value': '7.8'},
            {'source': 'tomatoes', 'name': 'Rotten Tomatoes', 'value': '91%'},
            {'source': 'metacritic', 'name': 'Metacritic', 'value': '74'}])

    def test_drops_missing_zero_out_of_range_and_malformed_values(self):
        bad = [{'source': 'imdb', 'value': None}, {'source': 'tomatoes', 'value': 0}, {'source': 'metacritic', 'value': 101},
               {'source': 'imdb', 'value': True}, {'source': 'imdb', 'value': '7'}, 'x', None]
        self.assertEqual(movie_trakt.parse({'ratings': bad}), [])
        for junk in (None, [], {}, {'ratings': 'x'}):
            self.assertEqual(movie_trakt.parse(junk), [])


class Store(test_music_web.unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'ratings.json'
        self.now, self.fetched = 1_700_000_000, []

    def store(self, key='secret', fail=False):
        def fetch(kind, provider, ident, api_key):
            self.fetched.append((kind, provider, ident))
            if fail:
                raise OSError('fixture-secret')
            return {'ratings': [{'source': 'imdb', 'value': 8}]}
        return movie_trakt.RatingStore(self.path, key, fetch, clock=lambda: self.now)

    def test_no_key_never_fetches(self):
        self.assertIsNone(self.store(key='').get('movie', 'imdb', 'tt1'))
        self.assertEqual(self.fetched, [])

    def test_cache_lasts_seven_days_and_survives_a_restart(self):
        self.assertEqual(self.store().get('movie', 'imdb', 'tt1')[0]['value'], '8.0')
        self.now += 7 * 86400 - 1
        self.assertEqual(self.store().get('movie', 'imdb', 'tt1')[0]['value'], '8.0')
        self.assertEqual(len(self.fetched), 1)
        self.now += 2
        self.store().get('movie', 'imdb', 'tt1')
        self.assertEqual(len(self.fetched), 2)

    def test_daily_budget_stops_lookups_logs_once_and_resets_next_day(self):
        with patch.object(movie_trakt, 'DAILY_BUDGET', 2), self.assertLogs('music_web.movie_trakt', 'WARNING') as logs:
            store = self.store()
            self.assertIsNotNone(store.get('movie', 'imdb', 'tt1'))
            self.assertIsNotNone(store.get('movie', 'imdb', 'tt2'))
            self.assertIsNone(store.get('movie', 'imdb', 'tt3'))
            self.assertIsNone(store.get('movie', 'imdb', 'tt4'))
            self.assertEqual(len(self.fetched), 2)
            self.assertEqual(len(logs.output), 1)
            self.now += 86400
            self.assertIsNotNone(store.get('movie', 'imdb', 'tt3'))

    def test_a_failed_lookup_is_quiet_for_the_page_and_not_retried_at_once(self):
        with self.assertLogs('music_web.movie_trakt', 'WARNING') as logs:
            store = self.store(fail=True)
            self.assertIsNone(store.get('movie', 'imdb', 'tt1'))
            self.assertIsNone(store.get('movie', 'imdb', 'tt1'))
        self.assertEqual(len(self.fetched), 1)
        self.assertIn('cause=OSError', logs.output[0])
        self.assertNotIn('fixture-secret', logs.output[0])


class Routes(test_music_web.Base):
    extra = {
        'FAMILY_PROFILES': True,
        'JELLYFIN_PUBLIC_URL': 'https://movies.test',
        'JELLYFIN_API_KEY': 'jellyfin-secret',
        'JELLYFIN_PROFILES': {'sample-a': {'username': 'viewer', 'password': 'fixture'}},
        'MDBLIST_API_KEY': 'mdblist-secret',
        'TRAKT_CLIENT_ID': '',
    }

    def viewer(self, name='sample-a'):
        client = self.app.test_client()
        token = self.go(client, 'GET', '/api/connect').json['csrf_token']
        self.assertEqual(self.post(client, token, '/api/profile/select', json=self.profile_credentials(name)).status_code, 200)
        # Selecting a profile starts a new session with its own CSRF token.
        return client, self.go(client, 'GET', '/api/connect').json['csrf_token']

    def services(self, **kwargs):
        fake = FakeServices(**kwargs)
        patcher = patch('music_web.movie_trakt.urllib.request.build_opener')
        patcher.start().return_value = fake
        self.addCleanup(patcher.stop)
        return fake

    def test_ratings_come_from_one_cached_lookup(self):
        fake = self.services()
        client, _ = self.viewer()
        route = '/api/movies/ratings?kind=movie&imdb=tt0111161'
        result = self.go(client, 'GET', route)
        self.assertEqual([row['value'] for row in result.json['ratings']], ['7.8', '91%', '74'])
        self.assertEqual(self.go(client, 'GET', route).json, result.json)
        self.assertEqual(fake.calls, [('GET', 'api.mdblist.com', '/imdb/movie/tt0111161')])
        self.assertNotIn('mdblist-secret', result.get_data(as_text=True))

    def test_ratings_by_tmdb_id_and_series_kind(self):
        fake = self.services()
        client, _ = self.viewer()
        self.go(client, 'GET', '/api/movies/ratings?kind=tv&tmdb=1396')
        self.assertEqual(fake.calls[-1][2], '/tmdb/show/1396')

    def test_ratings_reject_bad_input_and_unlinked_profiles(self):
        fake = self.services()
        client, _ = self.viewer()
        for query in ('', 'kind=movie', 'kind=person&imdb=tt1', 'kind=movie&imdb=1', 'kind=episode&tmdb=5', 'kind=movie&tmdb=0'):
            self.assertEqual(self.go(client, 'GET', '/api/movies/ratings?' + query).status_code, 400)
        self.assertIn(self.go(self.viewer('sample-b')[0], 'GET', '/api/movies/ratings?kind=movie&imdb=tt1').status_code, (403, 404))
        self.assertEqual(fake.calls, [])

    def test_ratings_failure_gives_an_empty_list_not_an_error(self):
        self.services(error=OSError('fixture-secret'))
        client, _ = self.viewer()
        result = self.go(client, 'GET', '/api/movies/ratings?kind=movie&imdb=tt1')
        self.assertEqual((result.status_code, result.json), (200, {'ratings': []}))


class NoKey(Routes):
    extra = {**Routes.extra, 'MDBLIST_API_KEY': None}

    def test_without_a_key_there_are_no_chips_and_no_requests(self):
        fake = self.services()
        client, _ = self.viewer()
        result = self.go(client, 'GET', '/api/movies/ratings?kind=movie&imdb=tt0111161')
        self.assertEqual((result.status_code, result.json), (200, {'ratings': []}))
        self.assertEqual(fake.calls, [])

    test_ratings_come_from_one_cached_lookup = test_ratings_by_tmdb_id_and_series_kind = None
    test_ratings_reject_bad_input_and_unlinked_profiles = test_ratings_failure_gives_an_empty_list_not_an_error = None


class TraktLink(Routes):
    def test_unlinked_profile_starts_the_device_flow_with_a_fixed_address(self):
        fake = self.services()
        client, token = self.viewer()
        self.assertEqual(self.go(client, 'GET', '/api/trakt/status').json, {'linked': False})
        result = self.post(client, token, '/api/trakt/link')
        self.assertEqual(result.json, {'user_code': 'ABCD1234', 'url': 'https://trakt.tv/activate', 'expires_in': 600, 'interval': 5})
        self.assertIn(('POST', '127.0.0.1', f'/Trakt/Users/{UID}/Authorize'), fake.calls)
        self.assertEqual(self.post(client, token, '/api/trakt/link/poll').json, {'linked': False})
        fake.authorized = True
        self.assertEqual(self.post(client, token, '/api/trakt/link/poll').json, {'linked': True})

    def test_linked_profile_shows_state_without_tokens_and_toggles_sending(self):
        fake = self.services(users=[{'LinkedMbUserId': UID, 'AccessToken': 'trakt-token', 'RefreshToken': 'r', 'Scrobble': False},
                                    {'LinkedMbUserId': 'f' * 32, 'AccessToken': 'other'}])
        client, token = self.viewer()
        status = self.go(client, 'GET', '/api/trakt/status')
        self.assertEqual(status.json, {'linked': True, 'send': False, 'name': None})
        self.assertNotIn('trakt-token', status.get_data(as_text=True))
        self.assertEqual(self.post(client, token, '/api/trakt/send', json={'send': True}).json, {'ok': True})
        mine = next(user for user in fake.posted['TraktUsers'] if user['LinkedMbUserId'] == UID)
        self.assertTrue(mine['Scrobble'])
        self.assertEqual(len(fake.posted['TraktUsers']), 2)
        self.assertEqual(self.post(client, token, '/api/trakt/send', json={'send': 'yes'}).status_code, 400)

    def test_disconnect_removes_only_this_profiles_link(self):
        fake = self.services(users=[{'LinkedMbUserId': UID, 'AccessToken': 't'}, {'LinkedMbUserId': 'f' * 32, 'AccessToken': 'o'}])
        client, token = self.viewer()
        self.assertEqual(self.post(client, token, '/api/trakt/disconnect').json, {'ok': True})
        # Disconnect goes through the plugin's Deauthorize, which revokes the token at Trakt for this profile only.
        self.assertIn(('POST', fake.calls[-1][1], f'/Trakt/Users/{UID}/Deauthorize'), fake.calls)
        self.assertEqual([user['LinkedMbUserId'] for user in fake.config['TraktUsers']], ['f' * 32])

    def test_plugin_failures_are_plain_and_report_their_cause(self):
        self.services(error=OSError('http://secret.test refused 500'))
        client, token = self.viewer()
        with self.assertLogs('music_web.movie_trakt', 'WARNING') as logs:
            for result in (self.go(client, 'GET', '/api/trakt/status'), self.post(client, token, '/api/trakt/link'),
                           self.post(client, token, '/api/trakt/link/poll')):
                self.assertEqual(result.status_code, 503)
                self.assertEqual(result.json, {'error': 'Could not reach Trakt through Jellyfin. Try again in a minute.'})
        self.assertEqual(len(logs.output), 3)
        self.assertTrue(all('cause=OSError' in line and 'secret.test' not in line for line in logs.output))

    def test_a_reply_without_a_usable_code_is_a_failure(self):
        fake = self.services()
        fake.open_original = fake.open
        fake.open = lambda req, timeout=None: reply({'userCode': '<b>'}) if req.full_url.endswith('/Authorize') else fake.open_original(req, timeout)
        client, token = self.viewer()
        self.assertEqual(self.post(client, token, '/api/trakt/link').status_code, 503)

    def test_requires_csrf_and_a_linked_profile(self):
        self.services()
        client, _ = self.viewer()
        self.assertIn(self.go(client, 'POST', '/api/trakt/link').status_code, (400, 403))
        self.assertIn(self.go(self.viewer('sample-b')[0], 'GET', '/api/trakt/status').status_code, (403, 404))
