import json
import unittest
from unittest import mock

from music_web import link_playlists as links
from music_web.playlists import PlaylistError


class LinkPlaylistTests(unittest.TestCase):
    def test_detects_supported_sites_and_rejects_others(self):
        cases = {"https://open.spotify.com/playlist/" + "a" * 22: "spotify",
                 "https://music.youtube.com/playlist?list=PL123": "youtube",
                 "https://soundcloud.com/monstercat/sets/uncaged": "soundcloud",
                 "https://www.deezer.com/en/playlist/908622995": "deezer",
                 "http://soundcloud.com/a/sets/b": None, "https://evil.test/playlist/1": None,
                 "https://user:pw@www.deezer.com/playlist/1": None, 5: None}
        for url, expected in cases.items():
            self.assertEqual(links.detect(url), expected, url)

    def test_deezer_reads_every_page_into_unmatched_rows(self):
        pages = {"playlist/42": {"title": "Road trip", "nb_tracks": 3},
                 "playlist/42/tracks?limit=100&index=0": {"data": [
                     {"id": 1, "title": "Hey Jude", "artist": {"name": "The Beatles"}, "duration": 429, "album": {"title": "1"}},
                     {"id": 2, "title": "Song 2", "artist": {"name": "Blur"}, "duration": 122, "album": {"title": "Blur"}}]},
                 "playlist/42/tracks?limit=100&index=2": {"data": [
                     {"id": 3, "title": "Wonderwall", "artist": {"name": "Oasis"}, "duration": 258, "album": {"title": "Morning Glory"}}]}}
        result = links.fetch_deezer_playlist("https://www.deezer.com/en/playlist/42", read=pages.__getitem__)
        self.assertEqual(result["name"], "Road trip")
        self.assertEqual([t["title"] for t in result["tracks"]], ["Hey Jude", "Song 2", "Wonderwall"])
        self.assertEqual(result["tracks"][0], {"title": "Hey Jude", "artist": "The Beatles", "duration": 429, "spotify_uri": "deezer:1",
                                               "album": "1", "candidates": [], "state": "unmatched"})
        with self.assertRaises(PlaylistError):
            links.fetch_deezer_playlist("https://www.deezer.com/en/track/42", read=pages.__getitem__)

    def test_soundcloud_set_strips_artist_prefix_and_needs_a_set_link(self):
        intake = mock.Mock()
        intake.tool.return_value = "yt-dlp"
        intake.run.return_value = (0, json.dumps({"title": "Uncaged", "entries": [
            {"id": "321600703", "title": "Rogue - Unity", "artist": "Rogue", "duration": 202.9},
            {"id": "x", "title": "Skipped"},
            {"id": "315388431", "title": "Watch Out", "uploader": "Monstercat", "duration": 202.7}]}).encode(), "")
        result = links.fetch_soundcloud_playlist("https://soundcloud.com/monstercat/sets/uncaged/", intake)
        self.assertEqual([(t["title"], t["artist"], t["duration"]) for t in result["tracks"]],
                         [("Unity", "Rogue", 203), ("Watch Out", "Monstercat", 203)])
        self.assertEqual(intake.run.call_args[0][0][-1], "https://soundcloud.com/monstercat/sets/uncaged")
        with self.assertRaises(PlaylistError):
            links.soundcloud_link("https://soundcloud.com/monstercat/rogue-unity")


if __name__ == "__main__":
    unittest.main()


class LinkNameTests(unittest.TestCase):
    def test_reads_names_without_fetching_tracks(self):
        seen = []
        def read(address):
            seen.append(address)
            if "deezer" in address: return {"title": "Road trip"}
            if "soundcloud" in address: return {"title": "Uncaged Vol. 1 by Monstercat", "author_name": "Monstercat"}
            return {"title": "DnB\n"}
        self.assertEqual(links.link_name("https://open.spotify.com/playlist/" + "a" * 22, read), ("spotify", "DnB"))
        self.assertIn("open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com", seen[-1])
        self.assertEqual(links.link_name("https://soundcloud.com/monstercat/sets/uncaged", read), ("soundcloud", "Uncaged Vol. 1"))
        self.assertEqual(links.link_name("https://www.deezer.com/en/playlist/42", read), ("deezer", "Road trip"))
        self.assertEqual(seen[-1], "https://api.deezer.com/playlist/42")

    def test_unknown_names_are_blank_and_other_sites_are_refused(self):
        def fail(address): raise OSError("offline")
        self.assertEqual(links.link_name("https://www.youtube.com/playlist?list=PL1", fail), ("youtube", ""))
        with self.assertRaises(PlaylistError): links.link_name("https://evil.test/playlist/1", fail)
