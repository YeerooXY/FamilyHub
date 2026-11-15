import unittest
from music_web.genres import group, artist_name

class GenreTests(unittest.TestCase):
    def test_broad_labels_use_highest_recognized_tag_and_keep_unknown(self):
        self.assertEqual(group([{"name":"seen live", "count":99},{"name":"hip hop", "count":14},{"name":"pop", "count":2}]), "Hip-hop")
        self.assertEqual(group([{"name":"trance", "count":3}]), "Electronic")
        self.assertEqual(group([]), "Unsorted")
    def test_artist_comes_from_source_metadata_or_title_before_uploader(self):
        self.assertEqual(artist_name({"title":"Katy Perry - Roar", "artist":""},{"artist":"Uploader"}), "Katy Perry")
        self.assertEqual(artist_name({"title":"Song", "artist":"50 Cent"},{"artist":"Label"}), "50 Cent")
