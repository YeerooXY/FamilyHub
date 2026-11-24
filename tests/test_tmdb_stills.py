import io
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from music_web.tmdb_stills import IMAGE, StillCache


class StillCacheTests(unittest.TestCase):
    def test_downloads_a_picture_once_and_reads_it_from_disk(self):
        with TemporaryDirectory() as root:
            cache = StillCache({'STATE_DIR': root})
            picture = b'\xff\xd8fixture\xff\xd9'
            opener = Mock()
            opener.open.return_value = io.BytesIO(picture)
            self.assertEqual(cache.fetch(123456, 2, 3, '/abc123.jpg', opener), picture)
            self.assertEqual(opener.open.call_args.args[0].full_url, IMAGE + '/abc123.jpg')
            self.assertEqual(cache.file(123456, 2, 3).read_bytes(), picture)
            self.assertEqual(cache.fetch(123456, 2, 3, '/abc123.jpg', opener), picture)
            self.assertEqual(opener.open.call_count, 1)

    def test_rejects_invalid_ids_and_paths_before_fetching(self):
        with TemporaryDirectory() as root:
            cache = StillCache({'WORKSPACE': root})
            opener = Mock()
            for series, season, episode in [(True, 1, 1), ('../1', 1, 1), (1, -1, 1), (1, 1, 10000)]:
                self.assertIsNone(cache.fetch(series, season, episode, '/abc123.jpg', opener))
            for value in ('/../abc123.jpg', '//example.com/abc123.jpg', '/abc123.jpg?x=1', '/abc123.png'):
                self.assertIsNone(cache.fetch(1, 1, 1, value, opener))
            opener.open.assert_not_called()
