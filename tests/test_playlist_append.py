"""Append imports and legacy dates use the existing playlist store and intake flow."""
import io
import json
import tempfile
import threading
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from music_web.playlists import PlaylistStore
from music_web.playlist_preparation import PlaylistPreparation
from test_music_web import Base
import test_native_music_api as native
from test_playlist_preparation import entry, candidate, PID


class PlaylistAppendTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = PlaylistStore(temporary.name)
        self.lock = threading.RLock()
        self.original = dict(id=PID, name="Family mix", revision=3, description="Keep this",
                             shared=False, co_authors=["editor"], url="original-link",
                             tracks=[dict(entry("Existing"), state="review",
                                          candidates=[dict(candidate(), title="Artist - Existing", kind="video", channel="Unrelated uploader")])])  # not auto-resolvable, so the row must stay in review
        self.store.save("owner", self.original)

    def finish(self, coordinator):
        coordinator.thread.join(3)
        self.assertFalse(coordinator.thread.is_alive())
        return self.store.read("owner", PID)

    def test_append_keeps_existing_rows_and_prepares_only_new_songs(self):
        matched, downloaded = [], []
        def match(user, track, progress):
            matched.append(track["title"])
            return candidate()
        def download(user, track, progress):
            downloaded.append(track["title"])
            return dict(candidate(), saved=True)
        def read(*args):
            return dict(id="x" * 22, name="Source name", tracks=[
                entry("Existing"), dict(entry("Existing"), spotify_uri="deezer:existing"),
                dict(entry("Alternate label"), spotify_uri="deezer:existing"),
                entry("New"), entry("New"), entry("New (Live)")])
        coordinator = PlaylistPreparation(self.store, self.lock, download, match, read)
        coordinator.begin_import("owner", PID, 3, "spotify", "link", append=True, actor="editor")
        stored = self.finish(coordinator)
        self.assertEqual(stored["tracks"][0], self.original["tracks"][0])
        self.assertEqual([t["title"] for t in stored["tracks"]], ["Existing", "New", "New (Live)"])
        self.assertCountEqual(matched, ["New", "New (Live)"])
        self.assertCountEqual(downloaded, matched)
        status = coordinator.status("owner", PID)
        self.assertEqual((status["total"], status["processed"], status["saved"], status["review"]), (2, 2, 2, 0))
        self.assertTrue(all(t["state"] == "saved" and t["added_at"] and t["added_by"] == "editor"
                            for t in stored["tracks"][1:]))
        for field in ("name", "description", "shared", "co_authors", "url"):
            self.assertEqual(stored[field], self.original[field])
        matched.clear(); downloaded.clear()
        coordinator.begin_import("owner", PID, stored["revision"], "spotify", "link", append=True)
        again = self.finish(coordinator)
        self.assertEqual(again["tracks"], stored["tracks"])
        self.assertEqual((matched, downloaded), ([], []))

    def test_manual_matching_after_finished_append_can_process_the_whole_playlist(self):
        matched = []
        coordinator = PlaylistPreparation(self.store, self.lock,
            lambda *args: dict(candidate(), saved=True),
            lambda user, track, progress: matched.append(track["title"]) or candidate(),
            lambda *args: dict(id=PID, name="Source", tracks=[entry("New")]))
        coordinator.begin_import("owner", PID, 3, "spotify", "link", append=True)
        self.finish(coordinator)
        self.assertEqual(matched, ["New"])
        matched.clear()
        coordinator.start("owner", PID, "match")
        self.finish(coordinator)
        self.assertCountEqual(matched, ["Existing", "New"])

    def test_append_pause_and_resume_downloads_only_the_new_rows(self):
        entered, release = threading.Event(), threading.Event()
        downloaded = []
        def match(user, track, progress):
            entered.set(); release.wait(2)
            return candidate()
        def download(user, track, progress):
            downloaded.append(track["title"])
            return dict(candidate(), saved=True)
        coordinator = PlaylistPreparation(self.store, self.lock, download, match,
            lambda *args: dict(id=PID, name="Source", tracks=[entry("New")]))
        coordinator.begin_import("owner", PID, 3, "spotify", "link", append=True)
        try:
            self.assertTrue(entered.wait(1))
            coordinator.pause("owner", PID)
        finally:
            release.set()
        self.finish(coordinator)
        coordinator.start("owner", PID, "download")
        stored = self.finish(coordinator)
        self.assertEqual(downloaded, ["New"])
        self.assertEqual(stored["tracks"][0], self.original["tracks"][0])

    def test_append_rejects_stale_revision_and_default_still_requires_empty_playlist(self):
        reader = Mock()
        coordinator = PlaylistPreparation(self.store, self.lock, None, None, reader)
        for revision, append in ((2, True), (True, True), (3, False)):
            with self.assertRaises(ValueError):
                coordinator.begin_import("owner", PID, revision, "spotify", "link", append=append)
        reader.assert_not_called()
        self.assertEqual(self.store.read("owner", PID)["tracks"], self.original["tracks"])

    def test_append_paused_while_reading_requires_the_link_again(self):
        entered, release = threading.Event(), threading.Event()
        matched, downloaded = Mock(return_value=candidate()), Mock(return_value=candidate())
        def read(*args):
            entered.set(); release.wait(2)
            return dict(id=PID, name="Source", tracks=[entry("New")])
        coordinator = PlaylistPreparation(self.store, self.lock, downloaded, matched, read)
        coordinator.begin_import("owner", PID, 3, "spotify", "link", append=True)
        try:
            self.assertTrue(entered.wait(1))
            coordinator.pause("owner", PID)
        finally:
            release.set()
        self.finish(coordinator)
        for mode in ("match", "download"):
            with self.assertRaisesRegex(ValueError, "link again"):
                coordinator.start("owner", PID, mode)
        matched.assert_not_called(); downloaded.assert_not_called()
        self.assertEqual(self.store.read("owner", PID)["tracks"], self.original["tracks"])
        self.assertTrue(self.store.read("owner", PID)["auto_download_paused"])
        coordinator.begin_import("owner", PID, 3, "spotify", "link", append=True)
        stored = self.finish(coordinator)
        self.assertEqual([t["title"] for t in stored["tracks"]], ["Existing", "New"])
        self.assertEqual(stored["tracks"][0], self.original["tracks"][0])

    def test_failed_append_keeps_original_tracks(self):
        coordinator = PlaylistPreparation(self.store, self.lock, None, None,
            Mock(side_effect=ValueError("Unavailable")))
        coordinator.begin_import("owner", PID, 3, "spotify", "link", append=True)
        stored = self.finish(coordinator)
        self.assertEqual(stored["tracks"], self.original["tracks"])
        self.assertEqual(stored["preparation"]["state"], "error")

    def test_append_skips_same_recording_even_with_different_metadata(self):
        original = deepcopy(self.original)
        original["tracks"][0]["source_id"] = "abcdefghijk"
        self.store.save("owner", original)
        stored = self.store.import_playlist("owner", dict(id=PID, name="Source", tracks=[
            dict(entry("Other title"), source_id="abcdefghijk"), entry("Fresh")]), append=True)
        self.assertEqual([t["title"] for t in stored["tracks"]], ["Existing", "Fresh"])

    def test_append_limit_keeps_existing_entries(self):
        full = dict(self.original, tracks=[dict(entry("Existing")) for _ in range(10000)])
        self.store.save("owner", full)
        with self.assertRaisesRegex(ValueError, "10,000"):
            self.store.import_playlist("owner", dict(id=PID, name="Source", tracks=[entry("New")]), append=True)
        self.assertEqual(self.store.read("owner", PID), full)

    def test_append_preserves_distinct_non_latin_titles_and_skips_cross_provider_duplicates(self):
        original = dict(self.original, tracks=[dict(entry("Song 一"), artist="歌手")])
        self.store.save("owner", original)
        stored = self.store.import_playlist("owner", dict(id=PID, name="Source", tracks=[
            dict(entry("Song 一"), artist="歌手", spotify_uri="deezer:one"),
            dict(entry("Song 二"), artist="歌手", spotify_uri="deezer:two")]), append=True)
        self.assertEqual([t["title"] for t in stored["tracks"]], ["Song 一", "Song 二"])
        self.assertEqual(stored["tracks"][0], original["tracks"][0])

    def test_read_and_save_backfill_dates_once_without_changing_revision_or_attribution(self):
        legacy = deepcopy(self.original)
        legacy["tracks"] = [entry(), dict(entry("Null"), added_at=None), dict(entry("Empty"), added_at=""),
                            dict(entry("Dated"), added_at="2026-01-01T00:00:00Z", added_by="editor")]
        target = self.store.directory("owner") / (PID + ".json")
        target.write_text(json.dumps(legacy), encoding="utf-8")
        before = datetime.now(timezone.utc)
        migrated = self.store.read("owner", PID)
        after = datetime.now(timezone.utc)
        for track in migrated["tracks"][:3]:
            self.assertTrue(before <= datetime.fromisoformat(track["added_at"]) <= after)
            self.assertNotIn("added_by", track)
        self.assertEqual(migrated["tracks"][3], legacy["tracks"][3])
        self.assertEqual(migrated["revision"], 3)
        persisted = target.read_bytes()
        self.assertEqual(json.loads(persisted), migrated)
        with patch.object(self.store, "save", wraps=self.store.save) as save:
            self.assertEqual(self.store.read("owner", PID), migrated)
            save.assert_not_called()
        self.store.save("owner", migrated)
        self.assertEqual(target.read_bytes(), persisted)
        migrated["tracks"].append(entry("Radio song"))
        self.store.save("owner", migrated)
        self.assertTrue(migrated["tracks"][-1]["added_at"])
        self.assertEqual(migrated["tracks"][:-1], json.loads(persisted)["tracks"])


