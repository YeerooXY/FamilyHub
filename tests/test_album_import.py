import unittest
from music_web.public_playlists import read_album
from music_web.playlists import spotify_source, PlaylistError


def row(char, title):
    return dict(track=dict(uri='spotify:track:' + char * 22, name=title, duration=dict(totalMilliseconds=200000),
                           artists=dict(items=[dict(uri='spotify:artist:' + 'a' * 22, profile=dict(name='Artist'))])))


class AlbumTests(unittest.TestCase):
    aid = 'b' * 22

    def album(self, rows, total, name='GTA VI Album'):
        return dict(uri='spotify:album:' + self.aid, name=name, tracksV2=dict(totalCount=total, items=rows))

    def test_pages_keep_album_order_and_name(self):
        pages = {0: [row('c', 'One'), row('d', 'Two')], 2: [row('e', 'Three')]}
        seen = []
        result = read_album(self.aid, lambda offset: self.album(pages[offset], 3), lambda a, b: seen.append((a, b)))
        self.assertEqual([t['title'] for t in result['tracks']], ['One', 'Two', 'Three'])
        self.assertEqual({t['album'] for t in result['tracks']}, {'GTA VI Album'})
        self.assertEqual(seen[-1], (3, 3))
        self.assertEqual(result['url'], 'https://open.spotify.com/album/' + self.aid)

    def test_link_is_recognised_and_other_hosts_rejected(self):
        self.assertEqual(spotify_source('https://open.spotify.com/album/' + self.aid + '?si=x'), ('album', self.aid))
        with self.assertRaises(PlaylistError): spotify_source('https://attacker.test/album/' + self.aid)

    def test_incomplete_or_wrong_album_rejected(self):
        with self.assertRaises(PlaylistError): read_album(self.aid, lambda _: self.album([], 2))
        wrong = dict(self.album([row('c', 'One')], 1), uri='spotify:album:' + 'z' * 22)
        with self.assertRaises(PlaylistError): read_album(self.aid, lambda _: wrong)


if __name__ == '__main__':
    unittest.main()
