"""TMDB title matches: reduce the reply to safe fields and never expose the key."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from music_web import tmdb


class Parse(unittest.TestCase):
    def test_keeps_movies_and_series_with_poster_urls(self):
        reply = {'results': [
            {'media_type': 'person', 'id': 1, 'name': 'Someone'},
            {'media_type': 'movie', 'id': 2, 'title': 'Most Wanted', 'release_date': '2012-05-01', 'poster_path': '/abc123.jpg', 'overview': 'Plot'},
            {'media_type': 'tv', 'id': 3, 'name': 'Most Wanted', 'first_air_date': '', 'poster_path': None},
            {'media_type': 'movie', 'id': 4, 'title': 'Bad poster', 'poster_path': 'https://evil.example/x.jpg'},
            {'media_type': 'movie', 'id': 'x', 'title': 'Bad id'}]}
        matches = tmdb.parse(reply)
        self.assertEqual([m['id'] for m in matches], [2, 3, 4])
        self.assertEqual(matches[0]['poster'], 'https://image.tmdb.org/t/p/w342/abc123.jpg')
        self.assertEqual(matches[0]['year'], 2012)
        self.assertIsNone(matches[1]['year'])
        self.assertIsNone(matches[1]['poster'])
        self.assertIsNone(matches[2]['poster'])

    def test_limit_and_bad_reply(self):
        reply = {'results': [{'media_type': 'movie', 'id': n, 'title': f'T{n}'} for n in range(1, 20)]}
        self.assertEqual(len(tmdb.parse(reply, 6)), 6)
        self.assertEqual(tmdb.parse(None), [])
        self.assertEqual(tmdb.parse({'results': 'x'}), [])


if __name__ == '__main__':
    unittest.main()
