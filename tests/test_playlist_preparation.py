import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from music_web.playlist_preparation import PlaylistPreparation, _PlaylistOperation
from music_web.playlists import PlaylistStore
from tests.test_music_web import Base

PID = "p" * 22
URL = "https://www.youtube.com/watch?v=abcdefghijk"

def entry(title="Song"):
    return {"title": title, "artist": "Artist", "duration": 200, "spotify_uri": "spotify:track:" + title, "state": "unmatched", "candidates": []}

def candidate(source="abcdefghijk"):
    return {"id": source, "url": "https://www.youtube.com/watch?v=" + source, "title": "Artist - Song", "channel": "Artist", "duration": 200}

class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = PlaylistStore(self.temp.name)
        self.lock = threading.RLock()
        self.store.save("alex", {"id": PID, "name": "List", "revision": 1, "tracks": []})

    def finish(self, coordinator):
        coordinator.thread.join(3)
        self.assertFalse(coordinator.thread.is_alive())
        return coordinator.status("alex", PID)

    def test_idle_queue_starts_three_playlists_then_picks_up_the_next_batch(self):
        release=threading.Event();called=[]
        def prepare(user,track,progress):called.append(track['title']);release.wait(2);return dict(candidate(),saved=True)
        coordinator=PlaylistPreparation(self.store,self.lock,prepare)
        for n in range(4):
            pid=str(n)*22
            self.store.save('alex',dict(id=pid,name=str(n),revision=1,tracks=[dict(entry(str(n)),state='ready',source_id='abcdefghijk',match=candidate())]))
        self.assertEqual(coordinator.queue_idle(['alex'],lambda:False),[])
        try:
            selected=coordinator.queue_idle(['alex'],lambda:True)
            self.assertEqual(len(selected),3)
            self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[])
        finally:release.set()
        for op in list(coordinator.operations.values()):
            if op.thread:op.thread.join(3)
        self.assertEqual(len(coordinator.queue_idle(['alex'],lambda:True)),1)
        coordinator.thread.join(3)
        self.assertEqual(sorted(called),['0','1','2','3'])
        self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[])

    def test_idle_queue_refills_a_free_place_while_other_playlists_run(self):
        release=threading.Event()
        def prepare(user,track,progress):
            if track['title']=='0': release.wait(2)
            return dict(candidate(),saved=True)
        coordinator=PlaylistPreparation(self.store,self.lock,prepare)
        self.store.save('alex',dict(id='0'*22,name='0',revision=1,tracks=[dict(entry('0'),state='ready',source_id='abcdefghijk',match=candidate())]))
        try:
            self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[('alex','0'*22)])
            self.store.save('alex',dict(id='1'*22,name='1',revision=1,tracks=[dict(entry('1'),state='ready',source_id='abcdefghijk',match=candidate())]))
            self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[('alex','1'*22)])
        finally:release.set()
        for op in list(coordinator.operations.values()):
            if op.thread:op.thread.join(3)

    def test_idle_matching_downloads_approved_choices_and_preserves_review_pool(self):
        tracks=[entry('New'),dict(entry('Review'),state='review',match=candidate()),dict(entry('Failed'),state='error')]
        self.store.save('alex',dict(id=PID,name='List',revision=1,tracks=tracks))
        matched=[];downloaded=[]
        def match(user,track,progress):matched.append(track['title']);return candidate()
        def prepare(user,track,progress):downloaded.append(track['title']);return dict(candidate(),saved=True)
        coordinator=PlaylistPreparation(self.store,self.lock,prepare,match)
        self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[('alex',PID)])
        status=self.finish(coordinator)
        self.assertEqual(matched,['New']);self.assertEqual(downloaded,['New'])
        self.assertEqual([t['state'] for t in self.store.read('alex',PID)['tracks']],['saved','review','error'])
        self.assertTrue(status['automatic'])
        self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[])

    def test_manual_pause_is_not_overridden_by_idle_queue(self):
        data=dict(id=PID,name='List',revision=1,tracks=[dict(entry(),state='ready',source_id='abcdefghijk',match=candidate())])
        self.store.save('alex',data)
        coordinator=PlaylistPreparation(self.store,self.lock,lambda user,track,progress:dict(candidate(),saved=True))
        coordinator.pause('alex',PID)
        self.assertEqual(coordinator.queue_idle(['alex'],lambda:True),[])
        coordinator.start('alex',PID);self.finish(coordinator)
        self.assertFalse(self.store.read('alex',PID)['auto_download_paused'])

    def test_new_playlist_gets_next_slot_and_combined_bulk_work_stays_at_three(self):
        second='q'*22
        for pid,prefix,count in [(PID,'A',5),(second,'B',1)]:
            self.store.save('alex',dict(id=pid,name=prefix,revision=1,tracks=[entry(prefix+str(i)) for i in range(count)]))
        releases={name:threading.Event() for name in ['A0','A1','A2','A3','A4','B0']}
        entered={name:threading.Event() for name in releases};calls=[];guard=threading.Lock();active=peak=0
        def prepare(user,track,progress):
            nonlocal active,peak
            name=track['title']
            with guard: active+=1;peak=max(peak,active);calls.append(name)
            entered[name].set();releases[name].wait(3)
            with guard: active-=1
            return dict(candidate(),saved=True)
        coordinator=PlaylistPreparation(self.store,self.lock,prepare,download_workers=3)
        coordinator.start('alex',PID);first_thread=coordinator.thread
        try:
            self.assertTrue(all(entered[n].wait(1) for n in ['A0','A1','A2']))
            coordinator.start('alex',second);second_thread=coordinator.thread
            until=time.monotonic()+1
            while not coordinator.waiters and time.monotonic()<until: time.sleep(.01)
            self.assertTrue(coordinator.waiters)
            releases['A0'].set();self.assertTrue(entered['B0'].wait(1))
            self.assertFalse(entered['A3'].is_set())
            self.assertEqual(len(coordinator.work()),2)
        finally:
            for event in releases.values():event.set()
            first_thread.join(3);coordinator.thread.join(3)
        self.assertLessEqual(peak,3)
        self.assertEqual(coordinator.status('alex',PID)['state'],'done')
        self.assertEqual(coordinator.status('alex',second)['state'],'done')
        self.assertLess(calls.index('B0'),calls.index('A3'))

    def test_listening_defers_bulk_and_pause_does_not_mark_waiting_tracks_failed(self):
        allowed=threading.Event();called=threading.Event()
        self.store.save('alex',dict(id=PID,name='List',revision=1,tracks=[entry('One')]))
        def prepare(user,track,progress):called.set();return dict(candidate(),saved=True)
        coordinator=PlaylistPreparation(self.store,self.lock,prepare,allow_background=allowed.is_set)
        coordinator.start('alex',PID)
        self.assertFalse(called.wait(.15));coordinator.pause('alex',PID)
        status=self.finish(coordinator)
        self.assertEqual((status['state'],status['processed'],status['failed']),('paused',0,0))
        allowed.set();coordinator.start('alex',PID);self.finish(coordinator)
        self.assertTrue(called.is_set())

    def test_three_downloads_pause_drains_only_inflight_and_resumes_gaps(self):
        data = self.store.read("alex", PID)
        data["tracks"] = [entry(str(i)) for i in range(6)]
        self.store.save("alex", data)
        entered = [threading.Event() for _ in range(6)]
        release = threading.Event()
        calls = []
        def prepare(user, track, progress):
            index = int(track["title"])
            calls.append(index)
            progress("Downloading", file_phase="downloading", download_bytes=index + 1, download_total_bytes=None)
            entered[index].set()
            release.wait(2)
            return dict(candidate(), saved=True, download_size=100)
        coordinator = PlaylistPreparation(self.store, self.lock, prepare, download_workers=3)
        coordinator.start("alex", PID)
        try:
            self.assertTrue(all(event.wait(1) for event in entered[:3]))
            self.assertEqual(set(calls), {0, 1, 2})
            status = coordinator.status("alex", PID)
            self.assertEqual(len(status["active_downloads"]), 3)
            self.assertEqual((status["index"], status["download_bytes"]), (1, 1))
            coordinator.pause("alex", PID)
        finally:
            release.set()
        status = self.finish(coordinator)
        self.assertEqual((status["state"], status["saved"]), ("paused", 3))
        coordinator.start("alex", PID)
        status = self.finish(coordinator)
        self.assertEqual(status["saved"], 6)
        self.assertEqual(sorted(calls), list(range(6)))
        self.assertEqual(status["active_downloads"], [])

    def test_file_progress_is_persisted_and_reset_for_next_recording(self):
        data = self.store.read("alex", PID)
        data["tracks"] = [entry("One"), entry("Two")]
        self.store.save("alex", data)
        observations = []
        def prepare(user, track, progress):
            initial = coordinator.status(user, PID)
            observations.append((initial["download_bytes"], initial["download_total_bytes"], initial["file_size_bytes"]))
            progress("Downloading", file_phase="downloading", download_bytes=123, download_total_bytes=None)
            self.assertEqual(coordinator.status(user, PID)["download_bytes"], 123)
            progress("Purifying", file_phase="purifying", download_bytes=456, download_total_bytes=456)
            return dict(candidate(), saved=True, download_size=789)
        coordinator = PlaylistPreparation(self.store, self.lock, prepare, None, None)
        coordinator.start("alex", PID, "download")
        status = self.finish(coordinator)
        self.assertEqual(observations, [(0, None, None), (0, None, None)])
        self.assertEqual((status["file_phase"], status["download_bytes"], status["download_total_bytes"], status["file_size_bytes"]), ("saved", 456, 456, 789))

    def test_import_has_reading_then_per_track_matching_then_downloads_matches(self):
        read_entered, release = threading.Event(), threading.Event()
        downloads = []
        def prepare(user, track, progress):
            downloads.append(track["title"]); return {**candidate(), "saved": True}
        def read(provider, url, progress):
            progress(2, 2)
            read_entered.set()
            release.wait(2)
            return {"id": "x" * 22, "name": "Imported", "tracks": [entry(), entry("Unknown")]}
        def match(user, track, progress):
            progress("Searching YouTube")
            return candidate() if track["title"] == "Song" else None
        coordinator = PlaylistPreparation(self.store, self.lock, prepare, match, read)
        coordinator.begin_import("alex", PID, 1, "spotify", "https://open.spotify.com/playlist/" + "x" * 22)
        self.assertTrue(read_entered.wait(1))
        status = coordinator.status("alex", PID)
        self.assertEqual((status["phase"], status["loaded"], status["total"]), ("reading", 2, 2))
        with self.assertRaises(ValueError): coordinator.start("alex", "z" * 22)
        release.set()
        status = self.finish(coordinator)
        self.assertEqual((status["mode"], status["state"], status["saved"]), ("download", "done", 1))
        tracks = self.store.read("alex", PID)["tracks"]
        self.assertEqual([t["state"] for t in tracks], ["saved", "review"])
        self.assertEqual(tracks[0]["source_id"], "abcdefghijk")
        # Only the confident match downloads; the song needing review waits for the owner.
        self.assertEqual(downloads, ["Song"])

    def test_download_one_at_a_time_pause_and_resume(self):
        data = self.store.read("alex", PID); data["tracks"] = [entry("One"), entry("Two")]; self.store.save("alex", data)
        entered, release = threading.Event(), threading.Event()
        calls = []
        def prepare(user, track, progress):
            calls.append(track["title"]); progress("Purifying audio")
            if track["title"] == "One" and len(calls) == 1:
                entered.set(); release.wait(2)
            return {**candidate(), "saved": True}
        coordinator = PlaylistPreparation(self.store, self.lock, prepare)
        coordinator.start("alex", PID)
        self.assertTrue(entered.wait(1))
        self.assertEqual(calls, ["One"])
        self.assertEqual(coordinator.status("alex", PID)["message"], "Purifying audio")
        self.assertEqual(coordinator.pause("alex", PID)["state"], "pausing")
        release.set(); status = self.finish(coordinator)
        self.assertEqual((status["state"], status["saved"]), ("paused", 1))
        self.assertEqual(calls, ["One"])
        coordinator.start("alex", PID); status = self.finish(coordinator)
        self.assertEqual((status["state"], status["saved"]), ("done", 2))
        self.assertEqual(calls, ["One", "Two"])
        self.assertEqual([t["state"] for t in self.store.read("alex", PID)["tracks"]], ["saved", "saved"])

    def test_failure_does_not_claim_saved_or_stop_following_tracks(self):
        data = self.store.read("alex", PID); data["tracks"] = [entry("Bad"), entry("Good")]; self.store.save("alex", data)
        def prepare(user, track, progress):
            if track["title"] == "Bad": raise ValueError("signed URL secret must not appear")
            return {**candidate(), "saved": True}
        coordinator = PlaylistPreparation(self.store, self.lock, prepare)
        coordinator.start("alex", PID); status = self.finish(coordinator)
        self.assertEqual((status["saved"], status["failed"]), (1, 1))
        self.assertNotIn("secret", str(status))
        self.assertEqual([t["state"] for t in self.store.read("alex", PID)["tracks"]], ["error", "saved"])

    def test_restart_marks_running_state_paused(self):
        data = self.store.read("alex", PID); data["preparation"] = {"state": "running", "mode": "download", "processed": 4}; self.store.save("alex", data)
        coordinator = PlaylistPreparation(self.store, self.lock, lambda *args: None)
        self.assertEqual(coordinator.status("alex", PID)["state"], "paused")
        self.assertEqual(self.store.read("alex", PID)["preparation"]["processed"], 4)

    def test_three_search_limit_out_of_order_pause_preserves_results(self):
        data = self.store.read("alex", PID); data["tracks"] = [entry(str(i)) for i in range(6)]; self.store.save("alex", data)
        entered = [threading.Event() for _ in range(6)]
        release = [threading.Event() for _ in range(6)]
        counts_lock = threading.Lock()
        active = maximum = 0
        calls = []
        def match(user, track, progress):
            nonlocal active, maximum
            index = int(track["title"])
            with counts_lock:
                active += 1; maximum = max(maximum, active); calls.append(index)
            entered[index].set()
            release[index].wait(3)
            with counts_lock: active -= 1
            return candidate()
        coordinator = PlaylistPreparation(self.store, self.lock, lambda *args: self.fail("Matching downloaded audio"), match)
        self.addCleanup(lambda: [event.set() for event in release])
        coordinator.start("alex", PID, "match")
        self.assertTrue(all(event.wait(1) for event in entered[:3]))
        coordinator.pause("alex", PID)
        release[2].set()
        deadline = time.monotonic() + 2
        while coordinator.status("alex", PID)["processed"] != 1 and time.monotonic() < deadline:
            time.sleep(.01)
        status = coordinator.status("alex", PID)
        self.assertEqual((status["processed"], status["cursor"], status["completed_after"]), (1, 0, [2]))
        self.assertEqual(self.store.read("alex", PID)["tracks"][2]["state"], "ready")
        self.assertFalse(any(event.is_set() for event in entered[3:]))
        release[0].set(); release[1].set()
        status = self.finish(coordinator)
        self.assertEqual((status["state"], status["processed"], status["cursor"], status["completed_after"]), ("paused", 3, 3, []))
        for event in release: event.set()
        coordinator.start("alex", PID, "match"); status = self.finish(coordinator)
        self.assertEqual((status["processed"], status["found"]), (6, 6))
        self.assertEqual(sorted(calls), list(range(6)))
        self.assertEqual(maximum, 3)

    def test_restart_resumes_gaps_without_rechecking_completed_later_rows(self):
        data = self.store.read("alex", PID)
        data["tracks"] = [entry(str(i)) for i in range(4)]
        data["tracks"][1].update(state="ready", source_id="abcdefghijk", match=candidate())
        data["preparation"] = {**_PlaylistOperation._status("match", 4), "state": "running",
                               "processed": 1, "cursor": 0, "completed_after": [1], "found": 1,
                               "playlist_revision": 1}
        self.store.save("alex", data)
        calls = []
        def match(user, track, progress):
            calls.append(int(track["title"]))
            return candidate()
        coordinator = PlaylistPreparation(self.store, self.lock, lambda *args: None, match)
        self.assertEqual(coordinator.status("alex", PID)["state"], "paused")
        coordinator.start("alex", PID, "match"); status = self.finish(coordinator)
        self.assertEqual(sorted(calls), [0, 2, 3])
        self.assertEqual((status["processed"], status["found"], status["cursor"], status["completed_after"]), (4, 4, 4, []))

    def test_edit_while_paused_resets_parallel_resume_cursor(self):
        data = self.store.read("alex", PID)
        data["tracks"] = [entry("New order"), entry("Other")]
        data["revision"] = 2
        data["preparation"] = {**_PlaylistOperation._status("match", 2), "state": "paused",
                               "processed": 1, "cursor": 0, "completed_after": [1], "found": 1,
                               "playlist_revision": 1}
        self.store.save("alex", data)
        calls = []
        coordinator = PlaylistPreparation(self.store, self.lock, lambda *args: None,
                                          lambda user, track, progress: calls.append(track["title"]) or candidate())
        coordinator.start("alex", PID, "match"); status = self.finish(coordinator)
        self.assertCountEqual(calls, ["New order", "Other"])
        self.assertEqual((status["processed"], status["found"]), (2, 2))

    def test_resume_reranks_completed_review_from_cache_without_touching_manual_choice(self):
        data = self.store.read("alex", PID)
        topic = {**candidate(), "kind": "topic"}
        repost = {**candidate("lmnopqrstuv"), "kind": "other"}
        data["tracks"] = [
            {**entry(), "state": "review", "candidates": [repost, topic]},
            {**entry(), "state": "review", "candidates": [{**candidate(), "title": "Other song"}]},
            {**entry(), "state": "review", "candidates": [repost, topic], "source_id": "lmnopqrstuv", "match": repost},
            entry("Next")]
        data["preparation"] = {**_PlaylistOperation._status("match", 4), "state": "paused", "processed": 3,
                               "cursor": 3, "review": 3, "playlist_revision": 1}
        self.store.save("alex", data)
        calls = []
        coordinator = PlaylistPreparation(self.store, self.lock, lambda *args: None,
                                          lambda user, track, progress: calls.append(track["title"]) or candidate())
        coordinator.start("alex", PID, "match"); status = self.finish(coordinator)
        stored = self.store.read("alex", PID)
        self.assertEqual(calls, ["Next"])
        self.assertEqual(stored["tracks"][0]["source_id"], "abcdefghijk")
        self.assertEqual(stored["tracks"][0]["state"], "ready")
        self.assertEqual(stored["tracks"][1]["state"], "review")
        self.assertEqual(stored["tracks"][2]["source_id"], "lmnopqrstuv")
        self.assertEqual((status["found"], status["review"], status["processed"]), (2, 2, 4))

    def test_download_can_queue_behind_active_matching_and_runs_serially(self):
        data = self.store.read("alex", PID); data["tracks"] = [entry(str(i)) for i in range(3)]; self.store.save("alex", data)
        entered = [threading.Event() for _ in range(3)]; release = threading.Event()
        download_calls = []
        active = maximum = 0
        def match(user, track, progress):
            entered[int(track["title"])].set(); release.wait(2)
            return candidate()
        def prepare(user, track, progress):
            nonlocal active, maximum
            active += 1; maximum = max(active, maximum)
            download_calls.append(track["title"])
            time.sleep(.01)
            active -= 1
            return {**candidate(), "saved": True}
        coordinator = PlaylistPreparation(self.store, self.lock, prepare, match)
        coordinator.start("alex", PID, "match")
        self.assertTrue(all(event.wait(1) for event in entered))
        queued = coordinator.start("alex", PID, "download")
        self.assertTrue(queued["download_after_matching"])
        self.assertEqual(queued["mode"], "match")
        self.assertEqual(download_calls, [])
        release.set(); status = self.finish(coordinator)
        self.assertEqual((status["mode"], status["state"], status["saved"]), ("download", "done", 3))
        self.assertFalse(status["download_after_matching"])
        self.assertEqual(download_calls, ["0", "1", "2"])
        self.assertEqual(maximum, 1)

    def test_pause_keeps_queued_download_dormant_then_resume_continues_pipeline(self):
        data = self.store.read("alex", PID); data["tracks"] = [entry()]; self.store.save("alex", data)
        entered, release = threading.Event(), threading.Event()
        downloads = []
        def match(user, track, progress):
            entered.set(); release.wait(2); return candidate()
        coordinator = PlaylistPreparation(self.store, self.lock,
            lambda user, track, progress: downloads.append(track["title"]) or {**candidate(), "saved": True}, match)
        coordinator.start("alex", PID, "match"); self.assertTrue(entered.wait(1))
        coordinator.start("alex", PID, "download"); coordinator.pause("alex", PID)
        release.set(); status = self.finish(coordinator)
        self.assertEqual(status["state"], "paused")
        self.assertTrue(status["download_after_matching"])
        self.assertEqual(downloads, [])
        coordinator.start("alex", PID, "match"); status = self.finish(coordinator)
        self.assertEqual(downloads, ["Song"])
        self.assertEqual((status["mode"], status["saved"]), ("download", 1))

    def test_restart_and_download_request_resume_pending_matching_before_download(self):
        data = self.store.read("alex", PID)
        data["tracks"] = [{**entry("Done"), "source_id": "abcdefghijk", "match": candidate(), "state": "ready"}, entry("Remaining")]
        data["preparation"] = {**_PlaylistOperation._status("match", 2), "state": "running", "processed": 1,
                               "cursor": 1, "found": 1, "playlist_revision": 1, "download_after_matching": True}
        self.store.save("alex", data)
        calls = []
        coordinator = PlaylistPreparation(self.store, self.lock,
            lambda user, track, progress: calls.append("download:" + track["title"]) or {**candidate(), "saved": True},
            lambda user, track, progress: calls.append("match:" + track["title"]) or candidate())
        # No preliminary GET/status call: POST download must recover the persisted running state itself.
        coordinator.start("alex", PID, "download"); status = self.finish(coordinator)
        self.assertEqual(calls, ["match:Remaining", "download:Done", "download:Remaining"])
        self.assertEqual((status["saved"], status["mode"]), (2, "download"))
        self.assertFalse(status["download_after_matching"])

    def test_queued_download_survives_import_reading_pause_for_same_link(self):
        entered, release = threading.Event(), threading.Event()
        downloads = []
        def read(provider, url, progress):
            entered.set(); release.wait(2)
            return {"id": "x" * 22, "name": "Imported", "tracks": [entry()]}
        coordinator = PlaylistPreparation(self.store, self.lock,
            lambda user, track, progress: downloads.append(track["title"]) or {**candidate(), "saved": True},
            lambda *args: candidate(), read)
        coordinator.begin_import("alex", PID, 1, "spotify", "same-link")
        self.assertTrue(entered.wait(1)); coordinator.start("alex", PID, "download")
        coordinator.pause("alex", PID); release.set(); status = self.finish(coordinator)
        self.assertTrue(status["download_after_matching"])
        self.assertEqual(downloads, [])
        self.assertEqual(self.store.read("alex", PID)["tracks"], [])
        coordinator.begin_import("alex", PID, 1, "spotify", "same-link"); status = self.finish(coordinator)
        self.assertEqual((status["mode"], status["saved"]), ("download", 1))
        self.assertEqual(downloads, ["Song"])

    def test_queued_download_keeps_unresolved_and_failed_matches_without_research(self):
        data = self.store.read("alex", PID); data["tracks"] = [entry("Found"), entry("Unknown"), entry("Failed")]; self.store.save("alex", data)
        entered, release = threading.Event(), threading.Event()
        downloads = []
        def match(user, track, progress):
            entered.set(); release.wait(2)
            if track["title"] == "Failed": raise ValueError("search failed")
            return candidate() if track["title"] == "Found" else None
        coordinator = PlaylistPreparation(self.store, self.lock,
            lambda user, track, progress: downloads.append(track["title"]) or {**candidate(), "saved": True}, match)
        coordinator.start("alex", PID, "match"); self.assertTrue(entered.wait(1))
        coordinator.start("alex", PID, "download"); release.set(); status = self.finish(coordinator)
        self.assertEqual(downloads, ["Found"])
        self.assertEqual((status["saved"], status["review"], status["failed"]), (1, 1, 1))

