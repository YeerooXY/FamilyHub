import unittest
from music_web import link_playlists
from music_web.playlists import PlaylistError

SHARE = 'https://link.deezer.com/s/352CRciBNE4PpSQjsuJdH'


class DeezerShareTests(unittest.TestCase):
    def test_share_link_is_detected_as_deezer(self):
        self.assertEqual(link_playlists.detect(SHARE), 'deezer')
        self.assertIsNone(link_playlists.detect('https://link.deezer.com.attacker.test/s/x'))
        self.assertIsNone(link_playlists.detect('http://link.deezer.com/s/x'))

    def test_share_link_resolves_to_album_or_playlist(self):
        album = lambda url: 'https://www.deezer.com/album/1152002071?host=0&utm_source=user_sharing'
        self.assertEqual(link_playlists.deezer_link(SHARE, resolve=album), ('album', '1152002071'))
        playlist = lambda url: 'https://www.deezer.com/en/playlist/42'
        self.assertEqual(link_playlists.deezer_link(SHARE, resolve=playlist), ('playlist', '42'))

    def test_share_link_to_something_else_is_rejected(self):
        artist = lambda url: 'https://www.deezer.com/artist/5'
        with self.assertRaises(PlaylistError): link_playlists.deezer_link(SHARE, resolve=artist)

    def test_resolver_refuses_other_hosts(self):
        with self.assertRaises(PlaylistError): link_playlists.resolve_deezer_share('https://attacker.test/s/x')


if __name__ == '__main__':
    unittest.main()
