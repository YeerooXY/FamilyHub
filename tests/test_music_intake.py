"""Tests for scripts/music-intake.py. Run from the repository root:

    python -m unittest discover -s tests -v

Boundary tests need only Python. Audio tests run when ffmpeg and ffprobe are on PATH.
The public search test runs only with FAMILYHUB_NETWORK_TESTS=1 and yt-dlp on PATH.
"""
import hashlib, importlib.util, json, os, pathlib, shutil, subprocess, tempfile, unittest
from unittest import mock
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("music_intake", ROOT / "scripts" / "music-intake.py")
mi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mi)

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
META = ["--artist", "Sample Artist", "--album", "Sample Album", "--title", "Tone"]


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def fake_item(ws, data=b"placeholder bytes, never decoded", **changes):
    """A hand-built item for tests that never call ffmpeg."""
    digest = hashlib.sha256(data).hexdigest()
    d = ws / f"local-{digest[:16]}"
    d.mkdir()
    (d / "audio.flac").write_bytes(data)
    m = {"schema": 1, "id": d.name, "edit": None, "import": None,
         "source": {"kind": "local", "original_name": "tone.flac", "lossy": None},
         "audio": {"file": "audio.flac", "sha256": digest, "size": len(data), "codec": "flac", "format": "flac",
                   "sample_rate": 44100, "channels": 1, "duration": 8.0, "bit_rate": None}}
    m["audio"].update(changes)
    (d / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    return d


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = pathlib.Path(tmp.name)
        self.ws, self.lib = self.tmp / "workspace", self.tmp / "library"
        self.ws.mkdir()
        self.lib.mkdir()

    def symlink(self, target, link):
        try:
            os.symlink(target, link, target_is_directory=os.path.isdir(target))
        except (OSError, NotImplementedError):
            self.skipTest("cannot create symlinks here")

    def do_import(self, item, *extra):
        return mi.dispatch(["import", str(item), "--library", str(self.lib), *(extra or META)])


class Inputs(unittest.TestCase):
    def test_video_urls(self):
        vid = "aaaaaaaaaaa"
        for url in (f"https://www.youtube.com/watch?v={vid}", f"https://youtu.be/{vid}",
                    f"https://music.youtube.com/watch?v={vid}&list=PLxyz&t=3"):
            self.assertEqual(mi.video_id(url), vid)
        for url in ("https://www.youtube.com/playlist?list=PLxyz", "https://www.youtube.com/@channel/videos",
                    f"http://www.youtube.com/watch?v={vid}", f"https://example.com/watch?v={vid}",
                    f"https://youtube.com.example.com/watch?v={vid}", f"https://user@youtu.be/{vid}",
                    "https://youtu.be/short", f"https://www.youtube.com/live/{vid}", f"ytsearch:{vid}",
                    f"--exec=x https://youtu.be/{vid}", ""):
            with self.assertRaises(mi.IntakeError, msg=url):
                mi.video_id(url)

    def test_keep_intervals(self):
        self.assertEqual(mi.parse_keep(["1.5:4"], 10.0), [[1.5, 4.0]])
        self.assertEqual(mi.parse_keep(["0:2", "2:3", "5:10"], 10.0), [[0.0, 2.0], [2.0, 3.0], [5.0, 10.0]])
        for specs in (["4:1"], ["2:2"], ["0:11"], ["3:5", "4:6"], ["5:6", "1:2"], ["-1:2"], ["nan:2"], ["1:inf"],
                      ["1e1:20"], ["1"], ["1:2:3"], ["0:10"], [":"]):
            with self.assertRaises(mi.IntakeError, msg=specs):
                mi.parse_keep(specs, 10.0)

    def test_names(self):
        self.assertEqual(mi.safe_name("AC/DC: Live?", "artist"), "AC_DC_ Live_")
        for bad in ("..", ".", "", "   ", ".hidden", "CON", "nul.txt", "x" * 121):
            with self.assertRaises(mi.IntakeError, msg=bad):
                mi.safe_name(bad, "artist")


class Manifests(Base):
    def test_valid_item_loads(self):
        d, m, audio = mi.load_item(str(fake_item(self.ws)))
        self.assertEqual(os.path.basename(audio), "audio.flac")

    def test_malformed_manifests_are_rejected(self):
        item = fake_item(self.ws)
        good = json.loads((item / "manifest.json").read_text(encoding="utf-8"))
        (self.tmp / "outside.flac").write_bytes(b"placeholder bytes, never decoded")

        def broken(**top):
            return json.dumps({**good, **top})
        cases = ["{not json", "[]", broken(schema=2), broken(id="local-0000000000000000"), broken(id="../" + item.name),
                 broken(audio={**good["audio"], "file": "../outside.flac"}),
                 broken(audio={**good["audio"], "file": "audio.exe"}),
                 broken(audio={**good["audio"], "sha256": "0" * 64}),
                 broken(audio={**good["audio"], "duration": float("nan")}),
                 broken(source={"kind": "youtube", "url": "https://evil.example/x", "id": "aaaaaaaaaaa"}),
                 broken(edit={"parent": good["id"], "parent_sha256": "0" * 64, "keep": [[0, 1]]}),
                 broken(**{"import": {"path": "Local Imports/../../x.flac"}})]
        for text in cases:
            (item / "manifest.json").write_text(text, encoding="utf-8")
            with self.assertRaises(mi.IntakeError, msg=text[:80]):
                mi.load_item(str(item))
            with self.assertRaises(mi.IntakeError, msg=text[:80]):
                self.do_import(item)
        self.assertEqual(list(self.lib.iterdir()), [])

    def test_changed_staged_bytes_are_rejected(self):
        item = fake_item(self.ws)
        (item / "audio.flac").write_bytes(b"different")
        with self.assertRaises(mi.IntakeError):
            mi.load_item(str(item))

    def test_symlinked_audio_and_item_are_rejected(self):
        item = fake_item(self.ws)
        real = self.tmp / "elsewhere.flac"
        shutil.move(item / "audio.flac", real)
        self.symlink(real, item / "audio.flac")
        with self.assertRaises(mi.IntakeError):
            mi.load_item(str(item))
        other = fake_item(self.ws, b"second item")
        self.symlink(other, self.tmp / "item-link")
        with self.assertRaises(mi.IntakeError):
            mi.load_item(str(self.tmp / "item-link"))

    def test_trim_rejects_invalid_range_before_running_ffmpeg(self):
        item = fake_item(self.ws)
        for keep in ("5:3", "0:99", "0:8"):
            with self.assertRaises(mi.IntakeError):
                mi.dispatch(["trim", str(item), "--keep", keep])
        self.assertEqual([p.name for p in self.ws.iterdir()], [item.name])


class Staging(Base):
    def test_stage_rejects_unsafe_sources_before_running_ffmpeg(self):
        target = self.tmp / "real.flac"
        target.write_bytes(b"x")
        (self.tmp / "dir.flac").mkdir()
        (self.tmp / "notes.txt").write_text("x")
        for src in (self.tmp / "dir.flac", self.tmp / "notes.txt", self.tmp / "missing.flac"):
            self.assertEqual(mi.main(["stage", str(src), "--workspace", str(self.ws)]), 1, src)
        self.assertEqual(mi.main(["stage", str(target), "--workspace", str(self.tmp / "no-workspace")]), 1)
        self.assertEqual(list(self.ws.iterdir()), [])
        self.symlink(target, self.tmp / "link.flac")
        with self.assertRaises(mi.IntakeError):
            mi.dispatch(["stage", str(self.tmp / "link.flac"), "--workspace", str(self.ws)])
        self.assertEqual(list(self.ws.iterdir()), [])


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], check=True, timeout=120)