class UploadToPlaylistTests(Base):
    def test_upload_then_add_to_existing_playlist_keeps_previous_entries(self):
        native.NativeMusicApi.recording(self, native.FIRST)
        item, _, manifest, audio = native.NativeMusicApi.recording(self, native.SECOND, title="Uploaded song")
        local_id = "local-" + manifest["audio"]["sha256"][:16]
        local_item = item.parent / local_id
        item.rename(local_item)
        manifest.update(id=local_id, source=dict(kind="local"))
        self.intake.write_manifest(str(local_item), manifest)
        client, token = self.signed_in()
        playlist = self.post(client, token, "/api/playlists", json={"name": "Existing playlist"}).json["playlist"]
        path = "/api/playlists/" + playlist["id"]
        playlist = self.go(client, "PATCH", path, json=dict(revision=1, add_source_id=native.FIRST),
                           headers={"X-CSRFToken": token}).json["playlist"]
        previous = deepcopy(playlist["tracks"])
        with patch.object(self.intake, "cmd_stage", return_value=dict(item=str(local_item), manifest=manifest)):
            result = self.post(client, token, "/api/uploads", data=dict(read_tags="true", file=(io.BytesIO(audio), "song.wav")))
            self.assertEqual(result.status_code, 202, result.json)
            job = self.wait(client, result.json["job"]["id"])
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(job["source_id"], local_id)
        result = self.go(client, "PATCH", path, json=dict(revision=playlist["revision"], add_source_id=job["source_id"]),
                         headers={"X-CSRFToken": token})
        self.assertEqual(result.status_code, 200, result.json)
        tracks = result.json["playlist"]["tracks"]
        self.assertEqual(tracks[:-1], previous)
        self.assertEqual(tracks[-1]["source_id"], local_id)
        self.assertTrue(tracks[-1]["added_at"])
        self.assertEqual(tracks[-1]["added_by"], "sample-a")
