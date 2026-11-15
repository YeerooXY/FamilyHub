import json, pathlib, sys, unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from music_web.playlists import *
from test_music_web import Base, URL
PID='3ZOpGHzrl9qpQ3qTSxn5Nl'
def fixture():
 return {'id':PID,'name':'Example','notice':'Public entries','tracks':[{'title':'Alone','artist':'Maduk','duration':250,'spotify_uri':'spotify:track:x','candidates':[],'state':'unmatched'}]}
class Metadata(unittest.TestCase):
 def test_urls(self):
  self.assertEqual(playlist_id('https://open.spotify.com/playlist/'+PID+'?si=abc'),PID)
  for url in ['http://open.spotify.com/playlist/'+PID,'https://open.spotify.com.evil/playlist/'+PID,'https://user@open.spotify.com/playlist/'+PID,'https://127.0.0.1/playlist/'+PID,'https://open.spotify.com:90/playlist/'+PID]:
   with self.assertRaises(PlaylistError):playlist_id(url)
 def test_parse_order_and_unavailable(self):
  entity={'id':PID,'type':'playlist','title':'Example','trackList':[{'entityType':'track','title':t,'subtitle':'Artist','duration':123000} for t in ['A','B','A']]}
  page='<script id="__NEXT_DATA__">'+json.dumps({'props':{'pageProps':{'state':{'data':{'entity':entity}}}}})+'</script>'
  self.assertEqual([r['title'] for r in parse_page(page,PID)['tracks']],['A','B','A'])
  with self.assertRaises(PlaylistError):parse_page('private page',PID)
 def test_matching(self):
  rows=[{'title':'Maduk Alone nightcore','channel':'Uploader','duration':250},{'title':'Maduk - Alone (Official Audio)','channel':'Maduk','duration':251},{'title':'Not Alone','channel':'Maduk','duration':190}]
  found=rank_matches(fixture()['tracks'][0],rows)
  self.assertTrue(found[0]['recommended']);self.assertFalse(found[-1]['recommended'])
  for suffix in ['Bass Boosted','speedup','DNB Edit','remix','reverb']:
   self.assertFalse(rank_matches(fixture()['tracks'][0],[{'title':'Maduk - Alone ('+suffix+')','channel':'Maduk','duration':250}])[0]['recommended'])
  self.assertFalse(rank_matches(fixture()['tracks'][0],[{'title':'Not Alone','channel':'Maduk','duration':250}])[0]['recommended'])
class Routes(Base):
 def test_reimport_refresh_and_failure_preserves_saved_list(self):
  c,t=self.signed_in()
  old=fixture()
  with mock.patch('music_web.fetch_playlist',return_value=old):
   self.post(c,t,'/api/playlists/spotify',json={'url':'link'})
  fresh=fixture();fresh['tracks']=[dict(fresh['tracks'][0],spotify_uri='spotify:track:new'),fresh['tracks'][0]]
  with mock.patch('music_web.fetch_playlist',return_value=fresh):
   response=self.post(c,t,'/api/playlists/spotify',json={'url':'link'})
  self.assertEqual(len(response.json['playlist']['tracks']),2)
  with mock.patch('music_web.fetch_playlist',side_effect=PlaylistError('Incomplete page')):
   response=self.post(c,t,'/api/playlists/spotify',json={'url':'link'})
  self.assertEqual(response.status_code,400)
  self.assertEqual(len(self.go(c,'GET','/api/playlists').json['playlists'][0]['tracks']),2)
 def test_owner_isolation_and_matching(self):
  c,t=self.signed_in();other,ot=self.signed_in('sample-b')
  with mock.patch('music_web.fetch_playlist',return_value=fixture()):
   self.assertEqual(self.post(c,t,'/api/playlists/spotify',json={'url':'link'}).status_code,200)
  self.assertEqual(len(self.go(c,'GET','/api/playlists').json['playlists']),1)
  self.assertEqual(self.go(other,'GET','/api/playlists').json['playlists'],[])
  self.assertEqual(self.post(other,ot,f'/api/playlists/{PID}/match',json={'index':0}).status_code,400)
  candidate={'id':'dQw4w9WgXcQ','url':URL,'title':'Maduk - Alone','channel':'Maduk','duration':250}
  with mock.patch.object(self.intake,'cmd_search',return_value={'results':[candidate]}):
   response=self.post(c,t,f'/api/playlists/{PID}/match',json={'index':0})
  self.assertTrue(response.json['track']['candidates'][0]['recommended'])
  self.fake_ok()
  response=self.post(c,t,f'/api/playlists/{PID}/download',json={'index':0,'choice':0})
  self.assertEqual(response.status_code,202)
  job=self.state.jobs[response.json['job']['id']]
  self.assertTrue(job['playlist_import']);self.assertTrue(job['save']);self.assertEqual(job['priority'],20)
  self.wait(c,job['id'])
 def test_invalid_index(self):
  c,t=self.signed_in()
  with mock.patch('music_web.fetch_playlist',return_value=fixture()):self.post(c,t,'/api/playlists/spotify',json={'url':'link'})
  self.assertEqual(self.post(c,t,f'/api/playlists/{PID}/download',json={'index':True,'choice':0}).status_code,400)
if __name__=='__main__':unittest.main()