def decoded_md5(path):
    out = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "md5", "-"],
                         check=True, timeout=120, capture_output=True).stdout
    return out.strip()


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are not on PATH")
class ImportingAudio(Base):
    def staged_tone(self, freq=300, name="tone.flac", *codec):
        src = self.tmp / f"{freq}-{name}"
        ffmpeg("-f", "lavfi", "-i", f"aevalsrc=0.1*sin(2*PI*{freq}*t):s=44100:d=3", *(codec or ("-c:a", "flac")), str(src))
        return pathlib.Path(mi.dispatch(["stage", str(src), "--workspace", str(self.ws)])["item"])

    def test_import_tags_without_touching_audio_and_repeats_safely(self):
        item = self.staged_tone()
        staged_bytes = (item / "audio.flac").read_bytes()
        first = self.do_import(item, *META, "--track", "3")
        dest = self.lib / "Local Imports" / "Sample Artist" / "Sample Album" / "03 - Tone.flac"
        self.assertEqual(pathlib.Path(first["imported"]), dest)
        self.assertFalse(first["existing"])
        tags = mi.probe(str(dest), tags=True)["tags"]
        self.assertEqual({k: tags.get(k) for k in ("artist", "album", "title", "track")},
                         {"artist": "Sample Artist", "album": "Sample Album", "title": "Tone", "track": "3"})
        self.assertEqual(decoded_md5(dest), decoded_md5(item / "audio.flac"))  # same decoded audio
        self.assertEqual(mi.packet_hash(str(dest)), mi.packet_hash(str(item / "audio.flac")))  # stream copied
        self.assertEqual((item / "audio.flac").read_bytes(), staged_bytes)
        record = first["manifest"]["import"]
        self.assertEqual(record["path"], "Local Imports/Sample Artist/Sample Album/03 - Tone.flac")
        self.assertEqual((record["sha256"], record["library_sha256"]), (sha(item / "audio.flac"), sha(dest)))
        self.assertNotEqual(record["sha256"], record["library_sha256"])
        manifest, library_bytes = (item / "manifest.json").read_bytes(), dest.read_bytes()
        again = self.do_import(item, *META, "--track", "3")
        self.assertTrue(again["existing"])
        self.assertEqual((item / "manifest.json").read_bytes(), manifest)
        self.assertEqual(dest.read_bytes(), library_bytes)
        self.assertEqual([p.name for p in dest.parent.iterdir()], [dest.name])  # no leftover temp
        with self.assertRaises(mi.IntakeError):  # one staged item, one library name
            self.do_import(item, "--artist", "Other", "--album", "Other", "--title", "Other")
        self.assertFalse((self.lib / "Local Imports" / "Other").exists())

    def test_cancellation_after_tag_validation_prevents_atomic_publication(self):
        import threading
        item = self.staged_tone()
        cancel = threading.Event()
        original = mi.tag_copy
        def checked(*args):
            original(*args)
            cancel.set()
        mi.CONTROL.cancel = cancel
        try:
            with mock.patch.object(mi, "tag_copy", side_effect=checked):
                with self.assertRaises(mi.IntakeError):
                    self.do_import(item)
        finally:
            mi.CONTROL.cancel = None
        self.assertEqual(list(self.lib.rglob("*.flac")), [])
        self.assertIsNone(mi.load_item(str(item))[1]["import"])

    def test_complete_first_preview_contains_decodable_audio_and_preserves_original(self):
        item = self.staged_tone(300, "tone.webm", "-c:a", "libopus", "-f", "webm")
        original = sha(item / "audio.webm")
        output = self.ws / ".preview-test"
        result = mi.cmd_preview(type("Args", (), {"item": str(item), "output": str(output)})())
        self.assertIn("index.m3u8", result["assets"])
        self.assertIn("init.mp4", result["assets"])
        self.assertTrue(any(name.startswith("seg") and name.endswith(".m4s") for name in result["assets"]))
        playlist = (output / "index.m3u8").read_text(encoding="utf-8")
        self.assertIn("#EXT-X-ENDLIST", playlist)
        for name in result["assets"]:
            self.assertNotIn("/", name)
            self.assertTrue((output / name).is_file())
        segment = next(output / name for name in result["assets"] if name.startswith("seg"))
        joined = self.tmp / "first.mp4"
        joined.write_bytes((output / "init.mp4").read_bytes() + segment.read_bytes())
        decoded = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(joined), "-f", "null", "-"],
                                 timeout=30, capture_output=True)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode("utf-8", "replace"))
        self.assertEqual(sha(item / "audio.webm"), original)

    def test_collision_with_different_bytes_refuses(self):
        first, second = self.staged_tone(300), self.staged_tone(500)
        dest = pathlib.Path(self.do_import(first)["imported"])
        before = dest.read_bytes()
        with self.assertRaises(mi.IntakeError):
            self.do_import(second)
        self.assertEqual(dest.read_bytes(), before)
        self.assertEqual([p.name for p in dest.parent.iterdir()], [dest.name])
        self.assertIsNone(json.loads((second / "manifest.json").read_text(encoding="utf-8"))["import"])

    def test_edited_library_file_is_not_treated_as_a_repeat(self):
        item = self.staged_tone()
        dest = pathlib.Path(self.do_import(item)["imported"])
        dest.write_bytes(dest.read_bytes() + b"x")
        with self.assertRaises(mi.IntakeError):
            self.do_import(item)

    def test_container_that_cannot_hold_tags_is_rejected_not_transcoded(self):
        item = self.staged_tone(300, "tone.aac", "-c:a", "aac", "-f", "adts")
        with self.assertRaises(mi.IntakeError):
            self.do_import(item)
        self.assertEqual([p for p in self.lib.rglob("*") if p.is_file()], [])
        self.assertEqual(list(self.lib.rglob(".import-*")), [])

    def test_metadata_cannot_escape_the_import_directory(self):
        item = self.staged_tone()
        for artist in ("..", ".", "../../outside", "a/../b", "x\\..\\y"):
            try:
                out = self.do_import(item, "--artist", artist, "--album", "A", "--title", "T")
            except mi.IntakeError:
                continue
            self.assertTrue(mi.inside(out["imported"], self.lib / "Local Imports"), artist)
            os.remove(out["imported"])
        self.assertEqual([p.name for p in self.tmp.iterdir() if p.suffix == "" and p.name not in ("workspace", "library")], [])
        self.assertEqual([p.name for p in self.lib.iterdir()], ["Local Imports"])


