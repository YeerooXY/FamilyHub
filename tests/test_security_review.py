import io
import json
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch

from waitress.adjustments import Adjustments

from music_web.http_limits import BodyLimitedParser, SMALL_BODY_LIMIT
from test_music_web import Base, ORIGIN, PASSWORD, PROFILE_HASH


class ProtectedProfiles(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a'], 'JELLYFIN_PROFILES': {'sample-b': {}},
             'PROFILE_PASSWORD_HASHES': {'sample-a': PROFILE_HASH}}

    def test_credentials_are_required_on_both_selection_paths_and_replay_fails(self):
        client = self.app.test_client()
        connect = self.go(client, 'GET', '/api/connect')
        self.assertTrue(all(p['requires_password'] for p in connect.json['profiles']))
        self.assertNotIn(PROFILE_HASH, connect.get_data(as_text=True))
        csrf = connect.json['csrf_token']
        for name in ('sample-a', 'sample-b'):
            self.assertEqual(self.post(client, csrf, '/api/profile/select', json={'profile_id': name}).status_code, 403)
            self.assertEqual(self.go(client, 'POST', '/login', data={'profile_id': name, 'csrf_token': csrf}).status_code, 403)
        self.assertEqual(self.go(client, 'GET', '/api/server/stats').status_code, 401)
        selected = self.post(client, csrf, '/api/profile/select', json=self.profile_credentials('sample-a'))
        self.assertEqual(selected.status_code, 200)
        self.assertIn('Secure; HttpOnly;', selected.headers['Set-Cookie'])
        self.assertIn('SameSite=Lax', selected.headers['Set-Cookie'])
        self.assertEqual(self.go(client, 'GET', '/api/server/stats').status_code, 200)
        cookie = client.get_cookie('familyhub_music', domain='music.test').value
        self.go(client, 'POST', '/logout', data={'csrf_token': selected.json['csrf_token']})
        client.set_cookie('familyhub_music', cookie, domain='music.test')
        self.assertEqual(self.go(client, 'GET', '/api/server/stats').status_code, 401)
        with client.session_transaction(base_url=ORIGIN) as old_cookie:
            old_cookie['family_profile'] = 'sample-a'
        self.assertEqual(self.go(client, 'GET', '/api/server/stats').status_code, 401)
        browser = self.go(client, 'POST', '/login', data={'profile_id': 'sample-a', 'password': PASSWORD,
                          'csrf_token': self.token(client, '/login')})
        self.assertEqual(browser.status_code, 302)
        self.assertEqual(self.go(client, 'GET', '/api/server/stats').status_code, 200)

    def test_protected_profile_guesses_are_limited(self):
        client = self.app.test_client()
        csrf = self.go(client, 'GET', '/api/connect').json['csrf_token']
        for _ in range(8):
            self.assertEqual(self.post(client, csrf, '/api/profile/select', json={
                'profile_id': 'sample-a', 'password': 'wrong'}).status_code, 403)
        self.assertEqual(self.post(client, csrf, '/api/profile/select', json=self.profile_credentials('sample-a')).status_code, 429)


class PrivateFiles(Base):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.extra = {'FAMILY_PROFILES': True, 'FILES_ROOT': workspace.name}
        super().setUp()
        self.addCleanup(self.app.extensions['files'].db.close)

    def test_passwordless_profiles_have_shared_access_only(self):
        client = self.app.test_client()
        csrf = self.go(client, 'GET', '/api/connect').json['csrf_token']
        auth = self.post(client, csrf, '/api/profile/select', json={'profile_id': 'sample-a'}).json
        self.assertEqual(self.go(client, 'GET', '/api/files/list?space=family').status_code, 200)
        self.assertEqual(self.go(client, 'GET', '/api/files/list?space=mine').status_code, 403)
        folder = Path(self.extra['FILES_ROOT']) / 'profiles' / 'sample-a'
        folder.mkdir()
        (folder / 'old.txt').write_bytes(b'private')
        store = self.app.extensions['files']
        link, _, _ = store.create_link('sample-a', 'mine', ['old.txt'], 1, None, None)
        self.assertEqual(self.go(client, 'GET', '/api/files/links').json['links'], [])
        self.assertEqual(self.go(client, 'DELETE', '/api/files/links/' + link,
                                 headers={'X-CSRFToken': auth['csrf_token']}).status_code, 404)


