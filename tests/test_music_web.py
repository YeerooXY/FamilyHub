"""Offline tests for the mobile music app (music_web). Navidrome and the intake operations are faked.

Needs requirements-mobile.txt; the whole module is skipped when Flask is not installed.
Run from the repository root: python -m unittest tests.test_music_web
"""
import io, json, os, pathlib, re, sys, tempfile, threading, time, unittest
import wave
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    import music_web
    from werkzeug.security import generate_password_hash
except ImportError as e:
    raise unittest.SkipTest(f"music_web dependencies missing: {e}")

ORIGIN = "https://music.test"
PASSWORD = "correct-horse"
URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
META = {"artist": "Artist", "album": "Album", "title": "Title"}
PROFILE_HASH = generate_password_hash(PASSWORD, method="pbkdf2:sha256:1000")


class Base(unittest.TestCase):
    extra = {}
    check_presence = False

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws, self.lib = os.path.join(tmp.name, "ws"), os.path.join(tmp.name, "lib")
        os.mkdir(self.ws), os.mkdir(self.lib)
        self.settings = {
            "SECRET_KEY": "k" * 40, "CLI_PATH": str(ROOT / "scripts" / "music-intake.py"), "WORKSPACE": self.ws,
            "LIBRARY": self.lib, "PUBLIC_ORIGIN": ORIGIN, "PLAYER_URL": "https://player.test/",
            "ALLOWED_USERS": ["sample-a", "sample-b"],
            # Legacy file fixtures isolate transport/coordinator behavior from FFmpeg.
            "REQUIRE_FINISHED_AUDIO": False, **self.extra}
        protected = set(self.settings.get('ADMIN_USERS', ())) | set(self.settings.get('JELLYFIN_PROFILES', {}))
        self.settings.setdefault('PROFILE_PASSWORD_HASHES', dict.fromkeys(protected, PROFILE_HASH))
        self.app = music_web.create_app(self.settings)
        self.state = self.app.extensions["music"]
        self.intake = self.app.intake
        if not self.check_presence:
            # These route fixtures test their own work without waiting for lease handback.
            self.presence_stub = mock.patch.object(self.state.resources, "presence")
            self.presence_stub.start()
            mock.patch.object(self.state.resources, "end_search").start()
        # Coordinator fixtures use fake audio; measurement has separate FFmpeg integration tests.
        mock.patch("music_web.profile", return_value={}).start()
        mock.patch("music_web.prepare_record", return_value=None).start()
        self.ping = mock.patch("music_web.ping", side_effect=lambda base, u, p: p == PASSWORD)
        self.ping = self.ping.start()
        self.addCleanup(mock.patch.stopall)
        self.addCleanup(self.stop_worker)

    def stop_worker(self):
        for job in self.state.jobs.values():
            if job.get("cancel"):
                job["cancel"].set()
        self.state.resources.changed()
        worker = getattr(self.state, "worker", None)
        if worker:
            worker.join(5)
            self.assertFalse(worker.is_alive(), "test worker did not reap its processes")

    # ---- helpers ----
    def go(self, c, method, path, origin=True, **kw):
        kw.setdefault("base_url", ORIGIN)
        if origin and method != "GET":
            kw.setdefault("headers", {}).setdefault("Origin", ORIGIN)
        return getattr(c, method.lower())(path, **kw)

    def token(self, c, path):
        html = self.go(c, "GET", path).get_data(as_text=True)
        return re.search(r'(?:csrf_token" value|csrf-token" content)="([^"]+)"', html).group(1)

    def login(self, user="sample-a", pw=PASSWORD):
        c = self.app.test_client()
        r = self.go(c, "POST", "/login", data={"username": user, "password": pw, "csrf_token": self.token(c, "/login")})
        return c, r

    def signed_in(self, user="sample-a"):
        c, r = self.login(user)
        self.assertEqual(r.status_code, 302)
        return c, self.token(c, "/")

    def post(self, c, tok, path, **kw):
        kw.setdefault("headers", {})["X-CSRFToken"] = tok
        return self.go(c, "POST", path, **kw)

    def profile_credentials(self, name):
        return {"profile_id": name, "password": PASSWORD}

    def wait(self, c, job_id):
        for _ in range(250):
            job = self.go(c, "GET", f"/api/jobs/{job_id}").get_json()["job"]
            if job["state"] not in ("queued", "running"):
                return job
            time.sleep(0.02)
        self.fail("job did not finish")

    def fake_ok(self):
        self.calls = {}

        def fetch(args):
            self.calls["fetch"] = args
            return {"item": os.path.join(self.ws, "yt-item")}

        def imp(args):
            self.calls["import"] = args
            return {"item": args.item, "imported": os.path.join(self.lib, "secret", "path.flac")}
        mock.patch.object(self.intake, "cmd_fetch", fetch).start()
        mock.patch.object(self.intake, "cmd_import", imp).start()