class Importing(Base):
    def test_item_inside_library_is_refused(self):
        item = fake_item(self.lib)
        with self.assertRaises(mi.IntakeError):
            self.do_import(item)

    def test_symlinked_library_directories_are_refused(self):
        item = fake_item(self.ws)
        outside = self.tmp / "outside"
        outside.mkdir()
        self.symlink(outside, self.lib / "Local Imports")
        with self.assertRaises(mi.IntakeError):
            self.do_import(item)
        self.assertEqual(list(outside.iterdir()), [])
        self.symlink(self.lib, self.tmp / "library-link")
        with self.assertRaises(mi.IntakeError):
            mi.dispatch(["import", str(item), "--library", str(self.tmp / "library-link"), *META])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are not on PATH")
class RealAudio(Base):
    def ffmpeg(self, *args):
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], check=True, timeout=120)

    def test_stage_trim_import(self):
        src = self.tmp / "tone.flac"  # same synthetic tone convention as scripts/generate-samples.sh
        self.ffmpeg("-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*300*t):s=44100:d=6", "-c:a", "flac", str(src))
        original = sha(src)

        staged = mi.dispatch(["stage", str(src), "--workspace", str(self.ws)])
        item = pathlib.Path(staged["item"])
        audio = staged["manifest"]["audio"]
        self.assertEqual(sha(src), original)
        self.assertEqual((audio["sha256"], sha(item / audio["file"])), (original, original))
        self.assertEqual((audio["codec"], audio["sample_rate"], audio["channels"]), ("flac", 44100, 1))
        self.assertAlmostEqual(audio["duration"], 6.0, delta=0.05)
        self.assertIsNone(staged["manifest"]["source"]["lossy"])
        self.assertTrue(mi.dispatch(["stage", str(src), "--workspace", str(self.ws)])["existing"])

        trimmed = mi.dispatch(["trim", str(item), "--keep", "1:2", "--keep", "3:5"])
        edit = pathlib.Path(trimmed["item"])
        m = trimmed["manifest"]
        self.assertNotEqual(edit, item)
        self.assertAlmostEqual(m["audio"]["duration"], 3.0, delta=0.05)
        self.assertEqual(m["edit"], {"parent": item.name, "parent_sha256": original, "keep": [[1.0, 2.0], [3.0, 5.0]]})
        self.assertEqual(m["source"], staged["manifest"]["source"])
        self.assertEqual(sha(item / audio["file"]), original)
        self.assertTrue(mi.dispatch(["trim", str(item), "--keep", "1:2", "--keep", "3:5"])["existing"])
        self.assertNotEqual(mi.dispatch(["trim", str(item), "--keep", "1:2"])["item"], str(edit))
        self.assertEqual(sorted(p.name for p in self.ws.iterdir() if p.name.startswith(".")), [])

        done = self.do_import(edit)
        self.assertEqual(sha(done["imported"]), done["manifest"]["import"]["library_sha256"])
        self.assertEqual(mi.packet_hash(done["imported"]), mi.packet_hash(str(edit / "audio.flac")))
        self.assertEqual(sha(edit / "audio.flac"), m["audio"]["sha256"])
        self.assertEqual(sha(src), original)

    def test_corrupt_and_video_only_files_are_rejected(self):
        junk = self.tmp / "junk.flac"
        junk.write_bytes(os.urandom(4096))
        video = self.tmp / "video.mka"
        self.ffmpeg("-f", "lavfi", "-i", "testsrc=d=1:s=64x64:r=5", "-c:v", "ffv1", "-f", "matroska", str(video))
        for src in (junk, video):
            with self.assertRaises(mi.IntakeError, msg=src.name):
                mi.dispatch(["stage", str(src), "--workspace", str(self.ws)])
        self.assertEqual(list(self.ws.iterdir()), [])