class RequestBoundaries(Base):
    def test_chunked_json_respects_endpoint_limit_and_upload_names_are_safe(self):
        client, csrf = self.signed_in()
        response = self.post(client, csrf, '/api/playlists', data=json.dumps({'name': 'a' * 9000}),
                             content_type='application/json', environ_overrides={'CONTENT_LENGTH': '', 'wsgi.input_terminated': True})
        self.assertEqual(response.status_code, 413)
        upload = self.post(client, csrf, '/api/uploads', data={'file': (io.BytesIO(b'data'), '-track.mp3')})
        self.assertEqual(upload.status_code, 400)
        with self.assertRaises(self.intake.IntakeError):
            self.intake.safe_name('-track', 'title')

    def test_rejected_request_logs_omit_request_data(self):
        bearer = 'fixture-credential'
        with self.assertLogs(self.app.logger, 'WARNING') as logs:
            bad_host = self.app.test_client().get('/api/share/' + bearer, base_url='https://wrong.test')
            bad_origin = self.go(self.app.test_client(), 'POST', '/api/share/' + bearer + '/download',
                                 headers={'Origin': 'https://' + bearer + '.test'})
        self.assertEqual((bad_host.status_code, bad_origin.status_code), (400, 403))
        self.assertNotIn(bearer, '\n'.join(logs.output))

    def test_documented_activity_fields_remove_urls_and_credential_text(self):
        from music_web.feedback import log_text
        self.assertEqual(log_text('Film https://fixture.test/hidden?api_key=secret token=hidden', 120),
                         'Film [url] [credential]')

    def test_artwork_redirect_is_refused_before_following(self):
        from music_web import NoRedirect
        client, _ = self.signed_in()
        with patch('music_web.urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect = lambda *args, **kw: NoRedirect().redirect_request(
                None, None, 302, 'redirect', {}, 'https://elsewhere.test/art.jpg')
            status = self.go(client, 'GET', '/api/artwork/abcdefghijk').status_code
        self.assertEqual(status, 404)
        opener.assert_called_once_with(NoRedirect)


class WaitressLimits(unittest.TestCase):
    def test_buffers_large_requests_only_on_explicit_uploads_with_length(self):
        shared = Adjustments(max_request_body_size=512 << 20)
        for method, path, header, denied in [('POST', '/api/profiles', 'Content-Length: 2000000', True),
                                             ('POST', '/api/feedback', 'Content-Length: 2000000', False),
                                             ('PUT', '/api/uploads', 'Content-Length: 2000000', True),
                                             ('POST', '/api/uploads', 'Content-Length: 2000000', False),
                                             ('PUT', '/api/files/upload', 'Content-Length: 2000000', False),
                                             ('PUT', '/api/files/upload', 'Transfer-Encoding: chunked', False)]:
            with self.subTest(method=method, path=path, header=header):
                parser = BodyLimitedParser(shared)
                parser.received(f'{method} {path} HTTP/1.1\r\nHost: example.test\r\n{header}\r\n\r\n'.encode())
                if parser.chunked:
                    length = SMALL_BODY_LIMIT + 1
                    parser.received(f'{length:x}\r\n'.encode() + b'x' * length + b'\r\n0\r\n\r\n')
                    denied = True
                self.assertEqual(parser.error is not None, denied)
                self.assertEqual(shared.max_request_body_size, 512 << 20)


class DeploymentGuidance(unittest.TestCase):
    def test_bootstrap_uses_a_restricted_owner_supplied_key(self):
        guide = (Path(__file__).resolve().parents[1] / 'docs' / 'NEW_SERVER.md').read_text(encoding='utf-8')
        script = guide.split('## 3. Let the lead agent in', 1)[1].split('```sh\n', 1)[1].split('```', 1)[0]
        self.assertIn('ssh-keygen -lf /root/familyhub-lead.pub', script)
        self.assertIn("printf 'restrict %s\\n'", script)
        self.assertNotIn('NOPASSWD', script)
        self.assertNotIn('ssh-ed25519 ', script)


