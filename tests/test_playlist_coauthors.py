"""Co-author permissions remain scoped to the owner's playlist."""
import test_family_profiles as family
from test_music_web import Base
from music_web.playlists import PlaylistStore

class PlaylistCoAuthors(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a']}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def patch(self, client, token, pid, **data):
        return self.go(client, 'PATCH', '/api/playlists/' + pid, json=data, headers={'X-CSRFToken': token})

    def test_invite_edit_revoke_and_owner_storage(self):
        owner, token = self.select('sample-a')
        other, other_token = self.select('sample-b')
        p = self.post(owner, token, '/api/playlists', json={'name':'Shared mix'}).json['playlist']
        pid = p['id']
        denied = self.patch(other, other_token, pid, owner_id='sample-a', revision=1, name='Unauthorized')
        self.assertEqual(denied.status_code, 403)
        p = self.patch(owner, token, pid, revision=1, co_authors=['sample-b']).json['playlist']
        self.assertTrue(p['can_manage_authors'])
        p = self.patch(owner, token, pid, revision=2, shared=False).json['playlist']
        visible = self.go(other, 'GET', '/api/playlists').json['playlists']
        row = next(x for x in visible if x['id'] == pid)
        self.assertTrue(row['can_edit'])
        self.assertFalse(row['can_manage_authors'])
        for change in ({'co_authors':[]}, {'shared':True}):
            self.assertEqual(self.patch(other, other_token, pid, owner_id='sample-a', revision=3, **change).status_code,403)
        p = self.patch(other, other_token, pid, owner_id='sample-a', revision=3, name='Edited mix').json['playlist']
        self.assertEqual(p['owner_id'],'sample-a')
        store = PlaylistStore(self.ws)
        self.assertEqual(store.read('sample-a', pid)['name'], 'Edited mix')
        self.assertEqual(store.list('sample-b'), [])
        self.assertEqual(self.patch(other, other_token, pid, owner_id='sample-a', revision=3, name='Stale').status_code,409)
        p = self.patch(owner, token, pid, revision=4, co_authors=[]).json['playlist']
        self.assertEqual(self.patch(other, other_token, pid, owner_id='sample-a', revision=5, name='Revoked').status_code,403)
        self.assertFalse(any(x['id']==pid for x in self.go(other,'GET','/api/playlists').json['playlists']))

    def test_author_validation_and_removal(self):
        owner, token = self.select('sample-a'); other, other_token = self.select('sample-b')
        store=PlaylistStore(self.ws);pid='Z'*22
        store.save('sample-a',{'id':pid,'name':'Mix','revision':1,'shared':True,'tracks':[{'title':'One','artist':'A','duration':1}]})
        for authors in ('sample-b', [7], ['missing-profile']):
            self.assertEqual(self.patch(owner,token,pid,revision=1,co_authors=authors).status_code,400)
        p=self.patch(owner,token,pid,revision=1,co_authors=['sample-a','sample-b','sample-b']).json['playlist']
        self.assertEqual(p['co_authors'],['sample-b'])
        p=self.patch(other,other_token,pid,owner_id='sample-a',revision=2,remove_index=0).json['playlist']
        self.assertEqual(p['tracks'],[])
        updated=store.import_playlist('sample-a',{'id':pid,'name':'Reload','tracks':[]})
        self.assertEqual(updated['co_authors'],['sample-b'])

    def test_details_validate_atomically_and_preserve_description_on_import(self):
        owner, token=self.select('sample-a'); other, ot=self.select('sample-b')
        p=self.post(owner,token,'/api/playlists',json={'name':'Before'}).json['playlist'];pid=p['id']
        p=self.patch(owner,token,pid,revision=1,co_authors=['sample-b']).json['playlist']
        response=self.patch(owner,token,pid,revision=2,details={'name':'Changed','description':'x'*2001})
        self.assertEqual(response.status_code,400)
        store=PlaylistStore(self.ws);self.assertEqual(store.read('sample-a',pid)['name'],'Before')
        self.assertEqual(self.patch(other,ot,pid,owner_id='sample-a',revision=2,details={'name':'Not allowed','shared':False}).status_code,403)
        p=self.patch(other,ot,pid,owner_id='sample-a',revision=2,details={'name':'Mix','description':'Track notes'}).json['playlist']
        self.assertEqual((p['name'],p['description']),('Mix','Track notes'))
        imported=store.import_playlist('sample-a',{'id':pid,'name':'Imported','tracks':[{'title':'One','artist':'A','duration':1,'spotify_uri':'spotify:track:one'}]})
        self.assertEqual(imported['description'],'Track notes')
        self.assertTrue(imported['tracks'][0]['added_at'])
        stamp=imported['tracks'][0]['added_at']
        again=store.import_playlist('sample-a',{'id':pid,'name':'Again','tracks':[{'title':'One','artist':'A','duration':1,'spotify_uri':'spotify:track:one'}]})
        self.assertEqual(again['tracks'][0]['added_at'],stamp)
