"""Song and artist radio built from Deezer's artist radio and related artists (no network)."""
import unittest
from music_web import radio
from music_web.playlists import PlaylistError


def song(i, artist, title, duration=200):
    return {"id": i, "title": title, "duration": duration, "artist": {"id": 1, "name": artist}, "album": {"title": "Album"}}


PAGES = {
    "track/9": song(9, "Taio Cruz", "Dynamite") | {"artist": {"id": 1, "name": "Taio Cruz"}},
    "artist/1/radio?limit=50": {"data": [song(10 + n, "Taio Cruz", f"Hit {n}") for n in range(6)] + [song(30, "INNA", "Club Rocker (Radio Edit)"), song(31, "INNA", "Endless")]},
    "artist/1/related?limit=8": {"data": [{"id": 2, "name": "Flo Rida"}, {"id": 3, "name": "Pitbull"}]},
    "artist/2/top?limit=5": {"data": [song(40, "Flo Rida", "Right Round"), song(41, "Flo Rida", "Low")]},
    "artist/3/top?limit=5": {"data": [song(50, "Pitbull", "Fun"), song(9, "Taio Cruz", "Dynamite")]},
}


class Radio(unittest.TestCase):
    def test_seed_song_first_variety_and_no_variants(self):
        data = radio.read_radio("familyhub-radio:track:9", "Dynamite Radio", read=PAGES.__getitem__)
        titles = [(r["artist"], r["title"]) for r in data["tracks"]]
        self.assertEqual(titles[0], ("Taio Cruz", "Dynamite"))
        self.assertLessEqual(sum(a == "Taio Cruz" for a, _ in titles), radio.PER_ARTIST)
        self.assertIn(("Flo Rida", "Right Round"), titles)
        self.assertNotIn(("INNA", "Club Rocker (Radio Edit)"), titles, "edits and remixes are left out")
        self.assertEqual(len(titles), len(set(titles)), "a song appears once")
        self.assertEqual(data["tracks"][0]["spotify_uri"], "deezer:9")

    def test_seed_picks_the_matching_song_or_best_known_artist(self):
        pages = {"search?q=Taio+Cruz+Dynamite&limit=10": {"data": [song(8, "Someone", "Dynamite"), song(9, "Taio Cruz", "Dynamite")]},
                 "search/artist?q=Pendulum&limit=10": {"data": [{"id": 5, "name": "Pendulum", "nb_fan": 3}, {"id": 281, "name": "Pendulum", "nb_fan": 900000}]}}
        self.assertEqual(radio.seed("Taio Cruz, Lolly", "Taio Cruz - Dynamite (Official Video)", read=pages.__getitem__), ("familyhub-radio:track:9", "Dynamite Radio"))
        self.assertEqual(radio.seed("Pendulum", read=pages.__getitem__), ("familyhub-radio:artist:281", "Pendulum Radio"))
        with self.assertRaises(PlaylistError): radio.seed("", read=pages.__getitem__)
        with self.assertRaises(PlaylistError): radio.read_radio("https://evil.test/radio", "x", read=pages.__getitem__)