def entry(n, title="Song", channel="Someone", **extra):
    return {"id": f"{n:011d}", "title": title, "channel": channel, "duration": 200, **extra}


class SearchRanking(unittest.TestCase):
    def setUp(self):
        mi.SEARCH_CACHE.clear()
        self.gate = mock.patch.object(mi, "YOUTUBE", mi.YouTubeGate())
        self.gate.start()
        self.addCleanup(self.gate.stop)
        mi.YOUTUBE.spacing = 0

    def test_album_lookup_does_not_promote_other_songs_or_tribute_artists(self):
        general = [entry(1, "Artist Thriller (Official Audio)")]
        albums = [entry(2, "Another Song", "Artist - Topic"), entry(3, "Thriller", "Artist",
                   description="Provided to YouTube by Label"), entry(4, "Thriller", "Tribute Band - Topic")]
        replies = [(0, json.dumps({"entries": rows}).encode(), "") for rows in (general, albums)]
        with mock.patch.object(mi, "tool", return_value="yt-dlp"), mock.patch.object(mi, "run", side_effect=replies) as run:
            found = mi.dispatch(["search", "Artist Thriller", "--limit", "10"])["results"]
        self.assertEqual([row["id"] for row in found[:2]], [f"{i:011d}" for i in (3, 1)])
        self.assertEqual(run.call_count, 2)
        self.assertIn('"Provided to YouTube"', run.call_args.args[0][-1])

    def test_artist_typo_prioritizes_artist_over_songs_named_after_them(self):
        entries = [entry(1, "50 CENT", "Dean Blunt - Topic"), entry(2, "In Da Club", "50 Cent - Topic"), entry(3, "Many Men", "50 Cent - Topic")]
        with mock.patch.object(mi, "tool", return_value="yt-dlp"), mock.patch.object(mi, "run", return_value=(0, json.dumps({"entries": entries}).encode(), "")):
            results = mi.dispatch(["search", "50 centy", "--limit", "10"])["results"]
        self.assertEqual(results[0]["id"], entries[1]["id"])

    def test_provider_pagination_requests_next_batch(self):
        with mock.patch.object(mi, "tool", return_value="yt-dlp"), mock.patch.object(mi, "run", return_value=(0, b'{"entries":[]}', "")) as run:
            mi.cmd_search(SimpleNamespace(query="artist", limit=30, offset=30))
        command = run.call_args.args[0]
        self.assertIn("ytsearch60:artist", command)
        self.assertNotIn("--playlist-start", command)
        self.assertEqual(run.call_count, 1)

    def test_album_on_primary_artist_channel_keeps_duet_eligible(self):
        album = entry(1, "Scared to Be Lonely", "Martin Garrix", description="Provided to YouTube by Label")
        rank = mi.listening_rank(album, "Martin Garrix Dua Lipa Scared To Be Lonely", ("martin", "garrix", "dua", "lipa"))
        self.assertFalse(rank[1], "A duet does not require both names in the channel name")

    def test_listening_editions_before_story_video_and_unrequested_versions(self):
        entries = [entry(1, "Thriller (Official Video)"),
                   entry(2, "Thriller (Short Film)"),
                   entry(3, "Thriller (Official Audio)"),
                   entry(4, "Thriller", "Michael Jackson - Topic"),
                   entry(5, "Thriller (Lyrics)"),
                   entry(6, "Thriller (Live at Wembley)", "Michael Jackson - Topic"),
                   entry(7, "Thriller (Album Version)"),
                   entry(8, "Thriller (Piano Cover)"),
                   entry(9, "Thriller reaction")]
        ordered = sorted(entries, key=lambda e: mi.listening_rank(e, "Michael Jackson Thriller"))
        self.assertEqual([e["id"] for e in ordered[:4]], [f"{n:011d}" for n in (4, 3, 7, 5)])
        self.assertEqual(mi.kind(entries[0]), "video")
        self.assertEqual(mi.kind(entries[1]), "video")

    def test_explicit_versions_keep_their_query_and_avoid_variant_penalty(self):
        for query in ("Artist Song live", "Artist Song remix", "Artist Song official video", "Artist full album"):
            self.assertEqual(mi.listening_query(query), query)
        self.assertEqual(mi.listening_query("Artist Song"), "Artist Song official audio")
        self.assertEqual(mi.listening_query("Artist Song official audio"), "Artist Song official audio")
        remix = entry(1, "Song (Remix)")
        self.assertLess(mi.listening_rank(remix, "Song remix"), mi.listening_rank(remix, "Song"))

    def test_song_titles_are_not_mistaken_for_story_or_live_footage(self):
        for title in ("Love Story", "Live Forever", "Cover Me", "The Story of Us"):
            self.assertEqual(mi.listening_rank(entry(1, title), title)[:3], (False, False, False))

    def search(self, entries, *argv, rc=0, raw=None):
        out = raw if raw is not None else json.dumps({"entries": entries}).encode()
        with mock.patch.object(mi, "tool", return_value="yt-dlp"), \
                mock.patch.object(mi, "run", return_value=(rc, out, "boom")) as run:
            result = mi.dispatch(["search", "fictional song", *argv])
        return result["results"], run.call_args_list[0].args[0]

    def test_ranks_before_limit_in_bounded_search_pool(self):
        entries = [entry(i) for i in range(1, 11)] + [
            entry(11, "Song (Official Music Video)"), entry(12, "Song (Official Audio)"),
            entry(13, "Song", "Fictional Artist - Topic")]
        results, args = self.search(entries, "--limit", "3")
        self.assertEqual([r["id"] for r in results], [f"{n:011d}" for n in (13, 12, 1)])
        self.assertEqual([r["kind"] for r in results], ["topic", "audio", "other"])
        self.assertEqual(args.count("ytsearch30:fictional song"), 1)
        self.assertEqual(results[0]["url"], mi.WATCH + results[0]["id"])

    def test_invalid_and_duplicate_ids_dropped_before_limit(self):
        entries = [{"id": "short"}, "junk", None, {"id": None}, entry(1), entry(1, "Copy"), entry(2)]
        results, _ = self.search(entries, "--limit", "2")
        self.assertEqual([r["id"] for r in results], [f"{1:011d}", f"{2:011d}"])
        self.assertEqual(results[0]["title"], "Song")

    def test_songs_precede_long_uploads_and_collections(self):
        entries = [entry(1, "Michael Jackson (Official Audio)", duration=4500),
                   entry(2, "Michael Jackson Full Album", "Michael Jackson - Topic", duration=None),
                   entry(3, "Michael Jackson Greatest Hits"),
                   entry(4, "Billie Jean (Official Music Video)"),
                   entry(5, "Beat It (Official Audio)"),
                   entry(6, "Thriller", "Michael Jackson - Topic"),
                   entry(7, "Billie Jean", "Michael Jackson - Topic")]
        results, _ = self.search(entries, "--limit", "30")
        self.assertEqual([r["id"] for r in results], [f"{n:011d}" for n in (6, 7, 5, 4, 2, 1, 3)])
        self.assertEqual(results[4]["kind"], "topic")

    def test_complete_pool_available_for_pagination(self):
        results, args = self.search([entry(i) for i in range(30)], "--limit", "30")
        self.assertEqual(len(results), 30)
        self.assertEqual([r["id"] for r in results], [f"{i:011d}" for i in range(30)])
        self.assertEqual(args.count("ytsearch30:fictional song"), 1)

    def test_stable_ties_and_missing_metadata(self):
        entries = [{"id": f"{n:011d}"} for n in (5, 4, 3)] + [entry(6, None, None)]
        results, _ = self.search(entries)
        self.assertEqual([r["id"] for r in results], [f"{n:011d}" for n in (5, 4, 3, 6)])
        self.assertEqual({r["kind"] for r in results}, {"other"})

    def test_topic_variants_and_false_promotion(self):
        entries = [entry(1, "Official Music Video"), entry(2, "Topic of the day", "Topic Records"),
                   entry(3, "Official Lyrics"), entry(4, "x", "A–Topic"), entry(5, "x", None, uploader="b  -  TOPIC"),
                   entry(6, "Song [Audio]")]
        results, _ = self.search(entries, "--limit", "10")
        self.assertEqual([(r["id"][-1], r["kind"]) for r in results],
                         [("4", "topic"), ("5", "topic"), ("6", "audio"), ("3", "audio"), ("2", "other"),
                          ("1", "video")])

    def test_errors(self):
        for kw in ({"rc": 1}, {"raw": b"not json"}, {"raw": b"[]"}):
            with self.assertRaises(mi.IntakeError, msg=kw):
                self.search([], **kw)
        with mock.patch.object(mi, "tool", return_value="yt-dlp"), \
                mock.patch.object(mi.subprocess, "run", side_effect=mi.subprocess.TimeoutExpired("yt-dlp", 1)):
            with self.assertRaises(mi.IntakeError):
                mi.dispatch(["search", "x"])
        for limit in (0, 31):
            with self.assertRaises(mi.IntakeError):
                self.search([], "--limit", str(limit))


