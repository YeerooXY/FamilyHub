"""Passwordless profiles are available only on an explicitly enabled family server."""
import json
import unittest
from unittest import mock

from test_music_web import Base, ORIGIN
from music_web import create_app
from music_web.playlists import PlaylistStore
from music_web.profiles import ProfileStore


class DisabledProfiles(Base):
    def test_password_mode_keeps_session_expiry_and_has_no_profile_marker(self):
        client, _ = self.signed_in()
        self.assertEqual(self.app.permanent_session_lifetime.days, 30)
        with client.session_transaction(base_url=ORIGIN) as session:
            self.assertNotIn('family_profile', session)
        self.state.sessions.clear()
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 401)

    def test_bootstrap_requires_explicit_opt_in(self):
        client = self.app.test_client()
        response = self.go(client, 'GET', '/api/connect')
        self.assertEqual(response.status_code, 409)
        self.assertIn('not enabled', response.json['error'])
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 401)


class FirstPassword(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a'], 'PROFILE_PASSWORD_HASHES': {}}

    def test_password_setup_signs_in_even_after_normal_sign_in_is_rate_limited(self):
        client = self.app.test_client()
        token = self.go(client, 'GET', '/api/connect').json['csrf_token']
        credentials = {'profile_id': 'sample-a', 'password': 'long enough pass'}
        for _ in range(8):
            self.assertEqual(self.post(client, token, '/api/profile/select', json=credentials).status_code, 403)
        self.assertEqual(self.post(client, token, '/api/profile/select', json=credentials).status_code, 429)
        self.assertEqual(self.post(client, token, '/api/profile/password-setup', json=credentials).status_code, 200)
        self.assertEqual(self.go(client, 'GET', '/api/profile/preferences').status_code, 200)

    def test_protected_profile_without_hash_creates_one_then_needs_it(self):
        client = self.app.test_client()
        boot = self.go(client, 'GET', '/api/connect').json
        profile = next(p for p in boot['profiles'] if p['id'] == 'sample-a')
        self.assertTrue(profile['requires_password'] and profile['needs_password_setup'])
        short = self.post(client, boot['csrf_token'], '/api/profile/password-setup', json={'profile_id': 'sample-a', 'password': 'short'})
        self.assertEqual(short.status_code, 400)
        made = self.post(client, boot['csrf_token'], '/api/profile/password-setup', json={'profile_id': 'sample-a', 'password': 'long enough pass'})
        self.assertEqual(made.status_code, 200, made.json)
        other = self.app.test_client()
        boot = self.go(other, 'GET', '/api/connect').json
        self.assertNotIn('needs_password_setup', next(p for p in boot['profiles'] if p['id'] == 'sample-a'))
        again = self.post(other, boot['csrf_token'], '/api/profile/password-setup', json={'profile_id': 'sample-a', 'password': 'another long pass'})
        self.assertEqual(again.status_code, 409)
        wrong = self.post(other, boot['csrf_token'], '/api/profile/select', json={'profile_id': 'sample-a', 'password': 'nope nope'})
        self.assertEqual(wrong.status_code, 403)
        right = self.post(other, boot['csrf_token'], '/api/profile/select', json={'profile_id': 'sample-a', 'password': 'long enough pass'})
        self.assertEqual(right.status_code, 200)


class FamilyProfiles(Base):
    extra = {'FAMILY_PROFILES': True}

    def bootstrap(self, client=None):
        client = client or self.app.test_client()
        response = self.go(client, 'GET', '/api/connect')
        self.assertEqual(response.status_code, 200, response.json)
        return client, response.json

    def select(self, profile_id='sample-a', client=None):
        client, bootstrap = self.bootstrap(client)
        response = self.post(client, bootstrap['csrf_token'], '/api/profile/select', json=self.profile_credentials(profile_id))
        self.assertEqual(response.status_code, 200, response.json)
        return client, response.json['csrf_token']

    def test_display_name_rename_preserves_profile_identity_and_preferences(self):
        client, token = self.select()
        path = '/api/profile/name'
        headers = {'X-CSRFToken': token}
        self.assertEqual(self.go(client, 'PATCH', '/api/profile/preferences', json={'shuffle': True}, headers=headers).status_code, 200)
        response = self.go(client, 'PATCH', path, json={'name': '  Mária 🌿  '}, headers=headers)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['profile']['id'], 'sample-a')
        self.assertEqual(response.json['profile']['name'], 'Mária 🌿')
        self.assertTrue(self.go(client, 'GET', '/api/profile/preferences').json['preferences']['shuffle'])
        _, connection = self.bootstrap()
        self.assertEqual({p['id']: p['name'] for p in connection['profiles']},
                         {'sample-a': 'Mária 🌿', 'sample-b': 'sample-b'})
        self.assertEqual(ProfileStore(self.ws, []).get('sample-a')['name'], 'Mária 🌿')

    def test_display_name_rename_requires_identity_and_validates_name(self):
        client, bootstrap = self.bootstrap()
        path = '/api/profile/name'
        self.assertEqual(self.go(client, 'PATCH', path, json={'name': 'New'}, headers={'X-CSRFToken': bootstrap['csrf_token']}).status_code, 401)
        client, token = self.select(client=client)
        self.assertEqual(self.go(client, 'PATCH', path, json={'name': 'New'}).status_code, 400)
        headers = {'X-CSRFToken': token}
        for payload in ({'name': 'New', 'profile_id': 'sample-b'}, {'name': ' SAMPLE-B '}, {'name': ' '}, {'name': 'x' * 65}, {'name': 'A\nB'}):
            with self.subTest(payload=payload):
                self.assertEqual(self.go(client, 'PATCH', path, json=payload, headers=headers).status_code, 400)
        response = self.go(client, 'PATCH', path, json={'name': 'SAMPLE-A'}, headers=headers)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['profile']['id'], 'sample-a')

    def test_seed_selection_rotates_csrf_without_navidrome_and_remembers_session(self):
        client, bootstrap = self.bootstrap()
        self.assertTrue(bootstrap['family_profiles'])
        self.assertEqual([p['id'] for p in bootstrap['profiles']], ['sample-a', 'sample-b'])
        client, token = self.select(client=client)
        self.ping.assert_not_called()
        self.assertNotEqual(token, bootstrap['csrf_token'])
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 200)
        self.assertEqual(self.go(client, 'GET', '/login').status_code, 302)
        with client.session_transaction(base_url=ORIGIN) as session:
            self.assertTrue(session.permanent)
        stale = self.post(client, bootstrap['csrf_token'], '/api/playlists', json={'name': 'Old token'})
        self.assertEqual(stale.status_code, 400)
        self.assertEqual(stale.json['code'], 'csrf')

    def test_stale_account_forms_link_back_to_a_fresh_page(self):
        client, old_token = self.select()
        _, new_token = self.select('sample-b', client)
        for path in ('/login', '/logout'):
            with self.subTest(path=path):
                response = self.go(client, 'POST', path, data={'csrf_token': old_token, 'profile_id': 'sample-a'})
                self.assertEqual(response.status_code, 400)
                self.assertIn(b'href="/">Reload FamilyHub</a>', response.data)
                self.assertIn(b'data-user="sample-b"', self.go(client, 'GET', '/').data)
        response = self.go(client, 'POST', '/logout', data={'csrf_token': new_token}, follow_redirects=True)
        self.assertIn(b'Choose your profile', response.data)

    def test_bootstrap_selection_and_creation_keep_host_origin_csrf_guards(self):
        client, bootstrap = self.bootstrap()
        self.assertEqual(client.get('/api/connect', base_url='https://other.test').status_code, 400)
        for path, body in (('/api/profile/select', {'profile_id': 'sample-a'}), ('/api/profiles', {'name': 'New'})):
            with self.subTest(path=path):
                self.assertEqual(self.go(client, 'POST', path, json=body).status_code, 400)
                response = self.go(client, 'POST', path, origin=False, json=body,
                                   headers={'X-CSRFToken': bootstrap['csrf_token'], 'Origin': 'https://other.test'})
                self.assertEqual(response.status_code, 403)
        for profile_id in ('missing', None, ['sample-a'], '../sample-a'):
            self.assertEqual(self.post(client, bootstrap['csrf_token'], '/api/profile/select', json={'profile_id': profile_id}).status_code, 400)
        self.assertEqual(self.go(client, 'GET', '/api/profile/preferences').status_code, 401)

    def test_create_profile_validation_limit_and_stable_restart(self):
        client, bootstrap = self.bootstrap()
        token = bootstrap['csrf_token']
        for name in ('', 'x' * 65, 'bad\nname', True):
            self.assertEqual(self.post(client, token, '/api/profiles', json={'name': name}).status_code, 400)
        created = self.post(client, token, '/api/profiles', json={'name': ' New person '})
        self.assertEqual(created.status_code, 201)
        profile = created.json['profile']
        self.assertEqual(profile['name'], 'New person')
        self.assertNotEqual(profile['id'], profile['name'])
        self.assertEqual(self.post(client, token, '/api/profiles', json={'name': 'new person'}).status_code, 400)
        for index in range(9):
            self.assertEqual(self.post(client, token, '/api/profiles', json={'name': f'Person {index}'}).status_code, 201)
        self.assertEqual(self.post(client, token, '/api/profiles', json={'name': 'Too many'}).status_code, 400)
        self.restart()
        _, bootstrap = self.bootstrap()
        self.assertIn(profile, bootstrap['profiles'])
        self.assertEqual(len(bootstrap['profiles']), 12)

    def restart(self):
        self.app = create_app({'SECRET_KEY': 'k' * 40, 'CLI_PATH': self.app.intake.__file__, 'WORKSPACE': self.ws,
                               'LIBRARY': self.lib, 'PUBLIC_ORIGIN': ORIGIN, 'ALLOWED_USERS': ['sample-a', 'sample-b'],
                               'FAMILY_PROFILES': True})
        self.state = self.app.extensions['music']

    def test_remembered_cookie_restores_profile_after_restart_and_logout_clears_it(self):
        client, token = self.select()
        cookie = client.get_cookie('familyhub_music', domain='music.test')
        self.restart()
        client = self.app.test_client()
        client.set_cookie('familyhub_music', cookie.value, domain='music.test')
        self.assertEqual(self.app.permanent_session_lifetime.days, 3650)
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 200)
        self.assertEqual(self.go(client, 'GET', '/login').status_code, 302)
        with client.session_transaction(base_url=ORIGIN) as session:
            self.assertEqual(session['family_profile'], 'sample-a')
            self.assertEqual(self.state.sessions[session['sid']]['user'], 'sample-a')
        self.assertEqual(self.post(client, token, '/logout').status_code, 302)
        self.assertIn('Choose your profile', self.go(client, 'GET', '/login').get_data(as_text=True))
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 401)
        with client.session_transaction(base_url=ORIGIN) as session:
            self.assertNotIn('family_profile', session)

    def test_expired_family_session_restores_only_an_existing_profile(self):
        client, _ = self.select()
        for session in self.state.sessions.values():
            session['expiry'] = 0
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 200)
        store = ProfileStore(self.ws, [])
        data = store.read()
        data['profiles'] = [profile for profile in data['profiles'] if profile['id'] != 'sample-a']
        store.write(data)
        self.state.sessions.clear()
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 401)
        self.assertIn('Choose your profile', self.go(client, 'GET', '/login').get_data(as_text=True))
        with client.session_transaction(base_url=ORIGIN) as session:
            self.assertNotIn('family_profile', session)

    def test_preferences_are_validated_isolated_and_persisted(self):
        client, token = self.select()
        response = self.go(client, 'PATCH', '/api/profile/preferences', json={'volume': .35, 'shuffle': True, 'auto_dj': True}, headers={'X-CSRFToken': token})
        self.assertEqual(response.json['preferences'], {'volume': .35, 'shuffle': True, 'auto_dj': True, 'crossfade_seconds': 6, 'volume_level': 'normal', 'spotify_subscribed': None, 'repeat_mode': 'off', 'listening_history_paused': False})
        for change in ({'volume': True}, {'volume': -1}, {'volume': 1.1}, {'volume': 10 ** 300}, {'volume': '1'}, {'shuffle': 1}, {'auto_dj': 1}, {'auto_dj': None}, {'crossfade_seconds': 13}, {'crossfade_seconds': -1}, {'crossfade_seconds': 2.5}, {'crossfade_seconds': True}, {'volume_level': 'invalid'}, {'volume_level': None}, {'volume_level': True}, {'volume_level': []}, {'other': 1}, {}):
            self.assertEqual(self.go(client, 'PATCH', '/api/profile/preferences', json=change, headers={'X-CSRFToken': token}).status_code, 400)
        other, _ = self.select('sample-b')
        self.assertEqual(self.go(other, 'GET', '/api/profile/preferences').json['preferences'], {'volume': 1, 'shuffle': False, 'auto_dj': True, 'crossfade_seconds': 6, 'volume_level': 'normal', 'spotify_subscribed': None, 'repeat_mode': 'off', 'listening_history_paused': False})
        self.restart()
        client, _ = self.select()
        self.assertEqual(self.go(client, 'GET', '/api/profile/preferences').json['preferences'], {'volume': .35, 'shuffle': True, 'auto_dj': True, 'crossfade_seconds': 6, 'volume_level': 'normal', 'spotify_subscribed': None, 'repeat_mode': 'off', 'listening_history_paused': False})

    def test_profile_cache_reuses_parse_and_detects_replacement(self):
        user = 'sample-a'
        with mock.patch('music_web.state.json.loads', wraps=json.loads) as loads:
            store = ProfileStore(self.ws, [])
            self.assertEqual(store.get(user)['name'], user)
            self.assertFalse(store.preferences(user)['listening_history_paused'])
            store.read()['profiles'][0]['name'] = 'Unsaved'
            self.assertEqual(store.get(user)['name'], user)
            loads.assert_called_once()
        ProfileStore(self.ws, []).preferences(user, {'listening_history_paused': True})
        store.files.refresh()
        self.assertTrue(store.preferences(user)['listening_history_paused'])
        store.preferences(user, {'listening_history_paused': False})
        self.assertFalse(store.preferences(user)['listening_history_paused'])

    def test_volume_levels_are_saved_per_profile(self):
        client, token = self.select()
        for level in ("loud", "normal", "quiet"):
            response = self.go(client, 'PATCH', '/api/profile/preferences',
                               json={'volume_level': level}, headers={'X-CSRFToken': token})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['preferences']['volume_level'], level)
        other, _ = self.select('sample-b')
        self.assertEqual(self.go(other, 'GET', '/api/profile/preferences').json['preferences']['volume_level'], 'normal')
        self.restart()
        client, _ = self.select()
        self.assertEqual(self.go(client, 'GET', '/api/profile/preferences').json['preferences']['volume_level'], 'quiet')

    def test_sharing_during_download_preserves_progress_and_track_edit_lock(self):
        client, token = self.select()
        playlist = self.post(client, token, '/api/playlists', json={'name': 'Downloading'}).json['playlist']
        pid = playlist['id']; store = PlaylistStore(self.ws)
        playlist['preparation'] = {'state': 'running', 'mode': 'download', 'playlist_revision': 1, 'processed': 3, 'cursor': 3}
        store.save('sample-a', playlist)
        coordinator = self.state.playlist_preparation
        operation = coordinator._operation('sample-a', pid)
        operation.active = ('sample-a', pid)
        response = self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 1, 'shared': True}, headers={'X-CSRFToken': token})
        self.assertEqual(response.status_code, 200, response.json)
        persisted = store.read('sample-a', pid)
        self.assertTrue(persisted['shared'])
        self.assertEqual((persisted['preparation']['processed'], persisted['preparation']['playlist_revision']), (3, 2))
        other, other_token = self.select('sample-b')
        visible = self.go(other, 'GET', '/api/playlists').json['playlists']
        self.assertTrue(any(row['id'] == pid and row['shared'] for row in visible))
        self.assertEqual(self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 2, 'name': 'Blocked'}, headers={'X-CSRFToken': token}).status_code, 409)
        self.assertEqual(self.go(other, 'PATCH', '/api/playlists/' + pid, json={'revision': 2, 'owner_id': 'sample-a', 'shared': False}, headers={'X-CSRFToken': other_token}).status_code, 403)
        self.assertEqual(self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 1, 'shared': False}, headers={'X-CSRFToken': token}).status_code, 409)
        coordinator.update('sample-a', pid, message='Purifying audio')
        self.assertTrue(store.read('sample-a', pid)['shared'])
        operation.active = None

    def test_shared_playlist_owner_permissions_and_colliding_playlist_ids(self):
        store = PlaylistStore(self.ws)
        pid = '6CCDIMytDCox2aDcNi1ztu'
        for owner in ('sample-a', 'sample-b'):
            store.save(owner, {'id': pid, 'name': owner, 'tracks': [], 'revision': 1})
        client, token = self.select()
        other, other_token = self.select('sample-b')
        own = self.go(client, 'GET', '/api/playlists').json['playlists']
        self.assertEqual(len(own), 1)
        self.assertFalse(own[0]['shared'])
        self.assertTrue(own[0]['can_edit'])
        self.assertEqual(self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 1, 'shared': 1}, headers={'X-CSRFToken': token}).status_code, 400)
        response = self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 1, 'shared': True}, headers={'X-CSRFToken': token})
        self.assertTrue(response.json['playlist']['shared'])
        self.assertEqual(self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 1, 'shared': False}, headers={'X-CSRFToken': token}).status_code, 409)
        rows = self.go(other, 'GET', '/api/playlists').json['playlists']
        self.assertEqual({(p['owner_id'], p['id']) for p in rows}, {('sample-a', pid), ('sample-b', pid)})
        shared = next(p for p in rows if p['owner_id'] == 'sample-a')
        self.assertFalse(shared['can_edit'])
        for method in ('PATCH', 'DELETE'):
            response = self.go(other, method, '/api/playlists/' + pid, json={'revision': 2, 'owner_id': 'sample-a', 'name': 'Forbidden'}, headers={'X-CSRFToken': other_token})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(store.read('sample-a', pid)['name'], 'sample-a')
        self.assertEqual(store.read('sample-b', pid)['name'], 'sample-b')
        response = self.go(client, 'PATCH', '/api/playlists/' + pid, json={'revision': 2, 'shared': False}, headers={'X-CSRFToken': token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.go(other, 'GET', '/api/playlists').json['playlists']), 1)

    def test_browser_profile_selection_and_legacy_playlist_preservation(self):
        pid = '6CCDIMytDCox2aDcNi1ztu'
        PlaylistStore(self.ws).save('sample-a', {'id': pid, 'name': 'Legacy', 'tracks': []})
        client = self.app.test_client()
        page = self.go(client, 'GET', '/login').get_data(as_text=True)
        self.assertIn('Choose your profile', page)
        self.assertNotIn('type="password"', page)
        token = self.token(client, '/login')
        response = self.go(client, 'POST', '/login', data={'profile_id': 'sample-a', 'csrf_token': token})
        self.assertEqual(response.status_code, 302)
        self.ping.assert_not_called()
        self.assertEqual(self.go(client, 'GET', '/api/playlists').json['playlists'][0]['name'], 'Legacy')


if __name__ == '__main__':
    unittest.main()
