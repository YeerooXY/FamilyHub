"""Family playlist defaults and server-enforced admin deletion."""
import unittest
import test_family_profiles as family
from test_music_web import Base
from music_web.playlists import PlaylistStore

class AdminPlaylists(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a']}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def test_new_and_imported_playlists_shared_private_reimports_stay_private(self):
        client, token = self.select()
        p = self.post(client, token, '/api/playlists', json={'name': 'New'}).json['playlist']
        self.assertTrue(p['shared'])
        self.assertTrue(p['can_delete'])
        store = PlaylistStore(self.ws)
        imported = {'id': 'A'*22, 'name': 'Import', 'tracks': []}
        self.assertTrue(store.import_playlist('sample-b', imported)['shared'])
        imported['shared'] = False
        store.save('sample-b', imported)
        self.assertFalse(store.import_playlist('sample-b', {'id': 'A'*22, 'name': 'Updated', 'tracks': []})['shared'])
        other, _ = self.select('sample-b')
        visible = self.go(other, 'GET', '/api/playlists').json['playlists']
        self.assertTrue(any(row['id'] == p['id'] for row in visible))
        self.assertTrue(all(not row['can_delete'] for row in visible))

    def test_admin_deletes_other_private_playlist_preserves_collision_and_audio(self):
        store = PlaylistStore(self.ws); pid = 'B'*22
        for owner in ('sample-a', 'sample-b'):
            store.save(owner, {'id': pid, 'name': owner, 'revision': 3, 'tracks': [], 'shared': False})
        client, token = self.select()
        rows = self.go(client, 'GET', '/api/playlists').json['playlists']
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['can_delete'] for row in rows))
        data = {'owner_id': 'sample-b', 'revision': 3}
        operation = self.state.playlist_preparation._operation('sample-b', pid)
        operation.active = ('sample-b', pid)
        self.assertEqual(self.post_delete(client, token, pid, data).status_code, 409)
        operation.active = None
        self.assertEqual(self.post_delete(client, token, pid, {**data, 'revision': 2}).status_code, 409)
        self.assertEqual(self.post_delete(client, token, pid, data).status_code, 200)
        self.assertEqual(store.read('sample-a', pid)['name'], 'sample-a')
        self.assertEqual(store.list('sample-b'), [])

    def post_delete(self, client, token, pid, data):
        return self.go(client, 'DELETE', '/api/playlists/'+pid, json=data, headers={'X-CSRFToken': token})

    def test_non_admin_cannot_delete_own_or_other_or_spoof_role(self):
        client, token = self.select('sample-b'); store=PlaylistStore(self.ws); pid='C'*22
        for owner in ('sample-a', 'sample-b'):
            store.save(owner, {'id':pid, 'name':owner, 'revision':1, 'tracks':[], 'shared':True})
        for owner in ('sample-a', 'sample-b'):
            response=self.post_delete(client, token, pid, {'owner_id':owner,'revision':1,'is_admin':True})
            self.assertEqual(response.status_code,403)
            self.assertTrue(store.list(owner))
        admin, admin_token = self.select()
        self.assertEqual(self.post_delete(admin, admin_token, pid, {'owner_id':[], 'revision':1}).status_code,400)


class RetiredBrowserPlayer(Base):
    extra = {'FAMILY_PROFILES': True, 'BROWSER_PLAYER': False}
    def test_old_pages_removed_native_bootstrap_and_updates_available(self):
        client = self.app.test_client()
        for path in ('/', '/login', '/static/playlists.js'):
            response = self.go(client, 'GET', path)
            self.assertEqual(response.status_code, 410)
            self.assertNotIn('<html', response.get_data(as_text=True).lower())
        response = self.go(client, 'GET', '/api/connect')
        self.assertEqual(response.status_code, 200)
        selected = self.post(client, response.json['csrf_token'], '/api/profile/select', json={'profile_id':'sample-a'})
        self.assertEqual(selected.status_code,200)
        self.assertEqual(self.go(client,'GET','/api/library').status_code,200)

if __name__ == '__main__': unittest.main()
