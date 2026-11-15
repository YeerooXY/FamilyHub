"""Offline source barrier, cancellation, byte-boundary and connected coordinator checks."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from tests.test_music_intake import Base, HAVE_FFMPEG, ffmpeg, mi
from tests.test_music_web import Base as WebBase, META, URL


class DownloadSizeTests(unittest.TestCase):
    def test_only_exact_single_http_size_is_used(self):
        self.assertEqual(mi.exact_download_size({"filesize": 123, "protocol": "https"}), 123)
        for metadata in ({"filesize_approx": 123, "protocol": "https"},
                         {"filesize": 123, "protocol": "m3u8_native"},
                         {"filesize": 123, "protocol": "https", "fragments": [{}]},
                         {"filesize": True, "protocol": "https"},
                         {"filesize": -1, "protocol": "https"}):
            self.assertIsNone(mi.exact_download_size(metadata))


@unittest.skipUnless(HAVE_FFMPEG, "FFmpeg required")
class Progressive(Base):
    def test_saved_audio_publishes_decodable_segment_before_encoding_finishes(self):
        source = self.source()
        staged = mi.cmd_stage(SimpleNamespace(file=str(source), workspace=str(self.ws)))
        root = self.tmp / "saved-hls"
        observed = []
        original_command = mi.hls_command
        def paced(audio, output):
            command = original_command(audio, output)
            command[command.index("-i"):command.index("-i")] = ["-readrate", "8"]
            return command
        def notify():
            playlist = root / "index.m3u8"
            if observed or not playlist.exists():
                return
            text = playlist.read_text()
            if "seg00000.m4s" in text and "#EXT-X-ENDLIST" not in text:
                first = self.tmp / "saved-first.mp4"
                first.write_bytes((root / "init.mp4").read_bytes() + (root / "seg00000.m4s").read_bytes())
                decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", str(first), "-f", "s16le", "-"], capture_output=True, timeout=5)
                self.assertEqual(decoded.returncode, 0)
                self.assertGreater(len(decoded.stdout), 1000)
                observed.append(True)
        with mock.patch.object(mi, "hls_command", side_effect=paced):
            mi.cmd_preview(SimpleNamespace(item=staged["item"], output=str(root), notify=notify))
        self.assertEqual(observed, [True], "Saved playback waited for complete encoding")

    def source(self):
        path = self.tmp / "source.webm"
        ffmpeg("-f", "lavfi", "-i", "sine=frequency=300:duration=40", "-c:a", "libopus", str(path))
        return path

    def producer(self, path, fail=False):
        release = self.tmp / "release"
        eof = self.tmp / "eof"
        code = ("import os,sys,time,pathlib; p=pathlib.Path(sys.argv[1]); data=p.read_bytes(); "
                "sys.stdout.buffer.write(data[:len(data)//2]); sys.stdout.buffer.flush();\n"
                "while not pathlib.Path(sys.argv[2]).exists(): time.sleep(.02)\n"
                "sys.stdout.buffer.write(data[len(data)//2:]); sys.stdout.buffer.flush(); "
                "pathlib.Path(sys.argv[3]).write_text('EOF'); sys.exit(" + ("1" if fail else "0") + ")")
        return [sys.executable, "-c", code, str(path), str(release), str(eof)], release, eof

    def test_first_decoded_segment_precedes_upstream_eof_and_exact_spool(self):
        source = self.source()
        command, release, eof = self.producer(source)
        root, spool = self.tmp / "hls", self.tmp / "spool"
        result, failures = {}, []
        byte_progress = []
        cancel = threading.Event()
        def run():
            try:
                result.update(mi.pump_preview(command, str(spool), str(root), cancel, timeout=30,
                                              progress=lambda **fields: byte_progress.append(fields)))
            except Exception as e:
                failures.append(e)
        thread = threading.Thread(target=run)
        thread.start()
        try:
            decoded = False
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not failures:
                segments = sorted(root.glob("seg*.m4s"))
                if segments and (root / "init.mp4").exists():
                    first = self.tmp / "first.mp4"
                    first.write_bytes((root / "init.mp4").read_bytes() + segments[0].read_bytes())
                    proc = subprocess.run(["ffmpeg", "-v", "error", "-i", str(first), "-f", "s16le", "-"], capture_output=True, timeout=5)
                    if proc.returncode == 0 and len(proc.stdout) > 1000:
                        decoded = True
                        break
                time.sleep(.05)
            self.assertTrue(decoded, str(failures))
            self.assertFalse(eof.exists(), "upstream EOF must still be held behind the barrier")
            self.assertGreater(byte_progress[-1]["download_bytes"], 0)
            self.assertIsNone(byte_progress[-1]["download_total_bytes"])
        finally:
            release.write_text("release")
            thread.join(15)
            if thread.is_alive():
                cancel.set()
                thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertFalse(failures, str(failures))
        self.assertEqual(spool.read_bytes(), source.read_bytes())
        self.assertEqual(byte_progress[-1], {"download_bytes": source.stat().st_size, "download_total_bytes": source.stat().st_size})
        self.assertEqual([p["download_bytes"] for p in byte_progress], sorted(p["download_bytes"] for p in byte_progress))
        self.assertEqual(result["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertTrue(result["preview_complete"])
        self.assertIn("#EXT-X-ENDLIST", (root / "index.m3u8").read_text())

    def test_byte_limit_cancels_and_reaps_source(self):
        source = self.source()
        command, _, eof = self.producer(source)
        start = time.monotonic()
        with self.assertRaises(mi.IntakeError):
            mi.pump_preview(command, str(self.tmp / "spool"), str(self.tmp / "hls"), threading.Event(), max_bytes=100, timeout=5)
        self.assertLess(time.monotonic() - start, 8)
        self.assertFalse(eof.exists())
        self.assertEqual(list(self.lib.iterdir()), [])

    def test_cancelled_prefix_restart_measures_duplicate_bytes_instead_of_claiming_resume(self):
        source = self.source()
        command, _, _ = self.producer(source)
        spool = self.tmp / "prefix"
        cancel = threading.Event()
        def progress():
            if spool.exists() and spool.stat().st_size >= source.stat().st_size // 2:
                cancel.set()
        with self.assertRaises(mi.IntakeError):
            mi.pump_preview(command, str(spool), str(self.tmp / "prefix-hls"), cancel, progress, timeout=10)
        prefix_bytes = spool.stat().st_size
        self.assertGreater(prefix_bytes, 0)
        result = mi.pump_preview([sys.executable, "-c", "import sys;sys.stdout.buffer.write(open(sys.argv[1],'rb').read())", str(source)],
            str(self.tmp / "complete"), str(self.tmp / "complete-hls"), threading.Event())
        self.assertEqual(result["bytes"], source.stat().st_size)
        self.assertEqual(prefix_bytes + result["bytes"] - source.stat().st_size, prefix_bytes)
        self.assertEqual(mi.sha256_file(str(self.tmp / "complete")), mi.sha256_file(str(source)))

    def test_progressive_fetch_remux_import_preserves_packets_and_original_sha(self):
        source_file = self.source()
        source = {"kind": "youtube", "id": "dQw4w9WgXcQ", "url": URL, "lossy": True}
        original_pump = mi.pump_preview
        def local_pump(command, *args, **kw):
            return original_pump([sys.executable, "-c", "import sys;sys.stdout.buffer.write(open(sys.argv[1],'rb').read())", str(source_file)], *args, **kw)
        args = SimpleNamespace(workspace=str(self.ws), preview=str(self.tmp / "hls"), cancel=threading.Event(),
                               notify=lambda: None, budget=lambda: None, preview_failed=lambda: None)
        with mock.patch.object(mi, "tool", side_effect=lambda name: sys.executable if name == "yt-dlp" else __import__('shutil').which(name)), mock.patch.object(mi, "pump_preview", local_pump):
            item = mi.progressive_fetch(args, {"format_id": "251", "duration": 40}, source)
        _, manifest, audio = mi.load_item(item["item"])
        self.assertEqual(manifest["source"]["original_sha256"], mi.sha256_file(str(source_file)))
        self.assertEqual(Path(item["item"], "original.spool").read_bytes(), source_file.read_bytes())
        self.assertEqual(mi.packet_hash(audio), mi.packet_hash(str(source_file)))
        result = self.do_import(Path(item["item"]))
        mi.decode_check(result["imported"])
        self.assertEqual(mi.packet_hash(result["imported"]), mi.packet_hash(str(source_file)))

    def test_nonsequential_m4a_falls_back_without_second_acquisition(self):
        source_file = self.tmp / "end-metadata.m4a"
        ffmpeg("-f", "lavfi", "-i", "sine=duration=20", "-c:a", "aac", str(source_file))
        command, release, eof = self.producer(source_file)
        root = self.tmp / "hls"
        args = SimpleNamespace(workspace=str(self.ws), preview=str(root), cancel=threading.Event(),
                               notify=lambda: None, budget=lambda: None, preview_failed=lambda: None)
        original_pump = mi.pump_preview
        paths, result, errors = [], {}, []
        def local_pump(_command, spool, *rest, **kw):
            paths.append(spool)
            return original_pump(command, spool, *rest, **kw)
        def fetch():
            try:
                result.update(mi.progressive_fetch(args, {"format_id": "140", "duration": 20},
                    {"kind": "youtube", "id": "dQw4w9WgXcQ", "url": URL, "lossy": True}))
            except Exception as e:
                errors.append(e)
        with mock.patch.object(mi, "tool", side_effect=lambda name: sys.executable if name == "yt-dlp" else __import__('shutil').which(name)), mock.patch.object(mi, "pump_preview", local_pump):
            thread = threading.Thread(target=fetch)
            thread.start()
            try:
                deadline = time.monotonic() + 5
                half = source_file.stat().st_size // 2
                while time.monotonic() < deadline and not errors:
                    if paths and Path(paths[0]).exists() and Path(paths[0]).stat().st_size >= half:
                        break
                    time.sleep(.02)
                self.assertTrue(paths and Path(paths[0]).stat().st_size >= half)
                self.assertFalse(eof.exists())
                self.assertEqual(list(root.glob("seg*.m4s")), [])
            finally:
                release.write_text("release")
                thread.join(15)
                if thread.is_alive():
                    args.cancel.set()
                    thread.join(5)
        self.assertFalse(errors, errors)
        self.assertEqual(len(paths), 1)
        self.assertIn("#EXT-X-ENDLIST", (root / "index.m3u8").read_text())
        self.assertEqual(Path(result["item"], "original.spool").read_bytes(), source_file.read_bytes())

    def test_clean_short_source_is_not_published_for_longer_metadata(self):
        source_file = self.tmp / "short.opus"
        ffmpeg("-f", "lavfi", "-i", "sine=duration=5", "-c:a", "libopus", str(source_file))
        original_pump = mi.pump_preview
        def local_pump(_command, *rest, **kw):
            return original_pump([sys.executable, "-c", "import sys;sys.stdout.buffer.write(open(sys.argv[1],'rb').read())", str(source_file)], *rest, **kw)
        args = SimpleNamespace(workspace=str(self.ws), preview=str(self.tmp / "hls"), cancel=threading.Event(),
                               notify=lambda: None, budget=lambda: None, preview_failed=lambda: None)
        with mock.patch.object(mi, "tool", side_effect=lambda name: sys.executable if name == "yt-dlp" else __import__('shutil').which(name)), mock.patch.object(mi, "pump_preview", local_pump):
            with self.assertRaises(mi.IntakeError):
                mi.progressive_fetch(args, {"format_id": "251", "duration": 40},
                    {"kind": "youtube", "id": "dQw4w9WgXcQ", "url": URL, "lossy": True})
        self.assertEqual(list(self.ws.iterdir()), [])
        self.assertEqual(list(self.lib.iterdir()), [])


class Coordinator(WebBase):
    extra = {'ALLOWED_USERS':['sample-a','sample-b',*[f'burst-{i}' for i in range(9)]]}

    def test_eight_foreground_listeners_can_prepare_together_and_ninth_waits(self):
        release=threading.Event();eight=threading.Event();guard=threading.Lock();active=peak=started=0;jobs=[]
        def fetch(args):
            nonlocal active,peak,started
            with guard:
                active+=1;started+=1;peak=max(peak,active)
                if started==8:eight.set()
            try:release.wait(4);return {'item':'fixture'}
            finally:
                with guard:active-=1
        with mock.patch.object(self.intake,'cmd_fetch',side_effect=fetch),mock.patch.object(self.intake,'cmd_import'):
            try:
                for i in range(9):
                    client,token=self.signed_in(f'burst-{i}')
                    result=self.post(client,token,'/api/jobs',json={'url':'https://youtu.be/'+f'{i:011d}',**META})
                    self.assertEqual(result.status_code,202,result.json);jobs.append((client,result.json['job']['id']))
                self.assertTrue(eight.wait(1));self.assertEqual(started,8);self.assertEqual(peak,8)
                self.assertEqual(self.state.jobs[jobs[-1][1]]['state'],'queued')
            finally:release.set()
            for client,jid in jobs:self.assertEqual(self.wait(client,jid)['state'],'done')
            self.assertEqual(started,9);self.assertLessEqual(peak,8)

    def test_foreground_admission_has_headroom_when_background_queue_is_full(self):
        other,ot=self.signed_in('sample-b');release=threading.Event();background=[]
        def fetch(args):release.wait(4);return {'item':'fixture'}
        with mock.patch.object(self.intake,'cmd_fetch',side_effect=fetch),mock.patch.object(self.intake,'cmd_import'):
            try:
                for owner in range(4):
                    client,token=self.signed_in(f'burst-{owner}');background.append((client,token))
                    rows=[dict(url='https://youtu.be/'+f'{owner*6+i:011d}') for i in range(6)]
                    response=self.post(client,token,'/api/queue',json=dict(tracks=rows,allow_new=True))
                    self.assertEqual(response.status_code,200,response.json)
                self.assertEqual(sum(j['state'] in ('queued','running') for j in self.state.jobs.values()),24)
                response=self.post(other,ot,'/api/jobs',json={'url':URL,**META})
                self.assertEqual(response.status_code,202,response.json)
                jid=response.json['job']['id']
            finally:
                for client,token in background:self.post(client,token,'/api/queue',json=dict(tracks=[],allow_new=True))
                release.set()
            self.assertEqual(self.wait(other,jid)['state'],'done')

    def test_three_background_jobs_reserve_fourth_slot_and_other_owner_cancel_isolated(self):
        first, token = self.signed_in()
        other, other_token = self.signed_in("sample-b")
        release = threading.Event()
        three_started = threading.Event()
        foreground_started = threading.Event()
        guard = threading.Lock()
        calls = []
        active = peak = 0
        def fetch(args):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
                calls.append(args.url)
                if len(calls) == 3: three_started.set()
                if args.url == URL: foreground_started.set()
            try:
                while not release.wait(.01):
                    if args.cancel.is_set(): raise self.intake.IntakeError("cancelled")
                return {"item": "fixture"}
            finally:
                with guard: active -= 1
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), mock.patch.object(self.intake, "cmd_import"):
            try:
                rows = [{"url": "https://youtu.be/" + f"{i:011d}"} for i in range(1, 7)]
                response = self.post(first, token, "/api/queue", json={"tracks": rows, "allow_new": True})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(three_started.wait(2))
                time.sleep(.1)
                self.assertEqual(len(calls), 3)
                response = self.post(other, other_token, "/api/jobs", json={"url": URL, **META})
                self.assertEqual(response.status_code, 202)
                foreground = response.json["job"]["id"]
                self.assertTrue(foreground_started.wait(2))
                self.assertEqual(peak, 4)
                self.post(first, token, "/api/queue", json={"tracks": [], "allow_new": True})
                self.assertFalse(self.state.jobs[foreground]["cancel"].is_set())
                self.assertEqual(self.post(first, token, f"/api/jobs/{foreground}/cancel", json={}).status_code, 404)
            finally:
                release.set()
            self.assertEqual(self.wait(other, foreground)["state"], "done")
            self.assertLessEqual(peak, 4)

    def test_eviction_refuses_changed_cache_but_next_acquisition_works(self):
        import music_web
        c, token = self.signed_in()
        self.fake_ok()
        for mode in ("missing", "modified"):
            with self.subTest(mode=mode):
                job = self.post(c, token, "/api/jobs", json={"url": URL, **META}).json["job"]
                self.wait(c, job["id"])
                private = self.state.jobs[job["id"]]
                private.update(temporary_item=True, item=str(Path(self.ws) / "yt-dQw4w9WgXcQ-000000000000"), current=False)
                if mode == "modified":
                    Path(private["item"]).mkdir(exist_ok=True)
                    Path(private["item"], "manifest.json").write_text("{}")
                for expiry in (False, True):
                    private["created"] = private["accessed"] = 0 if expiry else time.time()
                    with mock.patch.object(music_web, "MAX_JOBS", 1):
                        new = self.post(c, token, "/api/jobs", json={"url": "https://youtu.be/00000000001", **META})
                    self.assertEqual(new.status_code, 202)
                    self.assertEqual(self.wait(c, new.json["job"]["id"])["state"], "done")
                    # Reinsert the invalid cache to exercise both capacity and TTL paths.
                    self.state.jobs[private["id"]] = private
                self.state.jobs.clear()
                if mode == "modified":
                    self.assertTrue(Path(private["item"], "manifest.json").exists())

    def test_listen_does_not_cancel_upload(self):
        import io
        c, token = self.signed_in()
        entered, release = threading.Event(), threading.Event()
        def stage(args):
            entered.set()
            self.assertTrue(release.wait(3))
            self.assertFalse(self.intake.CONTROL.cancel.is_set())
            return {"item": "fake"}
        with mock.patch.object(self.intake, "cmd_stage", side_effect=stage), mock.patch.object(self.intake, "cmd_import"), mock.patch.object(self.intake, "cmd_fetch", return_value={"item": "fake"}):
            upload = self.post(c, token, "/api/uploads", data={**META, "file": (io.BytesIO(b"audio"), "song.flac")}).json["job"]
            try:
                self.assertTrue(entered.wait(2))
                listen = self.post(c, token, "/api/jobs", json={"url": URL, **META}).json["job"]
                self.assertFalse(self.state.jobs[upload["id"]]["cancel"].is_set())
            finally:
                release.set()
            self.assertEqual(self.wait(c, upload["id"])["state"], "done")
            self.assertEqual(self.wait(c, listen["id"])["state"], "done")

    def test_dedupe_updates_queue_priority_and_preserves_current(self):
        c, token = self.signed_in()
        entered, release = threading.Event(), threading.Event()
        def fetch(args):
            entered.set()
            release.wait(3)
            return {"item": "fake"}
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), mock.patch.object(self.intake, "cmd_import"):
            first = self.post(c, token, "/api/queue", json={"tracks": [{"url": URL}], "allow_new": True}).json["jobs"][0]
            try:
                self.assertTrue(entered.wait(2))
                private = self.state.jobs[first["id"]]
                for before, weaker in ((1, 20), (20, 2)):
                    private["priority"] = before
                    if weaker == 20:
                        rows = [{"url": "https://youtu.be/00000000001"}, {"url": "https://youtu.be/00000000002"}, {"url": URL}]
                        body = {"tracks": rows, "allow_new": True}
                    else:
                        body = {"tracks": [], "previews": [{"url": URL, "duration": 240}], "allow_new": True}
                    self.post(c, token, "/api/queue", json=body)
                    self.assertEqual(private["priority"], weaker)
                self.post(c, token, "/api/jobs", json={"url": URL, **META})
                self.assertEqual(private["priority"], 0)
                self.assertTrue(private["current"])
                self.post(c, token, "/api/queue", json={"tracks": [{"url": URL}], "allow_new": True})
                self.assertEqual(private["priority"], 0)
                self.assertTrue(private["current"])
            finally:
                release.set()
            self.wait(c, first["id"])

    def test_metadata_edit_during_acquisition_and_rejection_after_import_starts(self):
        c, token = self.signed_in()
        entered, release = threading.Event(), threading.Event()
        importing, finish = threading.Event(), threading.Event()
        def fetch(args):
            entered.set()
            release.wait(3)
            return {"item": "fake", "manifest": {"source": {"title": "Provider title", "channel": "Provider"}}}
        def imp(args):
            importing.set()
            finish.wait(3)
        edited = {**META, "artist": "Edited artist", "title": "Edited title"}
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), mock.patch.object(self.intake, "cmd_import", side_effect=imp) as importer:
            job = self.post(c, token, "/api/jobs", json={"url": URL}).json["job"]
            try:
                self.assertTrue(entered.wait(2))
                r = self.post(c, token, "/api/jobs", json={"url": URL, **edited})
                self.assertEqual(r.status_code, 202)
                release.set()
                self.assertTrue(importing.wait(2))
                self.assertEqual(self.post(c, token, "/api/jobs", json={"url": URL, **META}).status_code, 409)
            finally:
                release.set()
                finish.set()
            result = self.wait(c, job["id"])
            self.assertEqual((result["artist"], result["title"]), (edited["artist"], edited["title"]))
            self.assertEqual(importer.call_args.args[0].artist, edited["artist"])
            self.assertEqual(self.post(c, token, "/api/jobs", json={"url": URL, **META}).status_code, 409)

    def test_public_analysis_summary_and_internal_transition_grid(self):
        c, token = self.signed_in()
        self.fake_ok()
        ids = []
        for vid in (URL, "https://youtu.be/00000000001"):
            job = self.post(c, token, "/api/jobs", json={"url": vid, **META}).json["job"]
            self.wait(c, job["id"])
            ids.append(job["id"])
            self.state.jobs[job["id"]]["analysis"] = {"reliable": True, "bpm": 120, "confidence": .9,
                "reason": "Beat grid", "beats": [i * .5 for i in range(120)], "path": self.ws}
        public = self.go(c, "GET", "/api/jobs").json
        self.assertNotIn("beats", str(public))
        self.assertNotIn(self.ws, str(public))
        with mock.patch.object(self.intake, "load_item", return_value=("fake", {"audio": {"duration": 60}}, "fake")):
            plan = self.post(c, token, "/api/transition", json={"current": ids[0], "next": ids[1], "fade": 4, "dj": True}).json["plan"]
        self.assertEqual(plan["mode"], "Beat blend")
        self.assertEqual(plan["out"], 56)

    def test_analysis_failure_and_duration_limit_are_explicit(self):
        c, token = self.signed_in()
        for mode in ("timeout", "missing_dependency", "too_long"):
            with self.subTest(mode=mode):
                root = Path(self.ws) / "analysis-item"
                root.mkdir(exist_ok=True)
                def run(command, *args):
                    if "analysis decode" in args:
                        return 0, b"", b""
                    if mode == "timeout":
                        raise self.intake.IntakeError("beat analysis timed out")
                    return 1, b"", b"ModuleNotFoundError"
                duration = 601 if mode == "too_long" else 60
                with mock.patch.object(self.intake, "cmd_fetch", return_value={"item": str(root)}), mock.patch.object(self.intake, "cmd_preview", return_value={"assets": set()}), mock.patch.object(self.intake, "cmd_import"), mock.patch.object(self.intake, "load_item", return_value=(str(root), {"audio": {"duration": duration}}, "audio")), mock.patch.object(self.intake, "run", side_effect=run) as runner, mock.patch.object(self.intake, "tool", return_value="ffmpeg"):
                    job = self.post(c, token, "/api/jobs", json={"url": URL, **META}).json["job"]
                    self.wait(c, job["id"])
                    worker = getattr(self.state, "worker", None)
                    if worker:
                        worker.join(3)
                        self.assertFalse(worker.is_alive())
                    private = self.state.jobs[job["id"]]
                    self.assertFalse(private["analysis"]["reliable"])
                    self.assertEqual(private["analysis_state"], "done")
                    self.assertFalse(private["analyzing"])
                    if mode == "too_long":
                        runner.assert_not_called()
                        self.assertIn("ten minutes", private["analysis"]["reason"])
                    else:
                        self.assertEqual(private["analysis"]["reason"], "Beat analysis unavailable")
                self.state.jobs.clear()

    def test_generations_are_revoked_with_session_records(self):
        c, token = self.signed_in()
        self.post(c, token, "/api/queue", json={"tracks": [], "allow_new": False, "generation": 8})
        record = next(iter(self.state.sessions.values()))
        self.assertEqual(record["generations"], {"queue": 8})
        self.assertEqual(self.post(c, token, "/api/queue", json={"tracks": [], "allow_new": False, "generation": 7}).status_code, 409)
        self.post(c, token, "/logout", data={"csrf_token": token})
        self.assertFalse(self.state.sessions)
        c, token = self.signed_in()
        self.assertNotIn("generations", next(iter(self.state.sessions.values())))
        self.post(c, token, "/api/queue", json={"tracks": [], "allow_new": False, "generation": 1})
        old_sid = next(iter(self.state.sessions))
        self.go(c, "POST", "/login", data={"username": "sample-a", "password": "correct-horse", "csrf_token": token})
        self.assertNotIn(old_sid, self.state.sessions)
        self.assertNotIn("generations", next(iter(self.state.sessions.values())))
        next(iter(self.state.sessions.values()))["expiry"] = 0
        self.assertEqual(self.go(c, "GET", "/api/jobs").status_code, 401)
        self.assertFalse(self.state.sessions)

    def test_cancel_during_import_validation_does_not_wait_for_publication_lock(self):
        c, token = self.signed_in()
        entered = threading.Event()
        def importing(args):
            entered.set()
            if not self.intake.CONTROL.cancel.wait(3):
                raise AssertionError("cancellation was blocked by import work")
            raise self.intake.IntakeError("cancelled")
        with mock.patch.object(self.intake, "cmd_fetch", return_value={"item": "fake"}), mock.patch.object(self.intake, "cmd_import", side_effect=importing):
            job = self.post(c, token, "/api/jobs", json={"url": URL, **META}).json["job"]
            self.assertTrue(entered.wait(2))
            start = time.monotonic()
            self.assertEqual(self.post(c, token, f"/api/jobs/{job['id']}/cancel", json={}).status_code, 200)
            self.assertLess(time.monotonic() - start, 1)
            self.assertEqual(self.wait(c, job["id"])["state"], "cancelled")

    def test_failed_jobs_without_preview_directories_are_evicted(self):
        import music_web
        c, token = self.signed_in()
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=self.intake.IntakeError("failed")):
            for _ in range(music_web.MAX_JOBS + 3):
                result = self.post(c, token, "/api/jobs", json={"url": URL, **META})
                self.assertEqual(result.status_code, 202)
                self.assertEqual(self.wait(c, result.json["job"]["id"])["state"], "error")
        self.assertEqual(len(self.state.jobs), music_web.MAX_JOBS)

    def test_priorities_obsolete_queue_and_rapid_skip_cancel_owned_work(self):
        c, token = self.signed_in()
        started, calls = threading.Event(), []
        active = 0
        def fetch(args):
            nonlocal active
            active += 1
            self.assertLessEqual(active, 4)
            calls.append(args.url)
            started.set()
            try:
                if args.url != URL:
                    if not args.cancel.wait(4):
                        raise AssertionError("obsolete acquisition was not cancelled")
                    raise self.intake.IntakeError("cancelled")
                return {"item": "fake"}
            finally:
                active -= 1
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), mock.patch.object(self.intake, "cmd_import"):
            rows = [{"url": "https://youtu.be/" + f"{i:011d}"} for i in range(1, 7)]
            first = self.post(c, token, "/api/queue", json={"tracks": rows, "allow_new": True})
            self.assertTrue(started.wait(2))
            current = self.post(c, token, "/api/jobs", json={"url": URL, **META})
            self.assertEqual(self.wait(c, current.json["job"]["id"])["state"], "done")
            self.post(c, token, "/api/queue", json={"tracks": [], "allow_new": True})
            deadline = time.monotonic() + 3
            while any(j["state"] == "running" and j["priority"] > 0 for j in self.state.jobs.values()) and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertIn(URL, calls)
            self.assertLessEqual(calls.index(URL), 3)
            self.assertEqual(self.state.jobs[first.json["jobs"][0]["id"]]["state"], "cancelled")
            self.assertTrue(all(j["state"] == "cancelled" for j in self.state.jobs.values() if j["priority"] > 0))

    def test_default_details_duplicate_taps_and_running_promotion_share_one_acquisition(self):
        c, token = self.signed_in()
        entered, release = threading.Event(), threading.Event()
        calls = []
        def fetch(args):
            calls.append(args.url)
            entered.set()
            release.wait(5)
            return {"item": "test-item"}
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), mock.patch.object(self.intake, "cmd_import") as imp:
            r = self.post(c, token, "/api/queue", json={"tracks": [{"url": URL, "title": "Exact choice", "channel": "Artist"}], "allow_new": True})
            jid = r.json["jobs"][0]["id"]
            try:
                self.assertTrue(entered.wait(2))
                for _ in range(3):
                    r = self.post(c, token, "/api/jobs", json={"url": URL})
                    self.assertEqual(r.json["job"]["id"], jid)
                self.assertEqual(self.state.jobs[jid]["priority"], 0)
            finally:
                release.set()
            self.assertEqual(self.wait(c, jid)["state"], "done")
            self.assertEqual(calls, [URL])
            self.assertEqual(imp.call_count, 1)

    def test_finished_preview_survives_scrolling_away_and_back(self):
        self.fake_ok()
        c, token = self.signed_in()
        data = {"tracks": [], "previews": [{"url": URL, "duration": 240}], "preload_search": True, "allow_new": False}
        first = self.post(c, token, "/api/queue", json=data).json["jobs"][0]
        self.wait(c, first["id"])
        self.post(c, token, "/api/queue", json={"tracks": [], "allow_new": False})
        self.assertFalse(self.state.jobs[first["id"]]["cancel"].is_set())
        again = self.post(c, token, "/api/queue", json=data).json["jobs"][0]
        self.assertEqual(first["id"], again["id"])

    def test_search_preloads_are_independent_bounded_and_reused_for_listening(self):
        self.fake_ok()
        c, token = self.signed_in()
        data = {"tracks": [], "previews": [{"url": URL, "duration": 240}],
                "allow_new": False, "preload_search": True}
        job = self.post(c, token, "/api/queue", json=data).json["jobs"][0]
        self.assertEqual(self.wait(c, job["id"])["state"], "done")
        promoted = self.post(c, token, "/api/jobs", json={"url": URL, "allow_new": True}).json["job"]
        self.assertEqual(promoted["id"], job["id"])
        self.wait(c, promoted["id"])
        for duration in (0, 601, 3600, None):
            data["previews"][0]["duration"] = duration
            self.assertEqual(self.post(c, token, "/api/queue", json=data).json["jobs"], [])
        data["preload_search"] = "true"
        self.assertEqual(self.post(c, token, "/api/queue", json=data).status_code, 400)

    def test_explicit_queue_selection_can_prepare_without_automatic_discovery(self):
        self.fake_ok()
        c, token = self.signed_in()
        data = {"tracks": [{"url": URL, "requested": True}], "allow_new": False}
        job = self.post(c, token, "/api/queue", json=data).json["jobs"][0]
        self.assertEqual(self.wait(c, job["id"])["state"], "done")
        data["tracks"][0]["requested"] = "yes"
        self.assertEqual(self.post(c, token, "/api/queue", json=data).status_code, 400)

    def test_local_queue_never_acquires_and_old_generation_is_refused(self):
        c, token = self.signed_in()
        with mock.patch.object(self.intake, "cmd_fetch") as fetch:
            r = self.post(c, token, "/api/queue", json={"tracks": [{"url": URL}], "allow_new": False, "generation": 2})
            self.assertEqual(r.json["jobs"], [])
            r = self.post(c, token, "/api/queue", json={"tracks": [{"url": URL}], "allow_new": True, "generation": 1})
            self.assertEqual(r.status_code, 409)
            fetch.assert_not_called()
            r = self.post(c, token, "/api/jobs", json={"url": URL, "allow_new": False})
            self.assertEqual(r.status_code, 403)
            fetch.assert_not_called()

    def test_cancel_owner_csrf_and_readiness(self):
        self.fake_ok()
        c, token = self.signed_in()
        other, other_token = self.signed_in("sample-b")
        job = self.post(c, token, "/api/jobs", json={"url": URL, **META}).json["job"]
        self.wait(c, job["id"])
        path = "/api/jobs/" + job["id"]
        self.assertEqual(self.post(other, other_token, path + "/cancel", json={}).status_code, 404)
        self.assertEqual(self.go(c, "POST", path + "/cancel", json={}).status_code, 400)
        self.assertEqual(self.go(c, "HEAD", path + "/media/index.m3u8").status_code, 503)
        self.assertEqual(self.go(other, "HEAD", path + "/media/index.m3u8").status_code, 404)

    def test_media_range_expiry_and_foreign_playlist_refusal(self):
        c, token = self.signed_in()
        self.fake_ok()
        job = self.post(c, token, "/api/jobs", json={"url": URL, **META}).json["job"]
        self.wait(c, job["id"])
        private = self.state.jobs[job["id"]]
        root = Path(self.ws) / (".preview-" + job["id"])
        root.mkdir()
        (root / "seg00000.m4s").write_bytes(b"0123456789")
        (root / "index.m3u8").write_text("#EXTM3U\nhttps://foreign.test/secret\n")
        private.update(preview_state="ready", assets={"seg00000.m4s", "index.m3u8"})
        prefix = "/api/jobs/" + job["id"] + "/media/"
        self.assertEqual(self.go(c, "GET", prefix + "index.m3u8").status_code, 404)
        with self.go(c, "GET", prefix + "seg00000.m4s", headers={"Range": "bytes=2-4"}) as response:
            self.assertEqual((response.status_code, response.data), (206, b"234"))
            self.assertEqual(response.headers["Content-Range"], "bytes 2-4/10")
        with self.go(c, "GET", prefix + "seg00000.m4s", headers={"Range": "bytes=30-40"}) as response:
            self.assertEqual(response.status_code, 416)
        private["created"] = private["accessed"] = 0
        self.assertEqual(self.go(c, "HEAD", prefix + "seg00000.m4s").status_code, 410)

    def test_superseded_search_is_cancelled_before_result_publication(self):
        c, token = self.signed_in()
        entered, release = threading.Event(), threading.Event()
        outputs = []
        def search(args):
            if args.query == "old":
                entered.set()
                self.assertTrue(release.wait(3))
            return {"results": []}
        def old_search():
            outputs.append(self.post(c, token, "/api/search", json={"query": "old"}).status_code)
        with mock.patch.object(self.intake, "cmd_search", side_effect=search):
            thread = threading.Thread(target=old_search)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.post(c, token, "/api/search", json={"query": "new"}).status_code, 200)
            finally:
                release.set()
                thread.join(3)
        self.assertEqual(outputs, [409])

    @unittest.skipUnless(HAVE_FFMPEG, "FFmpeg required")
    def test_two_profiles_same_source_fetch_once_and_reuse_published_recording(self):
        source_file = Path(self.ws) / "source.opus"
        ffmpeg("-f", "lavfi", "-i", "sine=duration=2", "-c:a", "libopus", str(source_file))
        first, token = self.signed_in()
        other, other_token = self.signed_in("sample-b")
        entered, release = threading.Event(), threading.Event()
        def fetch(args):
            entered.set()
            self.assertTrue(release.wait(3))
            result = self.intake.cmd_stage(SimpleNamespace(workspace=self.ws, file=str(source_file)))
            old = Path(result["item"])
            _, manifest, _ = self.intake.load_item(str(old))
            name = "yt-dQw4w9WgXcQ-" + manifest["audio"]["sha256"][:12]
            new = old.with_name(name)
            old.rename(new)
            manifest.update(id=name, source={"kind": "youtube", "id": "dQw4w9WgXcQ", "url": URL, "lossy": True})
            self.intake.write_manifest(str(new), manifest)
            return {"item": str(new), "manifest": manifest}
        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch) as acquisition:
            try:
                a = self.post(first, token, "/api/jobs", json={"url": URL, **META}).json["job"]
                self.assertTrue(entered.wait(2))
                b = self.post(other, other_token, "/api/jobs", json={"url": URL, **META}).json["job"]
                self.assertNotEqual(a["id"], b["id"])
                self.assertEqual(self.go(first, "GET", f"/api/jobs/{b['id']}").status_code, 404)
                time.sleep(.1)
                self.assertEqual(acquisition.call_count, 1)
            finally:
                release.set()
            self.assertEqual(self.wait(first, a["id"])["state"], "done")
            self.assertEqual(self.wait(other, b["id"])["state"], "done")
            self.assertEqual(acquisition.call_count, 1)

    @unittest.skipUnless(HAVE_FFMPEG, "FFmpeg required")
    def test_validated_saved_source_reused_after_job_eviction(self):
        source_file = Path(self.ws) / "source.opus"
        ffmpeg("-f", "lavfi", "-i", "sine=duration=2", "-c:a", "libopus", str(source_file))
        result = self.intake.cmd_stage(SimpleNamespace(workspace=self.ws, file=str(source_file)))
        source_file.unlink()
        old = Path(result["item"])
        _, manifest, _ = self.intake.load_item(str(old))
        name = "yt-dQw4w9WgXcQ-" + manifest["audio"]["sha256"][:12]
        new = old.with_name(name)
        old.rename(new)
        manifest.update(id=name, source={"kind": "youtube", "id": "dQw4w9WgXcQ", "url": URL, "lossy": True})
        self.intake.write_manifest(str(new), manifest)
        self.intake.cmd_import(SimpleNamespace(item=str(new), library=self.lib, track=None, **META))
        c, token = self.signed_in()
        with mock.patch.object(self.intake, "cmd_fetch") as fetch, mock.patch.object(self.intake, "cmd_import") as imp:
            job = self.post(c, token, "/api/jobs", json={"url": URL, "allow_new": False}).json["job"]
            self.assertEqual(self.wait(c, job["id"])["state"], "done")
            fetch.assert_not_called()
            imp.assert_not_called()
        self.assertEqual(len(self.post(c, token, "/api/queue", json={"tracks": [{"url": URL}], "allow_new": False}).json["jobs"]), 1)
        with mock.patch.object(self.intake, "sha256_file", wraps=self.intake.sha256_file) as hashing:
            for _ in range(3):
                self.assertEqual(len(self.go(c, "GET", "/api/library").json["results"]), 1)
            self.assertEqual(hashing.call_count, 0)
            _, manifest, audio = self.intake.load_item(str(new))
            target = Path(self.lib).joinpath(*manifest["import"]["path"].split("/"))
            original = target.read_bytes()
            target.write_bytes(original + b"changed")
            self.assertEqual(self.go(c, "GET", "/api/library").json["results"], [])
            target.write_bytes(original)
            self.assertEqual(len(self.go(c, "GET", "/api/library").json["results"]), 1)
            original_id = manifest["source"]["id"]
            manifest["source"].update(id="00000000001", url="https://www.youtube.com/watch?v=00000000001")
            self.intake.write_manifest(str(new), manifest)
            self.assertEqual(self.go(c, "GET", "/api/library").json["results"], [])
            manifest["source"].update(id=original_id, url=URL)
            self.intake.write_manifest(str(new), manifest)
            self.assertEqual(len(self.go(c, "GET", "/api/library").json["results"]), 1)
            Path(audio).chmod(0o600)
            with open(audio, "ab") as out:
                out.write(b"changed")
            hashing.reset_mock()
            self.assertEqual(self.go(c, "GET", "/api/library").json["results"], [])
            self.assertGreater(hashing.call_count, 0)
            Path(audio).unlink()
            self.assertEqual(self.go(c, "GET", "/api/library").json["results"], [])



class MixTests(unittest.TestCase):
    def test_grid_alignment_rate_and_fallback(self):
        from music_web.mixing import transition
        a = {"reliable": True, "bpm": 120, "beats": [i * .5 for i in range(120)]}
        b = {"reliable": True, "bpm": 124, "beats": [.23 + i * 60 / 124 for i in range(120)]}
        plan = transition(a, b, 60, 4, True)
        self.assertEqual(plan["mode"], "Beat blend")
        self.assertIn(plan["out"], a["beats"])
        self.assertIn(plan["in"], b["beats"])
        self.assertAlmostEqual(plan["rate"] * b["bpm"], a["bpm"])
        self.assertEqual(transition(a, {**b, "bpm": 160}, 60, 4, True)["rate"], 1)
        self.assertEqual(transition(a, {"reliable": False}, 60, 4, True)["mode"], "Crossfade")

    def test_file_analysis_keeps_full_grid_across_bounded_windows(self):
        from music_web.analysis import analyze_file
        import numpy as np
        import soundfile as sf
        import tempfile
        sr = 22050
        samples = np.zeros(sr * 30, dtype=np.float32)
        click = np.sin(2 * np.pi * 1000 * np.arange(400) / sr) * np.exp(-np.arange(400) / 80)
        for beat in np.arange(.25, 29.5, .5):
            offset = int(sr * beat)
            samples[offset:offset + len(click)] += click
        with tempfile.TemporaryDirectory() as root:
            path = str(Path(root) / "clicks.wav")
            with sf.SoundFile(path, "w", samplerate=sr, channels=1) as out:
                out.write(samples)
                out.write(samples)
            result = analyze_file(path)
        self.assertTrue(result["reliable"], result)
        self.assertAlmostEqual(result["bpm"], 120, delta=3)
        self.assertTrue(any(b > 50 for b in result["beats"]))
        self.assertTrue(all(a < b for a, b in zip(result["beats"], result["beats"][1:])))

    def test_known_tempo_clicks_and_silence(self):
        from music_web.analysis import analyze
        import numpy as np
        sr = 22050
        y = np.zeros(sr * 24)
        click = np.sin(2 * np.pi * 1000 * np.arange(400) / sr) * np.exp(-np.arange(400) / 80)
        for beat in np.arange(.25, 23.5, .5):
            offset = int(sr * beat)
            y[offset:offset + len(click)] += click
        result = analyze(y, sr)
        self.assertAlmostEqual(result["bpm"], 120, delta=3)
        self.assertTrue(result["reliable"], result)
        self.assertFalse(analyze(np.zeros(sr * 4), sr)["reliable"])
        variable = np.zeros(sr * 24)
        for beat in np.concatenate([np.arange(.25, 8, .5), np.arange(8.2, 16, .4), np.arange(16.2, 23.5, .65)]):
            offset = int(sr * beat)
            variable[offset:offset + len(click)] += click
        self.assertFalse(analyze(variable, sr)["reliable"])