class PreparationApiTests(Base):
    def wait_preparation(self):
        coordinator = self.state.playlist_preparation
        coordinator.thread.join(3)
        self.assertFalse(coordinator.thread.is_alive())

    def test_import_accepts_valid_upload_choices_then_downloads(self):
        client, token = self.signed_in()
        target = self.post(client, token, "/api/playlists", json={"name": "Empty"}).get_json()["playlist"]
        imported = {"id": "x" * 22, "name": "Imported", "tracks": [entry()]}
        with patch("music_web.fetch_playlist", return_value=imported), patch.object(self.intake, "cmd_search", return_value={"results": [candidate(), candidate("lmnopqrstuv")]}) as search:
            result = self.post(client, token, "/api/playlists/" + target["id"] + "/import", json={"provider": "spotify", "url": "https://open.spotify.com/playlist/" + "x" * 22, "revision": target["revision"]})
            self.assertEqual(result.status_code, 202)
            self.wait_preparation()
        status = self.go(client, "GET", "/api/playlists/" + target["id"] + "/prepare").get_json()
        self.assertEqual((status["mode"], status["state"], status["total"]), ("download", "done", 1))
        self.assertEqual(search.call_count, 1)

    def test_async_import_is_owner_scoped_and_rejects_invalid_source(self):
        client, token = self.signed_in()
        target = self.post(client, token, "/api/playlists", json={"name": "Empty"}).get_json()["playlist"]
        other, other_token = self.signed_in("sample-b")
        result = self.post(other, other_token, "/api/playlists/" + target["id"] + "/prepare", json={"mode": "download"})
        self.assertEqual(result.status_code, 409)
        self.assertIsNone(self.state.playlist_preparation.thread)
        result = self.post(client, token, "/api/playlists/" + target["id"] + "/import", json={"provider": "spotify", "url": "https://evil.test/playlist/" + "x" * 22, "revision": target["revision"]})
        self.assertEqual(result.status_code, 400)
        self.assertIsNone(self.state.playlist_preparation.thread)

    def test_structural_edit_blocked_while_matching(self):
        client, token = self.signed_in()
        target = self.post(client, token, "/api/playlists", json={"name": "Empty"}).get_json()["playlist"]
        entered, release = threading.Event(), threading.Event()
        def reader(*args, **kwargs):
            entered.set(); release.wait(2)
            return {"id": "x" * 22, "name": "Imported", "tracks": []}
        with patch("music_web.fetch_playlist", side_effect=reader):
            self.post(client, token, "/api/playlists/" + target["id"] + "/import", json={"provider": "spotify", "url": "https://open.spotify.com/playlist/" + "x" * 22, "revision": target["revision"]})
            self.assertTrue(entered.wait(1))
            result = self.go(client, "PATCH", "/api/playlists/" + target["id"], json={"name": "Changed", "revision": target["revision"]}, headers={"X-CSRFToken": token})
            self.assertEqual(result.status_code, 409)
            release.set(); self.wait_preparation()

    def test_cached_exact_topic_is_chosen_without_network_search(self):
        client, token = self.signed_in()
        playlist = self.post(client, token, "/api/playlists", json={"name": "Cached"}).json["playlist"]
        playlist["tracks"] = [{**entry(), "state": "review", "candidates": [
            {**candidate("lmnopqrstuv"), "kind": "other"}, {**candidate(), "kind": "topic"}]}]
        PlaylistStore(self.ws).save("sample-a", playlist)
        with patch.object(self.intake, "cmd_search") as search:
            response = self.post(client, token, "/api/playlists/" + playlist["id"] + "/prepare", json={"mode": "match"})
            self.assertEqual(response.status_code, 200)
            self.wait_preparation()
            search.assert_not_called()
        stored = PlaylistStore(self.ws).read("sample-a", playlist["id"])
        self.assertEqual(stored["tracks"][0]["source_id"], "abcdefghijk")
        self.assertEqual(stored["tracks"][0]["state"], "ready")
        self.assertEqual(self.state.jobs, {})

    def test_matching_uses_all_thirty_search_candidates(self):
        client, token = self.signed_in()
        playlist = self.post(client, token, "/api/playlists", json={"name": "Pool"}).json["playlist"]
        playlist["tracks"] = [entry()]
        PlaylistStore(self.ws).save("sample-a", playlist)
        results = [{**candidate(f"{i:011d}"), "title": "Other recording"} for i in range(29)]
        results.append({**candidate(), "kind": "topic"})
        with patch.object(self.intake, "cmd_search", return_value={"results": results}) as search:
            self.post(client, token, "/api/playlists/" + playlist["id"] + "/prepare", json={"mode": "match"})
            self.wait_preparation()
        self.assertEqual(search.call_args.args[0].limit, 30)
        stored = PlaylistStore(self.ws).read("sample-a", playlist["id"])
        self.assertEqual(stored["tracks"][0]["source_id"], "abcdefghijk")


