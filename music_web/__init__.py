"""FamilyHub mobile music app: Navidrome sign-in, public metadata search, fetch or upload, then import.

Acquisition/import reuse scripts/music-intake.py. One coordinator schedules acquisition,
HLS and bounded beat analysis; browser decks handle playback. See docs/MOBILE_MUSIC.md.
"""
import gzip, hashlib, importlib.util, io, json, logging, os, re, secrets, shutil, sys, threading, time, urllib.error, urllib.parse, urllib.request
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextlib import suppress
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

from flask import Flask, abort, g, jsonify, redirect, render_template, request, session, send_file
from flask_wtf.csrf import CSRFProtect, generate_csrf
from werkzeug.exceptions import HTTPException
from .genres import GenreLabels, artist_name
from .playlist_preparation import PlaylistPreparation
from .listening_stats import ListeningStats
from .playlists import PlaylistError, PlaylistStore, fetch_playlist, fetch_youtube_playlist, rank_matches, normalized, duration_matches, preferred_match
from .profiles import ProfileError, ProfileStore
from .mixing import transition
from .audio_profile import profile
from . import mobile_audio
from . import app_updates
from . import profile_artwork
from .listening_versions import ListeningVersions
from .catalogue_review import CatalogueReview, register as register_catalogue_review
from .source_quality import register as register_source_quality
from .song_analysis import register as register_song_analysis
from .finished_audio import FinishedAudio, prepare_record, activity as finished_audio_activity
from .playlist_artwork import PlaylistArtwork, ArtworkError
from .lyrics import LyricsCache
from .worker_activity import WorkerActivity
from . import link_playlists
from . import radio

MAX_UPLOAD = 128 << 20
SESSION_HOURS = 12
REMEMBER_HOURS = 30 * 24
MAX_JOBS = 50
MAX_VERIFIED_SOURCES = 4096  # Keep a full family library warm while bounding manifest memory.
PREVIEW_TTL = 2 * 60 * 60
MAX_PREVIEWS = 24
MAX_CACHE_BYTES = 16 << 30
MIN_FREE_BYTES = 256 << 20


def scratch_size(workspace, library, intake):
    size = 0
    for root, dirs, files in os.walk(workspace, followlinks=False):
        dirs[:] = [d for d in dirs if not intake.is_link(os.path.join(root, d))]
        if root == workspace:
            # Published assets are durable storage, not acquisition scratch space.
            dirs[:] = [d for d in dirs if d not in
                       (".app-updates", ".listening-versions", ".finished-audio")]
            for name in dirs[:]:
                if not intake.ID_RE.fullmatch(name):
                    continue
                try:
                    manifest = os.path.join(root, name, "manifest.json")
                    intake.regular_file(manifest, "manifest")
                    with open(manifest, encoding="utf-8") as file:
                        data = json.loads(file.read(65536))
                        record = data.get("import") if isinstance(data, dict) else None
                    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                        continue
                    target = os.path.join(library, *record["path"].split("/"))
                    if intake.inside(target, library):
                        intake.regular_file(target, "published audio")
                        dirs.remove(name)
                except (OSError, ValueError, intake.IntakeError):
                    pass
        for name in files:
            path = os.path.join(root, name)
            with suppress(OSError):
                if not intake.is_link(path):
                    size += os.stat(path).st_size
    return size
def preview_victims(jobs, exclude=None):
    """Keep audible/recently requested segments and the next deck alive."""
    now = time.time()
    return sorted((j for j in jobs if j is not exclude and j["preview_state"] == "ready"
                   and not j.get("current") and not j.get("analyzing")
                   and (j.get("priority") != 1 or j["cancel"].is_set())
                   and now - j.get("accessed", 0) > 15),
                  key=lambda j: (-j["priority"], j["created"]))


DEFAULTS = {
    "CLI_PATH": "/usr/local/lib/familyhub/music-intake.py",
    "WORKSPACE": "/srv/familyhub/data/quarantine/music/intake",
    "LIBRARY": "/srv/familyhub/data/media/music",
    "NAVIDROME_URL": "http://127.0.0.1:4533",
    "PLAYER_URL": "https://familyhub.example.ts.net:8443/",
    "PUBLIC_ORIGIN": "https://familyhub.example.ts.net:8444",
    "ALLOWED_USERS": [],
    "FAMILY_PROFILES": False,
    "BROWSER_PLAYER": True,
    "ADMIN_USERS": [],
    "SECRET_FILE": "/etc/familyhub/music-web.secret",
    "MAX_UPLOAD": MAX_UPLOAD,
    "REQUIRE_FINISHED_AUDIO": True,
}
STEP_TEXT = {"fetch": "Downloading audio", "stage": "Checking the audio file", "import": "Importing to the library",
             "prepare": "Preparing listening audio"}
# Known upload failures: (log label, message for the person who uploaded). Matched on the intake's
# own wording, so no path or URL from the error text reaches the log or the app.
UPLOAD_FAILURES = (
    ("not-audio", "cannot read this file as audio", "This file isn't an audio file the server can read."),
    ("video", "contains a video stream", "This is a video file. Upload the audio only."),
    ("several-tracks", "expected exactly one audio stream", "This file has more than one audio track."),
    ("damaged", "does not decode cleanly", "This file is damaged or cut off partway, so it can't be played reliably."),
    ("no-length", "no usable duration", "The server couldn't tell how long this song is. The file may be damaged."),
    ("timeout", "cancelled or timed out", "The server took too long with this file. Try it again when the server is less busy."),
)

def upload_failure(error):
    text = str(error)
    return next(((label, message) for label, needle, message in UPLOAD_FAILURES if needle in text), None)

FAIL_TEXT = {"fetch": "Download failed. Check the link and try again.",
             "stage": "This file could not be read as audio.",
             "import": "Import failed. Try a different album or title, or ask the administrator.",
             "prepare": "The server could not finish preparing audio. Try again."}
DONE_TEXT = "Saved to your library."
HTTP_TEXT = {400: "Request rejected. Reload the page and try again.", 401: "Sign in required.", 403: "Request rejected.",
             404: "Not found.", 405: "Method not allowed.", 413: "The upload is too large.", 429: "Too many requests."}


class ApiError(Exception):
    def __init__(self, message, code=400):
        self.message, self.code = message, code


class AuthUnavailable(Exception):
    pass