class ActivityPresenceTests(Base):
    check_presence = True

    def setUp(self):
        with mock.patch.dict(os.environ, FAMILYHUB_INACTIVE_MINUTES="1"):
            super().setUp()
        self.governor = self.state.resources
        self.clock = mock.Mock(return_value=self.governor.clock())
        self.governor.clock = self.clock
        mock.patch.object(self.governor, "wake").start()
        self.client, self.csrf = self.signed_in()
        self.background = {"X-FamilyHub-Activity": "background"}

    def advance(self, seconds):
        self.clock.return_value += seconds

    def heartbeat(self, playing, headers):
        response = self.post(self.client, self.csrf, "/api/playback/activity",
                             json={"device_id": "a" * 32, "playing": playing}, headers=dict(headers))
        self.assertEqual(response.status_code, 200)

    def test_background_refresh_and_paused_heartbeats_do_not_extend_activity(self):
        for _ in range(5):
            self.advance(12)
            response = self.go(self.client, "GET", "/api/library", headers=self.background)
            self.assertEqual(response.status_code, 200)
            self.heartbeat(False, self.background)
        self.assertEqual(self.governor.inactive_count(), 1)
        self.assertEqual(self.governor.reservations(), ("offline", 0, 0))
        self.assertEqual(self.governor.background_slots(6), 6)
        self.assertEqual(self.go(self.client, "GET", "/api/library").status_code, 200)
        self.assertEqual(self.governor.inactive_count(), 0)
        self.assertEqual(self.governor.reservations(), ("browsing", 2, 1))

    def test_background_playing_heartbeat_reserves_listening_capacity(self):
        self.advance(60)
        self.assertEqual(self.governor.inactive_count(), 1)
        self.heartbeat(True, self.background)
        self.assertEqual(self.governor.inactive_count(), 0)
        self.assertEqual(self.governor.reservations(), ("listening", 2, 2))
        self.heartbeat(False, self.background)
        self.advance(15)
        self.assertEqual(self.governor.reservations(), ("offline", 0, 0))

    def test_legacy_paused_heartbeat_retains_online_idle(self):
        for _ in range(5):
            self.advance(12)
            self.heartbeat(False, {})
            self.assertEqual(self.governor.reservations(), ("online-idle", 1, 1))
        self.assertEqual(self.governor.inactive_count(), 0)

    def test_background_playback_preparation_does_not_create_a_listening_lease(self):
        self.advance(60)
        response = self.go(self.client, "GET", "/api/library/abcdefghijk/playback-info?quality=max",
                           headers=self.background)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.governor.inactive_count(), 1)
        self.assertEqual(self.governor.reservations(), ("offline", 0, 0))

    def test_room_updates_keep_state_and_only_playing_heartbeats_renew_presence(self):
        self.app.extensions["listening_rooms"].clock = self.clock
        state = dict(queue=[dict(id="abcdefghijk", title="Song", channel="Artist")],
                     index=0, position=0, playing=True, auto_dj=False, crossfading=False)
        created = self.post(self.client, self.csrf, "/api/listening/rooms", json=state)
        self.assertEqual(created.status_code, 201)
        path = "/api/listening/rooms/" + created.json["room"]["id"]
        for _ in range(3):
            self.advance(11)
            response = self.go(self.client, "PUT", path, json=state,
                               headers={**self.background, "X-CSRFToken": self.csrf})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.governor.reservations(), ("offline", 0, 0))
        self.heartbeat(True, self.background)
        self.assertEqual(self.governor.reservations(), ("listen-together", 2, 2))


class ForegroundAdmissionTests(Base):
    check_presence = True
    extra = {"BACKGROUND_WORKERS": 8}

    def setUp(self):
        super().setUp()
        self.clock = mock.Mock(return_value=time.monotonic())
        self.state.resources.clock = self.clock
        self.app.extensions["listening_rooms"].clock = self.clock

    def advance(self, seconds):
        governor = self.state.resources
        with governor.condition:
            self.clock.return_value += seconds
            governor._changed()

    def test_opening_app_keeps_base_background_and_current_song_gets_a_slot(self):
        self.fake_ok()
        client, token = self.signed_in()
        started, urgent, last = threading.Semaphore(0), threading.Event(), threading.Event()
        release = threading.Event()
        sources = ["https://youtu.be/" + f"{index:011d}" for index in range(13)]

        def fetch(args):
            if args.url.endswith("dQw4w9WgXcQ"):
                urgent.set()
            else:
                if args.url.endswith("00000000012"):
                    last.set()
                started.release()
                release.wait(3)
                self.assertFalse(args.cancel.is_set())
                self.intake.CONTROL.budget()
            return {"item": os.path.join(self.ws, "yt-item")}

        with mock.patch.object(self.intake, "cmd_fetch", side_effect=fetch), \
                mock.patch.object(self.intake, "cmd_preview", side_effect=self.intake.IntakeError("fixture")):
            queued = self.post(client, token, "/api/library/additions", json={"urls": sources})
            self.assertEqual(queued.status_code, 202)
            # Library additions keep their usual background slots while their owner is online.
            self.assertTrue(started.acquire(timeout=1))
            self.advance(30)
            try:
                self.assertTrue(all(started.acquire(timeout=1) for _ in range(11)))
                self.assertFalse(last.is_set())
                listener, listener_token = self.signed_in("sample-b")
                self.assertEqual(self.state.resources.reservations(), ("online-idle", 1, 1))
                deadline = time.monotonic() + .25
                current = self.post(listener, listener_token, "/api/jobs", json={"url": URL, **META})
                self.assertTrue(urgent.wait(max(0, deadline - time.monotonic())))
                self.assertEqual(self.state.resources.reservations(), ("listening", 2, 2))
                self.assertEqual(self.wait(listener, current.json["job"]["id"])["state"], "done")
            finally:
                release.set()
            self.assertEqual(self.wait(client, queued.json["jobs"][0]["id"])["state"], "done")
            self.advance(16)
            self.assertTrue(last.wait(1))
            self.assertEqual(self.wait(client, queued.json["jobs"][-1]["id"])["state"], "done")

    def test_authenticated_requests_heartbeats_and_room_exit(self):
        client, token = self.signed_in()
        governor = self.state.resources
        self.assertEqual(governor.reservations(), ("online-idle", 1, 1))
        self.go(client, "GET", "/api/library")
        self.assertEqual(governor.reservations(), ("browsing", 2, 1))
        def search(_):
            self.assertEqual(governor.reservations(), ("searching", 2, 1))
            return {"results": []}
        with mock.patch.object(self.intake, "cmd_search", side_effect=search):
            self.assertEqual(self.post(client, token, "/api/search", json={"query": "Example"}).status_code, 200)
        self.advance(3)
        self.assertEqual(governor.reservations(), ("browsing", 2, 1))
        device = "a" * 32
        activity = {"device_id": device, "playing": True, "device_info": {"sequence": 1}}
        self.assertEqual(self.post(client, token, "/api/playback/activity", json=activity).status_code, 200)
        self.assertEqual(governor.reservations(), ("listening", 2, 2))
        track = {"id": "dQw4w9WgXcQ", "channel": "Artist", "title": "Track"}
        playback = {"queue": [track], "index": 0, "position": 0, "playing": True,
                    "auto_dj": False, "crossfading": False}
        created = self.post(client, token, "/api/listening/rooms", json=playback)
        self.assertEqual(created.status_code, 201)
        room = "/api/listening/rooms/" + created.json["room"]["id"]
        self.assertEqual(governor.reservations(), ("listen-together", 2, 2))
        self.assertEqual(self.go(client, "DELETE", room, headers={"X-CSRFToken": token, "Origin": ORIGIN}).status_code, 200)
        self.assertEqual(governor.reservations(), ("listening", 2, 2))
        self.post(client, token, "/api/playback/activity", json={**activity, "playing": False,
                                                               "device_info": {"sequence": 2}})
        self.advance(5)
        self.assertEqual(governor.reservations()[0], "browsing")
        self.advance(10)
        self.assertEqual(governor.reservations(), ("offline", 0, 0))