class PreparedMetadata(Base):
    def test_metadata_file_removed_before_audio_validation(self):
        from types import SimpleNamespace
        import threading
        paths = []
        def pump(command, *args, progress, total_bytes):
            self.assertTrue(callable(progress))
            self.assertIsNone(total_bytes)
            progress(download_bytes=100, download_total_bytes=None)
            paths.append(pathlib.Path(command[command.index("--load-info-json") + 1]))
            self.assertTrue(paths[0].is_file())
            return {"sha256": "a" * 64, "bytes": 100, "preview_complete": True}
        def probe(_spool):
            self.assertFalse(paths[0].exists())
            raise mi.IntakeError("invalid audio")
        args = SimpleNamespace(workspace=str(self.ws), preview=str(self.tmp / "hls"),
                               cancel=threading.Event(), notify=lambda: None, budget=lambda: None)
        with mock.patch.object(mi, "tool", return_value="yt-dlp"), \
                mock.patch.object(mi, "pump_preview", side_effect=pump), \
                mock.patch.object(mi, "probe", side_effect=probe):
            with self.assertRaisesRegex(mi.IntakeError, "invalid audio"):
                mi.progressive_fetch(args, {"format_id": "251", "duration": 200}, {})
        self.assertEqual(len(paths), 1)
        self.assertEqual(list(self.ws.iterdir()), [])

    def test_fetch_reuses_private_metadata_and_cleans_it_after_source_failure(self):
        from types import SimpleNamespace
        import threading
        vid = "dQw4w9WgXcQ"
        url = mi.WATCH + vid
        metadata = {"id": vid, "duration": 200, "format_id": "251", "acodec": "opus",
                    "url": "https://media.example/audio?token=private", "title": "Song",
                    "protocol": "https", "filesize": 12345}
        paths = []
        def pump(command, *args, progress, total_bytes):
            self.assertTrue(callable(progress))
            self.assertEqual(total_bytes, 12345)
            self.assertNotIn(url, command)
            self.assertNotIn(metadata["url"], command)
            self.assertEqual(command[command.index("-f") + 1], "251")
            path = pathlib.Path(command[command.index("--load-info-json") + 1])
            paths.append(path)
            self.assertEqual(path.parent.parent, self.ws)
            self.assertEqual(json.loads(path.read_bytes()), metadata)
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            raise mi.IntakeError("source failed")
        args = SimpleNamespace(url=url, workspace=str(self.ws), preview=str(self.tmp / "hls"),
                               cancel=threading.Event(), notify=lambda: None, budget=lambda: None)
        with mock.patch.object(mi, "tool", side_effect=lambda name: name), \
                mock.patch.object(mi, "run", return_value=(0, json.dumps(metadata).encode(), "")) as run, \
                mock.patch.object(mi, "pump_preview", side_effect=pump):
            with self.assertRaisesRegex(mi.IntakeError, "source failed"):
                mi.cmd_fetch(args)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(len(paths), 1)
        self.assertFalse(paths[0].exists())
        self.assertEqual(list(self.ws.iterdir()), [])


@unittest.skipUnless(os.environ.get("FAMILYHUB_NETWORK_TESTS") == "1" and shutil.which("yt-dlp"),
                     "set FAMILYHUB_NETWORK_TESTS=1 with yt-dlp on PATH to query public YouTube search")
class Network(unittest.TestCase):
    def test_search_returns_bounded_metadata_only(self):
        out = mi.dispatch(["search", "sine wave test tone", "--limit", "3"])
        self.assertLessEqual(len(out["results"]), 3)
        for r in out["results"]:
            self.assertEqual(r["url"], mi.WATCH + r["id"])


if __name__ == "__main__":
    unittest.main()
