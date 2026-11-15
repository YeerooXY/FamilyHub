import unittest
from music_web.public_playlists import read_artist_catalogue
from music_web.playlists import spotify_source, PlaylistError

class ArtistTests(unittest.TestCase):
 def test_pages_dedup_and_artist_filter(self):
  aid='a'*22; albums=['spotify:album:'+c*22 for c in 'bc'];calls=[];progress=[]
  def releases(offset):return dict(totalCount=2,items=[dict(releases=dict(items=[dict(uri=albums[offset])]))])
  def tracks(album,offset):
   calls.append((album,offset));return dict(totalCount=2,items=[dict(track=dict(uri='spotify:track:'+('d' if offset==0 else 'e')*22,name='Song'+str(offset),duration=dict(totalMilliseconds=100000),artists=dict(items=[dict(uri='spotify:artist:'+aid,profile=dict(name='Artist'))])) )])
  result=read_artist_catalogue(aid,'Artist',releases,tracks,lambda a,b:progress.append((a,b)))
  self.assertEqual(len(result['tracks']),2);self.assertEqual(len(calls),4);self.assertEqual(progress[-1],(2,2))
  self.assertEqual(spotify_source('https://open.spotify.com/artist/'+aid+'?si=x'),('artist',aid))
  with self.assertRaises(PlaylistError):spotify_source('https://attacker.test/artist/'+aid)
 def test_incomplete_catalogue_rejected(self):
  with self.assertRaises(PlaylistError):read_artist_catalogue('a'*22,'Artist',lambda _:dict(totalCount=2,items=[]),lambda *_:None)
