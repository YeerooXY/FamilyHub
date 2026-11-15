import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from music_web.playlists import fetch_youtube_playlist, PlaylistError
from tests.test_music_web import Base

class YouTubeReader(unittest.TestCase):
    def test_full_playlist_and_url_boundary(self):
        rows = [{"id": f"{i:011d}", "title": f"Track {i}", "channel": "Artist", "duration": 200} for i in range(549)]
        intake = SimpleNamespace(tool=lambda _: "yt-dlp", run=Mock(return_value=(0, json.dumps({"title": "DnB", "entries": rows}), "")))
        result = fetch_youtube_playlist("https://www.youtube.com/playlist?list=PL1234567890", intake)
        self.assertEqual(len(result["tracks"]), 549)
        self.assertEqual(result["tracks"][-1]["source_id"], "00000000548")
        for url in ["https://evil.test/playlist?list=PL1234567890", "https://youtube.com:8080/playlist?list=PL1234567890", "https://user@youtube.com/playlist?list=PL1234567890", "http://youtube.com/playlist?list=PL1234567890"]:
            with self.assertRaises(PlaylistError): fetch_youtube_playlist(url, intake)
        self.assertEqual(intake.run.call_count, 1)
    def test_oversize_and_empty_fail(self):
        for entries in [[], [{}] * 10001]:
            intake = SimpleNamespace(tool=lambda _: "yt-dlp", run=lambda *args: (0, json.dumps({"entries": entries}), ""))
            with self.assertRaises(PlaylistError): fetch_youtube_playlist("https://youtube.com/playlist?list=PL1234567890", intake)


class PlaylistImportApi(Base):
    def test_target_import_and_revision_conflict(self):
        client, token = self.signed_in()
        target = self.post(client, token, "/api/playlists", json={"name": "Empty"}).get_json()["playlist"]
        imported = {"id": "x" * 22, "name": "Imported", "tracks": [{"title": "Song", "artist": "Artist", "duration": 200, "spotify_uri": "spotify:track:one", "state": "unmatched", "candidates": []}]}
        with patch("music_web.fetch_playlist", return_value=imported):
            result = self.post(client, token, "/api/playlists/spotify", json={"url": "https://open.spotify.com/playlist/" + "x" * 22, "target_id": target["id"], "revision": target["revision"]})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.get_json()["playlist"]["id"], target["id"])
        self.assertEqual(len(self.go(client, "GET", "/api/playlists").get_json()["playlists"]), 1)
        with patch("music_web.fetch_playlist") as reader:
            result = self.post(client, token, "/api/playlists/spotify", json={"url": "unused", "target_id": target["id"], "revision": target["revision"]})
            self.assertEqual(result.status_code, 409)
            reader.assert_not_called()
    def test_youtube_routes_to_reader(self):
        client, token = self.signed_in()
        with patch("music_web.fetch_youtube_playlist", return_value={"id": "x" * 22, "name": "Videos", "tracks": []}) as reader:
            result = self.post(client, token, "/api/playlists/youtube", json={"url": "https://youtube.com/playlist?list=PL1234567890"})
        self.assertEqual(result.status_code, 200)
        self.assertIs(reader.call_args.args[1], self.app.intake)