class RecordingReviewApiTests(Base):
    def create_review(self, client, token):
        playlist = self.post(client, token, "/api/playlists", json={"name": "Review"}).get_json()["playlist"]
        playlist["tracks"] = [{**entry(), "state": "review", "candidates": [candidate(), candidate("lmnopqrstuv")]}]
        PlaylistStore(self.ws).save("sample-a", playlist)
        return playlist

    def test_review_choices_bind_without_downloading(self):
        client, token = self.signed_in()
        playlist = self.create_review(client, token)
        path = "/api/playlists/" + playlist["id"]
        response = self.go(client, "GET", path + "/match?index=0&revision=" + str(playlist["revision"]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json["track"]["candidates"]), 2)
        self.assertFalse(response.json["track"]["candidates"][0]["saved"])
        result = self.post(client, token, path + "/recording", json={"index": 0, "choice": 1, "source_id": "lmnopqrstuv", "revision": playlist["revision"]})
        self.assertEqual(result.status_code, 200)
        selected = result.json["playlist"]["tracks"][0]
        self.assertEqual((selected["source_id"], selected["state"]), ("lmnopqrstuv", "ready"))
        self.assertEqual(self.state.jobs, {})
        self.assertEqual(result.json["playlist"]["revision"], playlist["revision"] + 1)

    def test_reordered_playlist_and_replaced_candidates_cannot_bind_wrong_recording(self):
        client, token = self.signed_in()
        playlist = self.create_review(client, token)
        path = "/api/playlists/" + playlist["id"]
        data = {"index": 0, "choice": 0, "source_id": "lmnopqrstuv", "revision": playlist["revision"]}
        self.assertEqual(self.post(client, token, path + "/recording", json=data).status_code, 409)
        data.update(source_id="abcdefghijk", revision=playlist["revision"] - 1)
        self.assertEqual(self.post(client, token, path + "/recording", json=data).status_code, 409)
        self.assertEqual(self.go(client, "GET", path + "/match?index=0&revision=0").status_code, 409)
        with patch.object(self.intake, "cmd_search") as search:
            self.assertEqual(self.post(client, token, path + "/match", json={"index": 0, "revision": 0}).status_code, 409)
            search.assert_not_called()
        other, other_token = self.signed_in("sample-b")
        data["revision"] = playlist["revision"]
        self.assertEqual(self.post(other, other_token, path + "/recording", json=data).status_code, 400)
        self.assertEqual(self.go(client, "POST", path + "/recording", json=data).status_code, 400)

    def test_original_duration_matches_purified_recording_without_accepting_wrong_version(self):
        from music_web.playlists import rank_matches, duration_matches
        track = {"title": "Kukasauto", "artist": "DESH", "duration": 196}
        recording = {"id": "5LAEZp9_K68", "url": "https://www.youtube.com/watch?v=5LAEZp9_K68", "title": "Kukasauto", "channel": "DESH", "duration": 179.77, "original_duration": 195.73}
        self.assertTrue(duration_matches(track, recording))
        self.assertTrue(rank_matches(track, [recording])[0]["recommended"])
        self.assertFalse(rank_matches(track, [{**recording, "title": "Kukasauto (Live)"}])[0]["recommended"])
        self.assertFalse(duration_matches(track, {**recording, "original_duration": 250}))