class MovieGrants(Base):
    extra = {'FAMILY_PROFILES': True, 'JELLYFIN_PUBLIC_URL': 'https://movies.test',
             'JELLYFIN_INTERNAL_URL': 'http://127.0.0.1:8096/jellyfin',
             'JELLYFIN_PROFILES': {'sample-a': {'username': 'viewer', 'password': 'fixture-password'},
                                  'sample-b': {'username': 'other-viewer', 'password': 'fixture-password'}},
             'MOVIE_DOWNLOADS': {'profiles': ['sample-a']}}
    item = 'a' * 32

    def select(self, name='sample-a'):
        client = self.app.test_client()
        csrf = self.go(client, 'GET', '/api/connect').json['csrf_token']
        return client, self.post(client, csrf, '/api/profile/select', json=self.profile_credentials(name)).json['csrf_token']

    def grant(self, client, csrf, opener, viewer='viewer'):
        login = {'User': {'Id': viewer + '-id', 'Name': viewer, 'Policy': {'IsAdministrator': False}},
                 'AccessToken': 'upstream-secret'}
        opener.return_value.open.return_value = io.BytesIO(json.dumps(login).encode())
        response = self.post(client, csrf, '/api/movies/session', json={'device': '1' * 32})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertNotIn('upstream-secret', response.get_data(as_text=True))
        return response.json

    @patch('music_web.movies.urllib.request.build_opener')
    def test_authorized_movie_library_keeps_credentials_off_client_and_validates_paths(self, opener):
        client, csrf = self.select()
        movie = self.grant(client, csrf, opener)
        path = 'Items/' + self.item + '/PlaybackInfo'
        upstream = {'MediaSources': [{'Id': self.item, 'Path': '/internal/title.mkv', 'AccessToken': 'upstream-secret',
                    'TranscodingUrl': f'/jellyfin/Videos/{self.item}/master.m3u8?api_key=upstream-secret&x=1'}]}
        opener.return_value.open.return_value = io.BytesIO(json.dumps(upstream).encode())
        data = dict(ticket=movie['media_ticket'], path=path, query='userId=another', payload={})
        answer = self.post(client, csrf, '/api/movies/library', json=data)
        self.assertEqual(answer.status_code, 200, answer.json)
        self.assertEqual(answer.json['result']['MediaSources'], [{'Id': self.item,
                         'TranscodingUrl': f'/Videos/{self.item}/master.m3u8?x=1'}])
        req = opener.return_value.open.call_args.args[0]
        self.assertTrue(req.full_url.endswith('?userId=viewer-id'))
        self.assertIn('Token="upstream-secret"', req.get_header('Authorization'))
        opener.reset_mock()
        self.assertEqual(self.post(client, csrf, '/api/movies/library', json={**data, 'path': 'System/Info'}).status_code, 400)
        other, other_csrf = self.select()
        self.assertEqual(self.post(other, other_csrf, '/api/movies/library', json=data).status_code, 404)
        opener.assert_not_called()

    @patch('music_web.movies.urllib.request.build_opener')
    def test_movie_favorite_changes_only_the_granted_viewers_state(self, opener):
        client, csrf = self.select()
        movie = self.grant(client, csrf, opener)
        data = dict(ticket=movie['media_ticket'], path=f'UserFavoriteItems/{self.item}', query='')
        for favorite, method in [(True, 'POST'), (False, 'DELETE')]:
            opener.return_value.open.return_value = io.BytesIO(b'{"IsFavorite":' + json.dumps(favorite).encode() + b'}')
            reply = self.post(client, csrf, '/api/movies/library', json={**data, 'payload': {'favorite': favorite}})
            self.assertEqual(reply.json, {'result': {'IsFavorite': favorite}})
            req = opener.return_value.open.call_args.args[0]
            self.assertTrue(req.full_url.endswith(f'/Users/viewer-id/FavoriteItems/{self.item}'))
            self.assertEqual(req.get_method(), method)
        opener.reset_mock()
        for invalid in [{'query': 'userId=other', 'payload': {'favorite': True}}, {'payload': {'favorite': 'false'}}, {'payload': None}]:
            self.assertEqual(self.post(client, csrf, '/api/movies/library', json={**data, **invalid}).status_code, 400)
        opener.assert_not_called()

    @patch('music_web.movies.urllib.request.build_opener')
    def test_resume_dismissal_uses_only_the_allowed_viewer_action(self, opener):
        client, csrf = self.select()
        movie = self.grant(client, csrf, opener)
        route = '/api/movies/library'
        path = f'UserItems/{self.item}/HideFromResume'
        data = dict(ticket=movie['media_ticket'], path=path, query='hide=true', payload={'positionTicks': 120000000})
        opener.reset_mock()
        for invalid in ({'path': path + '/anything'}, {'path': f'UserItems/{"-" * 32}/HideFromResume'},
                        {'query': 'hide=false'}, {'query': 'hide=true&userId=other'},
                        {'payload': None}, {'payload': {'positionTicks': True}}):
            self.assertEqual(self.post(client, csrf, route, json={**data, **invalid}).status_code, 400)
        opener.assert_not_called()
        upstream = opener.return_value.open
        upstream.return_value = io.BytesIO()
        self.assertEqual(self.post(client, csrf, route, json=data).json, {'result': None})
        req = upstream.call_args.args[0]
        self.assertTrue(req.full_url.endswith(f'/{path}?hide=true&userId=viewer-id'))
        self.assertEqual((req.get_method(), req.data), ('POST', b''))

        upstream.side_effect = urllib.error.HTTPError(req.full_url, 404, 'Not found', {}, None)
        self.assertEqual(self.post(client, csrf, route, json=data).json, {'result': None})
        upstream.side_effect = None
        entry = {'Id': self.item, 'UserData': {'PlaybackPositionTicks': 120000000}}
        for resource, query, expected in [
                ('UserItems/Resume', '', []), ('Items', 'filters=IsResumable', []),
                ('Items', f'ids={self.item}', [{**entry, 'FamilyHubResumeHidden': True}])]:
            upstream.return_value = io.BytesIO(json.dumps({'Items': [entry], 'TotalRecordCount': 1}).encode())
            reply = self.post(client, csrf, route, json={**data, 'path': resource, 'query': query, 'payload': None})
            self.assertEqual(reply.json['result'], {'Items': expected, 'TotalRecordCount': len(expected)})
        entry['UserData']['PlaybackPositionTicks'] += 1
        upstream.return_value = io.BytesIO(json.dumps({'Items': [entry]}).encode())
        reply = self.post(client, csrf, route, json={**data, 'path': 'UserItems/Resume', 'query': '', 'payload': None})
        self.assertEqual(reply.json['result']['Items'], [entry])

    @patch('music_web.movies.urllib.request.build_opener')
    def test_next_up_dismissal_is_profile_scoped_and_expires_when_the_episode_changes(self, opener):
        client, csrf = self.select()
        movie = self.grant(client, csrf, opener)
        other, other_csrf = self.select('sample-b')
        other_movie = self.grant(other, other_csrf, opener, 'other-viewer')
        route = '/api/movies/library'
        episode_id = 'b' * 32
        data = dict(ticket=movie['media_ticket'], path='Shows/NextUp', query='',
                    payload={'seriesId': self.item, 'episodeId': episode_id})
        opener.reset_mock()
        self.assertEqual(self.post(other, other_csrf, route, json=data).status_code, 404)
        self.assertEqual(self.post(client, csrf, route, json={**data, 'payload': {'seriesId': self.item}}).status_code, 400)
        self.assertEqual(self.post(client, csrf, route, json=data).json, {'result': None})
        opener.assert_not_called()
        entry = {'Id': episode_id, 'SeriesId': self.item, 'Type': 'Episode'}
        successor = {**entry, 'Id': 'c' * 32}
        fresh, fresh_csrf = self.select()
        fresh_movie = self.grant(fresh, fresh_csrf, opener)
        for profile, token, ticket, item, expected in [
                (fresh, fresh_csrf, fresh_movie['media_ticket'], entry, []),
                (other, other_csrf, other_movie['media_ticket'], entry, [entry]),
                (fresh, fresh_csrf, fresh_movie['media_ticket'], successor, [successor])]:
            opener.return_value.open.return_value = io.BytesIO(json.dumps({'Items': [item], 'TotalRecordCount': 1}).encode())
            reply = self.post(profile, token, route, json={**data, 'ticket': ticket, 'payload': None})
            self.assertEqual(reply.json['result'], {'Items': expected, 'TotalRecordCount': len(expected)})

    @patch('music_web.movies.urllib.request.build_opener')
    def test_media_rewrites_playlist_and_revokes_ticket(self, opener):
        client, csrf = self.select()
        movie = self.grant(client, csrf, opener)
        prefix = movie['media_url'].removeprefix(ORIGIN)
        path = f'{prefix}Videos/{self.item}/master.m3u8'
        stream = io.BytesIO(b'#EXTM3U\n#EXT-X-MAP:URI="main/init.mp4?api_key=upstream-secret"\nmain/0.mp4?ApiKey=upstream-secret\n')
        stream.headers, stream.status = Message(), 200
        opener.return_value.open.return_value = stream
        anonymous = self.app.test_client()
        response = self.go(anonymous, 'GET', path)
        self.assertEqual(response.status_code, 200)
        self.assertIn(f'{prefix}Videos/{self.item}/main/0.mp4', response.get_data(as_text=True))
        self.assertNotIn('upstream-secret', response.get_data(as_text=True))
        self.assertEqual(self.go(anonymous, 'GET', prefix + 'System/Info').status_code, 404)
        partial = io.BytesIO(b'abc')
        partial.headers, partial.status = Message(), 206
        partial.headers['Content-Type'] = 'video/mp4'
        partial.headers['Content-Range'] = 'bytes 0-2/10'
        opener.return_value.open.return_value = partial
        media = self.go(anonymous, 'GET', f'{prefix}Videos/{self.item}/stream', headers={
            'Range': 'bytes=0-2', 'Origin': 'https://0.0.0.1'})
        self.assertEqual((media.status_code, media.data), (206, b'abc'))
        self.assertEqual(media.headers['Content-Range'], 'bytes 0-2/10')
        self.assertEqual(opener.return_value.open.call_args.args[0].get_header('Range'), 'bytes=0-2')
        opener.return_value.open.return_value = io.BytesIO()
        self.assertEqual(self.post(client, csrf, '/api/movies/media/close', json={'ticket': movie['media_ticket']}).status_code, 200)
        self.assertTrue(opener.return_value.open.call_args.args[0].full_url.endswith('/Sessions/Logout'))
        self.assertEqual(self.go(anonymous, 'GET', path).status_code, 404)

    def test_movie_download_allowlist_cannot_grant_admin_access(self):
        client, csrf = self.select()
        self.assertEqual(self.go(client, 'GET', '/api/movies/downloads').status_code, 403)
        for path in ('download', 'youtube-download'):
            self.assertEqual(self.post(client, csrf, '/api/movies/' + path, json={}).status_code, 403)

    def test_route_inventory_matches_flask_registration(self):
        review = (Path(__file__).resolve().parents[1] / 'docs' / 'SECURITY_REVIEW.md').read_text(encoding='utf-8')
        listed = review.split('## Complete route inventory', 1)[1].split('```text\n', 1)[1].split('```', 1)[0]
        registered = {','.join(sorted(rule.methods - {'HEAD', 'OPTIONS'})) + ' ' + rule.rule
                      for rule in self.app.url_map.iter_rules()}
        self.assertEqual(set(listed.splitlines()), registered)