def load_intake(path):
    spec = importlib.util.spec_from_file_location("music_intake", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ping(base, user, password):
    """Ask Navidrome whether these credentials work (Subsonic token auth, so the password is not sent)."""
    salt = secrets.token_hex(8)
    query = urllib.parse.urlencode({"u": user, "t": hashlib.md5((password + salt).encode(), usedforsecurity=False).hexdigest(),
                                    "s": salt, "v": "1.16.1", "c": "familyhub-music", "f": "json"})
    try:
        with urllib.request.urlopen(f"{base.rstrip('/')}/rest/ping.view?{query}", timeout=10) as r:
            reply = json.loads(r.read(65536))["subsonic-response"]
    except (OSError, ValueError, KeyError, TypeError):
        raise AuthUnavailable()
    return isinstance(reply, dict) and reply.get("status") == "ok"


def create_app(test_config=None):
    cfg = dict(DEFAULTS)
    path = os.environ.get("FAMILYHUB_MUSIC_CONFIG")
    if test_config is None and path:
        with open(path, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    cfg.update(test_config or {})
    if not cfg.get("SECRET_KEY"):
        with open(cfg["SECRET_FILE"], encoding="utf-8") as fh:
            cfg["SECRET_KEY"] = fh.read().strip()
    if len(cfg["SECRET_KEY"]) < 32:
        raise RuntimeError("the secret must be at least 32 characters")
    origin = cfg["PUBLIC_ORIGIN"].rstrip("/")
    host = urllib.parse.urlsplit(origin).netloc
    ws, lib = os.path.abspath(cfg["WORKSPACE"]), os.path.abspath(cfg["LIBRARY"])
    allowed = set(cfg["ALLOWED_USERS"])
    family_mode = cfg.get("FAMILY_PROFILES") is True
    profile_store = ProfileStore(ws, allowed) if family_mode else None
    max_upload = cfg["MAX_UPLOAD"]

    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=cfg["SECRET_KEY"], SESSION_COOKIE_NAME="familyhub_music", SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=3650) if family_mode else timedelta(hours=REMEMBER_HOURS), SESSION_REFRESH_EACH_REQUEST=False,
        MAX_CONTENT_LENGTH=max_upload + (1 << 20),
        WTF_CSRF_TIME_LIMIT=None, WTF_CSRF_SSL_STRICT=False)  # origin is checked in guard()
    app.intake = load_intake(cfg["CLI_PATH"])
    catalogue_review = CatalogueReview(ws)
    from .playback_devices import PlaybackDevices
    playback_devices = PlaybackDevices()
    listening_versions = ListeningVersions(ws, app.intake)
    finished_audio = FinishedAudio(ws, app.intake)
    genre_labels = GenreLabels(ws, enabled=cfg.get("GENRE_LOOKUP", cfg["PUBLIC_ORIGIN"] != "https://music.test"))
    sessions, jobs, hits, lock = {}, OrderedDict(), {}, threading.RLock()
    worker_lock = threading.Lock()
    import_lock = threading.Lock()
    budget_lock = threading.Lock()
    budget_cache = {"at": 0.0, "size": 0}
    selections = {}
    saved_cache = OrderedDict()
    saved_lock = threading.RLock()
    searches = {}
    search_cache = OrderedDict()
    app.extensions["music"] = SimpleNamespace(sessions=sessions, jobs=jobs)
    log = logging.getLogger("music_web")

    def allow(key, limit, window):
        now = time.monotonic()
        with lock:
            q = hits.setdefault(key, deque())
            while q and q[0] <= now - window:
                q.popleft()
            if len(hits) > 2000:  # drop idle keys so unknown names cannot grow the table without bound
                for k in [k for k, v in hits.items() if not v or v[-1] < now - 3600]:
                    del hits[k]
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    def current():
        sid = session.get("sid")
        with lock:
            s = sessions.get(sid) if isinstance(sid, str) else None
            if s and s["expiry"] > time.time():
                return s["user"]
            sessions.pop(sid, None)
            if family_mode and session.get("family_profile"):
                try:
                    profile = profile_store.get(session["family_profile"])
                except ProfileError:
                    session.pop("family_profile", None)
                else:
                    # Remember only a profile choice. Retain CSRF so a returning tab can
                    # continue its first request after a server restart.
                    sid = secrets.token_urlsafe(32)
                    sessions[sid] = {"user": profile["id"], "expiry": time.time() + REMEMBER_HOURS * 3600}
                    session["sid"] = sid
                    session.permanent = True
                    return profile["id"]
        session.pop("sid", None)

    @app.before_request
    def guard():
        if request.host != host:
            abort(400)
        if not cfg["BROWSER_PLAYER"] and not request.path.startswith("/api/"):
            return app.response_class("Open the FamilyHub Music app.\n", status=410, mimetype="text/plain")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            sent, ref = request.headers.get("Origin"), request.headers.get("Referer", "")
            if not (sent == origin if sent is not None else ref == origin or ref.startswith(origin + "/")):
                abort(403)
        if request.endpoint in ("login", "static", "family_connect", "create_family_profile", "select_family_profile", "app_update_manifest", "app_update_package", "profile_image"):
            return
        g.user = current()
        if not g.user:
            if request.path.startswith("/api/"):
                raise ApiError(HTTP_TEXT[401], 401)
            return redirect("/login")

    CSRFProtect(app)  # registered after guard(), so host, origin and sign-in are checked first

    @app.after_request
    def headers(resp):
        resp.headers.update({
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
                                       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; "
            "base-uri 'none'; object-src 'none'; media-src 'self' blob:; worker-src 'none'",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cache-Control": "no-store",
            "Strict-Transport-Security": "max-age=31536000"})
        # The apps refresh these lists every few minutes. An unchanged list answers 304 with
        # no body, and a changed one is gzip-compressed (about a fifth of the size).
        if (request.method == "GET" and request.path in ("/api/library", "/api/playlists")
                and resp.status_code == 200 and resp.mimetype == "application/json" and not resp.direct_passthrough):
            resp.add_etag()
            resp.make_conditional(request)
            if (resp.status_code == 200 and "gzip" in request.headers.get("Accept-Encoding", "")
                    and "Content-Encoding" not in resp.headers):
                resp.set_data(gzip.compress(resp.get_data(), 6))
                resp.headers["Content-Encoding"] = "gzip"
                resp.headers["Vary"] = "Accept-Encoding"
        return resp

    @app.errorhandler(ApiError)
    def api_error(e):
        return jsonify(error=e.message), e.code

    @app.errorhandler(HTTPException)
    def http_error(e):
        text = HTTP_TEXT.get(e.code, "Request failed.")
        return (jsonify(error=text) if request.path.startswith("/api/") else text), e.code

    # ---- sign in ----
    def require_family():
        if not family_mode:
            raise ApiError("Family profiles are not enabled on this server.", 409)

    app_updates.register(app, ws, require_family)
    profile_artwork.register(app, ws, profile_store, require_family, lock)

    @app.errorhandler(ProfileError)
    def profile_error(error):
        return jsonify(error=str(error)), 400

    def establish_session(user, remember):
        old = session.get("sid")
        session.clear()
        sid = secrets.token_urlsafe(32)
        with lock:
            sessions.pop(old, None)
            now = time.time()
            for key in [key for key, value in sessions.items() if value["expiry"] <= now]:
                del sessions[key]
            hours = REMEMBER_HOURS if remember else SESSION_HOURS
            sessions[sid] = {"user": user, "expiry": now + hours * 3600}
        session.permanent = remember
        session["sid"] = sid
        if family_mode:
            session["family_profile"] = user

    @app.get("/api/connect")
    def family_connect():
        require_family()
        with lock:
            profiles = profile_store.list()
        return jsonify(family_profiles=True, server_name="FamilyHub Music", profiles=profiles, csrf_token=generate_csrf())

    @app.post("/api/profiles")
    def create_family_profile():
        require_family()
        with lock:
            profile = profile_store.create(body().get("name"))
        return jsonify(profile=profile), 201

    @app.post("/api/profile/select")
    def select_family_profile():
        require_family()
        with lock:
            profile = profile_store.get(body().get("profile_id"))
            preferences = profile_store.preferences(profile["id"])
            establish_session(profile["id"], True)
        g.pop("csrf_token", None)
        return jsonify(profile=profile, preferences=preferences, csrf_token=generate_csrf())

    @app.route("/api/profile/playback", methods=["GET", "PUT"])
    def family_playback():
        require_family()
        with lock:
            if request.method == "PUT":
                data = body(65536)
                if data.get("profile_id") != g.user:
                    raise ApiError("The selected profile changed.", 409)
                value = profile_store.playback(g.user, data.get("playback", {}))
            else:
                value = profile_store.playback(g.user)
        return jsonify(profile_id=g.user, playback=value)

    @app.route("/api/profile/preferences", methods=["GET", "PATCH"])
    def family_preferences():
        require_family()
        with lock:
            preferences = profile_store.preferences(g.user, body() if request.method == "PATCH" else None)
        return jsonify(preferences=preferences)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        def page(error=None, code=200):
            return render_template("login.html", error=error,
                                   family_profiles=profile_store.list() if family_mode else None,
                                   username=request.form.get("username", "")[:64]), code
        if request.method == "GET":
            return redirect("/") if current() else page()
        if family_mode:
            try:
                with lock:
                    profile = profile_store.create(request.form.get("name")) if request.form.get("action") == "create" else profile_store.get(request.form.get("profile_id"))
                    establish_session(profile["id"], True)
            except ProfileError as error:
                return page(str(error), 400)
            return redirect("/")
        user, pw = request.form.get("username", "").strip()[:64], request.form.get("password", "")
        if not (allow("login", 30, 300) and allow("login:" + user.lower(), 8, 300)):
            return page("Too many attempts. Wait a few minutes.", 429)
        try:
            ok = bool(user and pw and len(pw) <= 256 and user in allowed and ping(cfg["NAVIDROME_URL"], user, pw))
        except AuthUnavailable:
            return page("Sign-in is unavailable. Try again later.", 503)
        if not ok:
            return page("Username or password is wrong.", 401)
        establish_session(user, request.form.get("remember") == "1")
        return redirect("/")

    @app.post("/logout")
    def logout():
        with lock:
            sessions.pop(session.get("sid"), None)
        session.clear()
        return redirect("/login")

    @app.get("/")
    def index():
        profile_name = profile_store.get(g.user)["name"] if family_mode else g.user
        return render_template("index.html", player_url=cfg["PLAYER_URL"], user=g.user,
                               family_mode=family_mode, profile_name=profile_name)

    # ---- validation ----
    def body(limit=8192):
        if (request.content_length or 0) > limit:
            raise ApiError("Request is too large.", 413)
        d = request.get_json(silent=True)
        if not isinstance(d, dict):
            raise ApiError("Request body must be a JSON object.")
        return d

    def meta(d):
        out = {}
        for key, label in (("artist", "Artist"), ("album", "Album"), ("title", "Title")):
            v = d.get(key)
            v = v.strip() if isinstance(v, str) else ""
            if not v or any(ord(c) < 32 or ord(c) == 127 for c in v):
                raise ApiError(f"{label} is required and cannot contain control characters.")
            try:
                app.intake.safe_name(v, key)
            except app.intake.IntakeError:
                raise ApiError(f"{label} cannot be used as a file name.")
            out[key] = v
        t = d.get("track")
        t = int(t) if isinstance(t, str) and t.strip().isdecimal() and len(t.strip()) <= 4 else t
        if t in (None, ""):
            t = None
        elif isinstance(t, bool) or not isinstance(t, int) or not 1 <= t <= 999:
            raise ApiError("Track number must be between 1 and 999.")
        out["track"] = t
        return out

    # ---- jobs ----
    def remove_preview(job_id):
        root = os.path.join(ws, ".preview-" + job_id)
        if not os.path.lexists(root):
            return
        # Missing directories are normal; links and non-directories remain refusals.
        app.intake.real_dir(root, "preview directory")
        shutil.rmtree(root)

    def discard(job):
        remove_preview(job["id"])
        path = job.get("item")
        if job.get("temporary_item") and job.get("source_id") and path and not any(
                other is not job and (other.get("item") == path or
                    other.get("source_id") == job.get("source_id") and other["state"] in ("queued", "running"))
                for other in jobs.values()):
            if os.path.dirname(os.path.abspath(path)) != ws or not app.intake.inside(path, ws):
                raise app.intake.IntakeError("temporary cache escaped workspace")
            directory, manifest, _ = app.intake.load_item(path)
            if (manifest["import"] is None and manifest["source"].get("kind") == "youtube"
                    and manifest["source"].get("id") == job["source_id"]
                    and os.path.basename(directory).startswith("yt-" + job["source_id"] + "-")):
                targets = [os.path.join(directory, name) for name in os.listdir(directory)]
                for target in targets:
                    app.intake.regular_file(target, "temporary cache file")
                for target in targets:
                    os.chmod(target, 0o600)
                shutil.rmtree(directory)

    def new_job(user, step, m, source_id=None, priority=0, save=True):
        with lock:
            now = time.time()
            for old in list(jobs.values()):
                if old["state"] not in ("queued", "running") and not old.get("analyzing") and now - old.get("accessed", old["created"]) > PREVIEW_TTL:
                    with suppress(OSError, app.intake.IntakeError):
                        discard(old)
                    jobs.pop(old["id"], None)
            if source_id:
                found = next((j for j in jobs.values() if j["owner"] == user and j.get("source_id") == source_id
                              and j["state"] not in ("error", "cancelled") and not j["cancel"].is_set()
                              and j["preview_state"] != "expired"), None)
                if found:
                    found["accessed"] = now
                    found["priority"] = 0 if found.get("current") else priority
                    found["save"] |= save
                    return found
            if len([j for j in jobs.values() if j["state"] in ("queued", "running")]) >= (32 if priority == 0 else 24):
                raise ApiError("The preparation queue is full. Try again shortly.", 429)
            job = {"id": secrets.token_urlsafe(12), "owner": user, "state": "running", "message": STEP_TEXT[step],
                   "artist": m["artist"], "title": m["title"], "phase": step,
                   "preview_state": "unavailable", "assets": set(), "created": time.time(),
                   "source_id": source_id, "priority": priority, "save": save, "meta": m,
                   "cancel": threading.Event(), "publish": threading.Lock(), "current": False}
            jobs[job["id"]] = job
            for k in [k for k, v in jobs.items() if v["state"] not in ("queued", "running") and not v.get("current") and not v.get("analyzing")][:max(0, len(jobs) - MAX_JOBS)]:
                with suppress(OSError, app.intake.IntakeError):
                    discard(jobs[k])
                del jobs[k]
            return job

    def public(job):
        out = {k: job[k] for k in ("id", "state", "message", "artist", "title", "phase", "preview_state")}
        out.update(source_id=job.get("source_id"), priority=job.get("priority", 0), saved=bool(job.get("committed") or job.get("already_saved")))
        if job.get("playback"):
            out["playback"] = job["playback"]
        if job.get("analysis"):
            out["analysis"] = {k: job["analysis"][k] for k in ("bpm", "reliable", "confidence", "reason")
                               if k in job["analysis"]}
        if job["preview_state"] == "ready":
            out["media_url"] = f"/api/jobs/{job['id']}/media/index.m3u8"
        return out

    def source_signature(result):
        intake = app.intake
        path, manifest = result["item"], result["manifest"]
        paths = [ws, path, os.path.join(path, "manifest.json"),
                 os.path.join(path, manifest["audio"]["file"])]
        record = manifest.get("import")
        if record:
            target = os.path.join(lib, *record["path"].split("/"))
            if not intake.inside(target, lib):
                raise intake.IntakeError("library path escaped root")
            paths.append(lib)
            parent = lib
            for part in record["path"].split("/")[:-1]:
                parent = os.path.join(parent, part)
                paths.append(parent)
            paths.append(target)
        if os.path.dirname(path) != ws or not intake.inside(path, ws):
            raise intake.IntakeError("item escaped workspace")
        signature = []
        for name in paths:
            if name in (os.path.join(path, "manifest.json"), os.path.join(path, manifest["audio"]["file"])) or (record and name == target):
                st = intake.regular_file(name, "cached audio or manifest")
            else:
                intake.real_dir(name, "cached directory")
                st = os.stat(name)
                signature.append((st.st_dev, st.st_ino))
                continue
            signature.append((st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns))
        return tuple(signature)

    def saved_source(source_id, imported=True):
        key = (source_id, imported)
        with saved_lock:
            cached = saved_cache.get(key)
            if cached:
                result, signature = cached
                try:
                    if source_signature(result) == signature:
                        saved_cache.move_to_end(key)
                        return result
                except (OSError, app.intake.IntakeError):
                    pass
                del saved_cache[key]
            entry = validate_source(source_id, imported)
            if entry:
                saved_cache[key] = entry
                while len(saved_cache) > MAX_VERIFIED_SOURCES:
                    saved_cache.popitem(last=False)
                return entry[0]

    def validate_source(source_id, imported):
        # Manifests remain the catalogue. Never infer recording identity from a title.
        for name in os.listdir(ws):
            if not app.intake.ID_RE.fullmatch(name) or not (name.startswith("yt-" + source_id + "-") or name == source_id and name.startswith("local-")):
                continue
            try:
                path, manifest, audio = app.intake.load_item(os.path.join(ws, name))
                if manifest["edit"] is not None or not ((manifest["source"].get("kind") == "youtube" and manifest["source"].get("id") == source_id) or (manifest["source"].get("kind") == "local" and manifest["id"] == source_id)):
                    continue
                record = manifest.get("import")
                if not imported and record:
                    continue
                if imported:
                    if not record:
                        continue
                    target = os.path.join(lib, *record["path"].split("/"))
                    parent = os.path.dirname(target)
                    while parent != os.path.abspath(lib):
                        app.intake.real_dir(parent, "library directory")
                        parent = os.path.dirname(parent)
                    app.intake.regular_file(target, "library audio")
                    if not app.intake.inside(target, lib):
                        continue
                result = {"item": path, "manifest": manifest, "existing": True}
                signature = source_signature(result)
                # Refuse a cache entry if any input changed during hashing.
                _, checked, _ = app.intake.load_item(path)
                if imported and app.intake.sha256_file(target) != record["library_sha256"]:
                    continue
                if checked != manifest or signature != source_signature(result):
                    continue
                return result, signature
            except (app.intake.IntakeError, OSError):
                continue

    class PlaybackYield(Exception):
        pass

    listening_stats = ListeningStats(ws)
    def playback_demand():
        # Listening to an available recording needs no preparation capacity.
        with lock:
            return any(j['state'] in ('queued','running')
                       and not (j.get('cancel') and j['cancel'].is_set())
                       and (not j.get('playlist_import') or j.get('current'))
                       and not j.get('search_preview')
                       and (j.get('current') or j.get('priority',20) <= 1)
                       for j in jobs.values())

    @app.post("/api/playback/activity")
    def playback_activity():
        data = body(65536)
        device = data.get("device_id")
        if not isinstance(device, str) or not re.fullmatch(r"[a-f0-9]{32}", device) or type(data.get("playing")) is not bool:
            raise ApiError("Invalid playback activity.", 400)
        track = data.get("track")
        if track is not None:
            if not isinstance(track, dict) or any(not isinstance(track.get(key), str) or len(track[key]) > limit or any(ord(c) < 32 for c in track[key]) for key, limit in (("id", 128), ("title", 500), ("channel", 300))):
                raise ApiError("Invalid current song.")
            track = {key: track[key] for key in ("id", "title", "channel")}
        counters = data.get("counters")
        if counters is not None:
            try: listening_stats.sync(g.user, data.get("counter_device_id") or device, counters)
            except ValueError as error: raise ApiError(str(error), 400)
        try: listening_stats.heartbeat(g.user, device, data["playing"], count_time=counters is None, track=track)
        except ValueError as error: raise ApiError(str(error), 429)
        # The same check-in lists this device for "Connect to a device" and collects a transfer sent to it.
        command, controls = playback_devices.report(g.user, device, data.get("device_info"), data["playing"], track, data.get("position"))
        return jsonify(ok=True, counters_accepted=counters is not None, command=command, controls=controls)

    @app.get("/api/server/stats")
    def server_stats():
        profiles = profile_store.list() if family_mode else [dict(id=u, name=u) for u in cfg["ALLOWED_USERS"]]
        result = listening_stats.snapshot(profiles, profile_store.subscription_history() if family_mode else None)
        names = {p["id"]: p["name"] for p in profiles}
        disk = shutil.disk_usage(lib)
        with lock:
            result.update(catalogue_paused=playback_demand(), storage_total_bytes=disk.total, storage_free_bytes=disk.free,
                jobs=[dict(title=j["title"], owner=j["owner"], user=names.get(j["owner"], j["owner"]),
                           kind="listening" if j.get("current") else "upload" if j.get("read_local_tags") else "recording",
                           phase="Waiting for playback preparation" if j["state"] == "queued" and j.get("playlist_import") and playback_demand() else ("Purifying audio" if j.get("phase") == "prepare" else j.get("message", j.get("phase", ""))),
                           state=j["state"], download_bytes=j.get("download_bytes", 0), download_total_bytes=j.get("download_total_bytes"))
                      for j in jobs.values() if j["state"] in ("queued", "running") and (not j.get("playlist_id") or j.get("current"))])
        result["jobs"] += [{**row, "user": names.get(row["owner"],row["owner"])} for row in playlist_preparation.work()]
        tagging = catalogue_review.progress() if metadata_lookup else None
        if tagging:
            paused = playback_demand()
            result["jobs"].append(dict(title="Song tagging", owner="", user="", kind="tagging", state="queued" if paused else "running",
                phase="Paused while a song is prepared" if paused else "Looking up tags on MusicBrainz",
                processed=tagging["processed"], total=tagging["total"], remaining=tagging["remaining"],
                current_title=tagging["current_title"], download_bytes=0, download_total_bytes=None))
        result['workers'] = worker_snapshot(names, tagging, result['jobs'])
        return jsonify(result)

    def worker_snapshot(names, tagging, work):
        paused = playback_demand()
        rows = []
        with lock:
            for i, entry in enumerate(acquisition_slots):
                row = dict(id=f'acquisition-{i}', title=f'Acquisition / preparation {i + 1}',
                           state='idle', current_title='', waiting_for='A recording request')
                if entry is not None:
                    job, analyzing = entry
                    total, received = job.get('download_total_bytes'), job.get('download_bytes', 0)
                    row.update(state='working', current_title=job['title'], owner=job['owner'],
                               phase='Beat analysis' if analyzing else job.get('message', job.get('phase', '')),
                               progress=min(100, max(0, 100 * received / total)) if total and not analyzing and job.get('phase') == 'fetch' else None,
                               waiting_for='Playback preparation' if analyzing and paused else '')
                rows.append(row)
        rows += playlist_preparation.activity.snapshot(paused, 'Playback preparation' if paused else 'Playlist work')
        for row in rows:
            if not row.get('playlist_id'):
                continue
            operation = next((job for job in work if job.get('playlist_id') == row['playlist_id'] and job.get('owner') == row['owner']), None)
            if operation:
                file = next((file for file in operation.get('files', []) if file['title'] == row['current_title']), operation)
                row['phase'] = file.get('message', operation.get('phase', ''))
                if row['phase'].startswith('Waiting'):
                    row.update(state='paused', waiting_for=row['phase'].removeprefix('Waiting for '))
                if file.get('file_phase') == 'downloading' and file.get('download_total_bytes'):
                    row['progress'] = min(100, max(0, 100 * file.get('download_bytes', 0) / file['download_total_bytes']))
        rows += finished_audio_activity.snapshot(waiting_for='A recording to prepare')
        rows += mobile_audio.background_activity.snapshot(waiting_for='A recording needing an Opus copy')
        rows += mobile_audio.listening_activity.snapshot(waiting_for='A listening request needing an Opus copy')
        source = app.extensions['music'].source_quality
        if cfg.get('SOURCE_QUALITY_SCAN', cfg['PUBLIC_ORIGIN'] != 'https://music.test'):
            rows += source.activity.snapshot(paused, 'Playback preparation' if paused else 'Next library scan')
        rows += source.replacement_activity.snapshot(paused and source.replace_lock.locked(),
                    'Playback preparation' if paused and source.replace_lock.locked() else 'A source replacement request')
        if cfg.get('SONG_ANALYSIS_SCAN', cfg['PUBLIC_ORIGIN'] != 'https://music.test'):
            idle = song_analysis_idle()
            rows += song_analysis.activity.snapshot(not idle, 'Acquisition and source-quality decoder' if not idle else 'Next library scan')
        if metadata_lookup:
            row = dict(id='tagging-0', title='Metadata tagging', state='idle', current_title='', waiting_for='Songs needing tags')
            if tagging:
                row.update(state='working' if tagging['current_title'] else 'paused' if paused or tagging['waiting'] == tagging['remaining'] else 'idle',
                           current_title=tagging['current_title'],
                           progress=100 * tagging['processed'] / tagging['total'] if tagging['total'] else None,
                           waiting_for='' if tagging['current_title'] else 'Playback preparation' if paused else 'MusicBrainz retry / next lookup')
            rows.append(row)
        if genre_labels.enabled:
            with genre_labels.lock:
                artist = genre_labels.pending[0] if genre_labels.pending else ''
            rows.append(dict(id='genre-0', title='Artist genres', current_title=artist,
                             state='working' if artist else 'idle', waiting_for='MusicBrainz lookup / rate limit' if artist else 'An artist needing a genre'))
        if automatic_downloads or metadata_lookup:
            rows += automatic_activity.snapshot(waiting_for='Next playlist queue check')
        for row in rows:
            if row.get('owner'):
                row['user'] = names.get(row['owner'], row['owner'])
        return rows

    def background_download(j):
        return j.get("playlist_import") and not j.get("current") and not j.get("analyzing")

    def yields_to_listener(job):
        # A listener's song pauses exactly one background playlist download: the one with
        # the least progress, so the least work is repeated. The others keep running.
        if not background_download(job) or not playback_demand():
            return False
        if job.get('source_replacement'):
            return True
        with lock:
            if any(j.get("yielded") and j["state"] == "queued" and not j["cancel"].is_set() for j in jobs.values()):
                return False
            running = [j for j in jobs.values() if j["state"] == "running" and background_download(j) and not j["cancel"].is_set()]
            victim = min(running, key=lambda j: (j.get("download_bytes") or 0, -j["created"]), default=None)
            if victim is not job:
                return False
            job["yielded"] = True
            return True

    def job_budget(job):
        if yields_to_listener(job):
            raise PlaybackYield()
        budget()

    def budget():
        with budget_lock:
            now = time.monotonic()
            if now - budget_cache["at"] >= .5:
                budget_cache.update(at=now, size=scratch_size(ws, lib, app.intake))
            size = budget_cache["size"]
        # Reserve headroom for eight acquisitions between full workspace scans.
        if size > MAX_CACHE_BYTES - (256 << 20) or shutil.disk_usage(ws).free < MIN_FREE_BYTES:
            raise app.intake.IntakeError("scratch capacity exceeded")

    def download_progress(job, **fields):
        # Account for new spool bytes between scans; a concurrent scan may count
        # these bytes twice temporarily, which conservatively reduces admission.
        with budget_lock:
            budget_cache["size"] += max(0, fields.get("download_bytes", 0) - job.get("download_bytes", 0))
            job.update(fields)

    def publish_assets(job):
        if job.get("preview_failed"):
            return
        root = os.path.join(ws, ".preview-" + job["id"])
        try:
            app.intake.real_dir(root, "preview")
            playlist = os.path.join(root, "index.m3u8")
            app.intake.regular_file(playlist, "playlist")
            with open(playlist, encoding="utf-8") as fh:
                text = fh.read(1 << 20)
            names = {"index.m3u8", "init.mp4"} | set(re.findall(r"^seg\d{5}\.m4s$", text, re.M))
            if not any(n.startswith("seg") for n in names):
                return
            for name in names:
                app.intake.regular_file(os.path.join(root, name), "asset")
            with lock:
                job["assets"].update(names)
                job["preview_state"] = "ready"
                cached = [j for j in jobs.values() if j["preview_state"] == "ready"]
                victims = preview_victims(cached, job)
                for old in victims[:max(0, len(cached) - MAX_PREVIEWS)]:
                    remove_preview(old["id"])
                    old["assets"].clear()
                    old["preview_state"] = "expired"
        except (OSError, app.intake.IntakeError):
            pass

    def settle(job, state, message):
        with lock:
            job["state"], job["message"] = state, message
            if state in ("done", "error"):
                job["phase"] = state

    def work(job, url, tmp, m):
        step, intake, outcome = "fetch" if url else "stage", app.intake, ("done", DONE_TEXT)
        intake.CONTROL.cancel = job["cancel"]
        # Background work runs at lower CPU priority so a listener's song is served first.
        intake.CONTROL.background = analyzing_job(job)
        intake.CONTROL.budget = lambda: job_budget(job)
        intake.CONTROL.publish = job["publish"]
        intake.CONTROL.committed = lambda: job.update(committed=True)
        try:
            job_budget(job)
            if url:
                item = saved_source(job["source_id"]) if job.get("source_id") else None
                if not item and job.get("source_id"):
                    item = saved_source(job["source_id"], imported=False)
                if not item and job.get("item"):
                    path, manifest, _ = intake.load_item(job["item"])
                    item = {"item": path, "manifest": manifest}
                if not item:
                    item = intake.cmd_fetch(SimpleNamespace(url=url, workspace=ws,
                        preview=os.path.join(ws, ".preview-" + job["id"]), cancel=job["cancel"],
                        notify=lambda: publish_assets(job), budget=lambda: job_budget(job),
                        progress=lambda **fields: download_progress(job, **fields),
                        preview_failed=lambda: job.update(preview_state="unavailable", preview_failed=True)))
                job["item"] = item["item"]
                job["already_saved"] = bool(item.get("manifest", {}).get("import"))
                job["playback"] = profile(intake, item["item"], item.get("manifest", {}))
                source = item.get("manifest", {}).get("source", {})
                with lock:
                    if job.get("automatic_meta") and source.get("title"):
                        m = meta({"artist": (source.get("artist") or source.get("channel") or "YouTube").removesuffix(" - Topic")[:120],
                                  "title": (source.get("track_title") or source["title"])[:120], "album": (source.get("album") or "Selected recordings")[:120]})
                        job.update(meta=m, artist=m["artist"], title=m["title"])
                if not job["save"] and (not item.get("existing", False) or any(
                        j.get("temporary_item") and j.get("item") == item["item"] for j in jobs.values())):
                    job["temporary_item"] = True
            else:
                item = intake.cmd_stage(SimpleNamespace(file=tmp, workspace=ws))
                manifest = item.get("manifest", {})
                if manifest.get("source", {}).get("kind") == "local": job["source_id"] = manifest["id"]
                if job.get("read_local_tags") and manifest.get("import"):
                    m = meta(manifest["import"]); job.update(meta=m, artist=m["artist"], title=m["title"], local_existing=True, already_saved=True)
                elif job.get("read_local_tags"):
                    _, _, audio = intake.load_item(item["item"])
                    tags = intake.probe(audio, tags=True).get("tags", {})
                    fields = job["local_fields"]
                    fallback = job["meta"]
                    values = {}
                    for key in ("artist", "album", "title"):
                        value = fields.get(key) or tags.get(key) or fallback[key]
                        value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', ' ', str(value)).strip()[:120]
                        try: intake.safe_name(value, key)
                        except intake.IntakeError: value = fallback[key]
                        values[key] = value
                    m = meta(values)
                    job.update(meta=m, artist=m["artist"], title=m["title"])

            if url and job["preview_state"] != "ready":
                root = os.path.join(ws, ".preview-" + job["id"])
                try:
                    with lock:
                        ready_count = sum(j["preview_state"] == "ready" for j in jobs.values())
                        cached = preview_victims(jobs.values(), job)
                        for old in cached[:max(0, ready_count - MAX_PREVIEWS + 1)]:
                            with suppress(OSError):
                                remove_preview(old["id"])
                            old["assets"].clear()
                            old["preview_state"] = "expired"
                    preview = intake.cmd_preview(SimpleNamespace(item=item["item"], output=root,
                        notify=lambda: publish_assets(job)))
                    with lock:
                        job["assets"].update(preview["assets"])
                        job["preview_state"] = "ready"
                except Exception as e:
                    log.warning("preview for job %s failed: %s", job["id"], type(e).__name__)
                    job["preview_state"] = "unavailable"
            if url and job["save"] and "gain_db" not in job.get("playback", {}):
                try:
                    job["playback"] = profile(intake, item["item"], item.get("manifest", {}), measure=True)
                except (ValueError, OSError, intake.IntakeError):
                    pass  # Measurement failure must not discard playable audio.
            step = "import"
            job["phase"] = step
            settle(job, "running", STEP_TEXT[step])
            if job["cancel"].is_set():
                raise intake.IntakeError("cancelled")
            if job["save"]:
                record = item.get("manifest", {}).get("import")
                if record:
                    with job["publish"]:
                        job.update(artist=record["artist"], title=record["title"])
                        job["committed"] = True
                else:
                    with job["publish"], lock:
                        job["metadata_locked"] = True
                        m = job["meta"]
                        job.update(artist=m["artist"], title=m["title"])
                    with import_lock:
                        job_budget(job)
                        if not job.get("local_existing"): intake.cmd_import(SimpleNamespace(item=item["item"], library=lib, **m))
                job["committed"] = True
                job["temporary_item"] = False
                step = "prepare"
                job["phase"] = step
                settle(job, "running", STEP_TEXT[step])
                prepare_record(finished_audio, listening_versions, lib, item["item"])
            else:
                outcome = ("done", "Prepared")
            if url and os.path.isdir(item["item"]) and not job.get("analysis"):
                job["analysis_state"] = "pending"
        except PlaybackYield:
            # Interrupted progressive downloads own an incomplete preview directory.
            # It must be discarded before retrying the same supervised acquisition.
            with suppress(OSError, intake.IntakeError):
                remove_preview(job["id"])
            job["assets"].clear()
            job.update(state="queued", message="Paused so a listener's song goes first", phase="queued",
                       preview_state="pending", download_bytes=0, download_total_bytes=None)
            intake.CONTROL.cancel = None
            intake.CONTROL.background = False
            intake.CONTROL.budget = None
            intake.CONTROL.publish = None
            intake.CONTROL.committed = None
            return
        except Exception as e:  # the browser gets a fixed message; the log keeps only a known reason, never URLs or paths
            reason = upload_failure(e) if isinstance(e, intake.IntakeError) else None
            log.warning("job %s failed at %s: %s%s", job["id"], step, type(e).__name__, f" ({reason[0]})" if reason else "")
            outcome = (("cancelled", "Cancelled") if job["cancel"].is_set() and not job.get("committed") else
                       ("error", FAIL_TEXT[step] if isinstance(e, intake.IntakeError) or step == "prepare" else "Import failed unexpectedly."))
            if outcome[0] == "error" and reason and step == "stage":
                outcome = ("error", reason[1])
            if str(e) == "scratch capacity exceeded":
                outcome = ("error", "The server needs more processing space. Ask the server owner to free space.")
        if tmp:
            with suppress(OSError):
                os.unlink(tmp)  # only the temp file this request created; removed before the job reports its result
        if outcome[0] == "cancelled" or (outcome[0] == "error" and step == "fetch"):
            with suppress(OSError, intake.IntakeError):
                remove_preview(job["id"])
            job["assets"].clear()
            job["preview_state"] = "expired"
        settle(job, *outcome)
        intake.CONTROL.cancel = None
        intake.CONTROL.background = False
        intake.CONTROL.budget = None
        intake.CONTROL.publish = None
        intake.CONTROL.committed = None

    def analyze_job(job):
        intake = app.intake
        wav = os.path.join(ws, ".preview-" + job["id"], "analysis.wav")
        intake.CONTROL.cancel = job["cancel"]
        # Background work runs at lower CPU priority so a listener's song is served first.
        intake.CONTROL.background = analyzing_job(job)
        def analysis_budget():
            if playback_demand(): raise PlaybackYield()
            budget()
        intake.CONTROL.budget = analysis_budget
        retry = False
        try:
            analysis_budget()
            _, manifest, audio = intake.load_item(job["item"])
            if "gain_db" not in job.get("playback", {}):
                try:
                    job["playback"] = profile(intake, job["item"], manifest, measure=True)
                except (ValueError, OSError, intake.IntakeError):
                    pass
            if manifest["audio"]["duration"] > 600:
                job["analysis"] = {"reliable": False, "reason": "Beat analysis is limited to ten minutes"}
                return
            rc, _, _ = intake.run([intake.tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-i", audio,
                "-ac", "1", "-ar", "22050", wav], 60, "analysis decode")
            if rc:
                raise intake.IntakeError("analysis decode failed")
            rc, data, _ = intake.run([sys.executable, "-m", "music_web.analysis", wav], 120, "beat analysis", True)
            if rc:
                raise intake.IntakeError("analysis failed")
            job["analysis"] = json.loads(data)
        except PlaybackYield:
            retry = True
        except (intake.IntakeError, ValueError, OSError):
            job["analysis"] = {"reliable": False, "reason": "Beat analysis unavailable"}
        finally:
            with suppress(OSError):
                os.unlink(wav)
            with lock:
                job.update(analysis_state="pending" if retry else "done", analyzing=False)
            intake.CONTROL.cancel = None
            intake.CONTROL.background = False
            intake.CONTROL.budget = None

    def analyzing_job(job):
        # True for work nobody is waiting on: beat analysis and background playlist songs.
        return bool(job.get("analyzing")) or not foreground(job)

    # Background work (playlist songs, analysis) scales with the server's cores, leaving half of
    # them for songs someone is waiting to hear; never fewer than eight slots in total.
    background_workers = cfg.get("BACKGROUND_WORKERS") or (3 if cfg["PUBLIC_ORIGIN"] == "https://music.test" else max(2, min(8, (os.cpu_count() or 4) // 2)))
    workers = max(8, background_workers + 4)
    acquisition_slots = [None] * workers

    def foreground(job, analyzing=False):
        return not analyzing and job["priority"] == 0 and (not job.get("playlist_import") or job.get("current"))

    def drain():
        with worker_lock, ThreadPoolExecutor(max_workers=workers, thread_name_prefix="music-acquire") as pool:
            active, last_served = {}, {}
            dispatch_number = 0
            while True:
                with lock:
                    for future in list(active):
                        if future.done():
                            job, analyzing, slot = active.pop(future)
                            acquisition_slots[slot] = None
                            if future.exception() is not None:
                                log.warning("job %s worker failed: %s", job["id"], type(future.exception()).__name__)
                                if analyzing:
                                    job.update(analysis_state="done", analyzing=False)
                                else:
                                    settle(job, "error", "Recording preparation failed.")
                    # Optional beat analysis reads a published recording and owns
                    # its own WAV; it must not delay another listener's playback.
                    sources = {job.get("source_id") for job, analyzing, _ in active.values()
                               if job.get("source_id") and not analyzing}
                    background = sum(not foreground(job, analyzing) for job, analyzing, _ in active.values())
                    pending = [(j, False) for j in jobs.values() if j["state"] == "queued"
                               and not j["cancel"].is_set() and j.get("source_id") not in sources]
                    pending += [(j, True) for j in jobs.values() if j["state"] == "done"
                                and j.get("analysis_state") == "pending" and not j.get("analyzing")
                                and not j["cancel"].is_set() and j.get("source_id") not in sources]
                    listening = playback_demand()
                    pending = [(j, a) for j, a in pending
                               if (background < background_workers or foreground(j,a))
                               and (not listening or (not a and (not j.get("playlist_import") or j.get("current"))))]
                    if pending and len(active) < workers:
                        job, analyzing = min(pending, key=lambda pair: (
                            pair[0]["priority"] + (20 if pair[1] else 0),
                            last_served.get((pair[0]["priority"] + (20 if pair[1] else 0), pair[0]["owner"], pair[0].get("playlist_id")), -1),
                            pair[0]["created"]))
                        dispatch_number += 1
                        last_served[(job["priority"] + (20 if analyzing else 0), job["owner"], job.get("playlist_id"))] = dispatch_number
                        if analyzing:
                            job["analyzing"] = True
                            future = pool.submit(analyze_job, job)
                        else:
                            job["state"] = "running"; job.pop("yielded", None)
                            future = pool.submit(work, job, job.get("url"), job.get("tmp"), job["meta"])
                        slot = acquisition_slots.index(None)
                        acquisition_slots[slot] = (job, analyzing)
                        active[future] = (job, analyzing, slot)
                        continue
                    if not active and not any(not j["cancel"].is_set() and
                            (j["state"] == "queued" or j.get("analysis_state") == "pending") for j in jobs.values()):
                        app.extensions["music"].worker = None
                        return
                # A short wait also admits newly queued foreground playback promptly.
                if active: wait(active, timeout=.05, return_when=FIRST_COMPLETED)
                else: time.sleep(.1)

    def start(job, url, tmp, m):
        with lock:
            if "url" not in job:
                job.update(url=url, tmp=tmp, state="queued")
        # Only one drain thread waits for work; no thread per queued recording.
        with lock:
            thread = app.extensions["music"].__dict__.get("worker")
            if not thread or not thread.is_alive():
                thread = threading.Thread(target=drain, daemon=True)
                app.extensions["music"].worker = thread
                thread.start()
        return jsonify(job=public(job)), 202

    playlist_store = PlaylistStore(ws)
    playlist_artwork = PlaylistArtwork(ws)

    @app.errorhandler(ArtworkError)
    def playlist_artwork_error(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(PlaylistError)
    def playlist_error(error):
        return jsonify(error=str(error)), 400

    def visible_playlist(playlist, owner):
        playlist = dict(playlist)
        if re.fullmatch(r'[0-9a-f]{64}', playlist.get('cover_sha256', '')):
            playlist['cover_url'] = f"/api/playlists/{urllib.parse.quote(owner, safe='')}/{playlist['id']}/artwork/{playlist['cover_sha256']}.jpg"
        if not family_mode:
            return playlist
        profile = profile_store.get(owner)
        return {**playlist, "owner_id": owner, "owner_name": profile["name"],
                "can_edit": owner == g.user or g.user in playlist.get("co_authors", []), "can_manage_authors": owner == g.user, "can_delete": g.user in cfg["ADMIN_USERS"], "shared": playlist.get("shared", False)}

    @app.get('/api/playlists/<owner>/<pid>/artwork/<digest>.jpg')
    def playlist_cover(owner, pid, digest):
        if not re.fullmatch(r'[0-9a-f]{64}', digest):
            abort(404)
        with lock:
            playlist = playlist_store.read(owner, pid)
            if owner != g.user and not (family_mode and (playlist.get('shared') is True or g.user in playlist.get('co_authors', []) or g.user in cfg['ADMIN_USERS'])):
                abort(403)
            if playlist.get('cover_sha256') != digest:
                abort(404)
        return send_file(playlist_artwork.path(owner, pid, digest), mimetype='image/jpeg',
                         conditional=True, etag=digest, max_age=86400)

    @app.get("/api/playlists")
    def list_playlists():
        available = {}
        for recording in library_tracks():
            key = (normalized(recording["title"]), normalized(recording["channel"].split(",")[0]))
            available.setdefault(key, []).append(recording)
        with lock:
            playlists = playlist_store.list(g.user)
            for playlist in playlists:
                for track in playlist["tracks"]:
                    if not track.get("source_id") and not track.get("match"):
                        key = (normalized(track["title"]), normalized(track["artist"].split(",")[0]))
                        matches = [r for r in available.get(key, []) if duration_matches(track, r)]
                        if len(matches) == 1:
                            track.update(source_id=matches[0]["id"], match=matches[0], state="saved")
                    job = jobs.get(track.get("job_id"))
                    if job and job["owner"] == g.user:
                        track["state"] = "saved" if job["state"] == "done" and (job.get("committed") or job.get("already_saved")) else job["state"]
                    elif track.get("match") and (stored := saved_source(track["match"]["id"])):
                        try:
                            library_record(stored)
                            track["state"] = "saved"
                        except ApiError as error:
                            if error.code != 503: raise
                            track["state"] = "preparing"
                    elif track.get("state") in ("queued", "running"):
                        track["state"] = "ready"
                playlist_store.save(g.user, playlist)
            if family_mode:
                playlists = [visible_playlist(playlist, g.user) for playlist in playlists]
                for profile in profile_store.list():
                    if profile["id"] != g.user:
                        playlists.extend(visible_playlist(playlist, profile["id"])
                                         for playlist in playlist_store.list(profile["id"]) if playlist.get("shared") is True or g.user in playlist.get("co_authors", []) or g.user in cfg["ADMIN_USERS"])
        return jsonify(playlists=playlists)

    @app.post("/api/playlists/spotify")
    @app.post("/api/playlists/youtube")
    def preview_spotify():
        if not allow("playlist-import:" + g.user, 10, 60):
            raise ApiError("Wait a minute before importing another playlist.", 429)
        data = body()
        target = data.get("target_id")
        if target is not None:
            with lock:
                existing = playlist_store.read(g.user, target)
                if playlist_preparation.is_active(g.user, target):
                    raise ApiError("Wait for this playlist operation to finish.", 409)
                if existing["tracks"] or data.get("revision") != existing["revision"]:
                    raise ApiError("Import into an empty, unchanged playlist.", 409)
        playlist = (fetch_youtube_playlist(data.get("url"), app.intake) if request.path.endswith("/youtube")
                    else fetch_playlist(data.get("url")))
        with lock:
            if target is not None:
                existing = playlist_store.read(g.user, target)
                if playlist_preparation.is_active(g.user, target):
                    raise ApiError("Wait for this playlist operation to finish.", 409)
                if existing["tracks"] or data.get("revision") != existing["revision"]:
                    raise ApiError("This playlist changed while importing. Try again.", 409)
                playlist["id"] = target
            if playlist_preparation.is_active(g.user, playlist["id"]):
                raise ApiError("Wait for this playlist operation to finish.", 409)
            playlist = playlist_store.import_playlist(g.user, playlist)
        return jsonify(playlist=visible_playlist(playlist, g.user))

    def playlist_name(value):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 200 or any(ord(c) < 32 for c in value):
            raise ApiError("Enter a playlist name of 1 to 200 characters.")
        return value.strip()

    @app.post("/api/playlists")
    def create_playlist():
        name = playlist_name(body().get("name"))
        with lock:
            if len(playlist_store.list(g.user)) >= 100:
                raise ApiError("You can save up to 100 playlists.")
            pid = "".join(secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") for _ in range(22))
            playlist = {"id": pid, "name": name, "revision": 1, "tracks": [], "notice": "", "url": "", "shared": True}
            playlist_store.save(g.user, playlist)
        return jsonify(playlist=visible_playlist(playlist, g.user)), 201

    @app.post("/api/radio")
    def start_radio():
        # "<song> Radio" or "<artist> Radio": a new playlist of similar songs that is matched
        # and downloaded like an imported playlist.
        data = body(4096)
        artist, title = data.get("artist"), data.get("title", "")
        if not isinstance(artist, str) or not isinstance(title, str): raise ApiError("Choose a song or an artist for the radio.")
        if not allow("radio:" + g.user, 10, 60): raise ApiError("Wait a minute before starting another radio.", 429)
        try: url, name = radio.seed(artist, title)
        except (OSError, ValueError): raise ApiError("Radio is unavailable right now. Try again later.", 503)
        with lock:
            if len(playlist_store.list(g.user)) >= 100:
                raise ApiError("You can save up to 100 playlists.")
            pid = "".join(secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") for _ in range(22))
            playlist = {"id": pid, "name": name[:200], "revision": 1, "tracks": [], "notice": "", "url": "", "shared": True,
                        "description": "Songs like " + name.removesuffix(" Radio")[:180], "radio": True}
            playlist_store.save(g.user, playlist)
        try: playlist_preparation.begin_import(g.user, pid, 1, "radio", url, True, name[:200])
        except ValueError as error: raise ApiError(str(error), 409)
        return jsonify(playlist=visible_playlist(playlist_store.read(g.user, pid), g.user)), 201

    @app.route("/api/playlists/<pid>", methods=["PATCH", "DELETE"])
    def edit_playlist(pid):
        data = body(751024 if request.method == "PATCH" else 8192)
        owner = data.get("owner_id", g.user)
        if request.method == "DELETE" and family_mode and g.user not in cfg["ADMIN_USERS"]:
            raise ApiError("Only an admin can delete playlists.", 403)
        with lock:
            if family_mode: profile_store.get(owner)
            playlist = playlist_store.read(owner, pid)
            operation = set(data) - {"revision", "owner_id"}
            if owner != g.user:
                allowed = (request.method == "DELETE" and g.user in cfg["ADMIN_USERS"]) or (request.method == "PATCH" and g.user in playlist.get("co_authors", []) and operation not in ({"shared"}, {"co_authors"}))
                if not allowed:
                    raise ApiError("Only the owner or a co-author can edit this playlist.", 403)
            sharing_only = request.method == "PATCH" and operation in ({"shared"}, {"co_authors"})
            if playlist_preparation.is_active(owner, pid) and not sharing_only:
                raise ApiError("Pause playlist preparation before editing this playlist.", 409)
            if type(data.get("revision")) is not int or data["revision"] != playlist["revision"]:
                raise ApiError("This playlist changed. Refresh it before editing.", 409)
            if request.method == "DELETE":
                playlist_store.delete(owner, pid)
                return jsonify(deleted=True)
            operation = set(data) - {"revision", "owner_id"}
            tracks = playlist["tracks"]
            if operation == {"details"}:
                details = data["details"]
                if not isinstance(details, dict) or not details or set(details) - {"name", "description", "shared", "cover_image"}:
                    raise ApiError("Choose valid playlist details.")
                name = playlist_name(details.get("name", playlist["name"]))
                description = details.get("description", playlist.get("description", ""))
                if not isinstance(description, str) or len(description) > 2000 or any(ord(c) < 32 and c not in "\n\r\t" for c in description):
                    raise ApiError("Description can contain up to 2,000 characters.")
                if "shared" in details:
                    if owner != g.user: raise ApiError("Only the owner can change sharing.", 403)
                    if type(details["shared"]) is not bool: raise ApiError("Shared must be true or false.")
                digest = playlist_artwork.save(owner, pid, details["cover_image"]) if "cover_image" in details else None
                playlist.update(name=name, description=description)
                if "shared" in details: playlist["shared"] = details["shared"]
                if digest: playlist["cover_sha256"] = digest
            elif operation == {"name"}:
                playlist["name"] = playlist_name(data["name"])
            elif operation == {"cover_image"}:
                playlist['cover_sha256'] = playlist_artwork.save(owner, pid, data['cover_image'])
            elif operation == {"co_authors"}:
                require_family()
                authors = data["co_authors"]
                if not isinstance(authors, list) or len(authors) > 100 or any(not isinstance(a, str) for a in authors):
                    raise ApiError("Choose valid co-authors.")
                for author in authors:
                    profile_store.get(author)
                playlist["co_authors"] = list(dict.fromkeys(a for a in authors if a != owner))
            elif operation == {"shared"}:
                require_family()
                if type(data["shared"]) is not bool:
                    raise ApiError("Shared must be true or false.")
                playlist["shared"] = data["shared"]
            elif operation == {"add_source_id"}:
                if len(tracks) >= 10000:
                    raise ApiError("A playlist can contain up to 10,000 entries.")
                source_id = data["add_source_id"]
                if not isinstance(source_id, str) or not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id):
                    raise ApiError("Invalid recording.")
                item = saved_source(source_id)
                if not item:
                    raise ApiError("Save this recording to the server library first.", 404)
                track, _ = library_record(item)
                tracks.append({"added_at": datetime.now(timezone.utc).isoformat(), "added_by": g.user, "album": track.get("library_album", ""), "title": track["title"], "artist": track["channel"], "duration": track["duration"],
                               "source_id": source_id, "spotify_uri": "", "match": track,
                               "candidates": [track], "state": "saved"})
            elif operation in ({"remove_index"}, {"move_from", "move_to"}):
                if any(type(data[key]) is not int or not 0 <= data[key] < len(tracks) for key in operation):
                    raise ApiError("Invalid playlist entry.")
                if "remove_index" in data:
                    tracks.pop(data["remove_index"])
                else:
                    tracks.insert(data["move_to"], tracks.pop(data["move_from"]))
            else:
                raise ApiError("Choose one playlist change at a time.")
            previous_revision = playlist["revision"]
            playlist["revision"] += 1
            if sharing_only and playlist.get("preparation", {}).get("playlist_revision") == previous_revision:
                playlist["preparation"]["playlist_revision"] = playlist["revision"]
            playlist_store.save(owner, playlist)
            return jsonify(playlist=visible_playlist(playlist, owner))

    def match_playlist_recording(user, track, progress):
        source = track.get("source_id") or (track.get("match") or {}).get("id")
        if source:
            existing = saved_source(source)
            if existing:
                try: return library_record(existing)[0]
                except ApiError as error:
                    if error.code != 503: raise
            if track.get("match"):
                return track["match"]
        ready = preferred_match(rank_matches(track, library_tracks()))
        if ready is not None:
            return library_record(saved_source(ready["id"]))[0]
        # Re-evaluate persisted choices before making another network request.
        if track.get("candidates"):
            track["candidates"] = rank_matches(track, track["candidates"], search=app.intake.cmd_search)
            cached = preferred_match(track["candidates"])
            if cached is not None:
                return cached
        progress("Searching YouTube")
        query = (track["artist"].split(",")[0] + " " + track["title"])[:200]
        found = app.intake.cmd_search(SimpleNamespace(query=query, limit=30, offset=0))["results"]
        track["candidates"] = rank_matches(track, found, search=app.intake.cmd_search)
        return preferred_match(track["candidates"])

    def prepare_playlist_recording(user, track, progress):
        with app.app_context():
            g.user = user
            row = match_playlist_recording(user, track, progress)
            if row is None: return None
            source = app.intake.video_id(row["url"])
            existing = saved_source(source)
            if existing:
                try: return library_record(existing)[0]
                except ApiError as error:
                    if error.code != 503: raise
            metadata = fetch_metadata(row, source)
            with lock:
                job = new_job(user, "fetch", metadata, source, 20, True)
                job["playlist_import"] = True
                if getattr(progress, 'source_replacement', False):
                    job['source_replacement'] = True
                job["playlist_id"] = getattr(progress,"playlist_id",None)
                job.setdefault("automatic_meta", True)
                if job["state"] == "done": job.update(state="queued", message=STEP_TEXT["import"])
            start(job, app.intake.WATCH + source, None, metadata)
            last_progress = None
            while job["state"] in ("queued", "running"):
                message = "Purifying audio" if job.get("phase") == "prepare" else job.get("message", "Preparing recording")
                fields = {"file_phase": "queued" if job["state"] == "queued" else ("downloading" if job.get("phase") == "fetch" else "purifying"),
                          "download_bytes": job.get("download_bytes", 0),
                          "download_total_bytes": job.get("download_total_bytes")}
                snapshot = (message, fields)
                if snapshot != last_progress:
                    progress(message, **fields)
                    last_progress = snapshot
                time.sleep(1)
            if job["state"] != "done": raise ValueError("Recording preparation failed.")
            ready = library_record(saved_source(source))[0]
            progress("Ready on server", file_phase="saved", download_bytes=job.get("download_bytes", 0),
                     download_total_bytes=job.get("download_total_bytes"), file_size_bytes=ready.get("download_size"))
            return ready

    def read_imported_playlist(provider, url, progress):
        if provider == "spotify":
            # Spotify's web player sometimes loads too slowly under load; one more try usually works.
            try: return fetch_playlist(url, progress=progress)
            except PlaylistError:
                time.sleep(5)
                return fetch_playlist(url, progress=progress)
        if provider == "soundcloud": return link_playlists.fetch_soundcloud_playlist(url, app.intake, progress)
        if provider == "deezer": return link_playlists.fetch_deezer_playlist(url, progress)
        if provider == "radio": return radio.read_radio(url, "Radio", progress)
        data = fetch_youtube_playlist(url, app.intake)
        progress(len(data["tracks"]), len(data["tracks"]))
        return data

    playlist_preparation = PlaylistPreparation(playlist_store, lock, prepare_playlist_recording,
                                               match_playlist_recording, read_imported_playlist, download_workers=background_workers,
                                               allow_background=lambda: not playback_demand())
    app.extensions["music"].playlist_preparation = playlist_preparation
    app.extensions["music"].catalogue_review = catalogue_review
    def review_recording(identifier):
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})",identifier): raise ApiError("Choose a saved song.")
        item=saved_source(identifier)
        if not item:raise ApiError("Save this song on the server before requesting review.",404)
        return library_record(item)[0],item['manifest']['import']['library_sha256']
    def review_rate():
        if not allow('catalogue-review:'+g.user,20,60):raise ApiError("Wait before flagging more songs.",429)
    register_catalogue_review(app,body,catalogue_review,review_recording,lambda:g.user in cfg['ADMIN_USERS'],review_rate)
    def replacement_busy(identifier):
        with lock:
            return any(j.get('source_id') == identifier and j['state'] in ('queued', 'running') for j in jobs.values())

    def replace_source(user, identifier, candidate):
        from .source_quality import replace_saved
        def progress(*args, **kwargs): pass
        progress.source_replacement = True
        prepare_playlist_recording(user, dict(source_id=candidate['id'], match=candidate), progress)
        while playback_demand(): time.sleep(.2)
        with app.app_context():
            g.user = user
            with app.extensions['music'].source_quality.scan_lock, lock, catalogue_review.lock, listening_stats.lock:
                replace_saved(ws, lib, identifier, candidate, saved_source, playlist_store,
                              catalogue_review, listening_stats, app.intake,
                              length=lambda saved: library_record(saved)[0]['duration'])

    register_source_quality(app, ws, app.intake, lambda: not playback_demand(), lambda: g.user in cfg['ADMIN_USERS'], catalogue_review,
                            cfg.get('SOURCE_QUALITY_SCAN', cfg['PUBLIC_ORIGIN'] != 'https://music.test'),
                            replace=replace_source, busy=replacement_busy)
    def song_analysis_idle():
        with lock:
            return not playback_demand() and not any(j['state'] in ('queued', 'running') or j.get('analyzing') for j in jobs.values())
    song_analysis = register_song_analysis(app, ws, lib, app.intake, song_analysis_idle,
        cfg.get('SONG_ANALYSIS_SCAN', cfg['PUBLIC_ORIGIN'] != 'https://music.test'))

    automatic_downloads=cfg.get("AUTO_PLAYLIST_DOWNLOADS",cfg["PUBLIC_ORIGIN"] != "https://music.test")
    metadata_lookup=cfg.get("METADATA_LOOKUP",cfg["PUBLIC_ORIGIN"] != "https://music.test")
    automatic_activity = WorkerActivity('playlist-queue', 'Playlist queue')
    if automatic_downloads or metadata_lookup:
        auto_stop = threading.Event()
        def automatic_playlists():
            while not auto_stop.wait(30):
                try:
                    owners = [p['id'] for p in profile_store.list()] if family_mode else sorted(allowed)
                    # Playlists prepare while people listen; a listener's own song still goes first.
                    idle=lambda:not playback_demand()
                    with automatic_activity.track('Family library'):
                        if automatic_downloads:playlist_preparation.queue_idle(owners,idle)
                        if metadata_lookup:
                            library_tracks()
                            catalogue_review.flush()
                except Exception as error:
                    log.warning("automatic playlist queue: %s", type(error).__name__)
        def apply_metadata_votes():
            # scripts/metadata-ai-vote.py drops model votes here; they are applied once and removed.
            inbox = os.path.join(ws, ".metadata-votes.json")
            if not os.path.exists(inbox): return
            try:
                with open(inbox, encoding="utf-8") as handle: data = json.loads(handle.read(4 << 20))
                applied = catalogue_review.apply_votes(data.get("votes", []), str(data.get("label", "AI vote"))[:80])
                log.info("metadata votes: %d songs filled", applied)
            except (OSError, ValueError, AttributeError) as error:
                log.warning("metadata votes: %s", type(error).__name__)
            with suppress(OSError): os.remove(inbox)
        def tag_songs():
            # One tagger works continuously while nobody needs a song prepared. MusicBrainz allows
            # about one request a second per server, so more taggers would only get it blocked.
            while not auto_stop.is_set():
                try:
                    if playback_demand(): auto_stop.wait(5); continue
                    apply_metadata_votes()
                    if not catalogue_review.process_one(lambda:not playback_demand()): auto_stop.wait(30)
                except Exception as error:
                    log.warning("song tagging: %s", type(error).__name__); auto_stop.wait(30)
        if metadata_lookup:
            threading.Thread(target=tag_songs,name="song-tagging",daemon=True).start()
        auto_thread = threading.Thread(target=automatic_playlists,name="playlist-idle-queue",daemon=True)
        app.extensions["music"].auto_playlist_stop = auto_stop
        app.extensions["music"].auto_playlist_thread = auto_thread
        auto_thread.start()

    @app.get("/api/playlists/link-name")
    def playlist_link_name():
        url = request.args.get("url", "")
        if not 1 <= len(url) <= 2048: raise ApiError("Paste a playlist link.")
        if not allow("link-name:" + g.user, 30, 60): raise ApiError("Wait a moment before checking another link.", 429)
        try: provider, name = link_playlists.link_name(url)
        except PlaylistError as error: raise ApiError(str(error))
        return jsonify(provider=provider, name=name)

    @app.post("/api/playlists/<pid>/import")
    def import_playlist_background(pid):
        data = body()
        if "append" in data and type(data["append"]) is not bool:
            raise ApiError("Append must be true or false.")
        provider, url = data.get("provider"), data.get("url")
        # The app may send the site it detected; the server checks the link itself.
        if isinstance(url, str) and provider in (None, "auto"): provider = link_playlists.detect(url)
        if provider not in link_playlists.SOURCES or not isinstance(url, str) or not 1 <= len(url) <= 2048:
            raise ApiError("Paste a public Spotify, YouTube, SoundCloud or Deezer playlist link.")
        if link_playlists.detect(url) != provider:
            raise ApiError("This link does not match the chosen site.")
        if data.get("download") not in (None, True, False):
            raise ApiError("Download must be true or false.")
        name = data.get("name")
        if name is not None and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 200 or any(ord(c) < 32 for c in name)):
            raise ApiError("Enter a playlist name up to 200 characters.")
        if provider == "spotify":
            from .playlists import spotify_source
            spotify_source(url)
        if provider == "soundcloud": link_playlists.soundcloud_link(url)
        if provider == "deezer": link_playlists.deezer_link(url)
        if not allow("playlist-import:" + g.user, 10, 60):
            raise ApiError("Wait a minute before importing another playlist.", 429)
        try:
            with lock:
                owner = editable_playlist_owner(pid, data)
                status = playlist_preparation.begin_import(owner, pid, data.get("revision"), provider, url, data.get("download", True) is not False, name.strip() if name else None, append=data.get("append", False), actor=g.user)
        except ValueError as error: raise ApiError(str(error), 409)
        return jsonify(status), 202

    def editable_playlist_owner(pid, data):
        owner = data.get("owner_id", request.args.get("owner_id", g.user))
        if not isinstance(owner, str): raise ApiError("Choose a valid playlist owner.")
        if owner != g.user:
            playlist = playlist_store.read(owner, pid)
            if not family_mode or g.user not in playlist.get("co_authors", []):
                raise ApiError("Only the owner or a co-author can edit this playlist.", 403)
        return owner

    @app.route("/api/playlists/<pid>/prepare", methods=["GET", "POST", "DELETE"])
    def prepare_playlist(pid):
        try:
            data = body() if request.method != "GET" else {}
            with lock:
                owner = editable_playlist_owner(pid, data)
                if request.method == "POST": status = playlist_preparation.start(owner, pid, data.get("mode", "download"))
                elif request.method == "DELETE": status = playlist_preparation.pause(owner, pid)
                else: status = playlist_preparation.status(owner, pid)
        except ValueError as error: raise ApiError(str(error), 409)
        return jsonify(status)

    @app.get("/api/playlists/<pid>/match")
    def playlist_candidates(pid):
        index = request.args.get("index", type=int)
        with lock:
            owner = editable_playlist_owner(pid, {})
            playlist = playlist_store.read(owner, pid)
            if "revision" in request.args and request.args.get("revision", type=int) != playlist["revision"]:
                raise ApiError("This playlist changed. Reopen its recording choices.", 409)
            if type(index) is not int or not 0 <= index < len(playlist["tracks"]):
                raise ApiError("Invalid playlist entry.")
            track = dict(playlist["tracks"][index])
            candidates = []
            for candidate in track.get("candidates", []):
                candidate = dict(candidate)
                existing = saved_source(candidate.get("id"))
                candidate["saved"] = False
                if existing:
                    try:
                        library_record(existing)
                        candidate["saved"] = True
                    except ApiError as error:
                        if error.code != 503: raise
                candidates.append(candidate)
            track["candidates"] = candidates
        return jsonify(track=track, revision=playlist["revision"])

    @app.post("/api/playlists/<pid>/recording")
    def choose_playlist_recording(pid):
        data = body()
        with lock:
            owner = editable_playlist_owner(pid, data)
            playlist = playlist_store.read(owner, pid)
            if playlist_preparation.is_active(owner, pid):
                raise ApiError("Pause playlist preparation before choosing a recording.", 409)
            if type(data.get("revision")) is not int or data["revision"] != playlist["revision"]:
                raise ApiError("This playlist changed. Reopen its recording choices.", 409)
            index, choice = data.get("index"), data.get("choice")
            if type(index) is not int or not 0 <= index < len(playlist["tracks"]):
                raise ApiError("Invalid playlist entry.")
            track = playlist["tracks"][index]
            candidates = track.get("candidates", [])
            if type(choice) is not int or not 0 <= choice < len(candidates):
                raise ApiError("Choose one of the listed recordings.")
            selected = dict(candidates[choice])
            source = app.intake.video_id(selected["url"])
            if selected.get("id") != source or data.get("source_id") != source:
                raise ApiError("The recording choices changed. Reopen them and choose again.", 409)
            state = "ready"
            existing = saved_source(source)
            if existing:
                try:
                    selected = library_record(existing)[0]
                    state = "saved"
                except ApiError as error:
                    if error.code != 503: raise
            track.update(source_id=source, match=selected, state=state)
            track.pop("job_id", None)
            playlist["revision"] += 1
            playlist_store.save(owner, playlist)
        return jsonify(playlist=visible_playlist(playlist, owner))

    @app.post("/api/playlists/<pid>/match")
    def match_playlist_track(pid):
        data = body()
        index = data.get("index")
        with lock:
            owner = editable_playlist_owner(pid, data)
            playlist = playlist_store.read(owner, pid)
            if playlist_preparation.is_active(owner, pid):
                raise ApiError("Pause playlist matching before choosing a recording.", 409)
            if "revision" in data and (type(data["revision"]) is not int or data["revision"] != playlist["revision"]):
                raise ApiError("This playlist changed. Reopen its recording choices.", 409)
        if type(index) is not int or not 0 <= index < len(playlist["tracks"]): raise ApiError("Invalid playlist entry.")
        revision = playlist["revision"]
        track = playlist["tracks"][index]
        if not allow("search:" + g.user, 40, 60): raise ApiError("Search limit reached. Resume matching in a minute.", 429)
        query = (track["artist"].split(",")[0] + " " + track["title"])[:200]
        try: found = app.intake.cmd_search(SimpleNamespace(query=query, limit=30, offset=0))["results"]
        except Exception: raise ApiError("Could not find recordings. Try again.", 502)
        candidates = rank_matches(track, found, search=app.intake.cmd_search)
        with lock:
            owner = editable_playlist_owner(pid, data)
            playlist = playlist_store.read(owner, pid)
            if playlist["revision"] != revision:
                raise ApiError("This playlist changed. Refresh it before matching.", 409)
            playlist["tracks"][index]["candidates"] = candidates
            if playlist["tracks"][index]["state"] == "unmatched": playlist["tracks"][index]["state"] = "ready"
            playlist_store.save(owner, playlist)
        return jsonify(track=playlist["tracks"][index])

    @app.post("/api/playlists/<pid>/download")
    def download_playlist_track(pid):
        data = body(); index, choice = data.get("index"), data.get("choice")
        with lock:
            playlist = playlist_store.read(g.user, pid)
            if type(index) is not int or not 0 <= index < len(playlist["tracks"]): raise ApiError("Invalid playlist entry.")
            if playlist_preparation.is_active(g.user, pid):
                raise ApiError("Pause playlist preparation before choosing a recording.", 409)
            track = playlist["tracks"][index]
            if type(choice) is not int or not 0 <= choice < len(track["candidates"]): raise ApiError("Choose a recording first.")
            row = track["candidates"][choice]
            vid = app.intake.video_id(row["url"])
            m = fetch_metadata(row, vid)
            job = new_job(g.user, "fetch", m, vid, 20, True)
            job["playlist_import"] = True
            job.setdefault("automatic_meta", True)
            if job["state"] == "done" and job.get("item") and job["message"] == "Prepared": job.update(state="queued", message=STEP_TEXT["import"])
            track.update(match=row, job_id=job["id"], state="queued")
            playlist_store.save(g.user, playlist)
        return start(job, app.intake.WATCH + vid, None, m)

    @app.post("/api/search")
    @app.post("/api/recommendations")
    def search():
        data = body()
        q = data.get("query")
        offset = data.get("offset", 0)
        if type(offset) is not int or offset < 0 or offset >= 3000 or offset % 30 not in (0, 8, 16, 24):
            raise ApiError("Invalid search page.")
        include_long = data.get("include_long", False)
        if type(include_long) is not bool:
            raise ApiError("Invalid long-mix filter.")
        recommendation = request.path.endswith("recommendations")
        seed_artist = data.get("seed_artist", "") if recommendation else ""
        if not isinstance(seed_artist, str) or len(seed_artist) > 120 or any(ord(c) < 32 for c in seed_artist):
            raise ApiError("Invalid recommendation artist.")
        search_key = (g.user, recommendation)
        q = q.strip() if isinstance(q, str) else ""
        if not 1 <= len(q) <= 200 or any(ord(c) < 32 or ord(c) == 127 for c in q):
            raise ApiError("Enter 1 to 200 characters to search.")
        block = offset // 30 * 30
        page_offset = offset - block
        def page(found):
            full = len(found) >= 30
            found = [r for r in found if include_long or not isinstance(r.get("duration"), (int, float)) or r["duration"] < 1800]
            next_page = offset + 8 if page_offset + 8 < len(found) else block + 30 if full and block + 30 < 3000 else None
            results = [{k: r.get(k) for k in ("id", "url", "title", "channel", "duration", "kind")} for r in found[page_offset:page_offset + 8]]
            if recommendation:
                for track in results:
                    track["genre"] = genre_labels.get(artist_name(track, {"artist": track.get("channel") or ""}))
                return jsonify(results=results, next_offset=next_page, seed_genre=genre_labels.get(seed_artist))
            return jsonify(results=results, next_offset=next_page)
        cache_key = (g.user, recommendation, q.casefold(), block)
        with lock:
            cached = search_cache.get(cache_key)
            if cached and time.time() - cached[0] < 300:
                return page(cached[1])
        if not allow("search:" + g.user, 40, 60):
            raise ApiError("Too many searches. Wait a minute.", 429)
        cancel = threading.Event()
        with lock:
            previous = searches.get(search_key)
            if previous:
                previous.set()
            searches[search_key] = cancel
            for job in jobs.values():
                if not job.get("playlist_import") and not recommendation and not block and job["owner"] == g.user and job.get("search_preview") and not job.get("current") and job["state"] in ("queued", "running"):
                    job["cancel"].set()
                    if job["state"] == "queued":
                        job.update(state="cancelled", message="Cancelled")
        app.intake.CONTROL.cancel = cancel
        try:
            found = app.intake.cmd_search(SimpleNamespace(query=q, limit=30, offset=block))["results"]
        except Exception as e:
            log.warning("search failed: %s", type(e).__name__)
            raise ApiError("Search failed. Try again later.", 502)
        finally:
            app.intake.CONTROL.cancel = None
        with lock:
            if cancel.is_set():
                raise ApiError("A newer search replaced this request.", 409)
            selected = selections.setdefault(g.user, {})
            selected.update({r["id"]: r for r in found})
            selections[g.user] = dict(list(selected.items())[-100:])
            search_cache[cache_key] = (time.time(), found)
            while len(search_cache) > 32:
                search_cache.popitem(last=False)
        return page(found)

    def fetch_metadata(d, vid):
        if any(k in d for k in ("artist", "album", "track")):
            return meta(d)
        result = selections.get(g.user, {}).get(vid, d)
        artist, title = result.get("channel") or "YouTube", result.get("title") or vid
        if not isinstance(artist, str) or not isinstance(title, str):
            raise ApiError("Invalid track details.")
        return meta({"artist": artist.removesuffix(" - Topic")[:120],
                     "album": "Selected recordings", "title": title[:120]})

    def generation(d, kind):
        value = d.get("generation")
        if value is None:
            return
        if type(value) is not int or not 0 <= value <= 2**53 - 1:
            raise ApiError("Invalid request sequence.")
        with lock:
            record = sessions.get(session.get("sid"))
            if not record or record["expiry"] <= time.time():
                raise ApiError(HTTP_TEXT[401], 401)
            generations = record.setdefault("generations", {})
            if value < generations.get(kind, 0):
                raise ApiError("A newer selection replaced this request.", 409)
            generations[kind] = value

    @app.post("/api/jobs")
    def create_fetch():
        d = body()
        generation(d, "listen")
        try:
            vid = app.intake.video_id(d.get("url") if isinstance(d.get("url"), str) and len(d["url"]) <= 200 else "")
        except app.intake.IntakeError:
            raise ApiError("Enter one YouTube video link.")
        m = fetch_metadata(d, vid)
        if d.get("allow_new") is False and not saved_source(vid):
            raise ApiError("Enable Allow new music downloads and discovery to listen to this recording.", 403)
        job = new_job(g.user, "fetch", m, vid)
        explicit = any(k in d for k in ("artist", "album", "track"))
        with job["publish"], lock:
            if explicit and job["meta"] != m:
                if job.get("committed") or job.get("metadata_locked"):
                    raise ApiError("Import has started. Track details can no longer be changed.", 409)
                job.update(meta=m, artist=m["artist"], title=m["title"])
            if explicit or "automatic_meta" not in job:
                job["automatic_meta"] = not explicit
            for other in jobs.values():
                if other["owner"] == g.user:
                    other["current"] = other is job
                obsolete_current = other.get("priority", 0) == 0
                needs_slot = job["preview_state"] != "ready" and other["state"] == "running"
                if not other.get("playlist_import") and other is not job and other["owner"] == g.user and other.get("source_id") and (obsolete_current or needs_slot or other.get("analyzing")):
                    other["cancel"].set()
                    if other["state"] == "queued":
                        other.update(state="cancelled", message="Cancelled")
            if job["state"] == "done" and job.get("item") and job["message"] == "Prepared":
                # Promotion reuses the validated complete original, never fetches it again.
                job.update(state="queued", message=STEP_TEXT["import"])
            return start(job, app.intake.WATCH + vid, None, m)

    @app.post("/api/jobs/<job_id>/cancel")
    def cancel_job(job_id):
        with lock:
            job = jobs.get(job_id)
            if not job or job["owner"] != g.user:
                raise ApiError(HTTP_TEXT[404], 404)
        with job["publish"]:
            if job.get("committed"):
                job["cancel"].set()
                return jsonify(job={**public(job), "state": "done", "message": DONE_TEXT})
            if job["state"] != "done":
                job["cancel"].set()
                if job["state"] == "queued":
                    job.update(state="cancelled", message="Cancelled")
        return jsonify(job=public(job))

    artwork_cache = OrderedDict()
    artwork_lock = threading.Lock()

    @app.get("/api/artwork/<source_id>")
    def artwork(source_id):
        # Only a fixed image host and a validated source ID; never proxy a supplied URL.
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", source_id):
            abort(404)
        with artwork_lock:
            data = artwork_cache.get(source_id)
        if data is None:
            try:
                url = f"https://i.ytimg.com/vi/{source_id}/hqdefault.jpg"
                with urllib.request.urlopen(url, timeout=5) as response:
                    if response.geturl() != url or response.headers.get_content_type() != "image/jpeg":
                        abort(404)
                    data = response.read(262145)
                if len(data) > 262144 or not data.startswith(b"\xff\xd8\xff"):
                    abort(404)
            except (OSError, ValueError):
                abort(404)
            with artwork_lock:
                artwork_cache[source_id] = data
                while len(artwork_cache) > 64:
                    artwork_cache.popitem(last=False)
        return send_file(io.BytesIO(data), mimetype="image/jpeg", max_age=86400)

    def library_record(result):
        manifest = result["manifest"]
        record, source = manifest["import"], manifest["source"]
        recording_id = manifest["id"] if source["kind"] == "local" else source["id"]
        target = os.path.join(lib, *record["path"].split("/"))
        stat = app.intake.regular_file(target, "library audio")
        if not app.intake.inside(target, lib):
            raise ApiError("Recording unavailable.", 404)
        metadata = catalogue_review.overrides(recording_id,record["library_sha256"])
        track = {"id": recording_id, "url": source.get("url", ""), "title": record["title"],
                 "channel": metadata.get("artist",record["artist"]), "library_album": metadata.get("album",record["album"]),
                 "genre": metadata.get("genre") or genre_labels.get(metadata.get("artist") or artist_name(source, record)), "duration": manifest["audio"]["duration"],
                 "saved": True, "download_url": "/api/library/" + recording_id + "/download",
                 "download_size": stat.st_size, "download_sha256": record["library_sha256"],
                 "download_extension": os.path.splitext(target)[1].lower()}
        track["playback_info_url"] = "/api/library/" + recording_id + "/playback-info"
        track["playback_version"] = mobile_audio.TIERS["normal"][1]
        edition = listening_versions.select(recording_id, record["library_sha256"])
        if edition:
            version, target = edition
            track.update(duration=version["duration"], download_size=version["size"],
                         download_sha256=version["sha256"], download_extension=os.path.splitext(target)[1],
                         listening_version="trimmed", original_duration=version["original_duration"],
                         source_start=version["start"], source_end=version["end"])
        finished = finished_audio.select(track["download_sha256"])
        if not finished and cfg["REQUIRE_FINISHED_AUDIO"]:
            raise ApiError("This recording is still being prepared. Try playing it again.", 503)
        if finished:
            version, target = finished
            offset = track.get("source_start", 0)
            track.update(duration=version["duration"], download_size=version["size"],
                         download_sha256=version["sha256"], download_extension=".flac",
                         listening_version="finished", original_duration=manifest["audio"]["duration"],
                         source_start=offset + version["start"], source_end=offset + version["end"],
                         loudness_lufs=version["lufs"], true_peak_db=version["true_peak"])
        measured = version if finished else profile(app.intake, result["item"], {
            "audio": {"sha256": track["download_sha256"], "duration": track["duration"], "file": target}})
        track.update(lufs=measured.get("lufs"), true_peak=measured.get("true_peak"))
        # Preserve the legacy gain for installed clients.
        track["playback_gain_db"] = 0 if finished else measured.get("gain_db", 0)
        track.update(song_analysis.metadata(recording_id, record['library_sha256']))
        catalogue_review.observe(track,source,record["library_sha256"])
        metadata=catalogue_review.overrides(recording_id,record["library_sha256"])
        track.update(channel=metadata.get('artist',track['channel']),library_album=metadata.get('album',track['library_album']),genre=metadata.get('genre',track['genre']))
        return track, target

    def mobile_record(source_id, digest=None, quality="normal"):
        if quality not in mobile_audio.TIERS:
            raise ApiError("Invalid audio quality.", 400)
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id):
            raise ApiError("Recording unavailable.", 404)
        item = saved_source(source_id)
        if not item:
            raise ApiError("Recording unavailable.", 404)
        track, original = library_record(item)
        source_hash = track["download_sha256"]
        if digest is not None and digest != source_hash:
            raise ApiError("Recording changed. Refresh the library.", 409)
        try:
            path = mobile_audio.prepare(app.intake, item["item"], original, source_hash, urgent=True, quality=quality, title=track['title'])
        except (OSError, ValueError, app.intake.IntakeError):
            raise ApiError("Could not prepare mobile audio. Try again.", 503)
        track["playback_version"] = mobile_audio.TIERS[quality][1]
        if os.path.getsize(path) >= track["download_size"]:
            track["playback_source_sha256"] = source_hash
            return track, original
        # Installed clients validate this legacy route name. The metadata and MIME
        # type identify the actual Opus file; keeping the URL preserves compatibility.
        download_url = f"/api/library/{source_id}/playback/{source_hash}/audio.m4a"
        if quality != "normal":
            download_url += f"?quality={quality}"
        track.update(download_url=download_url,
                     download_size=os.path.getsize(path), download_sha256=app.intake.sha256_file(path),
                     download_extension=".opus", playback_source_sha256=source_hash,
                     playback_version=mobile_audio.TIERS[quality][1])
        try:
            measured = profile(app.intake, item["item"], {"audio": {
                "sha256": track["download_sha256"], "duration": track["duration"], "file": path}}, measure=True)
        except (OSError, ValueError, app.intake.IntakeError):
            raise ApiError("Could not measure mobile audio. Try again.", 503)
        track.update(lufs=measured["lufs"], true_peak=measured["true_peak"],
                     playback_gain_db=min(12, -16 - measured["lufs"], -1.5 - measured["true_peak"]))
        return track, path

    @app.get("/api/library/<source_id>/playback-info")
    def playback_info(source_id):
        quality = request.args.get("quality", "normal")
        track, _ = mobile_record(source_id, quality=quality)
        return jsonify(track)

    lyrics_cache = LyricsCache(ws, cfg.get("LYRICS_LOOKUP"))
    lyrics_enabled = cfg.get("LYRICS_LOOKUP") is not None or cfg["PUBLIC_ORIGIN"] != "https://music.test"
    @app.get("/api/library/<source_id>/lyrics")
    def song_lyrics(source_id):
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id):
            raise ApiError("Recording unavailable.", 404)
        item = saved_source(source_id)
        if not item:
            raise ApiError("Recording unavailable.", 404)
        if not lyrics_enabled: return jsonify(state="none")
        track, _ = library_record(item)
        record = item["manifest"]["import"]
        reviewed = catalogue_review.overrides(source_id, record["library_sha256"]).get("artist", "")
        try:
            result = lyrics_cache.get(source_id, record["title"], track["channel"],
                                      float(track.get("original_duration") or track["duration"]), reviewed)
        except (OSError, ValueError, urllib.error.URLError, TimeoutError):
            raise ApiError("Lyrics are unavailable right now. Try again later.", 503)
        result = dict(result); result.pop("checked", None)
        # Timings follow the original release; playback may start later after trimming silence.
        offset = float(track.get("source_start") or 0)
        if result.get("lines") and offset:
            result["lines"] = [dict(line, t=round(line["t"] - offset, 2)) for line in result["lines"]]
        response = jsonify(result)
        response.headers["Cache-Control"] = "private, max-age=86400"
        return response

    @app.route("/api/library/<source_id>/playback/<digest>/audio.opus", methods=["GET", "HEAD"])
    @app.route("/api/library/<source_id>/playback/<digest>/audio.m4a", methods=["GET", "HEAD"])
    def playback_audio(source_id, digest):
        quality = request.args.get("quality", "normal")
        track, path = mobile_record(source_id, digest, quality=quality)
        return send_file(path, conditional=True,
                         etag=track["download_sha256"], max_age=0)

    @app.route("/api/library/<source_id>/download", methods=["GET", "HEAD"])
    def download_library_recording(source_id):
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id):
            raise ApiError("Recording unavailable.", 404)
        item = saved_source(source_id)
        if not item:
            raise ApiError("Recording unavailable.", 404)
        track, path = library_record(item)
        return send_file(path, conditional=True, etag=track["download_sha256"], max_age=0,
                         as_attachment=True, download_name=source_id + track["download_extension"])

    def library_tracks():
        rows = []
        for name in os.listdir(ws):
            if not app.intake.ID_RE.fullmatch(name) or not name.startswith(("yt-", "local-")):
                continue
            try:
                result = saved_source(name if name.startswith("local-") else name[3:14])
                if not result or os.path.basename(result["item"]) != name:
                    continue
                manifest = result["manifest"]
                record, source = manifest.get("import"), manifest["source"]
                if record and source["kind"] in ("youtube", "local") and not manifest["edit"]:
                    track, _ = library_record(result)
                    rows.append(track)
            except (OSError, ValueError, ApiError, app.intake.IntakeError):
                continue
        return rows

    @app.get("/api/library")
    def library():
        return jsonify(results=library_tracks())

    @app.post("/api/queue")
    def prepare_queue():
        d = body()
        generation(d, "queue")
        rows = d.get("tracks")
        if not isinstance(rows, list) or len(rows) > 6 or type(d.get("allow_new")) is not bool:
            raise ApiError("Choose up to six upcoming recordings.")
        previews = d.get("previews", [])
        if not isinstance(previews, list) or len(previews) > 16:
            raise ApiError("Choose up to sixteen visible search previews.")
        preload_search = d.get("preload_search", d["allow_new"])
        if type(preload_search) is not bool:
            raise ApiError("Invalid search preload setting.")
        requested, prepared = set(), []
        for i, row in enumerate(rows + (previews if preload_search else [])):
            if not isinstance(row, dict):
                raise ApiError("Invalid recording.")
            explicit = row.get("requested", False)
            if type(explicit) is not bool:
                raise ApiError("Invalid queue selection.")
            is_preview = i >= len(rows)
            if is_preview and (type(row.get("duration")) not in (int, float) or not 0 < row["duration"] <= 600):
                continue
            try:
                vid = app.intake.video_id(row.get("url", ""))
            except (app.intake.IntakeError, TypeError):
                raise ApiError("Invalid recording.")
            if vid in requested:
                continue
            if not (d["allow_new"] or explicit or is_preview and preload_search) and not saved_source(vid):
                continue
            requested.add(vid)
            m = fetch_metadata(row, vid)
            priority = (1 if i == 0 else 18 + i) if not is_preview else 2 + i - len(rows)
            if not is_preview and i > 0 and preload_search:
                visible = next((n for n, p in enumerate(previews) if isinstance(p, dict) and p.get("url") == row.get("url")), None)
                if visible is not None:
                    priority = 2 + visible
            job = new_job(g.user, "fetch", m, vid, priority, False)
            job["search_preview"] = is_preview
            job.setdefault("automatic_meta", not any(k in row for k in ("artist", "album", "track")))
            start(job, app.intake.WATCH + vid, None, m)
            prepared.append(public(job))
        with lock:
            for job in jobs.values():
                if not job.get("playlist_import") and job["owner"] == g.user and job.get("priority", 0) > 0 and job.get("source_id") not in requested:
                    if not job.get("committed") and job["state"] in ("queued", "running"):
                        job["cancel"].set()
                    if job["state"] == "queued":
                        job.update(state="cancelled", message="Cancelled")
        return jsonify(jobs=prepared)

    @app.post("/api/transition")
    def transition_plan():
        d = body()
        with lock:
            pair = [jobs.get(d.get(k)) for k in ("current", "next")]
            if any(not j or j["owner"] != g.user for j in pair):
                raise ApiError(HTTP_TEXT[404], 404)
        fade = d.get("fade", 0)
        rate = d.get("current_rate", 1)
        if type(fade) not in (int, float) or not 0 <= fade <= 12 or type(d.get("dj")) is not bool:
            raise ApiError("Choose a fade from 0 to 12 seconds.")
        if type(rate) not in (int, float) or not .94 <= rate <= 1.06:
            raise ApiError("Invalid playback rate.")
        try:
            _, manifest, _ = app.intake.load_item(pair[0]["item"])
        except (KeyError, app.intake.IntakeError, OSError):
            raise ApiError("Track is still preparing.", 409)
        return jsonify(plan=transition(pair[0].get("analysis", {}), pair[1].get("analysis", {}),
                                       manifest["audio"]["duration"], fade, d["dj"], rate,
                                       pair[0].get("playback"), pair[1].get("playback")))

    @app.post("/api/uploads")
    def create_upload():
        f = request.files.get("file")
        if not f or not f.filename:
            raise ApiError("Choose an audio file.")
        try:
            ext = app.intake.extension(f.filename)
        except app.intake.IntakeError:
            raise ApiError("Unsupported file type. Use " + ", ".join(sorted(app.intake.EXTENSIONS)) + ".")
        automatic = request.form.get("read_tags") == "true"
        fields = {key: request.form.get(key, "").strip() for key in ("artist", "album", "title")}
        fallback = dict(artist="Unknown artist", album="Unknown album", title="Uploaded song")
        if automatic:
            filename = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', ' ', os.path.splitext(os.path.basename(f.filename))[0]).strip()[:120]
            try: app.intake.safe_name(filename, "title"); fallback["title"] = filename
            except app.intake.IntakeError: pass
            m = meta({key: value or fallback[key] for key, value in fields.items()})
        else: m = meta(request.form)
        job = new_job(g.user, "stage", m)
        if automatic: job.update(read_local_tags=True, local_fields=fields, playlist_import=True, message="Queued for server preparation")
        tmp = os.path.join(ws, f".upload-{secrets.token_hex(16)}.{ext}")
        try:
            with open(tmp, "xb") as out:
                f.save(out)
            size = os.path.getsize(tmp)
            if not 0 < size <= max_upload:
                raise ApiError("The file is empty." if not size else "The upload is too large.", 400 if not size else 413)
        except BaseException as e:
            with suppress(OSError):
                os.unlink(tmp)
            settle(job, "error", "Upload failed.")
            raise e if isinstance(e, ApiError) else ApiError("Upload failed.", 500)
        return start(job, None, tmp, m)

    @app.get("/api/jobs")
    def list_jobs():
        with lock:
            return jsonify(jobs=[public(j) for j in jobs.values() if j["owner"] == g.user][-MAX_JOBS:])

    @app.get("/api/jobs/<job_id>")
    def get_job(job_id):
        with lock:
            job = jobs.get(job_id)
            if not job or job["owner"] != g.user:
                raise ApiError(HTTP_TEXT[404], 404)
            return jsonify(job=public(job))

    @app.route("/api/jobs/<job_id>/media/<asset>", methods=["GET", "HEAD"])
    def job_media(job_id, asset):
        # Asset names are generated by the intake worker and explicitly published in this job.
        with lock:
            job = jobs.get(job_id)
            if not job or job["owner"] != g.user:
                raise ApiError(HTTP_TEXT[404], 404)
            if time.time() - job.get("accessed", job["created"]) > PREVIEW_TTL:
                raise ApiError("Preview expired. Start this saved recording again to prepare playback.", 410)
            if job["preview_state"] == "expired":
                raise ApiError("Preview expired. Listen again to prepare playback.", 410)
            if asset == "index.m3u8" and job["preview_state"] != "ready":
                return jsonify(error="Preparing playback."), 503, {"Retry-After": "2"}
            if not re.fullmatch(r"(?:index\.m3u8|init\.mp4|seg\d{5}\.m4s)", asset) or asset not in job["assets"]:
                raise ApiError(HTTP_TEXT[404], 404)
            root = os.path.join(ws, ".preview-" + job_id)
            path = os.path.join(root, asset)
            job["accessed"] = time.time()
        if not app.intake.inside(path, root):
            raise ApiError(HTTP_TEXT[404], 404)
        try:
            app.intake.real_dir(root, "preview directory")
            app.intake.regular_file(path, "preview asset")
        except app.intake.IntakeError:
            raise ApiError(HTTP_TEXT[404], 404)
        if asset == "index.m3u8":
            # A finite snapshot closes its descriptor before FFmpeg replaces the next playlist.
            with open(path, encoding="utf-8") as fh:
                text = fh.read(1 << 20)
            for line in text.splitlines():
                if line and not line.startswith("#") and not re.fullmatch(r"seg\d{5}\.m4s", line):
                    raise ApiError(HTTP_TEXT[404], 404)
                if "URI=" in line and line != '#EXT-X-MAP:URI="init.mp4"':
                    raise ApiError(HTTP_TEXT[404], 404)
            text = text.replace("#EXTM3U", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES", 1)
            return app.response_class(text, mimetype="application/vnd.apple.mpegurl")
        return send_file(path, mimetype="audio/mp4", conditional=True, etag=True, max_age=0)

    from .listening_rooms import register_listening_rooms
    register_listening_rooms(app, body, profile_store)
    from .playback_devices import register_playback_devices
    register_playback_devices(app, body, playback_devices)
    return app
