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