class AuthTests(Base):
    def test_artwork_requires_login_valid_id_and_jpeg(self):
        path = "/api/artwork/dQw4w9WgXcQ"
        self.assertEqual(self.go(self.app.test_client(), "GET", path).status_code, 401)
        c, _ = self.signed_in()
        with mock.patch("music_web.urllib.request.build_opener") as opener:
            fetch = opener.return_value.open
            self.assertEqual(self.go(c, "GET", "/api/artwork/invalid").status_code, 404)
            fetch.assert_not_called()
            response = fetch.return_value.__enter__.return_value
            response.geturl.return_value = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
            response.headers.get_content_type.return_value = "image/jpeg"
            response.read.return_value = b"\xff\xd8\xffsample"
            first = self.go(c, "GET", path)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.mimetype, "image/jpeg")
            self.assertEqual(self.go(c, "GET", path).data, first.data)
            self.assertEqual(fetch.call_count, 1)
            response.read.return_value = b"<html>not an image</html>"
            response.geturl.return_value = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
            self.assertEqual(self.go(c, "GET", "/api/artwork/abcdefghijk").status_code, 404)

    def test_remember_is_opt_in_and_server_expiry_matches(self):
        c, r = self.login()
        self.assertNotIn("Expires=", r.headers["Set-Cookie"])
        regular = next(iter(self.state.sessions.values()))
        self.assertAlmostEqual(regular["expiry"] - time.time(), 12 * 3600, delta=5)
        r = self.go(c, "POST", "/login", data={"username": "sample-a", "password": PASSWORD,
            "remember": "1", "csrf_token": self.token(c, "/")})
        self.assertEqual(r.status_code, 302)
        self.assertIn("Expires=", r.headers["Set-Cookie"])
        remembered = next(iter(self.state.sessions.values()))
        self.assertAlmostEqual(remembered["expiry"] - time.time(), 30 * 24 * 3600, delta=5)
        remembered["expiry"] = 0
        self.assertEqual(self.go(c, "GET", "/api/jobs").status_code, 401)

    def test_unauthenticated(self):
        c = self.app.test_client()
        r = self.go(c, "GET", "/")
        self.assertEqual((r.status_code, r.headers["Location"]), (302, "/login"))
        for path in ("/api/jobs", "/api/jobs/abc"):
            self.assertEqual(self.go(c, "GET", path).status_code, 401)
        self.assertEqual(self.go(c, "POST", "/api/search", json={"query": "x"}).status_code, 401)

    def test_login_success_and_cookie(self):
        c, r = self.login()
        self.assertEqual(r.status_code, 302)
        cookie = r.headers["Set-Cookie"]
        for flag in ("familyhub_music=", "Secure", "HttpOnly", "SameSite=Lax"):
            self.assertIn(flag, cookie)
        self.assertNotIn(PASSWORD, cookie)
        self.assertEqual(self.go(c, "GET", "/").status_code, 200)
        self.assertEqual([s["user"] for s in self.state.sessions.values()], ["sample-a"])

    def test_login_failures(self):
        c, r = self.login(pw="wrong")
        self.assertEqual(r.status_code, 401)
        self.assertNotIn(PASSWORD, r.get_data(as_text=True))
        self.ping.reset_mock()
        c, r = self.login(user="other")  # right password, not on the allowlist
        self.assertEqual(r.status_code, 401)
        self.ping.assert_not_called()
        self.assertFalse(self.state.sessions)
        self.ping.side_effect = music_web.AuthUnavailable()
        self.assertEqual(self.login()[1].status_code, 503)

    def test_login_rate_limit(self):
        codes = [self.login(pw="wrong")[1].status_code for _ in range(9)]
        self.assertEqual(codes[:8], [401] * 8)
        self.assertEqual(codes[8], 429)

    def test_csrf_and_origin(self):
        c = self.app.test_client()
        self.assertEqual(self.go(c, "POST", "/login", data={"username": "sample-a", "password": PASSWORD}).status_code, 400)
        c, tok = self.signed_in()
        self.assertEqual(self.go(c, "POST", "/api/search", json={"query": "x"}).status_code, 400)  # no token
        self.assertEqual(self.go(c, "POST", "/logout").status_code, 400)
        r = self.post(c, tok, "/api/search", json={"query": "x"}, headers={"Origin": "https://evil.test"})
        self.assertEqual(r.status_code, 403)
        r = self.post(c, tok, "/api/search", json={"query": "x"}, origin=False)  # neither Origin nor Referer
        self.assertEqual(r.status_code, 403)
        with mock.patch.object(self.intake, "cmd_search", return_value={"results": []}):
            r = self.post(c, tok, "/api/search", json={"query": "x"}, origin=False, headers={"Referer": ORIGIN + "/"})
        self.assertEqual(r.status_code, 200)

    def test_logout_expiry_and_revocation(self):
        c, tok = self.signed_in()
        sid = next(iter(self.state.sessions))
        self.assertEqual(self.go(c, "POST", "/logout", data={"csrf_token": tok}).status_code, 302)
        self.assertNotIn(sid, self.state.sessions)
        self.assertEqual(self.go(c, "GET", "/api/jobs").status_code, 401)
        c, _ = self.signed_in()
        for s in self.state.sessions.values():
            s["expiry"] = 0
        self.assertEqual(self.go(c, "GET", "/api/jobs").status_code, 401)
        c, _ = self.signed_in()
        self.state.sessions.clear()  # revoked on the server
        self.assertEqual(self.go(c, "GET", "/").status_code, 302)

    def test_relogin_revokes_previous_session(self):
        c, _ = self.signed_in()
        old = next(iter(self.state.sessions))
        self.go(c, "POST", "/login", data={"username": "sample-a", "password": PASSWORD, "csrf_token": self.token(c, "/")})
        self.assertNotIn(old, self.state.sessions)
        self.assertEqual(len(self.state.sessions), 1)

    def test_headers_host_and_static(self):
        c = self.app.test_client()
        r = self.go(c, "GET", "/login")
        csp = r.headers["Content-Security-Policy"]
        for part in ("default-src 'self'", "frame-ancestors 'none'", "script-src 'self'"):
            self.assertIn(part, csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertIn("media-src 'self' blob:", csp)
        self.assertIn("worker-src 'none'", csp)
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        for h in ("Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security"):
            self.assertIn(h, r.headers)
        self.assertEqual(c.get("/login", base_url="https://evil.test").status_code, 400)
        js = self.go(c, "GET", "/static/app.js")
        self.addCleanup(js.close)
        self.assertEqual(js.status_code, 200)
        self.assertNotIn("innerHTML", js.get_data(as_text=True))

    def test_index_exposes_only_safe_values(self):
        c, _ = self.signed_in()
        html = self.go(c, "GET", "/").get_data(as_text=True)
        self.assertIn("https://player.test/", html)
        for secret in ("k" * 40, self.ws, self.lib, PASSWORD):
            self.assertNotIn(secret, html)


class SearchTests(Base):
    def test_partial_then_complete_poll_uses_cache(self):
        c, tok = self.signed_in()
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        first = {"id": "abcdefghijk", "title": "First"}
        extra = {"id": "12345678901", "title": "Extra"}
        def run(command, *args):
            if "Provided to YouTube" not in command[-1]:
                return 0, json.dumps({"entries": [first]}).encode(), ""
            started.set()
            release.wait(5)
            finished.set()
            return 0, json.dumps({"entries": [extra]}).encode(), ""
        self.intake.YOUTUBE.spacing = 0
        with mock.patch.object(self.intake, "tool", return_value="yt-dlp"), mock.patch.object(self.intake, "run", side_effect=run) as runner:
            try:
                partial = self.post(c, tok, "/api/search", json={"query": "Artist"}).json
                self.assertFalse(partial["complete"])
                self.assertEqual(partial["results"][0]["id"], first["id"])
                self.assertTrue(started.wait(2))
                pending = self.post(c, tok, "/api/search", json={"query": "Artist"}).json
                self.assertFalse(pending["complete"])
                self.assertEqual(runner.call_count, 2)
            finally:
                release.set()
            self.assertTrue(finished.wait(2))
            for _ in range(100):
                final = self.post(c, tok, "/api/search", json={"query": "Artist"}).json
                if final["complete"]:
                    break
                time.sleep(.01)
            self.assertTrue(final["complete"])
            self.assertEqual(len(final["results"]), 2)
            self.assertEqual(runner.call_count, 2)

    def test_transient_search_retries_then_succeeds(self):
        for message in ("HTTP Error 403: Forbidden", "HTTP Error 429", "HTTP Error 503",
                        "yt-dlp search cancelled or timed out", "Unable to download API page"):
            with self.subTest(message=message):
                c, tok = self.signed_in()
                waits = mock.Mock(return_value=False)
                def search(args):
                    self.intake.CONTROL.cancel.wait = waits
                    if waits.call_count < 2:
                        raise self.intake.IntakeError(message)
                    return {"results": []}
                with mock.patch.object(self.intake, "cmd_search", side_effect=search) as intake_search:
                    r = self.post(c, tok, "/api/search", json={"query": message})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(intake_search.call_count, 3)
                self.assertEqual(waits.call_args_list, [mock.call(1.5), mock.call(4)])
                self.assertIsNone(self.intake.CONTROL.cancel)

    def test_transient_search_exhausted_returns_503(self):
        c, tok = self.signed_in()
        waits = mock.Mock(return_value=False)
        def search(args):
            self.intake.CONTROL.cancel.wait = waits
            raise self.intake.IntakeError("yt-dlp search failed: HTTP Error 403: Forbidden /private")
        with mock.patch.object(self.intake, "cmd_search", side_effect=search) as intake_search:
            r = self.post(c, tok, "/api/search", json={"query": "Artist"})
        self.assertEqual(intake_search.call_count, 3)
        self.assertEqual(waits.call_args_list, [mock.call(1.5), mock.call(4)])
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json["error"], "YouTube is limiting searches right now. Try again in a moment.")
        self.assertIsNone(self.intake.CONTROL.cancel)

    def test_search_cancelled_during_backoff_does_not_retry(self):
        c, tok = self.signed_in()
        def search(args):
            self.intake.CONTROL.cancel.wait = mock.Mock(return_value=True)
            raise self.intake.IntakeError("HTTP Error 403: Forbidden")
        with mock.patch.object(self.intake, "cmd_search", side_effect=search) as intake_search:
            r = self.post(c, tok, "/api/search", json={"query": "Artist"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(intake_search.call_count, 1)
        self.assertIsNone(self.intake.CONTROL.cancel)

    def test_long_mixes_hidden_unless_requested_and_cache_shared(self):
        c, tok = self.signed_in()
        rows = [{"id": str(i).zfill(11), "title": f"Song {i}", "duration": duration}
                for i, duration in enumerate((200, 1799, 1800, 7200))]
        with mock.patch.object(self.intake, "cmd_search", return_value={"results": rows}) as search:
            hidden = self.post(c, tok, "/api/search", json={"query": "Artist"}).json
            shown = self.post(c, tok, "/api/search", json={"query": "Artist", "include_long": True}).json
            self.assertEqual(len(hidden["results"]), 2)
            self.assertEqual(len(shown["results"]), 4)
            self.assertEqual(search.call_count, 1)
        self.assertEqual(self.post(c, tok, "/api/search", json={"query": "Artist", "include_long": "true"}).status_code, 400)

    def test_pages_reuse_search_and_recommendations_keep_the_search_cache(self):
        c, tok = self.signed_in()
        rows = [{"id": str(i).zfill(11), "title": f"Song {i}"} for i in range(30)]
        with mock.patch.object(self.intake, "cmd_search", return_value={"results": rows}) as search:
            first = self.post(c, tok, "/api/search", json={"query": "Artist"}).json
            self.assertEqual(first["next_offset"], 8)
            recommendation = self.post(c, tok, "/api/recommendations", json={"query": "Other artist"})
            self.assertEqual(recommendation.status_code, 200)
            second = self.post(c, tok, "/api/search", json={"query": "Artist", "offset": 8}).json
            last = self.post(c, tok, "/api/search", json={"query": "Artist", "offset": 24}).json
            self.assertEqual(second["results"][0]["id"], rows[8]["id"])
            self.assertEqual(len(last["results"]), 6)
            self.assertEqual(last["next_offset"], 30)
            self.assertEqual(search.call_count, 2)
        for offset in (-1, 1, 32, True, "8"):
            self.assertEqual(self.post(c, tok, "/api/search", json={"query": "Artist", "offset": offset}).status_code, 400)

    def test_results_are_trimmed_and_errors_brief(self):
        c, tok = self.signed_in()
        row = {"id": "abcdefghijk", "url": URL, "title": "<b>x</b>", "channel": "c", "duration": 3, "kind": "topic", "extra": "leak"}
        with mock.patch.object(self.intake, "cmd_search", return_value={"results": [row]}) as m:
            r = self.post(c, tok, "/api/search", json={"query": " maple "})
        self.assertEqual(m.call_args.args[0].query, "maple")
        self.assertEqual(m.call_args.args[0].limit, 30)
        self.assertEqual(r.get_json()["results"], [{k: v for k, v in row.items() if k != "extra"}])
        with mock.patch.object(self.intake, "cmd_search", side_effect=self.intake.IntakeError("/srv/x https://y")):
            r = self.post(c, tok, "/api/search", json={"query": "q"})
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("/srv", r.get_data(as_text=True))

    def test_search_continues_into_a_new_provider_batch(self):
        c, tok = self.signed_in()
        with mock.patch.object(self.intake, "cmd_search", return_value={"results": []}) as search:
            result = self.post(c, tok, "/api/search", json={"query": "Artist", "offset": 30}).json
        self.assertEqual(search.call_args.args[0].offset, 30)
        self.assertIsNone(result["next_offset"])

    def test_validation_and_rate_limit(self):
        c, tok = self.signed_in()
        for bad in ({}, {"query": ""}, {"query": 5}, {"query": "a" * 201}, {"query": "a\nb"}, [1]):
            self.assertEqual(self.post(c, tok, "/api/search", json=bad).status_code, 400, bad)
        with mock.patch.object(self.intake, "cmd_search", return_value={"results": []}):
            codes = [self.post(c, tok, "/api/search", json={"query": "q" + str(i)}).status_code for i in range(41)]
        self.assertEqual(codes[-2:], [200, 429])


class JobTests(Base):
    def start(self, c, tok, **over):
        return self.post(c, tok, "/api/jobs", json={"url": URL + "&list=PLx", **META, **over})

    def test_fetch_and_import(self):
        self.fake_ok()
        c, tok = self.signed_in()
        r = self.start(c, tok, track="7")
        self.assertEqual(r.status_code, 202)
        job = self.wait(c, r.get_json()["job"]["id"])
        self.assertEqual(job["state"], "done")
        self.assertEqual("Saved to your library.", job["message"])
        self.assertEqual((self.calls["fetch"].url, self.calls["fetch"].workspace), (URL, self.ws))
        imp = self.calls["import"]
        self.assertEqual((imp.library, imp.artist, imp.album, imp.title, imp.track), (self.lib, "Artist", "Album", "Title", 7))
        self.assertNotIn(self.ws, str(job) + r.get_data(as_text=True))
        self.assertNotIn(self.lib, str(job))

    def test_failures_are_not_leaked(self):
        self.fake_ok()
        c, tok = self.signed_in()
        for exc, text in ((self.intake.IntakeError("boom /srv/x https://y/z"), music_web.FAIL_TEXT["fetch"]),
                          (RuntimeError("/secret"), "Import failed unexpectedly.")):
            with mock.patch.object(self.intake, "cmd_fetch", side_effect=exc):
                job = self.wait(c, self.start(c, tok).get_json()["job"]["id"])
            self.assertEqual((job["state"], job["message"]), ("error", text))
        with self.assertLogs("music_web", "WARNING") as logs, \
                mock.patch.object(self.intake, "cmd_fetch", side_effect=RuntimeError("https://x/?sig=SECRET /srv/p")):
            self.wait(c, self.start(c, tok).get_json()["job"]["id"])
        self.assertNotIn("SECRET", "".join(logs.output))
        self.assertNotIn("/srv/p", "".join(logs.output))
        self.assertIn("RuntimeError", "".join(logs.output))

    def test_other_user_same_source_waits_without_409(self):
        self.fake_ok()
        gate = threading.Event()
        mock.patch.object(self.intake, "cmd_fetch", lambda a: gate.wait(5) and {"item": "x"}).start()
        c, tok = self.signed_in()
        first = self.start(c, tok).get_json()["job"]["id"]
        other, otok = self.signed_in("sample-b")
        r = self.start(other, otok)
        self.assertEqual(r.status_code, 202)
        self.assertNotEqual(r.json["job"]["id"], first)
        gate.set()
        self.assertEqual(self.wait(c, first)["state"], "done")
        self.assertEqual(self.start(other, otok).status_code, 202)

    def test_jobs_are_per_user(self):
        self.fake_ok()
        a, atok = self.signed_in("sample-a")
        b, _ = self.signed_in("sample-b")
        jid = self.start(a, atok).get_json()["job"]["id"]
        self.wait(a, jid)
        self.assertEqual(self.go(b, "GET", f"/api/jobs/{jid}").status_code, 404)
        self.assertEqual(self.go(b, "GET", "/api/jobs").get_json()["jobs"], [])
        self.assertEqual(len(self.go(a, "GET", "/api/jobs").get_json()["jobs"]), 1)

    def test_input_validation(self):
        called = mock.Mock()
        mock.patch.object(self.intake, "cmd_fetch", called).start()
        c, tok = self.signed_in()
        for url in ("http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://evil.test/watch?v=dQw4w9WgXcQ",
                    "file:///etc/passwd", "https://youtu.be/short", 5, None, "x" * 300):
            self.assertEqual(self.start(c, tok, url=url).status_code, 400, url)
        for over in ({"artist": ""}, {"artist": "  "}, {"album": ".."}, {"title": "a" * 121}, {"title": "a\nb"},
                     {"title": 5}, {"artist": None}, {"track": 0}, {"track": 1000}, {"track": True}, {"track": "x"},
                     {"track": 1.5}, {"track": []}):
            self.assertEqual(self.start(c, tok, **over).status_code, 400, over)
        self.assertEqual(self.post(c, tok, "/api/jobs", json=[URL]).status_code, 400)
        called.assert_not_called()
        self.assertFalse(self.state.jobs)

    def test_completed_jobs_are_bounded(self):
        self.fake_ok()
        c, tok = self.signed_in()
        for _ in range(music_web.MAX_JOBS + 5):
            self.wait(c, self.start(c, tok, url="https://youtu.be/" + f"{_:011d}").get_json()["job"]["id"])
        self.assertLessEqual(len(self.state.jobs), music_web.MAX_JOBS)

    def test_signed_preview_refreshes_playlist_and_scopes_every_asset(self):
        c, _ = self.signed_in()
        jid = "native-preview"
        root = pathlib.Path(self.ws) / (".preview-" + jid)
        root.mkdir()
        playlist = root / "index.m3u8"
        prefix = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg00000.m4s\n'
        playlist.write_text(prefix)
        for asset in ("init.mp4", "seg00000.m4s", "seg00001.m4s"):
            (root / asset).write_bytes(b"audio")
        self.state.jobs[jid] = dict(id=jid, owner="sample-a", state="running", message="Preparing", artist="Artist",
            title="Song", phase="fetch", source_id="abcdefghijk", preview_state="ready",
            assets={"index.m3u8", "init.mp4", "seg00000.m4s"}, created=time.time())
        job = self.go(c, "GET", "/api/jobs/" + jid).json["job"]
        native = self.app.test_client()
        response = self.go(native, "GET", job["stream_url"])
        self.assertEqual(response.status_code, 200)
        text = response.get_data(as_text=True)
        self.assertIn("#EXT-X-PLAYLIST-TYPE:EVENT", text)
        self.assertNotIn("#EXT-X-ENDLIST", text)
        assets = [line for line in text.splitlines() if line and not line.startswith("#")]
        assets.append(re.search(r'URI="([^"]+)"', text).group(1))
        for url in assets:
            self.assertEqual(self.go(native, "GET", url).data, b"audio")
        stolen = assets[0].replace("seg00000.m4s", "init.mp4")
        self.assertEqual(self.go(native, "GET", stolen).status_code, 401)
        playlist.write_text(prefix + "#EXTINF:2,\nseg00001.m4s\n#EXT-X-ENDLIST\n")
        self.state.jobs[jid]["assets"].add("seg00001.m4s")
        updated = self.go(native, "GET", job["stream_url"]).get_data(as_text=True)
        self.assertIn("seg00001.m4s?", updated)
        self.assertIn("#EXT-X-ENDLIST", updated)
        self.assertEqual(len(self.state.jobs), 1)

    def test_media_assets_are_owner_scoped_immutable_files(self):
        c, _ = self.signed_in("sample-a")
        other, _ = self.signed_in("sample-b")
        jid = "job-test"
        root = os.path.join(self.ws, ".preview-" + jid)
        os.mkdir(root)
        path = os.path.join(root, "seg00000.m4s")
        with open(path, "wb") as f:
            f.write(b"segment")
        self.state.jobs[jid] = {"id": jid, "owner": "sample-a", "state": "running", "message": "Playing",
                                "artist": "Artist", "title": "Title", "phase": "fetch", "preview_state": "ready",
                                "assets": {"seg00000.m4s"}, "created": time.time()}
        url = f"/api/jobs/{jid}/media/seg00000.m4s"
        self.assertEqual(self.go(other, "GET", url).status_code, 404)
        self.assertEqual(self.go(c, "GET", f"/api/jobs/{jid}/media/../manifest.json").status_code, 404)
        head = self.go(c, "HEAD", url)
        self.addCleanup(head.close)
        self.assertEqual((head.status_code, head.headers["Content-Length"]), (200, "7"))
        ranged = self.go(c, "GET", url, headers={"Range": "bytes=1-3"})
        self.addCleanup(ranged.close)
        self.assertEqual((ranged.status_code, ranged.data), (206, b"egm"))
        self.assertIn("media-src 'self'", self.go(c, "GET", "/").headers["Content-Security-Policy"])


class UploadTests(Base):
    extra = {"MAX_UPLOAD": 1024}

    def upload(self, c, tok, name="song.mp3", data=b"audio", **over):
        form = {**META, **over, "file": (io.BytesIO(data), name)}
        return self.post(c, tok, "/api/uploads", data=form, content_type="multipart/form-data")

    def leftovers(self):
        return [n for n in os.listdir(self.ws) if n.startswith(".upload-")]

    def test_upload_stage_import_and_cleanup(self):
        self.fake_ok()
        seen = {}

        def stage(args):
            seen["dir"], seen["name"] = os.path.dirname(args.file), os.path.basename(args.file)
            with open(args.file, "rb") as src:
                seen["workspace"], seen["data"] = args.workspace, src.read()
            return {"item": os.path.join(self.ws, "local-item")}
        mock.patch.object(self.intake, "cmd_stage", stage).start()
        c, tok = self.signed_in()
        r = self.upload(c, tok, track="3")
        self.assertEqual(r.status_code, 202)
        job = self.wait(c, r.get_json()["job"]["id"])
        self.assertEqual(job["state"], "done")
        self.assertEqual((seen["dir"], seen["workspace"], seen["data"]), (self.ws, self.ws, b"audio"))
        self.assertRegex(seen["name"], r"^\.upload-[0-9a-f]{32}\.mp3$")  # random name; the client name is not used
        self.assertEqual(self.calls["import"].track, 3)
        self.assertEqual(self.leftovers(), [])
        self.assertNotIn(self.ws, str(job))

    def test_cancelling_queued_upload_removes_only_its_staged_input(self):
        c, token = self.signed_in()
        stream = io.BytesIO()
        with wave.open(stream, "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\x01\x02" * 160)
        data = stream.getvalue()
        entered, release = threading.Event(), threading.Event()
        active_files = []

        def stage(args):
            path = pathlib.Path(args.file)
            active_files.append(path)
            entered.set()
            self.assertTrue(release.wait(5))
            self.assertEqual(path.read_bytes(), data)
            return {"item": "fixture"}

        resources = self.state.resources
        with (mock.patch.object(resources, "reservations", return_value=("listening", 2, 2)),
              mock.patch.object(resources, "background_slots", return_value=0),
              mock.patch.object(self.intake, "cmd_stage", side_effect=stage) as staging,
              mock.patch.object(self.intake, "cmd_import") as importer):
            active = self.upload(c, token, name="active.wav", data=data).json["job"]
            try:
                self.assertTrue(entered.wait(2))
                queued = self.upload(c, token, name="queued.wav", data=data).json["job"]
                self.assertEqual(queued["state"], "queued")
                self.assertEqual(len(self.leftovers()), 2)
                cancelled = self.post(c, token, f"/api/jobs/{queued['id']}/cancel", json={})
                self.assertEqual(cancelled.json["job"]["state"], "cancelled")
                self.assertEqual(self.leftovers(), [active_files[0].name])
                self.assertEqual(self.post(c, token, f"/api/jobs/{active['id']}/cancel", json={}).status_code, 200)
                self.assertTrue(active_files[0].is_file())
            finally:
                release.set()
            self.assertEqual(self.wait(c, active["id"])["state"], "cancelled")
            self.assertEqual(self.leftovers(), [])
            staging.assert_called_once()
            importer.assert_not_called()

    def test_cancelling_upload_during_copy_skips_queue_and_cleans_up(self):
        from werkzeug.datastructures import FileStorage

        c, token = self.signed_in()
        entered, release = threading.Event(), threading.Event()
        responses = []
        save = FileStorage.save

        def copy(storage, destination):
            save(storage, destination)
            entered.set()
            self.assertTrue(release.wait(5))

        with (mock.patch.object(FileStorage, "save", autospec=True, side_effect=copy),
              mock.patch.object(self.intake, "cmd_stage") as staging):
            thread = threading.Thread(target=lambda: responses.append(self.upload(c, token)))
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                job = self.go(c, "GET", "/api/jobs").json["jobs"][0]
                self.assertEqual(self.post(c, token, f"/api/jobs/{job['id']}/cancel", json={}).status_code, 200)
                self.assertEqual(len(self.leftovers()), 1)
            finally:
                release.set()
                thread.join(3)
            self.assertEqual([response.status_code for response in responses], [202])
            self.assertEqual(responses[0].json["job"]["state"], "cancelled")
            self.assertEqual(self.leftovers(), [])
            staging.assert_not_called()

    def test_upload_failure_names_the_reason_without_paths(self):
        self.fake_ok()
        c, tok = self.signed_in()
        for error, message, label in (
                ("audio does not decode cleanly (corrupt or truncated): /srv/secret/x.mp3", "This file is damaged or cut off partway, so it can't be played reliably.", "damaged"),
                ("file contains a video stream; only audio files are accepted", "This is a video file. Upload the audio only.", "video"),
                ("something new /srv/secret", "This file could not be read as audio.", None)):
            with mock.patch.object(self.intake, "cmd_stage", side_effect=self.intake.IntakeError(error)),                     self.assertLogs("music_web", "WARNING") as logs:
                job = self.wait(c, self.upload(c, tok).get_json()["job"]["id"])
            self.assertEqual((job["state"], job["message"]), ("error", message))
            self.assertNotIn("/srv/secret", "".join(logs.output))
            if label: self.assertIn(f"({label})", "".join(logs.output))

    def test_native_upload_uses_tags_and_falls_back_for_missing_metadata(self):
        self.fake_ok()
        item = os.path.join(self.ws, "local-0123456789abcdef")
        manifest = dict(id="local-0123456789abcdef", source=dict(kind="local"))
        mock.patch.object(self.intake, "cmd_stage", return_value=dict(item=item, manifest=manifest)).start()
        mock.patch.object(self.intake, "load_item", return_value=(item, manifest, "audio.flac")).start()
        probe = mock.patch.object(self.intake, "probe", return_value=dict(tags=dict(artist="Tagged artist", title="Tagged title"))).start()
        c, tok = self.signed_in()
        result = self.upload(c, tok, name="Filename.mp3", read_tags="true", title="", artist="", album="")
        self.assertEqual(result.status_code, 202, result.json)
        job = self.wait(c, result.json["job"]["id"])
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(job["source_id"], manifest["id"])
        self.assertEqual((self.calls["import"].title,self.calls["import"].artist,self.calls["import"].album), ("Tagged title","Tagged artist","Unknown album"))
        probe.assert_called_once_with("audio.flac", tags=True)
        self.assertEqual(self.leftovers(), [])

    def test_upload_failure_removes_temp(self):
        mock.patch.object(self.intake, "cmd_stage", side_effect=self.intake.IntakeError("/srv/x not audio")).start()
        c, tok = self.signed_in()
        job = self.wait(c, self.upload(c, tok).get_json()["job"]["id"])
        self.assertEqual((job["state"], job["message"]), ("error", music_web.FAIL_TEXT["stage"]))
        self.assertEqual(self.leftovers(), [])

    def test_upload_bounds_and_types(self):
        stage = mock.Mock()
        mock.patch.object(self.intake, "cmd_stage", stage).start()
        c, tok = self.signed_in()
        for name in ("song.exe", "song", "../song.txt"):
            self.assertEqual(self.upload(c, tok, name=name).status_code, 400, name)
        self.assertEqual(self.upload(c, tok, data=b"").status_code, 400)
        self.assertEqual(self.upload(c, tok, data=b"x" * 2000).status_code, 413)  # over MAX_UPLOAD
        self.assertEqual(self.upload(c, tok, data=b"x" * (2 << 20)).status_code, 413)  # over the request limit
        self.assertEqual(self.upload(c, tok, artist="").status_code, 400)
        self.assertEqual(self.post(c, tok, "/api/uploads", data=META).status_code, 400)  # no file
        self.assertEqual(self.leftovers(), [])
        stage.assert_not_called()
        self.assertEqual(self.go(c, "GET", "/api/jobs").status_code, 200)
        self.assertTrue(all(j["state"] == "error" for j in self.state.jobs.values()))  # a failed upload frees the slot


if __name__ == "__main__":
    unittest.main()
