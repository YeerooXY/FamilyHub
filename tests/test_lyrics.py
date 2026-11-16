"""Lyrics: title clean-up, LRC parsing and the cached per-song endpoint."""
import unittest

import test_native_music_api as native
from test_music_web import Base
from music_web import lyrics


class Parsing(unittest.TestCase):
    def test_upload_titles_become_artist_and_song_guesses(self):
        guesses = lyrics.candidates("Chase & Status feat. Plan B - Pieces (Official Video)", "minimalism88")
        self.assertEqual(guesses[0], ("Chase & Status feat. Plan B", "Pieces"))
        self.assertIn(("Chase & Status", "Pieces"), guesses)
        self.assertIn(("Chase", "Pieces"), guesses)
        self.assertEqual(lyrics.candidates("Enemy Brain", "Fox Stevenson - Topic"), [("Fox Stevenson", "Enemy Brain")])

    def test_lrc_lines_are_timed_and_sorted(self):
        self.assertEqual(lyrics.lines("[00:12.50]Second\n[00:01.00][00:20.00]Repeat\n[00:05.00]"),
                         [{"t": 1.0, "text": "Repeat"}, {"t": 5.0, "text": ""}, {"t": 12.5, "text": "Second"}, {"t": 20.0, "text": "Repeat"}])


class Endpoint(Base):
    recording = native.NativeMusicApi.recording

    def setUp(self):
        self.lookups = []
        def lookup(title, channel, duration, artist=""):
            self.lookups.append(title)
            return {"synced": "[00:01.00]Hello\n[00:03.00]World", "plain": "", "instrumental": False, "artist": "A", "track": "B", "source_id": 7}
        self.extra = {"LYRICS_LOOKUP": lookup}
        super().setUp()

    def test_lyrics_are_looked_up_once_then_served_from_cache(self):
        self.recording()
        client, _ = self.signed_in()
        first = self.go(client, "GET", f"/api/library/{native.FIRST}/lyrics")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json["state"], "synced")
        self.assertEqual([line["text"] for line in first.json["lines"]], ["Hello", "World"])
        self.assertNotIn("checked", first.json)
        self.assertEqual(self.go(client, "GET", f"/api/library/{native.FIRST}/lyrics").json, first.json)
        self.assertEqual(len(self.lookups), 1)

    def test_unknown_or_invalid_songs_are_not_looked_up(self):
        client, _ = self.signed_in()
        self.assertEqual(self.go(client, "GET", "/api/library/../lyrics").status_code, 404)
        self.assertEqual(self.go(client, "GET", "/api/library/abcdefghijk/lyrics").status_code, 404)
        self.assertEqual(self.lookups, [])


if __name__ == "__main__":
    unittest.main()
