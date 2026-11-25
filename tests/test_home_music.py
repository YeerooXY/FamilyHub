from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from threading import RLock
import unittest
from unittest.mock import Mock, patch

from flask import Flask, g, request

from music_web import home_albums, home_radio
from music_web.listening_history import ListeningHistory
from music_web.playlists import PlaylistError, PlaylistStore


def library_track(identifier, title, artist="North Atlas", genre="Rock"):
    return dict(id=identifier, title=title, channel=artist, library_album="Evening Signals",
                duration=203, saved=True, genre=genre)


def deezer(path, **kwargs):
    if path.startswith("search/album?"):
        return {"data": [{"id": 99, "title": "Evening Signals", "artist": {"name": "Other Artist"}},
                         {"id": 42, "title": "Evening Signals", "artist": {"name": "North Atlas"}}]}
    if path == "album/42":
        return {"title": "Evening Signals", "nb_tracks": 2}
    if path == "album/42/tracks?limit=100&index=0":
        return {"data": [{"id": 101, "title": "First Light", "artist": {"name": "North Atlas"}, "duration": 203}]}
    if path == "album/42/tracks?limit=100&index=1":
        return {"data": [{"id": 102, "title": "Last Light", "artist": {"name": "North Atlas"}, "duration": 203}]}
    raise AssertionError(path)


class HomeAlbumsTests(unittest.TestCase):
    def test_complete_list_cached_and_reconciled_against_fresh_library(self):
        reader = Mock(side_effect=deezer)
        lookup = home_albums.AlbumCatalogue()
        album = lookup.lookup("Evening Signals", "North Atlas", read=reader)
        self.assertEqual([t["spotify_uri"] for t in album["tracks"]], ["deezer:101", "deezer:102"])
        anchor = library_track("01234567890", "First Light")
        self.assertEqual([t["state"] for t in home_albums.match_tracks(album["tracks"], [anchor])], ["saved", "unmatched"])
        cached = lookup.lookup("Evening Signals", "north atlas", read=reader)
        library = [anchor, library_track("12345678901", "Last Light")]
        self.assertEqual([t["source_id"] for t in home_albums.match_tracks(cached["tracks"], library)], [t["id"] for t in library])
        self.assertEqual(reader.call_count, 4)

    def test_incomplete_response_is_retryable(self):
        lookup = home_albums.AlbumCatalogue()
        with self.assertRaises(PlaylistError):
            lookup.lookup("Evening Signals", "North Atlas", read=lambda path: {"data": []} if "index=1" in path else deezer(path))
        self.assertEqual(len(lookup.lookup("Evening Signals", "North Atlas", read=deezer)["tracks"]), 2)

    def test_routes_start_existing_download_preparation_and_reuse_private_playlist(self):
        with TemporaryDirectory() as directory:
            app = Flask(__name__)
            app.before_request(lambda: setattr(g, "user", "alex"))
            store = PlaylistStore(directory)
            preparation = Mock()
            anchor = library_track("01234567890", "First Light")
            home_albums.register(app, lambda limit: request.get_json(), lambda *args: True,
                                 lambda: [anchor], store, preparation, RLock(), lambda p, owner: p)
            client = app.test_client()
            data = {"recording_id": anchor["id"]}
            with patch.object(home_albums, "_deezer", side_effect=OSError("HTTP 503 details")):
                failure = client.post("/api/home/album", json=data)
                self.assertEqual(failure.status_code, 503)
                self.assertNotIn("HTTP", failure.json["error"])
            with patch.object(home_albums, "_deezer", side_effect=deezer) as read:
                album = client.post("/api/home/album", json=data).json["playlist"]
                self.assertEqual(client.post("/api/home/album/play", json={**data, "album_id": "wrong"}).status_code, 409)
                play = {**data, "album_id": album["id"]}
                first = client.post("/api/home/album/play", json=play).json["playlist"]
                second = client.post("/api/home/album/play", json=play).json["playlist"]
                self.assertEqual(first["id"], second["id"])
                self.assertFalse(first["shared"])
                self.assertEqual([t["state"] for t in first["tracks"]], ["saved", "unmatched"])
                preparation.start.assert_called_with("alex", first["id"], "download", actor="alex")
                self.assertEqual(read.call_count, 4)


class HomeRadioTests(unittest.TestCase):
    def test_history_builds_time_genre_and_artist_shortcuts(self):
        library = [library_track(str(i), f"Song {i}", f"Artist {i % 3}", "Jazz" if i % 2 else "Rock") for i in range(20)]
        events = [dict(recording_id=str(i), started_at=f"2026-11-25T{hour:02}:00:00Z")
                  for i, hour in enumerate([4, 4, 18, 18])]
        now = datetime(2026, 11, 25, 18, tzinfo=timezone.utc)
        result = home_radio.shortcuts(library, events, ["19", "18"], now, ListeningHistory.timestamp, 120)
        keyed = {shortcut["key"]: shortcut for shortcut in result}
        self.assertEqual(keyed["morning"]["track_ids"], ["1", "0"])
        self.assertEqual(keyed["evening"]["track_ids"], ["3", "2"])
        self.assertEqual(keyed["recent"]["track_ids"], ["19", "18"])
        self.assertEqual(keyed["genre:rock"]["label"], "Rock mix")
        self.assertIn("artist:artist 0", keyed)
        self.assertLessEqual(len(result), 7)
        self.assertEqual(result, home_radio.shortcuts(library, events, ["19", "18"], now, ListeningHistory.timestamp, 120))

    def test_cold_start_and_duplicate_recordings(self):
        library = [library_track("1", "First Light"), library_track("2", "First Light"), library_track("3", "Last Light")]
        now = datetime(2026, 11, 25, tzinfo=timezone.utc)
        result = home_radio.shortcuts(library, [], [], now, ListeningHistory.timestamp)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["label"], "Daily mix")
        self.assertEqual(len(result[0]["track_ids"]), 2)
        self.assertEqual(home_radio.shortcuts([], [], [], now, ListeningHistory.timestamp), [])

    def test_route_uses_only_current_profile_and_mixes_without_index(self):
        app = Flask(__name__)
        app.before_request(lambda: setattr(g, "user", "alex"))
        history = Mock(events=Mock(return_value=[]), utc=Mock(return_value=datetime(2026, 11, 25, tzinfo=timezone.utc)))
        library = [library_track("1", "First Light"), library_track("2", "New Arrival", "Second Artist")]
        library[1]["added_at"] = "2026-11-25T08:00:00+00:00"
        home_radio.register(app, lambda *args: True, lambda: library, lambda: None, history, None)
        response = app.test_client().get("/api/home/radio?offset=60")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["key"] for row in response.json["shortcuts"]], ["daily", "recent"])
        history.events.assert_called_once_with("alex")
