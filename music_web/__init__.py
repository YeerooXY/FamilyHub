"""FamilyHub mobile music app: Navidrome sign-in, public metadata search, fetch or upload, then import.

Acquisition/import reuse scripts/music-intake.py. One coordinator schedules acquisition,
HLS and bounded beat analysis; browser decks handle playback. See docs/MOBILE_MUSIC.md.
"""
import gzip, hashlib, hmac, importlib.util, io, json, logging, os, random, re, secrets, shutil, sys, threading, time, urllib.error, urllib.parse, urllib.request
from collections import Counter, OrderedDict, defaultdict, deque
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import nullcontext, suppress
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace

from flask import Flask, Response, abort, g, jsonify, redirect, render_template, request, session, send_file
from flask_wtf.csrf import CSRFError, CSRFProtect, generate_csrf
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash
from .catalog_search import NoRedirect
from .genres import GenreLabels, artist_name, genre_key, genre_label, most_common_genre
from .playlist_preparation import PlaylistPreparation
from .listening_stats import ListeningStats
from .wrapped import DeezerChart
from .playlists import PlaylistError, PlaylistStore, fetch_playlist, fetch_youtube_playlist, rank_matches, preferred_match, library_match_key, reuse_library_match
from .profiles import ProfileError, ProfileStore
from .state import StateWriter, migrate_state, state_path, start_backups, wait_for_write, write_json as write_state_json
from .mixing import transition
from .audio_profile import profile
from . import mobile_audio
from . import app_updates
from . import profile_artwork
from . import feedback, wordle
from .wordle_source import published_answer
from .listening_versions import ListeningVersions
from .catalogue_review import CatalogueReview, lookup as lookup_catalogue_metadata, register as register_catalogue_review
from .review_confidence import DEFAULT_AUTO_RESOLUTIONS_PER_HOUR, normal, pick_equivalent, presentation_title, recording_labels
from .source_quality import register as register_source_quality
from .song_analysis import register as register_song_analysis
from .finished_audio import FinishedAudio, prepare_record, activity as finished_audio_activity
from .playlist_artwork import PlaylistArtwork, ArtworkError
from .playback_diagnostics import (
    PlaybackDiagnostics, CLIENT_STAGES, NATIVE_STAGES, NATIVE_REASONS, EXIT_STAGES, record_client_exit, native_reason,
)
from .lyrics import LyricsCache
from .worker_activity import WorkerActivity, stage_summary
from .resources import (ResourceGovernor, TransferResources, PROVIDERS, background_activity, background_request,
                        enabled, transfer_limit, waiting, runtime_capacity, background_command, audio_command, lower_background_priority)
from . import link_playlists, similar_songs
from . import home_albums, home_radio
from . import radio
from .http_limits import body_limit
from .library_index import LibraryIndex, SOURCE_ID, file_stamp, library_folders, matches, search_words, source_id as folder_source_id
from . import library_loudness

MAX_UPLOAD = 512 << 20
SESSION_HOURS = 12
REMEMBER_HOURS = 30 * 24
MAX_JOBS = 50
MAX_VERIFIED_SOURCES = 4096  # Keep a full family library warm while bounding manifest memory.
PREVIEW_TTL = 2 * 60 * 60
MAX_PREVIEWS = 24
PLAYBACK_PROBLEMS = frozenset({"interrupted", "early_end", "unexpected_pause", "native_paused", "native_suppressed",
                               "native_error", "player_error", "stream_failed", "failed", "resume_failed",
                               "next_warmup_failed"})
MAX_CACHE_BYTES = 16 << 30
MIN_FREE_BYTES = 256 << 20


def scratch_size(workspace, library, intake):
    size = 0
    for root, dirs, files in os.walk(workspace, followlinks=False):
        dirs[:] = [d for d in dirs if not intake.is_link(os.path.join(root, d))]
        if root == workspace:
            # Published assets are durable storage, not acquisition scratch space.
            dirs[:] = [d for d in dirs if d not in
                       (".app-updates", ".listening-versions", ".finished-audio", ".discovery", ".library-loudness-v1")]
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
    "STATE_DIR": None,
    "STATE_BACKUP_DIR": None,
    "WAITRESS_THREADS": 4,
    "LIBRARY": "/srv/familyhub/data/media/music",
    "NAVIDROME_URL": "http://127.0.0.1:4533",
    "PLAYER_URL": "https://familyhub.example.ts.net:8443/",
    "PUBLIC_ORIGIN": "https://familyhub.example.ts.net:8444",
    "ALLOWED_USERS": [],
    "FAMILY_PROFILES": False,
    "BROWSER_PLAYER": True,
    "ADMIN_USERS": [],
    "PROFILE_PASSWORD_HASHES": {},
    "REQUIRE_PROFILE_PASSWORDS": False,
    "AUTO_RESOLUTIONS_PER_HOUR": DEFAULT_AUTO_RESOLUTIONS_PER_HOUR,
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
        with urllib.request.build_opener(NoRedirect).open(f"{base.rstrip('/')}/rest/ping.view?{query}", timeout=10) as r:
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
    cfg["WORKSPACE"] = ws
    threads = cfg["WAITRESS_THREADS"]
    if type(threads) is not int or threads < 1:
        raise ValueError("WAITRESS_THREADS must be a positive integer")
    migrate_state(cfg)
    state_writer = StateWriter()
    allowed = set(cfg["ALLOWED_USERS"])
    family_mode = cfg.get("FAMILY_PROFILES") is True
    require_profile_passwords = family_mode and cfg.get("REQUIRE_PROFILE_PASSWORDS") is True
    profile_store = ProfileStore(cfg, allowed, writer=state_writer) if family_mode else None
    password_file = state_path(cfg, ".profile-passwords.json")
    password_hashes = dict(cfg["PROFILE_PASSWORD_HASHES"])
    try:
        saved = json.loads(password_file.read_text(encoding="utf-8"))
        password_hashes.update({key: value for key, value in saved.items() if isinstance(key, str) and isinstance(value, str)})
    except (OSError, ValueError, AttributeError):
        pass
    password_lock = threading.Lock()
    protected_profiles = set(password_hashes) | set(cfg["ADMIN_USERS"]) | set(cfg.get("JELLYFIN_PROFILES", {}))

    def is_protected_profile(user):
        return require_profile_passwords or user in protected_profiles
    max_upload = cfg["MAX_UPLOAD"]

    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=cfg["SECRET_KEY"], SESSION_COOKIE_NAME="familyhub_music", SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=3650) if family_mode else timedelta(hours=REMEMBER_HOURS), SESSION_REFRESH_EACH_REQUEST=False,
        MAX_CONTENT_LENGTH=max_upload + (1 << 20), WAITRESS_THREADS=threads,
        WTF_CSRF_TIME_LIMIT=None, WTF_CSRF_SSL_STRICT=False)  # origin is checked in guard()
    app.intake = load_intake(cfg["CLI_PATH"])
    from . import verified_hashes
    verified_hashes.install(app.intake, ws, lib, state=cfg)
    catalogue_review = CatalogueReview(cfg, cfg['AUTO_RESOLUTIONS_PER_HOUR'])
    metadata_lookup = bool(cfg.get("METADATA_LOOKUP", cfg["PUBLIC_ORIGIN"] != "https://music.test") and catalogue_review.automatic_limit)
    from .playback_devices import PlaybackDevices
    listening_versions = ListeningVersions(ws, app.intake, state=cfg)
    finished_audio = FinishedAudio(ws, app.intake)
    genre_labels = GenreLabels(cfg, enabled=cfg.get("GENRE_LOOKUP", cfg["PUBLIC_ORIGIN"] != "https://music.test"))
    sessions, jobs, hits, lock = {}, OrderedDict(), {}, threading.RLock()
    session_lock = threading.RLock()
    playback_state_lock = threading.RLock()
    catalogue_lock = threading.RLock()
    dispatch_wake = threading.Event()
    automatic_downloads = cfg.get("AUTO_PLAYLIST_DOWNLOADS", cfg["PUBLIC_ORIGIN"] != "https://music.test")
    backlog_wake = threading.Event()
    job_changed = threading.Condition(lock)
    import_lock = threading.Lock()
    budget_lock = threading.Lock()
    budget_cache = {"at": 0.0, "size": 0}
    selections = {}
    saved_cache = OrderedDict()
    saved_lock = threading.RLock()
    library_index = None
    searches = {}
    search_cache = OrderedDict()
    radio_sources = OrderedDict()
    bulk_path = state_path(cfg, ".library-additions.json")
    bulk_file_lock = threading.Lock()
    bulk_revision = bulk_saved_revision = 0
    app.extensions["music"] = SimpleNamespace(sessions=sessions, jobs=jobs)
    from . import server_stats as health_stats
    app.extensions["server_health"] = (health_stats.start(state_path(cfg, ".server-stats.sqlite3").parent, cfg) if test_config is None else health_stats.Collector())
    log = logging.getLogger("music_web")
    resources = ResourceGovernor(lambda: resource_queue(), lambda: resource_metrics())
    def resource_changed():
        dispatch_wake.set()
        if automatic_downloads:
            backlog_wake.set()

    resources.changed = resource_changed
    playback_devices = PlaybackDevices(presence=resources)
    playback_diagnostics = PlaybackDiagnostics()
    from .activity import Activity
    app.extensions["activity"] = activity = Activity(credit=lambda user, seconds: listening_stats.add_watch(user, seconds),
                        history_paused=lambda user: bool(family_mode and profile_store.read()['preferences'].get(user, {}).get('listening_history_paused')))

    def job_playback_stage(job, stage, *, once=False):
        playback_diagnostics.record(job["owner"], job.get("play_action"), stage, once=once)

    @app.route("/api/playback/diagnostics", methods=["GET", "POST"])
    def playback_diagnostic_events():
        if request.method == "GET":
            return jsonify(actions=playback_diagnostics.recent(g.user))
        data = body(limit=1024)
        action, stage, elapsed = (data.get(key) for key in ("action", "stage", "elapsed_ms"))
        if isinstance(stage, str) and stage in EXIT_STAGES:
            if not record_client_exit(data):
                raise ApiError("Invalid client exit report.")
            return jsonify(ok=True)
        if (not playback_diagnostics.valid(action) or not isinstance(stage, str)
                or (stage not in CLIENT_STAGES and stage not in NATIVE_STAGES)
                or type(elapsed) is not int or not 0 <= elapsed <= 3600000):
            raise ApiError("Invalid playback timing.")
        observation = None
        if stage in NATIVE_STAGES:
            position, reason = data.get("position_ms"), data.get("reason")
            if type(position) is not int or not 0 <= position <= 86400000:
                raise ApiError("Invalid playback position.")
            observation = {"position_ms": position}
            if native_reason(stage, reason):
                observation["reason"] = reason
        playback_diagnostics.record(g.user, action, "client_" + stage, client_ms=elapsed, begin=True,
                                    observation=observation)
        if stage in ("screen_off", "screen_on", "next_warmup_start", "next_warmup_finish", "next_warmup_failed"):
            log.info("playback %s action=%s elapsed_ms=%d position_ms=%d", stage, action, elapsed, observation["position_ms"])
        # Interruptions reach the server journal with their position and reason, so a stop can be explained after the
        # in-memory timings expire (they last 30 minutes).
        if stage in PLAYBACK_PROBLEMS and (observation or {}).get("reason") not in ("user_request", "end_of_item", "remote_control"):
            seconds = (observation or {}).get("position_ms", 0) // 1000
            log.warning("playback %s at %d:%02d%s", stage, seconds // 60, seconds % 60,
                        " reason=" + observation["reason"] if observation and "reason" in observation else "")
        return jsonify(ok=True)
    transfers = TransferResources(transfer_limit(), lambda: min(
        MAX_CACHE_BYTES - scratch_size(ws, lib, app.intake), shutil.disk_usage(ws).free - MIN_FREE_BYTES),
        resources, listener_scratch=2 * (2 << 30) + (64 << 20) + app.intake.MAX_SECONDS * 32000)
    app.extensions["music"].resources = resources
    app.intake.RESOURCES = resources
    app.intake.RESOURCE_TRACK = resources.track
    app.intake.RESOURCE_WAIT = waiting
    app.intake.RESOURCE_COMPUTE = resources.compute
    app.intake.RESOURCE_CHANGED = dispatch_wake.set
    app.intake.BACKGROUND_COMMAND = background_command
    app.intake.AUDIO_COMMAND = audio_command

    def remove_upload(path):
        if path:
            with suppress(OSError):
                os.unlink(path)

    def cancel_acquisition(job):
        with job_changed:
            job["cancel"].set()
            upload = job.pop("tmp", None) if job["state"] == "queued" else None
            job_changed.notify_all()
        remove_upload(upload)
        if job.get("library_addition") and job["state"] in ("queued", "running"):
            save_bulk_queue()
        transfers.wake()
        resource_changed()

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
        with session_lock:
            s = sessions.get(sid) if isinstance(sid, str) else None
            if s and s["expiry"] > time.time() and (not require_profile_passwords or s["user"] in password_hashes):
                return s["user"]
            sessions.pop(sid, None)
            if family_mode and session.get("family_profile") and not is_protected_profile(session["family_profile"]):
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
            app.logger.warning("Rejected request: invalid host")
            abort(400)
        if not cfg["BROWSER_PLAYER"] and not request.path.startswith("/api/") and request.endpoint not in ("admin_page", "admin_asset"):
            return app.response_class("Open the FamilyHub app.\n", status=410, mimetype="text/plain")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            limit = body_limit(request.method, request.path)
            if limit is not None:
                request.max_content_length = min(app.config["MAX_CONTENT_LENGTH"], limit)
                if (request.content_length or 0) > request.max_content_length:
                    abort(413)
            sent, ref = request.headers.get("Origin"), request.headers.get("Referer", "")
            if not (sent == origin if sent is not None else ref == origin or ref.startswith(origin + "/")):
                app.logger.warning("Rejected request: invalid origin")
                abort(403)
        if request.endpoint in ("admin_page", "admin_asset", "login", "static", "family_connect", "create_family_profile", "select_family_profile", "set_first_family_password", "app_update_manifest", "app_update_package", "profile_image", "share_landing", "share_download", "movie_media", "announce_restart"):
            return
        # Audio players cannot send the sign-in cookie, so a stream link carries a signed ticket.
        if request.endpoint in ("playback_audio", "download_library_recording", "job_media") and "ticket" in request.args:
            g.user = stream_ticket_user()
            if not g.user:
                raise ApiError(HTTP_TEXT[401], 401)
            return
        g.user = current()
        if not g.user:
            if request.path.startswith("/api/"):
                raise ApiError(HTTP_TEXT[401], 401)
            return redirect("/login")

    STREAM_SECONDS = 24 * 3600
    def stream_signature(user, path, expires):
        return hmac.new(cfg["SECRET_KEY"].encode(), f"stream|{user}|{path}|{expires}".encode(), hashlib.sha256).hexdigest()

    def stream_url(url):
        # Bound to this profile and this song's path; the tier in the query only picks a copy of the same song.
        path = url.split("?", 1)[0]
        expires = int(time.time()) + STREAM_SECONDS
        ticket = urllib.parse.urlencode({"user": g.user, "expires": expires, "ticket": stream_signature(g.user, path, expires)})
        return url + ("&" if "?" in url else "?") + ticket

    def stream_ticket_user():
        user, expires, ticket = (request.args.get(k, "") for k in ("user", "expires", "ticket"))
        if (not user or not re.fullmatch(r'[0-9]{1,12}', expires) or not re.fullmatch(r'[a-f0-9]{64}', ticket)
                or int(expires) < time.time() or int(expires) > time.time() + STREAM_SECONDS + 60
                or require_profile_passwords and user not in password_hashes):
            return None
        return user if hmac.compare_digest(stream_signature(user, request.path, expires), ticket) else None

    csrf = CSRFProtect(app)  # registered after guard(), so host, origin and sign-in are checked first

    def listener_identity():
        return (g.user, session.get("sid") if "ticket" not in request.args else None)

    @app.before_request
    def request_presence():
        if not getattr(g, "user", None) or request.method in ("HEAD", "OPTIONS"):
            return
        sid = listener_identity()[1]
        background = background_activity()
        with session_lock:
            signed_in = sessions.get(sid)
            first_background = signed_in is not None and background and not signed_in.get("activity_header")
            if first_background:
                signed_in["activity_header"] = True
            activity_header = signed_in is not None and signed_in.get("activity_header")
        if background:
            if first_background:
                resources.remember_profile(g.user)
            return
        endpoint = request.endpoint
        if endpoint in ("playback_activity", "playback_diagnostic_events", "search", "logout", "job_media", "playback_audio"):
            return
        # Older clients poll these endpoints without an activity header.
        if not activity_header and endpoint in ("get_job", "list_jobs", "library_additions",
                                                "server_stats", "listening_pokes"):
            return
        if endpoint == "index" or request.path.startswith("/api/"):
            interactive = (request.method != "GET" and endpoint != "listening_room"
                           or endpoint in ("library", "list_playlists", "playlist_candidates"))
            resources.presence(listener_identity(), "browsing" if interactive else "online-idle", 10)

    @app.teardown_request
    def finish_search(_error):
        if "search_presence" in g:
            resources.end_search(*g.pop("search_presence"))

    @app.after_request
    def headers(resp):
        if (library_index is not None and resp.status_code == 200
                and request.endpoint in ('edit_metadata', 'undo_metadata')):
            identifier = request.view_args['identifier']
            library_index.update({identifier: ()})
        # Site icons are public favicons cached on disk for 30 days; keep their long cache header.
        keep_cache = request.endpoint == "movie_source_icon" and resp.status_code == 200
        cache = resp.headers.get("Cache-Control")
        resp.headers.update({
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
                                       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; "
            "base-uri 'none'; object-src 'none'; media-src 'self' blob:; worker-src 'none'",
            "X-Content-Type-Options": "nosniff",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cache-Control": "no-store",
            "Strict-Transport-Security": "max-age=31536000"})
        if keep_cache and cache:
            resp.headers["Cache-Control"] = cache
        if request.endpoint == "admin_page":
            resp.headers["Content-Security-Policy"] = resp.headers["Content-Security-Policy"].replace(
                "img-src 'self';", "img-src 'self' https://image.tmdb.org;")
        resp.headers.setdefault("Referrer-Policy", "no-referrer" if request.endpoint == "movie_media" else "same-origin")
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
        if e.code == 400:
            # Names the failed check (for example a missing CSRF session token); never logs token values.
            app.logger.warning("Rejected request at %s", request.endpoint)
        text = HTTP_TEXT.get(e.code, "Request failed.")
        return (jsonify(error=text) if request.path.startswith("/api/") else text), e.code

    @app.errorhandler(Exception)
    def unexpected_error(error):
        app.logger.error("Request failed at %s: %s", request.endpoint, type(error).__name__)
        if request.path.startswith("/api/"):
            return jsonify(error="Request failed."), 500
        return "Request failed.", 500

    @app.errorhandler(CSRFError)
    def csrf_error(error):
        if request.endpoint in ("login", "logout") and request.method == "POST":
            return render_template("account_retry.html"), 400
        if request.path.startswith("/api/"):
            app.logger.warning("Rejected CSRF check at %s", request.endpoint)
            return jsonify(error="Your session changed. Reload FamilyHub and try again.", code="csrf"), 400
        return http_error(error)

    # ---- sign in ----
    def require_family():
        if not family_mode:
            raise ApiError("Family profiles are not enabled on this server.", 409)

    app_updates.register(app, ws, require_family)
    from . import admin_page
    admin_page.register(app)
    profile_artwork.register(app, ws, profile_store, require_family, catalogue_lock, resources)

    @app.errorhandler(ProfileError)
    def profile_error(error):
        return jsonify(error=str(error)), 400

    def establish_session(user, remember, activity_header=False):
        old = session.get("sid")
        session.clear()
        sid = secrets.token_urlsafe(32)
        with session_lock:
            sessions.pop(old, None)
            now = time.time()
            for key in [key for key, value in sessions.items() if value["expiry"] <= now]:
                del sessions[key]
            hours = REMEMBER_HOURS if remember else SESSION_HOURS
            sessions[sid] = {"user": user, "expiry": now + hours * 3600, "activity_header": activity_header}
        session.permanent = remember
        session["sid"] = sid
        if family_mode and not is_protected_profile(user):
            session["family_profile"] = user

    def profile_entry(profile):
        if is_protected_profile(profile["id"]):
            profile = dict(profile, requires_password=True)
            if profile["id"] not in password_hashes:
                profile["needs_password_setup"] = True
        return profile

    def family_profile_list():
        return [profile_entry(profile) for profile in profile_store.list()]

    def verify_profile_password(user, password):
        if not is_protected_profile(user):
            return
        if not (allow("profile-login", 30, 300) and allow("profile-login:" + user, 8, 300)):
            raise ApiError("Too many attempts. Wait a few minutes.", 429)
        digest = password_hashes.get(user)
        if not digest:
            raise ApiError("Ask the server owner to set a password for this profile.", 403)
        if not isinstance(password, str) or not 1 <= len(password) <= 256:
            raise ApiError("Enter the password for this profile.", 403)
        if not check_password_hash(digest, password):
            raise ApiError("Incorrect password. Try again.", 403)

    @app.get("/api/connect")
    def family_connect():
        require_family()
        profiles = family_profile_list()
        return jsonify(family_profiles=True, server_name="FamilyHub", profiles=profiles, csrf_token=generate_csrf())

    @app.post("/api/profiles")
    def create_family_profile():
        require_family()
        if not allow("profile-create", 30, 3600):
            raise ApiError("Too many profiles created. Try again later.", 429)
        with catalogue_lock:
            profile = profile_store.create(body().get("name"))
        return jsonify(profile=profile_entry(profile)), 201

    @app.patch("/api/profile/name")
    def rename_family_profile():
        require_family()
        data = body()
        if set(data) != {"name"}:
            raise ApiError("Enter a display name for the selected profile.", 400)
        with catalogue_lock:
            profile = profile_store.set_name(g.user, data["name"])
        return jsonify(profile=profile)

    @app.post("/api/profile/password-setup")
    def set_first_family_password():
        require_family()
        data = body()
        profile = profile_store.get(data.get("profile_id"))
        password = data.get("password")
        if not is_protected_profile(profile["id"]):
            raise ApiError("This profile does not use a password.", 400)
        if not isinstance(password, str) or not 8 <= len(password) <= 256:
            raise ApiError("Use a password of 8 to 256 characters.", 400)
        if not allow("profile-password-setup", 10, 300):
            raise ApiError("Too many attempts. Wait a few minutes.", 429)
        with password_lock:
            if profile["id"] in password_hashes:
                raise ApiError("This profile already has a password. Sign in with it.", 409)
            digest = generate_password_hash(password)
            write_state_json(password_file, {**{key: value for key, value in password_hashes.items() if key not in cfg["PROFILE_PASSWORD_HASHES"]},
                                              profile["id"]: digest})
            password_hashes[profile["id"]] = digest
        return sign_in_family_profile(profile, background_activity())

    @app.post("/api/profile/select")
    def select_family_profile():
        require_family()
        background = background_activity()
        data = body()
        profile = profile_store.get(data.get("profile_id"))
        verify_profile_password(profile["id"], data.get("password"))
        return sign_in_family_profile(profile, background)

    def sign_in_family_profile(profile, background):
        preferences = profile_store.preferences(profile["id"])
        establish_session(profile["id"], True, activity_header=background)
        g.pop("csrf_token", None)
        if background:
            resources.remember_profile(profile["id"])
        else:
            resources.presence((profile["id"], session["sid"]))
        return jsonify(profile=profile, preferences=preferences, csrf_token=generate_csrf(),
                       server_health_admin=profile["id"] in cfg["ADMIN_USERS"],
                       movies_enabled=bool(cfg.get("JELLYFIN_PUBLIC_URL") and profile["id"] in cfg.get("JELLYFIN_PROFILES", {})))

    @app.route("/api/profile/playback", methods=["GET", "PUT", "PATCH"])
    def family_playback():
        require_family()
        if request.method in ("PUT", "PATCH"):
            with playback_state_lock:
                data = body(65536)
                if data.get("profile_id") != g.user:
                    raise ApiError("The selected profile changed.", 409)
                playback = data.get("playback", {})
                if request.method == "PATCH":
                    previous = profile_store.playback(g.user)
                    index = playback.get("index", previous["index"] if previous else None) if isinstance(playback, dict) else None
                    if (not previous or type(index) is not int or not 0 <= index < len(previous["track_ids"])
                            or playback.get("track_id") != previous["track_ids"][index]):
                        raise ApiError("The playback queue changed.", 409)
                    playback = dict(previous, index=index, position=playback.get("position"))
                value = profile_store.playback(g.user, playback)
        else:
            value = profile_store.playback(g.user)
        return jsonify(profile_id=g.user, playback=value)

    @app.route("/api/profile/preferences", methods=["GET", "PATCH"])
    def family_preferences():
        require_family()
        changes = body() if request.method == "PATCH" else None
        with catalogue_lock if changes is not None else nullcontext():
            preferences = profile_store.preferences(g.user, changes)
            if changes and changes.get('listening_history_paused') is True:
                listening_stats.reset_presence(g.user)
        return jsonify(preferences={key: value for key, value in preferences.items() if key != 'listening_history_resumed_at'})

    @app.route("/login", methods=["GET", "POST"])
    def login():
        def page(error=None, code=200):
            return render_template("login.html", error=error,
                                   family_profiles=family_profile_list() if family_mode else None,
                                   username=request.form.get("username", "")[:64]), code
        if request.method == "GET":
            return redirect("/") if current() else page()
        if family_mode:
            try:
                creating = request.form.get("action") == "create"
                if creating and not allow("profile-create", 30, 3600):
                    raise ApiError("Too many profiles created. Try again later.", 429)
                with catalogue_lock:
                    profile = profile_store.create(request.form.get("name")) if creating else profile_store.get(request.form.get("profile_id"))
                verify_profile_password(profile["id"], request.form.get("password"))
                establish_session(profile["id"], True)
            except ProfileError as error:
                return page(str(error), 400)
            except ApiError as error:
                return page(error.message, error.code)
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
        resources.close(listener_identity())
        with session_lock:
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
        request.max_content_length = min(request.max_content_length or limit + 1, limit + 1)
        if (request.content_length or 0) > limit:
            raise ApiError("Request is too large.", 413)
        d = None
        if request.is_json:
            raw = request.get_data()
            if len(raw) > limit:
                raise ApiError("Request is too large.", 413)
            try:
                d = app.json.loads(raw)
            except (ValueError, RecursionError):
                pass
        if not isinstance(d, dict):
            raise ApiError("Request body must be a JSON object.")
        return d

    feedback_event = None
    if family_mode:
        feedback_event = feedback.register(app, cfg, body, ApiError, profile_store, lambda: g.user in cfg["ADMIN_USERS"])
        wordle.register(app, cfg, require_family, profile_store, body, ApiError,
                        cfg.get("WORDLE_DAILY_ANSWER", published_answer), writer=state_writer, playing=activity.wordle)

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
                for other in list(jobs.values())):
            if os.path.dirname(os.path.abspath(path)) != ws or not app.intake.inside(path, ws):
                raise app.intake.IntakeError("temporary cache escaped workspace")
            directory, manifest, _ = app.intake.load_item(path)
            if (manifest["import"] is None and manifest["source"].get("kind") == "youtube"
                    and manifest["source"].get("id") == job["source_id"]
                    and os.path.basename(directory).startswith("yt-" + job["source_id"] + "-")):
                targets = [os.path.join(directory, name) for name in os.listdir(directory)]
                for target in targets:
                    app.intake.regular_file(target, "temporary cache file")
                with lock:
                    if any(other.get('item') == path or other.get('source_id') == job['source_id']
                           and other['state'] in ('queued', 'running') for other in jobs.values()):
                        return
                    retired = os.path.join(ws, '.retired-' + secrets.token_hex(8))
                    os.replace(directory, retired)
                for target in os.listdir(retired):
                    os.chmod(os.path.join(retired, target), 0o600)
                shutil.rmtree(retired)

    cleanup_pending = deque()
    cleanup_thread = None

    def retire(job, preview_only=False):
        nonlocal cleanup_thread
        # Called with the jobs lock. Only the cleanup worker touches retired files.
        cleanup_pending.append((dict(job), preview_only))
        if cleanup_thread is not None:
            return
        def clean():
            nonlocal cleanup_thread
            while True:
                with lock:
                    if not cleanup_pending:
                        cleanup_thread = None
                        return
                    old, preview = cleanup_pending.popleft()
                with suppress(OSError, app.intake.IntakeError):
                    remove_preview(old['id']) if preview else discard(old)
        cleanup_thread = threading.Thread(target=clean, name='retired-audio', daemon=True)
        cleanup_thread.start()

    def new_job(user, step, m, source_id=None, priority=0, save=True, library_addition=False, *, preserve_priority=False):
        with lock:
            now = time.time()
            for old in list(jobs.values()):
                if old["state"] not in ("queued", "running") and not old.get("analyzing") and now - old.get("accessed", old["created"]) > PREVIEW_TTL:
                    retire(old)
                    jobs.pop(old["id"], None)
            if source_id:
                found = next((j for j in jobs.values() if j["owner"] == user and j.get("source_id") == source_id
                              and j["state"] not in ("error", "cancelled") and not j["cancel"].is_set()
                              and (j["state"] in ("queued", "running") or j["preview_state"] != "expired"
                                   or j.get("source_ready"))), None)
                if found:
                    found["accessed"] = now
                    if found.get("current"):
                        found["priority"] = 0
                    else:
                        found["priority"] = min(priority, found["priority"]) if preserve_priority else priority
                    found["save"] |= save
                    transfers.wake()
                    return found
            if not library_addition and len([j for j in jobs.values() if j["state"] in ("queued", "running") and not j.get("library_addition")]) >= (32 if priority == 0 else 24):
                raise ApiError("The preparation queue is full. Try again shortly.", 429)
            job = {"id": secrets.token_urlsafe(12), "owner": user, "state": "running", "message": STEP_TEXT[step],
                   "artist": m["artist"], "title": m["title"], "phase": step,
                   "preview_state": "unavailable", "assets": set(), "created": time.time(),
                   "source_id": source_id, "priority": priority, "save": save, "meta": m, "queued_at": time.monotonic(),
                   "cancel": threading.Event(), "publish": threading.Lock(), "current": False}
            jobs[job["id"]] = job
            for k in [k for k, v in jobs.items() if v["state"] not in ("queued", "running") and not v.get("current") and not v.get("analyzing")][:max(0, len(jobs) - MAX_JOBS)]:
                retire(jobs[k])
                del jobs[k]
            return job

    def public(job, *, include_media=True):
        out = {k: job[k] for k in ("id", "state", "message", "artist", "title", "phase", "preview_state")}
        out.update(source_id=job.get("source_id"), priority=job.get("priority", 0), saved=bool(job.get("committed") or job.get("already_saved")))
        if job.get("playlist_error"):
            out["playlist_error"] = job["playlist_error"]
        if job.get("playback"):
            out["playback"] = job["playback"]
        if job.get("analysis"):
            out["analysis"] = {k: job["analysis"][k] for k in ("bpm", "reliable", "confidence", "reason")
                               if k in job["analysis"]}
        if include_media and job["preview_state"] == "ready":
            out["media_url"] = f"/api/jobs/{job['id']}/media/index.m3u8"
            out["stream_url"] = stream_url(out["media_url"])
            out["windows_preview_ready"] = job.get("windows_preview_ready", False)
        if include_media and job.get("source_ready") and job["state"] != "cancelled":
            out["fallback_url"] = f"/api/jobs/{job['id']}/media/source"
            out["fallback_stream_url"] = stream_url(out["fallback_url"])
            job_playback_stage(job, "source_stream_offered", once=True)
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

    def saved_source(source_id, imported=True, candidates=None):
        key = (source_id, imported)
        with saved_lock:
            cached = saved_cache.get(key)
        if cached:
            result, signature = cached
            try:
                if source_signature(result) == signature:
                    with saved_lock:
                        if key in saved_cache:
                            saved_cache.move_to_end(key)
                    return result
            except (OSError, app.intake.IntakeError):
                pass
            with saved_lock:
                if saved_cache.get(key) is cached:
                    del saved_cache[key]
        # Hashing a cold song must not hold the library-wide cache mutex.
        if candidates is None and imported and library_index is not None:
            candidates = library_index.candidates(source_id)
        entry = validate_source(source_id, imported, candidates)
        with saved_lock:
            if entry:
                saved_cache[key] = entry
                while len(saved_cache) > MAX_VERIFIED_SOURCES:
                    saved_cache.popitem(last=False)
                return entry[0]

    def validate_source(source_id, imported, candidates):
        # Manifests remain the catalogue. Never infer recording identity from a title.
        for name in os.listdir(ws) if candidates is None else candidates:
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

    listening_stats = ListeningStats(cfg, writer=state_writer)
    deezer_chart = DeezerChart(cfg, listening_stats.utc)
    from .profiles import file_version

    history_markers = {}

    restart_lock = threading.Lock()
    restart_at, restart_expires = 0, 0
    restart_nonces = {}

    @app.post("/api/server/restart-notice")
    @csrf.exempt  # The deployment request uses a single-use proof and has no browser session.
    def announce_restart():
        nonlocal restart_at, restart_expires
        if (request.remote_addr not in ("127.0.0.1", "::1")
                or any(name in request.headers for name in ("Forwarded", "X-Forwarded-For"))):
            abort(403)
        if not allow("announce-restart", 10, 60):
            abort(429)
        data = body(256)
        seconds = data.get("seconds")
        if type(seconds) is not int or not 1 <= seconds <= 60:
            raise ApiError("Choose a restart delay from 1 to 60 seconds.")
        proof = request.headers.get("X-FamilyHub-Restart-Proof", "")
        match = re.fullmatch(r"([0-9]{1,12}):([a-f0-9]{32}):([a-f0-9]{64})", proof)
        if not match:
            abort(403)
        stamp, nonce, signature = match.groups()
        expected = hmac.new(cfg["SECRET_KEY"].encode(), f"restart-notice|{stamp}|{nonce}|{seconds}".encode(), hashlib.sha256).hexdigest()
        if abs(time.time() - int(stamp)) > 30 or not hmac.compare_digest(expected, signature):
            abort(403)
        with restart_lock:
            now = time.monotonic()
            for used in [key for key, expiry in restart_nonces.items() if expiry <= now]:
                del restart_nonces[used]
            if nonce in restart_nonces:
                abort(403)
            restart_nonces[nonce] = now + 61
            restart_at, restart_expires = now + seconds, now + 120
        return jsonify(presence=resources.reservations()[0])

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
            feedback.note(song=track["title"], channel=track["channel"], video=track["id"], playing=data["playing"])
        device_info = data.get("device_info")
        playback_fields = {key: data[key] for key in ("status", "duration", "queue", "queue_rev", "epoch", "local_play", "acks") if key in data}
        if playback_fields:
            device_info = {**(device_info if isinstance(device_info, dict) else {}), **playback_fields}
        queue = device_info.get("queue") if isinstance(device_info, dict) else None
        track_ids = queue.get("track_ids") if isinstance(queue, dict) else None
        if isinstance(track_ids, list) and len(track_ids) > 1000:
            raise ApiError("Invalid playback queue.", 400)
        counters = data.get("counters")
        # The same check-in lists this device for "Connect to a device" and collects a transfer sent to it.
        if track and data["playing"] and opus_warmer and re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", track["id"]):
            opus_warmer.now_playing(track["id"])
        identity = listener_identity()
        background = background_activity()
        room_heartbeat = app.extensions["listening_rooms"].playback_heartbeat if background else None
        command, controls, epoch = playback_devices.report(g.user, device, device_info, data["playing"],
                                                          track, data.get("position"), identity,
                                                          background=background, room_heartbeat=room_heartbeat)
        owner = g.user
        writes = []
        accepted = False
        if catalogue_lock.acquire(timeout=.05):
            try:
                preferences = profile_store.preferences(owner) if family_mode else {}
                if preferences.get('listening_history_paused', False):
                    accepted = counters is not None  # Acknowledged so the app stops resending; nothing is recorded.
                else:
                    if counters is not None:
                        try:
                            version = file_version(listening_history.path(owner).with_suffix('.cleared'))
                        except FileNotFoundError:
                            version = None
                        cached_version, cleared = history_markers.get(owner, (None, None))
                        if version != cached_version:
                            cleared = listening_history.cleared_at(owner) if version is not None else None
                            history_markers[owner] = version, cleared
                        after_day = max(cleared or '', preferences.get('listening_history_resumed_at', ''))[:10]
                        try:
                            listening_stats.sync(owner, data.get("counter_device_id") or device, counters,
                                                 after_day=after_day, writes=writes)
                        except ValueError as error:
                            raise ApiError(str(error), 400)
                        accepted = True
                    try:
                        listening_stats.heartbeat(owner, device, data["playing"], count_time=counters is None,
                                                  track=track, writes=writes)
                    except ValueError as error:
                        raise ApiError(str(error), 429)
            finally:
                catalogue_lock.release()
        if writes:
            wait_for_write(writes[-1])
        receipt = dict(ok=True, counters_accepted=accepted, command=command, controls=controls, epoch=epoch)
        with restart_lock:
            now = time.monotonic()
            if now < restart_expires:
                receipt["restart_in_seconds"] = max(0, int(restart_at - now + .999))
        return jsonify(receipt)

    @app.get("/api/server/stats")
    def server_stats():
        if g.user not in cfg["ADMIN_USERS"]:
            raise ApiError("Only an admin can view server statistics.", 403)
        if "range" in request.args:
            return server_health(request.args["range"])
        return server_work(leaderboard=request.args.get('leaderboard') == '1')

    @app.get("/api/activity/stats")
    def activity_stats():
        return server_work(leaderboard=True)

    @app.get("/api/activity/online")
    def activity_online():
        """Online family members and what each is doing. Home asks every 30 s while it is visible."""
        profiles = profile_store.list() if family_mode else [dict(id=u, name=u) for u in cfg["ALLOWED_USERS"]]
        preferences = profile_store.read()["preferences"] if family_mode else {}
        paused = {p["id"] for p in profiles if preferences.get(p["id"], {}).get("listening_history_paused")}
        if not background_activity():
            activity.seen(g.user)
        members = activity.members(profiles, listening_stats.presence(), resources.online(), paused)
        public = (cfg.get("JELLYFIN_PUBLIC_URL") or "").rstrip("/")
        for row in members:
            if row.get("poster"):
                row["poster"] = f"{public}/{row['poster']}" if public.startswith("https://") else ""
        return jsonify(members=members)

    @app.get("/api/server/stats/now")
    def server_health_now():
        return server_health()

    def server_health(period=None):
        if g.user not in cfg["ADMIN_USERS"]:
            raise ApiError("Only an admin can view server health.", 403)
        if period is not None and period not in health_stats.RANGES:
            raise ApiError("Choose a supported time range.", 400)
        collector = app.extensions["server_health"]
        snapshot = collector.now if period is None else collector.ranges.get(period)
        if snapshot is None:
            raise ApiError("Server measurements are unavailable. Retry shortly.", 503)
        return app.response_class(snapshot, mimetype="application/json")

    def server_work(leaderboard=False):
        profiles = profile_store.list() if family_mode else [dict(id=u, name=u) for u in cfg["ALLOWED_USERS"]]
        names = {p["id"]: p["name"] for p in profiles}
        chart = deezer_chart.snapshot() if leaderboard and family_mode else {}
        wrapped_year = listening_history.utc().year if leaderboard and family_mode else None
        additions = songs_added(wrapped_year) if wrapped_year is not None else {}
        with catalogue_lock if leaderboard else nullcontext():
            preferences = profile_store.read()['preferences'] if family_mode else {}
            enabled = [p for p in profiles if not preferences.get(p['id'], {}).get('listening_history_paused')]
            result = listening_stats.snapshot(enabled if leaderboard else profiles,
                                              profile_store.subscription_history() if family_mode else None,
                                              hidden={p['id'] for p in profiles if p not in enabled})
            if wrapped_year is not None:
                result['wrapped_year'] = wrapped_year
                for row in result['profiles']:
                    wrapped = listening_history.wrapped(row['id'], wrapped_year, chart)
                    row['wrapped'] = dict(wrapped, songs_added=additions.get(row['id'], 0))
        if leaderboard:
            return jsonify(result)
        disk = shutil.disk_usage(lib)
        with lock:
            now = time.time()
            deferred_fetches = 0
            if app.intake.YOUTUBE.until <= time.monotonic():
                deferred_fetches = sum(1 for j in jobs.values() if j['state'] == 'queued' and j.get('url')
                    and not foreground(j) and j.get('retry_at', 0) > now and not j['cancel'].is_set())
            result.update(catalogue_paused=not background_idle(), storage_total_bytes=disk.total, storage_free_bytes=disk.free,
                jobs=[dict(title=j["title"], owner=j["owner"], user=names.get(j["owner"], j["owner"]),
                           kind="listening" if j.get("current") else "upload" if j.get("read_local_tags") else "recording",
                           phase="Waiting for background slot" if j["state"] == "queued" and j.get("playlist_import") and not background_idle() else ("Preparing finished audio" if j.get("phase") == "prepare" else j.get("message", j.get("phase", ""))),
                           state=j["state"], download_bytes=j.get("download_bytes", 0), download_total_bytes=j.get("download_total_bytes"))
                      for j in jobs.values() if j["state"] in ("queued", "running") and (not j.get("playlist_id") or j.get("current"))])
        result["jobs"] += [{**row, "user": names.get(row["owner"],row["owner"])} for row in playlist_preparation.work()]
        tagging = catalogue_review.progress() if metadata_lookup else None
        if tagging:
            paused = not background_idle()
            result["jobs"].append(dict(title="Song tagging", owner="", user="", kind="tagging", state="queued" if paused else "running",
                phase="Paused while a song is prepared" if paused else "Looking up tags on MusicBrainz",
                processed=tagging["processed"], total=tagging["total"], remaining=tagging["remaining"],
                current_title=tagging["current_title"], download_bytes=0, download_total_bytes=None))
        result['workers'] = worker_snapshot(names, tagging, result['jobs'])
        result['worker_stages'] = stage_summary(resources, deferred_fetches)
        result['catalogue_workers'] = dict(metadata=metadata_lookup,
            source_scan=source_scan, source_auto_replace=catalogue_review.source_automation,
            automatic_attempts_per_hour=catalogue_review.automatic_limit, playlist_matching=automatic_downloads)
        with lock:
            result['playlist_backlog'] = dict(playlist_preparation.backlog_counts)
        return jsonify(result)

    def worker_snapshot(names, tagging, work):
        paused = not background_idle()
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
        if source_scan:
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

    def job_budget(job):
        app.intake.CONTROL.background = analyzing_job(job)
        budget()

    class AcquisitionDeferred(Exception):
        pass

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
        with budget_lock, job_changed:
            if fields.get("download_bytes", 0) > 0 and not job.get("download_bytes", 0):
                job_playback_stage(job, "source_bytes_received")
            budget_cache["size"] += max(0, fields.get("download_bytes", 0) - job.get("download_bytes", 0))
            job.update(fields)
            now = time.monotonic()
            if now - job.get("progress_at", 0) >= 1:
                job["progress_at"] = now
                job_changed.notify_all()

    def publish_assets(job, *, completed=False):
        if job.get("preview_failed") and not completed:
            return
        root = os.path.join(ws, ".preview-" + job["id"])
        try:
            app.intake.real_dir(root, "preview")
            playlist = os.path.join(root, "index.m3u8")
            app.intake.regular_file(playlist, "playlist")
            with open(playlist, encoding="utf-8") as fh:
                text = fh.read(1 << 20)
            lines = text.splitlines()
            segments = {line for line in lines if line and not line.startswith("#")}
            if (not segments or any(not re.fullmatch(r"seg\d{5}\.m4s", name) for name in segments)
                    or any("URI=" in line and line != '#EXT-X-MAP:URI="init.mp4"' for line in lines)):
                return
            names = {"index.m3u8", "init.mp4"} | segments
            for name in names:
                app.intake.regular_file(os.path.join(root, name), "asset")
            with lock:
                job["assets"].update(names)
                job["preview_manifest"] = text
                if job["preview_state"] != "ready":
                    job_playback_stage(job, "preview_ready")
                job["preview_state"] = "ready"
                windows_ready = len(segments) >= 2 or "#EXT-X-ENDLIST" in lines
                if windows_ready and not job.get("windows_preview_ready"):
                    job_playback_stage(job, "windows_preview_ready")
                job["windows_preview_ready"] = windows_ready
                cached = [j for j in jobs.values() if j["preview_state"] == "ready"]
                victims = preview_victims(cached, job)
                for old in victims[:max(0, len(cached) - MAX_PREVIEWS)]:
                    retire(old, preview_only=True)
                    old["assets"].clear()
                    old["preview_state"] = "expired"
        except (OSError, app.intake.IntakeError):
            pass

    def settle(job, state, message):
        with job_changed:
            job["state"], job["message"] = state, message
            if state in ("done", "error"):
                job["phase"] = state
            if state in ("done", "error", "cancelled"):
                job_playback_stage(job, "job_" + state)
            job_changed.notify_all()
            if automatic_downloads and state in ("done", "error", "cancelled"):
                backlog_wake.set()
        if job.get("library_addition") and state in ("done", "error", "cancelled"):
            save_bulk_queue()
        if feedback_event and state in ("done", "error", "cancelled"):
            feedback_event("preparation", owner=job.get("owner"), status=state)

    def save_bulk_queue():
        nonlocal bulk_revision, bulk_saved_revision
        with lock:
            rows = [{key: j[key] for key in ("id", "owner", "source_id", "meta", "created", "retry_at", "retries", "addition_playlists") if key in j}
                    for j in jobs.values() if j.get("library_addition") and j["state"] in ("queued", "running")
                    and not j["cancel"].is_set()]
            bulk_revision += 1
            revision = bulk_revision
        with bulk_file_lock:
            if revision <= bulk_saved_revision:
                return True
            temporary = bulk_path.with_suffix(".json.tmp")
            try:
                with open(temporary, "w", encoding="utf-8") as stream:
                    json.dump(rows, stream)
                os.replace(temporary, bulk_path)
                bulk_saved_revision = revision
            except OSError:
                log.warning("Could not write the library addition queue")
                with suppress(OSError):
                    os.unlink(temporary)
                return False
            return True

    addition_counts, addition_checked = {}, None
    addition_lock = threading.Lock()

    def music_manifests(root, ids=None):
        for path in root.iterdir():
            name = path.name
            if (app.intake.ID_RE.fullmatch(name) and not name.startswith('edit-')
                    and (ids is None or (name[3:14] if name.startswith('yt-') else name) in ids)):
                try:
                    yield app.intake.read_manifest(str(path))[1]
                except (OSError, ValueError, app.intake.IntakeError):
                    continue

    def songs_added(year):
        nonlocal addition_counts, addition_checked
        with addition_lock:
            if addition_checked is None or time.monotonic() - addition_checked >= 3600:
                counts = {}
                root = Path(ws)
                replaced = root / '.replaced'
                archives = [path for path in replaced.iterdir() if path.is_dir()] if replaced.is_dir() else []
                for directory in [root, *archives]:
                    for manifest in music_manifests(directory):
                        record = manifest.get('import') or {}
                        owner, added_at = record.get('added_by'), record.get('added_at')
                        if isinstance(owner, str) and isinstance(added_at, str):
                            try:
                                when = datetime.fromisoformat(added_at)
                            except ValueError:
                                continue
                            owners = counts.setdefault(when.year, {})
                            owners[owner] = owners.get(owner, 0) + 1
                addition_counts, addition_checked = counts, time.monotonic()
            return addition_counts.get(year, {})

    def work(job, url, tmp, m):
        nonlocal addition_checked
        step, intake, outcome = "fetch" if url else "stage", app.intake, ("done", DONE_TEXT)
        intake.CONTROL.cancel = job["cancel"]
        # Background work runs at lower CPU priority so a listener's song is served first.
        intake.CONTROL.background = analyzing_job(job)
        intake.CONTROL.priority = lambda: work_priority(job)
        intake.CONTROL.budget = lambda: job_budget(job)
        intake.CONTROL.publish = job["publish"]
        intake.CONTROL.committed = lambda: job.update(committed=True)
        def defer():
            raise AcquisitionDeferred()
        def defer_youtube(cooling):
            if cooling:
                defer()
        intake.CONTROL.defer_youtube = defer_youtube
        job_playback_stage(job, "worker_started")
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
                    def lease(size=0):
                        return transfers.lease(size=size, background=lambda: work_priority(job),
                                               cancelled=job["cancel"].is_set, error=intake.IntakeError,
                                               defer=defer)
                    intake.CONTROL.transfer = lease
                    intake.CONTROL.reserve = lease
                    try:
                        item = intake.cmd_fetch(SimpleNamespace(url=url, workspace=ws,
                            preview=os.path.join(ws, ".preview-" + job["id"]), cancel=job["cancel"],
                            notify=lambda: publish_assets(job), budget=lambda: job_budget(job),
                            progress=lambda **fields: download_progress(job, **fields),
                            stage=lambda stage: job_playback_stage(job, stage),
                            cleanup_preview=lambda: remove_preview(job["id"]),
                            preview_failed=lambda: job.update(preview_state="unavailable", preview_failed=True)))
                    finally:
                        intake.CONTROL.transfer = intake.CONTROL.reserve = None
                job["item"] = item["item"]
                if item.get("manifest", {}).get("audio", {}).get("sha256"):
                    with job_changed:
                        job["source_ready"] = True
                        job_playback_stage(job, "source_ready")
                        job_changed.notify_all()
                job["already_saved"] = bool(item.get("manifest", {}).get("import"))
                job["playback"] = profile(intake, item["item"], item.get("manifest", {}))
                source = item.get("manifest", {}).get("source", {})
                with lock:
                    if job.get("automatic_meta") and source.get("title"):
                        title, artist = recording_labels(source)
                        m = meta({"artist": (artist or "YouTube").removesuffix(" - Topic")[:120],
                                  "title": title[:120], "album": (source.get("album") or "Selected recordings")[:120]})
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
                            retire(old, preview_only=True)
                            old["assets"].clear()
                            old["preview_state"] = "expired"
                    preview = intake.cmd_preview(SimpleNamespace(item=item["item"], output=root,
                        notify=lambda: publish_assets(job)))
                    publish_assets(job, completed=True)
                    with lock:
                        job["assets"].update(preview["assets"])
                        job["preview_state"] = "ready"
                        job_playback_stage(job, "preview_ready")
                except Exception as e:
                    log.warning("preview for job %s failed: %s", job["id"], type(e).__name__)
                    job["preview_state"] = "unavailable"
            can_analyze = url and os.path.isdir(item["item"])
            with job_changed:
                if job["cancel"].is_set():
                    raise intake.IntakeError("cancelled")
                # A save request either reaches this worker or sees a finished preview to promote.
                if not job["save"]:
                    if can_analyze and not job.get("analysis"):
                        job.update(analysis_state="pending", analysis_queued_at=time.monotonic())
                    settle(job, "done", "Prepared")
                    return
            if url and "gain_db" not in job.get("playback", {}):
                try:
                    job["playback"] = profile(intake, item["item"], item.get("manifest", {}), measure=True)
                except (ValueError, OSError, intake.IntakeError):
                    pass  # Measurement failure must not discard playable audio.
            step = "import"
            job["phase"] = step
            settle(job, "running", STEP_TEXT[step])
            if job["cancel"].is_set():
                raise intake.IntakeError("cancelled")
            record = item.get("manifest", {}).get("import")
            if record:
                with job["publish"], lock:
                    if job["cancel"].is_set():
                        raise intake.IntakeError("cancelled")
                    title, artist = recording_labels(item["manifest"]["source"], record)
                    job.update(artist=artist, title=title, committed=True)
            else:
                with job["publish"], lock:
                    job["metadata_locked"] = True
                    m = job["meta"]
                    job.update(artist=m["artist"], title=m["title"])
                with resources.track("import", "import lock") as running, import_lock:
                    running()
                    job_budget(job)
                    if not job.get("local_existing"):
                        owner = None if job.get('source_replacement') else job['owner']
                        intake.cmd_import(SimpleNamespace(item=item["item"], library=lib, added_by=owner,
                                                          automatic_title=bool(url and job.get("automatic_meta")), **m))
                        with addition_lock:
                            addition_checked = None
            job["committed"] = True
            job["temporary_item"] = False
            refresh_library_item(item['item'])
            step = "prepare"
            job["phase"] = step
            settle(job, "running", STEP_TEXT[step])
            resource_changed()
            job_playback_stage(job, "purification_started")
            try:
                prepare_record(finished_audio, listening_versions, lib, item["item"],
                               background=lambda: analyzing_job(job))
            finally:
                refresh_library_item(item['item'])
            job_playback_stage(job, "purification_finished")
            if can_analyze and not job.get("analysis"):
                job.update(analysis_state="pending", analysis_queued_at=time.monotonic())
        except AcquisitionDeferred:
            with job_changed:
                if job["cancel"].is_set():
                    settle(job, "cancelled", "Cancelled")
                else:
                    job.update(phase="queued")
                    settle(job, "queued", "Waiting for background slot")
            return
        except Exception as e:  # the browser gets a fixed message; the log keeps only a known reason, never URLs or paths
            if (job.get("library_addition") and not job["cancel"].is_set() and not job.get("committed")
                    and job.get("retries", 0) < 3 and isinstance(e, intake.IntakeError)
                    and re.search(r"timed?\s*out|timeout|connection reset|\b50[0234]\b", str(e), re.I)):
                with job_changed:
                    retries = job.get("retries", 0) + 1
                    job.update(retries=retries, retry_at=time.time() + 30 * 2 ** (retries - 1) + random.uniform(0, 10),
                               phase="queued")
                    settle(job, "queued", "Waiting to retry")
                save_bulk_queue()
                return
            reason = upload_failure(e) if isinstance(e, intake.IntakeError) else None
            log.warning("job %s failed at %s: %s%s", job["id"], step, type(e).__name__, f" ({reason[0]})" if reason else "")
            outcome = (("cancelled", "Cancelled") if job["cancel"].is_set() and not job.get("committed") else
                       ("error", FAIL_TEXT[step] if isinstance(e, intake.IntakeError) or step == "prepare" else "Import failed unexpectedly."))
            if outcome[0] == "error" and reason and step == "stage":
                outcome = ("error", reason[1])
            if str(e) == "scratch capacity exceeded":
                outcome = ("error", "The server needs more processing space. Ask the server owner to free space.")
        finally:
            intake.CONTROL.cancel = intake.CONTROL.budget = intake.CONTROL.publish = None
            intake.CONTROL.committed = intake.CONTROL.defer_youtube = intake.CONTROL.priority = None
            intake.CONTROL.background = False
        remove_upload(tmp)
        if outcome[0] == "cancelled" or (outcome[0] == "error" and step == "fetch"):
            with suppress(OSError, intake.IntakeError):
                remove_preview(job["id"])
            job["assets"].clear()
            job["preview_state"] = "expired"
        with catalogue_lock:
            if job.get("committed") and job.get("addition_playlists"):
                messages = [append_library_song(job["owner"], target, job["source_id"])
                            for target in job["addition_playlists"]]
                job["playlist_error"] = next((message for message in messages if message), None)
            settle(job, *outcome)

    def analyze_job(job):
        intake = app.intake
        wav = os.path.join(ws, ".preview-" + job["id"], "analysis.wav")
        intake.CONTROL.cancel = job["cancel"]
        # Background work runs at lower CPU priority so a listener's song is served first.
        intake.CONTROL.background = analyzing_job(job)
        intake.CONTROL.budget = budget
        try:
            budget()
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
        except (intake.IntakeError, ValueError, OSError):
            job["analysis"] = {"reliable": False, "reason": "Beat analysis unavailable"}
        finally:
            with suppress(OSError):
                os.unlink(wav)
            with lock:
                job.update(analysis_state="done", analyzing=False)
            intake.CONTROL.cancel = None
            intake.CONTROL.background = False
            intake.CONTROL.budget = None

    def analyzing_job(job):
        # True for work nobody is waiting on: beat analysis and background playlist songs.
        return bool(job.get("analyzing")) or not (foreground(job) or job.get("shared_foreground"))

    def work_priority(job, analyzing=False):
        if analyzing or job.get('analyzing'):
            return 3
        if foreground(job) or job.get('shared_foreground'):
            return 0
        return 1 if job.get('requested_download') or job.get('library_addition') else 2

    # Background work (playlist songs, analysis) scales with the server's cores, leaving half of
    # them for songs someone is waiting to hear; never fewer than eight slots in total.
    background_workers = cfg.get("BACKGROUND_WORKERS") or (3 if cfg["PUBLIC_ORIGIN"] == "https://music.test" else max(1, (resources.cpu_capacity + 1) // 2))
    workers = max(8, background_workers + 4)
    idle_acquisitions = workers if enabled("FAMILYHUB_IDLE_ACQUISITION") else background_workers
    idle_analysis = enabled("FAMILYHUB_IDLE_ANALYSIS")

    def background_cap():
        # People online reserve a little capacity, but playlist imports and library additions keep
        # their usual slots; only the extra idle capacity waits for everyone to leave.
        _, reserved_cpu, _ = resources.reservations()
        return max(max(1, background_workers - reserved_cpu), resources.background_slots(idle_acquisitions))
    # Keep a dispatch lane reclaimable even when all ordinary slots are doing work.
    acquisition_slots = [None] * (workers + 1)

    def foreground(job, analyzing=False):
        has_stream = job.get("source_ready") or job.get("preview_state") == "ready"
        return not analyzing and not (job.get("phase") == "prepare" and has_stream) and (
            job.get("current") or not job.get("playlist_import") and job.get("priority", 20) == 0)

    def resource_queue():
        with lock:
            active = [slot for slot in acquisition_slots if slot]
            sources = {j.get("source_id") for j, analyzing in active if not analyzing and j.get("source_id")}
            background = sum(not foreground(j, analyzing) for j, analyzing in active)
            used = len(active)
            cap = background_cap()
            ordered = sorted(jobs.values(), key=lambda j: (
                work_priority(j, j["state"] == "done"), j["priority"], j["created"]))
            for job in ordered:
                analyzing = job["state"] == "done" and job.get("analysis_state") == "pending" and not job.get("analyzing")
                if job["cancel"].is_set() or (job["state"] != "queued" and not analyzing):
                    continue
                source = job.get("source_id")
                is_foreground = bool(foreground(job, analyzing))
                if job.get('pending_persistence'):
                    reason = 'saving queue'
                elif source in sources:
                    reason = "same source"
                elif not is_foreground and not analyzing and job.get("url") and app.intake.YOUTUBE.until > time.monotonic():
                    reason = "YouTube cooldown"
                elif not is_foreground and background >= cap:
                    reason = "presence or background capacity"
                elif used >= workers + is_foreground:
                    reason = "acquisition capacity"
                else:
                    reason = "dispatch"
                    used += 1
                    background += not is_foreground
                    if source and not analyzing:
                        sources.add(source)
                stage = "analysis" if analyzing else "fetch" if job.get("url") else "import"
                yield stage, reason, job.get("analysis_queued_at" if analyzing else "queued_at", time.monotonic())
                if stage == "fetch":
                    yield "preview", reason, job["queued_at"]

    def resource_metrics():
        with playback_devices.lock:
            now = playback_devices.clock()
            online = sum(now - d["at"] <= playback_devices.ONLINE_SECONDS for d in playback_devices.devices.values())
        with transfers.transfer_condition:
            active = transfers.active
        with transfers.condition:
            reserved = transfers.reserved
        with lock:
            acquisitions = sum(slot is not None for slot in acquisition_slots)
        free = "unknown"
        with suppress(OSError):
            free = shutil.disk_usage(ws).free >> 20
        return dict(online=online, acquisition=f"{acquisitions}/{len(acquisition_slots)}",
                    acquisition_background_cap=background_cap(),
                    transfer=f"{active}/{transfers.idle_capacity}", scratch_reserved_MiB=reserved >> 20,
                    scratch_free_MiB=free, rss_MiB=runtime_capacity(rss_only=True),
                    youtube_cooldown_s=max(0, round(app.intake.YOUTUBE.until - time.monotonic())),
                    **playlist_preparation.backlog_counts)

    logging.getLogger("music_web.resources").info("resource capacity %s acquisition=%d background=%d transfer=%d",
                                                runtime_capacity(), workers, background_workers, transfers.capacity)

    def run_analysis(job):
        resources.yield_to_requests(job["cancel"].is_set)
        with resources.track("analysis"):
            analyze_job(job)

    def drain():
        with ThreadPoolExecutor(max_workers=len(acquisition_slots), thread_name_prefix="music-acquire") as pool, \
                ThreadPoolExecutor(max_workers=len(acquisition_slots), thread_name_prefix="music-analysis",
                                   initializer=lower_background_priority) as analysis_pool:
            active, last_served = {}, {}
            dispatch_number = 0
            while True:
                dispatch_wake.clear()
                for future in list(active):
                    if not future.done():
                        continue
                    with lock:
                        job, analyzing, slot = active.pop(future)
                        acquisition_slots[slot] = None
                        if automatic_downloads:
                            backlog_wake.set()
                    if future.exception() is not None:
                        log.warning("job %s worker failed: %s", job["id"], type(future.exception()).__name__)
                        if analyzing:
                            with lock:
                                job.update(analysis_state="done", analyzing=False)
                        else:
                            # Terminal queue persistence must not run inside the scheduler lock.
                            settle(job, "error", "Recording preparation failed.")
                with lock, resources.condition:
                    # Optional beat analysis reads a published recording and owns
                    # its own WAV; it must not delay another listener's playback.
                    sources = {job.get("source_id") for job, analyzing, _ in active.values()
                               if job.get("source_id") and not analyzing}
                    requested = {j.get("source_id") for j in jobs.values() if j["state"] == "queued"
                                 and not j["cancel"].is_set() and foreground(j)}
                    for job, analyzing, _ in active.values():
                        if not analyzing:
                            job["shared_foreground"] = bool(job.get("source_id") and job["source_id"] in requested)
                    resources.condition.notify_all()
                    background = sum(analyzing_job(job) for job, _, _ in active.values())
                    extra = any(not foreground(j, a) for j, a, _ in active.values())
                    pending = [(j, False) for j in jobs.values() if j["state"] == "queued"
                               and not j.get('pending_persistence') and not j["cancel"].is_set() and j.get("source_id") not in sources]
                    pending += [(j, True) for j in jobs.values() if j["state"] == "done"
                                and j.get("analysis_state") == "pending" and not j.get("analyzing")
                                and not j["cancel"].is_set() and j.get("source_id") not in sources]
                    now = time.monotonic()
                    cooldown = app.intake.YOUTUBE.until - now
                    wall_now = time.time()
                    cap = background_cap()
                    wait_times = []
                    if len(active) < workers and background < idle_acquisitions:
                        if any(not foreground(j, a) for j, a in pending) and cap <= background:
                            delay = resources.background_delay(background + 1)
                            if delay is not None:
                                wait_times.append(delay)
                        elif cooldown > 0 and any(not foreground(j, a) and not a and j.get("url") for j, a in pending):
                            wait_times.append(cooldown)
                        elif cap > background and cooldown <= 0:
                            wait_times.extend(j["retry_at"] - wall_now for j, a in pending
                                              if not foreground(j, a) and j.get("retry_at", 0) > wall_now)
                    pending = [(j, a) for j, a in pending
                               if (foreground(j, a) and len(active) < workers + (extra and j.get("priority") == 0)
                                   or (not foreground(j, a) and len(active) < workers and background < cap
                                       and (cooldown <= 0 or a or not j.get("url"))
                                       and (a or j.get("retry_at", 0) <= wall_now)))]
                    if pending:
                        job, analyzing = min(pending, key=lambda pair: (
                            work_priority(*pair),
                            pair[0]["priority"] + (20 if pair[1] else 0),
                            last_served.get((pair[0]["priority"] + (20 if pair[1] else 0), pair[0]["owner"], pair[0].get("playlist_id")), -1),
                            pair[0]["created"]))
                        dispatch_number += 1
                        last_served[(job["priority"] + (20 if analyzing else 0), job["owner"], job.get("playlist_id"))] = dispatch_number
                        if analyzing:
                            job["analyzing"] = True
                            future = analysis_pool.submit(run_analysis, job)
                        else:
                            job["state"] = "running"
                            job_changed.notify_all()
                            future = pool.submit(work, job, job.get("url"), job.get("tmp"), job["meta"])
                        slot = acquisition_slots.index(None)
                        acquisition_slots[slot] = (job, analyzing)
                        active[future] = (job, analyzing, slot)
                        future.add_done_callback(lambda _: dispatch_wake.set())
                        continue
                    if not active and not any(not j["cancel"].is_set() and
                            (j["state"] == "queued" or j.get("analysis_state") == "pending") for j in jobs.values()):
                        app.extensions["music"].worker = None
                        return
                dispatch_wake.wait(min(wait_times, default=None))

    def wake_dispatch():
        with lock:
            resources.wake()
            thread = app.extensions["music"].__dict__.get("worker")
            if not thread or not thread.is_alive():
                thread = threading.Thread(target=drain, daemon=True)
                app.extensions["music"].worker = thread
                thread.start()
            dispatch_wake.set()

    def enqueue_acquisition(job, url, tmp):
        with lock:
            if "url" not in job:
                job.update(url=url, tmp=tmp, state="queued", queued_at=time.monotonic())
            wake_dispatch()

    def start(job, url, tmp, m):
        enqueue_acquisition(job, url, tmp)
        return jsonify(job=public(job)), 202

    playlist_store = PlaylistStore(cfg)
    playlist_artwork = PlaylistArtwork(ws, resources)

    @app.errorhandler(ArtworkError)
    def playlist_artwork_error(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(PlaylistError)
    def playlist_error(error):
        return jsonify(error=str(error)), 400

    def visible_playlist(playlist, owner):
        playlist = dict(playlist)
        playlist["tracks"] = [{key: value for key, value in track.items() if key != "backlog_retry"}
                              for track in playlist["tracks"]]
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
        with catalogue_lock:
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
        recordings = {row["id"]: row for row in library_tracks()}
        for recording in recordings.values():
            key = library_match_key(recording["title"], recording["channel"])
            available.setdefault(key, []).append(recording)
        with catalogue_lock:
            playlists = []
            owners = [g.user] + ([p["id"] for p in profile_store.list() if p["id"] != g.user] if family_mode else [])
            for owner in owners:
                for playlist in playlist_store.list(owner):
                    if owner != g.user and not (playlist.get("shared") is True
                            or g.user in playlist.get("co_authors", []) or g.user in cfg["ADMIN_USERS"]):
                        continue
                    changed = False
                    for track in playlist["tracks"]:
                        previous = dict(track)
                        source = track.get("source_id") or (track.get("match") or {}).get("id")
                        ready = recordings.get(source)
                        if not source:
                            key = library_match_key(track["title"], track["artist"])
                            ready = reuse_library_match(track, available.get(key, []))
                        job = jobs.get(track.get("job_id"))
                        if ready:
                            track.update(source_id=ready["id"], match=ready, state="saved")
                            if source and track.get("spotify_uri", "") in ("", "library:" + source, "youtube:" + source):
                                track.update(title=ready["title"], artist=ready["channel"])
                            track.pop("backlog_retry", None)
                        elif job and job["owner"] == owner:
                            track["state"] = ("preparing" if job["state"] == "done"
                                              and (job.get("committed") or job.get("already_saved")) else job["state"])
                        elif source and saved_source(source):
                            track["state"] = "preparing"
                        elif track.get("state") in ("saved", "queued", "running"):
                            track["state"] = "ready" if source else "unmatched"
                        changed |= track != previous
                    if changed:
                        playlist_store.save(owner, playlist)
                    playlists.append(visible_playlist(playlist, owner))
        return jsonify(playlists=playlists)

    @app.post("/api/playlists/spotify")
    @app.post("/api/playlists/youtube")
    def preview_spotify():
        if not allow("playlist-import:" + g.user, 10, 60):
            raise ApiError("Wait a minute before importing another playlist.", 429)
        data = body()
        target = data.get("target_id")
        if target is not None:
            with catalogue_lock:
                existing = playlist_store.read(g.user, target)
                if playlist_preparation.is_active(g.user, target):
                    raise ApiError("Wait for this playlist operation to finish.", 409)
                if existing["tracks"] or data.get("revision") != existing["revision"]:
                    raise ApiError("Import into an empty, unchanged playlist.", 409)
        playlist = (fetch_youtube_playlist(data.get("url"), app.intake) if request.path.endswith("/youtube")
                    else fetch_playlist(data.get("url")))
        with catalogue_lock:
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
        feedback.note(playlist_name=name)
        with catalogue_lock:
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
        fallback = []
        try: url, name = radio.seed(artist, title)
        except (PlaylistError, OSError, ValueError) as error:
            app.logger.warning("radio seed failed: %s", type(error).__name__)
            fallback = radio.related_library(artist, genre_labels.get(artist), library_tracks())
            fallback = [t for t in fallback if radio._key(radio.clean_title(artist, t['title'])) != radio._key(radio.clean_title(artist, title))]
            if not fallback:
                raise ApiError("Radio could not find songs. Try another artist or choose songs from your library.",
                               404 if isinstance(error, PlaylistError) else 503)
            url, name = '', (radio.clean_title(artist, title) or artist) + ' Radio'
        with catalogue_lock:
            if len(playlist_store.list(g.user)) >= 100:
                raise ApiError("You can save up to 100 playlists.")
            pid = "".join(secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") for _ in range(22))
            playlist = {"id": pid, "name": name[:200], "revision": 1, "tracks": [], "notice": "", "url": "", "shared": True,
                        "description": "Songs like " + name.removesuffix(" Radio")[:180], "radio": True}
            if url:
                radio_sources[url] = artist, title
                while len(radio_sources) > 128:
                    radio_sources.popitem(last=False)
            playlist['tracks'] = [dict(title=t['title'], artist=t['channel'], duration=t['duration'],
                                       spotify_uri='library:' + t['id'], candidates=[],
                                       source_id=t['id'], state='saved', match=t) for t in fallback]
            playlist_store.save(g.user, playlist)
        try:
            if not fallback:
                playlist_preparation.begin_import(g.user, pid, 1, "radio", url, True, name[:200])
        except ValueError as error: raise ApiError(str(error), 409)
        return jsonify(playlist=visible_playlist(playlist_store.read(g.user, pid), g.user)), 201

    @app.route("/api/playlists/<pid>", methods=["PATCH", "DELETE"])
    def edit_playlist(pid):
        data = body(751024 if request.method == "PATCH" else 8192)
        owner = data.get("owner_id", g.user)
        prepared_cover = None
        details = data.get('details')
        image = details.get('cover_image') if isinstance(details, dict) else data.get('cover_image')
        if request.method == 'PATCH' and image is not None:
            with catalogue_lock:
                editable_playlist_owner(pid, data)
                if data.get('revision') != playlist_store.read(owner, pid)['revision']:
                    raise ApiError('This playlist changed. Refresh it before editing.', 409)
            # Encode before taking the transaction lock; revision is checked again below.
            prepared_cover = playlist_artwork.save(owner, pid, image)
        if request.method == "DELETE" and family_mode and g.user not in cfg["ADMIN_USERS"]:
            raise ApiError("Only an admin can delete playlists.", 403)
        with catalogue_lock:
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
                if "cover_image" in details and prepared_cover is None:
                    raise ArtworkError('Choose a JPEG or PNG image.')
                digest = prepared_cover
                playlist.update(name=name, description=description)
                if "shared" in details: playlist["shared"] = details["shared"]
                if digest: playlist["cover_sha256"] = digest
            elif operation == {"name"}:
                playlist["name"] = playlist_name(data["name"])
            elif operation == {"cover_image"}:
                if prepared_cover is None:
                    raise ArtworkError('Choose a JPEG or PNG image.')
                playlist['cover_sha256'] = prepared_cover
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
                if any((row.get("source_id") or (row.get("match") or {}).get("id")) == source_id for row in tracks):
                    raise ApiError("This song is already in the playlist.", 409)
                append_saved_entry(tracks, g.user, source_id, item)
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

    def matching_search(args, background=True):
        args.youtube_caller = "matching"
        args.youtube_background = background
        return app.intake.cmd_search(args)

    def match_playlist_recording(user, track, progress):
        source = track.get("source_id") or (track.get("match") or {}).get("id")
        if source:
            existing = saved_source(source)
            if existing:
                try: return library_record(existing)[0]
                except ApiError as error:
                    if error.code != 503: raise
            if track.get("match") and track["match"].get("url"):
                return {**track["match"], "saved": False}
        ready = reuse_library_match(track, library_tracks())
        if ready is not None:
            return ready
        # Re-evaluate persisted choices before making another network request.
        if track.get("candidates"):
            track["candidates"] = rank_matches(track, track["candidates"])
            cached = pick_equivalent(track, track["candidates"]) or preferred_match(track["candidates"])
            if cached is not None:
                return cached
        progress("Searching YouTube")
        query = (track["artist"].split(",")[0] + " " + track["title"])[:200]
        found = matching_search(SimpleNamespace(query=query, limit=30, offset=0))["results"]
        track["candidates"] = rank_matches(track, found, search=matching_search)
        return pick_equivalent(track, track["candidates"]) or preferred_match(track["candidates"])

    def queue_playlist_recording(user, pid, row, source_replacement=False, requested=False):
        with app.app_context():
            g.user = user
            source = app.intake.video_id(row["url"])
            metadata = fetch_metadata(row, source)
            with lock:
                job = new_job(user, "fetch", metadata, source, 20, True, preserve_priority=True)
                if not foreground(job):
                    job["playlist_import"] = True
                    job["playlist_id"] = pid
                if source_replacement:
                    job["source_replacement"] = True
                if requested:
                    job['requested_download'] = True
                job.setdefault("automatic_meta", True)
                if job["state"] == "done":
                    job.update(state="queued", message=STEP_TEXT["import"])
                enqueue_acquisition(job, app.intake.WATCH + source, None)
                return job

    def prepare_playlist_recording(user, track, progress):
        with app.app_context():
            g.user = user
            row = match_playlist_recording(user, track, progress)
            if row is None: return None
            if row.get("saved"): return row
            track.update(source_id=row["id"], match=row)
            job = queue_playlist_recording(user, getattr(progress, "playlist_id", None), row,
                                           getattr(progress, "source_replacement", False),
                                           requested=not getattr(progress, 'source_replacement', False))
            release = getattr(progress, "release_slot", None)
            if release:
                release()
            last_progress = None
            with waiting("acquisition"):
                while job["state"] in ("queued", "running"):
                    if job["state"] == "queued" and getattr(progress, "stopped", lambda: False)():
                        raise InterruptedError()
                    message = "Preparing finished audio" if job.get("phase") == "prepare" else job.get("message", "Preparing recording")
                    fields = {"file_phase": "queued" if job["state"] == "queued" else ("downloading" if job.get("phase") == "fetch" else "purifying"),
                              "download_bytes": job.get("download_bytes", 0),
                              "download_total_bytes": job.get("download_total_bytes")}
                    snapshot = (message, fields)
                    if snapshot != last_progress:
                        progress(message, **fields)
                        last_progress = snapshot
                    with job_changed:
                        if job['state'] in ('queued', 'running'):
                            job_changed.wait(timeout=1)
            if job["state"] != "done": raise ValueError("Recording preparation failed.")
            ready = library_record(saved_source(row["id"]))[0]
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
        if provider == "radio":
            try:
                return radio.read_radio(url, "Radio", progress)
            except (OSError, ValueError, PlaylistError):
                artist, title = radio_sources.get(url, ('', ''))
                found = radio.related_library(artist, genre_labels.get(artist), library_tracks())
                found = [t for t in found if radio._key(radio.clean_title(artist, t['title'])) != radio._key(radio.clean_title(artist, title))]
                if not found:
                    raise
                return dict(name='Radio', url=url, tracks=[dict(title=t['title'], artist=t['channel'],
                            duration=t['duration'], spotify_uri='library:' + t['id'], candidates=[],
                            source_id=t['id'], state='saved', match=t) for t in found])
        data = fetch_youtube_playlist(url, app.intake)
        progress(len(data["tracks"]), len(data["tracks"]))
        return data

    playlist_preparation = PlaylistPreparation(playlist_store, catalogue_lock, prepare_playlist_recording,
                                               match_playlist_recording, read_imported_playlist, download_workers=background_workers,
                                               resources=resources)
    app.extensions["music"].playlist_preparation = playlist_preparation
    if automatic_downloads:
        playlist_preparation.backlog_wake = backlog_wake
        playlist_store.changed = playlist_preparation.backlog_changed
    playlist_preparation.recheck_stored_reviews([p["id"] for p in profile_store.list()] if family_mode else sorted(allowed))
    app.extensions["music"].catalogue_review = catalogue_review
    def review_recording(identifier):
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})",identifier): raise ApiError("Choose a saved song.")
        item=saved_source(identifier)
        if not item:raise ApiError("Save this song on the server before requesting review.",404)
        return library_record(item)[0],item['manifest']['import']['library_sha256']
    def review_rate():
        if not allow('catalogue-review:'+g.user,20,60):raise ApiError("Wait before flagging more songs.",429)

    def playlist_review_gaps():
        owners = [profile['id'] for profile in profile_store.list()] if family_mode else [g.user]
        gaps = []
        for owner in owners:
            for playlist in playlist_store.list(owner, snapshot=True):
                view = visible_playlist(playlist, owner)
                editable = owner == g.user or g.user in playlist.get('co_authors', [])
                for index, track in enumerate(playlist['tracks']):
                    state = track.get('state', 'unmatched')
                    if (track.get('source_id') or track.get('match')) and state not in ('error', 'review'):
                        continue
                    retry = track.get('backlog_retry') or {}
                    retry_at = retry.get('at', 0) if not playlist.get('auto_download_paused') else 0
                    retry_reason = ('Recording search failed' if state == 'error' else 'No verified recording match') if retry_at else ''
                    gaps.append(dict(playlist_id=playlist['id'], owner_id=owner, playlist_name=playlist['name'],
                                     index=index, title=track['title'], artist=track['artist'],
                                     artwork_url=view.get('cover_url', ''), state=state, can_edit=editable,
                                     retry_at=retry_at, retry_reason=retry_reason))
        return gaps

    register_catalogue_review(app, body, catalogue_review, review_recording, lambda: g.user in cfg['ADMIN_USERS'],
                              review_rate, playlist_review_gaps, metadata_automatic=metadata_lookup)
    def replacement_busy(identifier):
        with lock:
            return any(j.get('source_id') == identifier and j['state'] in ('queued', 'running') for j in jobs.values())

    def report_source(identifier):
        saved = saved_source(identifier)
        if not saved:
            raise ApiError("This recording is unavailable.", 404)
        manifest = saved['manifest']
        record = manifest['import']
        return dict(id=identifier, sha256=manifest['audio']['sha256'], title=record['title'],
                    artist=record['artist'], duration=manifest['audio']['duration'], verdict='unknown',
                    source_tier=None, stamp=None)

    def replace_source(user, identifier, candidate, automatic, expected_digest, explicit):
        from .source_quality import analyze, automatic_match, manual_match, replace_saved, ScanPaused, SourceCheckError
        if not background_idle():
            raise ScanPaused()
        old = saved_source(identifier)
        if not old or old['manifest']['audio']['sha256'] != expected_digest or app.intake.video_id(candidate['url']) != candidate['id']:
            raise SourceCheckError('The recording changed. Refresh song review and compare the recordings.')
        old_record = old['manifest']['import']
        if automatic:
            old_digest = old_record['library_sha256']
            if listening_versions.versions.get(identifier, {}).get('source_sha256') == old_digest:
                raise SourceCheckError('This recording has a custom listening edition. Compare the recordings before replacing it.')
            artist, title = automatic['artist'], normal(automatic['title'])
            old_metadata = catalogue_review.overrides(identifier, old_digest)
            old_source = old['manifest']['source']
            old_titles = (old_source.get('title'), old_source.get('track_title'), old_metadata.get('title', old_record['title']))
            if (any(normal(presentation_title(value, artist)) != title for value in old_titles if value)
                    or normal(old_metadata.get('artist', artist)) != normal(artist)):
                raise SourceCheckError('The original title or artist identifies a different edition. Compare the recordings.')
        scanner = app.extensions['music'].source_quality
        with scanner.lock:
            expected = dict(scanner.rows.get(identifier + ':' + expected_digest, {}))
        def progress(*args, **kwargs): pass
        progress.source_replacement = True
        prepare_playlist_recording(user, dict(source_id=candidate['id'], match=candidate), progress)
        resources.wait_background()
        new = saved_source(candidate['id'])
        if not new:
            raise SourceCheckError('The suggested recording could not be prepared.')
        _, manifest, audio = app.intake.load_item(new['item'])
        candidate_source = dict(manifest['source'], duration=manifest['audio']['duration'])
        if explicit:
            candidate = {**candidate, 'title': manifest['import']['title'],
                         'channel': candidate_source.get('channel') or manifest['import']['artist'],
                         'duration': candidate_source['duration']}
            identity = True
        elif automatic:
            new_digest = manifest['import']['library_sha256']
            if listening_versions.versions.get(candidate['id'], {}).get('source_sha256') == new_digest:
                raise SourceCheckError('The suggested recording has a custom listening edition. Compare the recordings before replacing it.')
            identity = automatic_match(dict(automatic, id=identifier), candidate_source)
        else:
            candidate_source.setdefault('title', manifest['import']['title'])
            candidate_source.setdefault('channel', candidate['channel'])
            identity = expected and manual_match(expected, candidate_source)
        if not identity:
            raise SourceCheckError('The prepared recording did not pass the artist, title and duration checks.')
        quality = analyze(audio, manifest['audio']['duration'], background_idle, governor=resources)['verdict']
        if quality == 'suspect' or automatic and quality != 'clean':
            raise SourceCheckError('The suggested recording did not pass the audio quality check.')
        with app.app_context():
            g.user = user
            with scanner.scan_lock, catalogue_lock, catalogue_review.lock, listening_stats.lock:
                if not background_idle():
                    raise ScanPaused()
                if automatic and catalogue_review.overrides(identifier, old_digest) != old_metadata:
                    raise SourceCheckError('Song details changed during verification. Compare the recordings before replacing it.')
                replace_saved(ws, lib, identifier, candidate, saved_source, playlist_store,
                              catalogue_review, listening_stats, app.intake,
                              length=lambda saved: library_record(saved)[0]['duration'], automatic=automatic,
                              expected_digest=expected_digest, verified_digest=manifest['audio']['sha256'], explicit=explicit)
                if library_index is not None:
                    library_index.update({identifier: (), candidate['id']: (os.path.basename(new['item']),)})

    def undo_source(identifier, records):
        from .source_quality import undo_saved
        with app.extensions['music'].source_quality.scan_lock, catalogue_lock, catalogue_review.lock:
            if replacement_busy(identifier) or records.get(identifier, {}).get('state') == 'done' and saved_source(identifier):
                raise ValueError('The original recording already exists or is being prepared.')
            digest = undo_saved(ws, lib, identifier, records, playlist_store, catalogue_review)
            if library_index is not None:
                entry = records[identifier]
                library_index.update({identifier: (os.path.basename(entry['item']),), entry['new_id']: ()})
            return digest

    def background_idle():
        return bool(resources.background_slots(1))

    source_scan = cfg.get('SOURCE_QUALITY_SCAN', cfg['PUBLIC_ORIGIN'] != 'https://music.test')
    register_source_quality(app, ws, app.intake, background_idle, lambda: g.user in cfg['ADMIN_USERS'], catalogue_review,
                            source_scan,
                            replace=replace_source, busy=replacement_busy, undo=undo_source, body=body, report_source=report_source,
                            automatic_user=next(iter(cfg['ADMIN_USERS']), None) if cfg.get('SOURCE_AUTO_REPLACE', True) else None, state=cfg)
    def song_analysis_idle():
        with lock:
            return background_idle() and (idle_analysis or not any(
                j['state'] in ('queued', 'running') or j.get('analyzing') for j in jobs.values()))
    def warm_source(source_id):
        with app.app_context():
            item = saved_source(source_id)
            if not item: return None
            track, original = library_record(item)
            return item["item"], original, track["download_sha256"], track["title"]
    def warm_library():
        with app.app_context():
            return [row["id"] for row in library_tracks(keep_going=background_idle)]
    # Phone copies of the song playing anywhere, then the whole library while nobody waits.
    opus_warmer = (mobile_audio.Warmer(app.intake, warm_source, warm_library, background_idle)
                   if cfg.get("OPUS_WARMING", cfg["PUBLIC_ORIGIN"] != "https://music.test") else None)
    song_analysis = register_song_analysis(app, ws, lib, app.intake, song_analysis_idle,
        cfg.get('SONG_ANALYSIS_SCAN', cfg['PUBLIC_ORIGIN'] != 'https://music.test'), state=cfg)

    automatic_activity = WorkerActivity('playlist-queue', 'Playlist queue')
    if automatic_downloads or metadata_lookup:
        auto_stop = threading.Event()
        def backlog_can_start():
            active = sum(slot is not None for slot in acquisition_slots)
            queued = sum(j["state"] == "queued" and not j["cancel"].is_set() for j in jobs.values())
            return active + queued < background_cap() and app.intake.YOUTUBE.until <= time.monotonic()

        def backlog_delay():
            with lock:
                if not playlist_preparation.backlog_counts["backlog_pending"]:
                    return None
                active = sum(slot is not None for slot in acquisition_slots)
                needed = max(1, active + 1 if active >= background_cap() and active < idle_acquisitions else 1,
                             min(playlist_preparation.capacity, len(playlist_preparation.backlog_running) + 1))
                delay = resources.background_delay(needed)
                if delay is not None:
                    delay = max(delay, app.intake.YOUTUBE.until - time.monotonic())
                return delay if delay else None

        def resolve_backlog_recording(_owner, source):
            saved = saved_source(source)
            return library_record(saved)[0] if saved else None

        def automatic_playlists():
            lower_background_priority()
            next_scan = 0
            next_metadata = time.monotonic() + 30
            handback = float("inf")
            woke = True
            while not auto_stop.is_set():
                if woke:
                    backlog_wake.clear()
                now = time.monotonic()
                refresh = now >= next_scan
                started = False
                try:
                    if automatic_downloads and (woke or refresh or now >= handback):
                        owners = []
                        if refresh:
                            next_scan = now + 300
                            owners = [p["id"] for p in profile_store.list()] if family_mode else sorted(allowed)
                        with automatic_activity.track("Family library"):
                            started = playlist_preparation.sweep(owners, backlog_can_start, queue_playlist_recording,
                                                                 resolve_backlog_recording, refresh=refresh)
                        if any(playlist_preparation.backlog_counts.values()):
                            resources.wake()
                        delay = backlog_delay()
                        handback = time.monotonic() + delay if delay else float("inf")
                    if metadata_lookup and now >= next_metadata:
                        next_metadata = now + 30
                        if background_idle():
                            with automatic_activity.track("Family library"):
                                library_tracks(keep_going=background_idle)
                                catalogue_review.flush()
                except Exception as error:
                    log.warning("playlist backlog or metadata check failed: %s", type(error).__name__)
                    started = False
                    handback = float("inf")
                if started:
                    woke = True
                    continue
                deadline = min(next_scan if automatic_downloads else float("inf"), handback,
                               next_metadata if metadata_lookup else float("inf"))
                woke = backlog_wake.wait(max(0, deadline - time.monotonic()))
        def apply_metadata_votes():
            # scripts/metadata-ai-vote.py drops model votes here; they are applied once and removed.
            inbox = state_path(cfg, ".metadata-votes.json")
            if not os.path.exists(inbox): return
            try:
                with open(inbox, encoding="utf-8") as handle: data = json.loads(handle.read(4 << 20))
                catalogue_review.apply_votes(data.get("votes", []), str(data.get("label", "AI vote"))[:80], suggest_only=True)
            except (OSError, ValueError, AttributeError) as error:
                log.warning("metadata votes: %s", type(error).__name__)
            with suppress(OSError): os.remove(inbox)
        def tag_songs():
            background_request.set(True)
            # One tagger works continuously while nobody needs a song prepared. MusicBrainz allows
            # about one request a second per server, so more taggers would only get it blocked.
            while not auto_stop.is_set():
                try:
                    if not background_idle(): auto_stop.wait(30); continue
                    apply_metadata_votes()
                    updated = {}

                    def resolve(row):
                        updated[row['id']] = ()
                        return lookup_catalogue_metadata(row)

                    processed = catalogue_review.process_one(background_idle, resolver=resolve)
                    if library_index is not None and updated:
                        library_index.update(updated)
                    if not processed: auto_stop.wait(30)
                except Exception as error:
                    log.warning("song tagging: %s", type(error).__name__); auto_stop.wait(30)
        if metadata_lookup:
            threading.Thread(target=tag_songs,name="song-tagging",daemon=True).start()
        auto_thread = threading.Thread(target=automatic_playlists,name="playlist-idle-queue",daemon=True)
        app.extensions["music"].auto_playlist_stop = auto_stop
        app.extensions["music"].auto_playlist_thread = auto_thread

    @app.get("/api/playlists/link-name")
    def playlist_link_name():
        url = request.args.get("url", "")
        if not 1 <= len(url) <= 2048: raise ApiError("Paste a playlist link.")
        if not allow("link-name:" + g.user, 30, 60): raise ApiError("Wait a moment before checking another link.", 429)
        try: provider, name = link_playlists.link_name(url, intake=app.intake)
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
        feedback.note(provider=provider, playlist=pid, append=bool(data.get("append")))
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
            with catalogue_lock:
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
            with catalogue_lock:
                if request.method == "GET" and request.args.get("follow") == "1":
                    owner = request.args.get("owner_id", g.user)
                    playlist = playlist_store.read(owner, pid)
                    if owner != g.user and not (family_mode and (playlist.get("shared") is True
                            or g.user in playlist.get("co_authors", []) or g.user in cfg["ADMIN_USERS"])):
                        raise ApiError("This playlist is unavailable.", 403)
                    status = playlist_preparation.status(owner, pid)
                    return jsonify(state=status["state"], download_after_matching=status.get("download_after_matching", False))
                owner = editable_playlist_owner(pid, data)
                if request.method == "POST": status = playlist_preparation.start(owner, pid, data.get("mode", "download"), actor=g.user)
                elif request.method == "DELETE":
                    status = playlist_preparation.pause(owner, pid)
                    with job_changed:
                        job_changed.notify_all()
                else: status = playlist_preparation.status(owner, pid)
        except ValueError as error: raise ApiError(str(error), 409)
        return jsonify(status)

    @app.get("/api/playlists/<pid>/match")
    def playlist_candidates(pid):
        index = request.args.get("index", type=int)
        with catalogue_lock:
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
        with catalogue_lock:
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
            track.pop("backlog_retry", None)
            track.pop("replacement_origins", None)
            playlist["revision"] += 1
            playlist_store.save(owner, playlist)
        return jsonify(playlist=visible_playlist(playlist, owner))

    @app.post("/api/playlists/<pid>/match")
    def match_playlist_track(pid):
        data = body()
        index = data.get("index")
        with catalogue_lock:
            owner = editable_playlist_owner(pid, data)
            playlist = playlist_store.read(owner, pid)
            if playlist_preparation.is_active(owner, pid):
                raise ApiError("Pause playlist matching before choosing a recording.", 409)
            if "revision" in data and (type(data["revision"]) is not int or data["revision"] != playlist["revision"]):
                raise ApiError("This playlist changed. Reopen its recording choices.", 409)
            if type(index) is not int or not 0 <= index < len(playlist["tracks"]):
                raise ApiError("Invalid playlist entry.")
            if playlist["tracks"][index].pop("backlog_retry", None):
                playlist_store.save(owner, playlist)
        revision = playlist["revision"]
        track = playlist["tracks"][index]
        if not allow("search:" + g.user, 40, 60): raise ApiError("Search limit reached. Resume matching in a minute.", 429)
        query = (track["artist"].split(",")[0] + " " + track["title"])[:200]
        def manual_search(args):
            return matching_search(args, background=False)
        try: found = manual_search(SimpleNamespace(query=query, limit=30, offset=0))["results"]
        except Exception: raise ApiError("Could not find recordings. Try again.", 502)
        candidates = rank_matches(track, found, search=manual_search)
        with catalogue_lock:
            owner = editable_playlist_owner(pid, data)
            playlist = playlist_store.read(owner, pid)
            if playlist["revision"] != revision:
                raise ApiError("This playlist changed. Refresh it before matching.", 409)
            playlist["tracks"][index]["candidates"] = candidates
            playlist["tracks"][index].pop("backlog_retry", None)
            if playlist["tracks"][index]["state"] == "unmatched": playlist["tracks"][index]["state"] = "ready"
            playlist_store.save(owner, playlist)
        return jsonify(track=playlist["tracks"][index])

    @app.post("/api/playlists/<pid>/download")
    def download_playlist_track(pid):
        data = body(); index, choice = data.get("index"), data.get("choice")
        with catalogue_lock:
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
            job['requested_download'] = True
            job.setdefault("automatic_meta", True)
            if job["state"] == "done" and job.get("item") and job["message"] == "Prepared": job.update(state="queued", message=STEP_TEXT["import"])
            track.update(source_id=vid, match=row, job_id=job["id"], state="queued")
            track.pop("backlog_retry", None)
            track.pop("replacement_origins", None)
            playlist_store.save(g.user, playlist)
        return start(job, app.intake.WATCH + vid, None, m)

    @app.post("/api/recommendations")
    def recommendations():
        data = body()
        artist = data.get("seed_artist", data.get("query", ""))
        title = data.get("seed_title", "")
        offset = data.get("offset", 0)
        if not isinstance(artist, str) or not 1 <= len(artist.strip()) <= 120 or any(ord(c) < 32 or ord(c) == 127 for c in artist):
            raise ApiError("Invalid recommendation artist.")
        if not isinstance(title, str) or len(title) > 300 or any(ord(c) < 32 or ord(c) == 127 for c in title):
            raise ApiError("Invalid recommendation song.")
        if type(offset) is not int or not 0 <= offset <= 48 or offset % 8:
            raise ApiError("Invalid recommendation page.")
        artist = radio.first_artist(artist)
        genre = genre_labels.get(artist)
        key = (g.user, True, artist.casefold(), title.casefold())
        with lock:
            cached = search_cache.get(key) if offset else None
        if cached and time.time() - cached[0] < 300:
            _, found, from_deezer = cached
        else:
            with lock:
                if not allow("search:" + g.user, 40, 60):
                    raise ApiError("Too many searches. Wait a minute.", 429)
            library = library_tracks()
            try:
                found = similar_songs.suggestions(artist, title, library)
                from_deezer = bool(found)
            except PlaylistError:
                found = []
                from_deezer = False
            except (OSError, ValueError):
                from_deezer = False
                found = radio.related_library(artist, genre, library)
                if not found:
                    raise ApiError("Similar songs are unavailable right now. Try again later or add songs from your library.", 503)
            if not found:
                found = radio.related_library(artist, genre, library)
            found = list({row["id"]: row for row in found}.values())
            if found:
                with lock:
                    search_cache[key] = (time.time(), found, from_deezer)
                    while len(search_cache) > 32:
                        search_cache.popitem(last=False)
        results = found[offset:offset + 8]
        return jsonify(results=results, next_offset=offset + 8 if offset + 8 < len(found) else None,
                       seed_genre=genre, from_deezer=from_deezer, state="ready" if results else "empty",
                       message="" if results else "No similar songs found. Try another song.")

    @app.post("/api/recommendations/match")
    def match_recommendation():
        identifier = body().get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"deezer:[0-9]{1,15}", identifier):
            raise ApiError("Invalid Deezer song.")
        with lock:
            if not allow("match-recommendation:" + g.user, 40, 60):
                raise ApiError("Too many recordings requested. Wait a minute.", 429)
        try:
            track = similar_songs.recording(identifier)
            row = match_playlist_recording(g.user, track, lambda _: None)
        except PlaylistError:
            raise ApiError("This song is unavailable in Deezer. Choose another song.", 404)
        except (OSError, ValueError, app.intake.IntakeError):
            raise ApiError("The recording could not be checked. Try again later.", 503)
        if row is None:
            raise ApiError("No reliable recording was found. Choose another song.", 404)
        return jsonify(row)

    @app.post("/api/search")
    def search():
        data = body()
        q = data.get("query")
        offset = data.get("offset", 0)
        if type(offset) is not int or offset < 0 or offset >= 3000 or offset % 30 not in (0, 8, 16, 24):
            raise ApiError("Invalid search page.")
        include_long = data.get("include_long", False)
        if type(include_long) is not bool:
            raise ApiError("Invalid long-mix filter.")
        search_key = (g.user, False)
        q = q.strip() if isinstance(q, str) else ""
        if not 1 <= len(q) <= 200 or any(ord(c) < 32 or ord(c) == 127 for c in q):
            raise ApiError("Enter 1 to 200 characters to search.")
        block = offset // 30 * 30
        page_offset = offset - block
        def page(found, complete=True):
            full = len(found) >= 30
            found = [r for r in found if include_long or not isinstance(r.get("duration"), (int, float)) or r["duration"] < 1800]
            next_page = offset + 8 if page_offset + 8 < len(found) else block + 30 if full and block + 30 < 3000 else None
            results = [{k: r.get(k) for k in ("id", "url", "title", "channel", "duration", "kind")} for r in found[page_offset:page_offset + 8]]
            for track in results:
                track["title"], track["channel"] = recording_labels({**track, "kind": "youtube"})
            return jsonify(results=results, next_offset=next_page, complete=complete)
        cache_key = (g.user, False, q.casefold(), block)
        with lock:
            previous = searches.get(search_key)
            cached = search_cache.get(cache_key)
            cached = cached and time.time() - cached[0] < 300
            same = previous and previous[0] == cache_key and not previous[1].is_set()
            if previous and not (cached and same):
                previous[1].set()
            if background_activity():
                cancel = threading.Event()
            else:
                cancel = resources.begin_search(search_key)
                g.search_presence = (search_key, cancel)
            if cached and (same or search_cache[cache_key][2]):
                _, found, complete = search_cache[cache_key]
                return page(found, complete)
            searches[search_key] = (cache_key, cancel)
            if not allow("search:" + g.user, 40, 60):
                raise ApiError("Too many searches. Wait a minute.", 429)
            for job in jobs.values():
                if not job.get("playlist_import") and not job.get("library_addition") and not block and job["owner"] == g.user and job.get("search_preview") and not job.get("current") and job["state"] in ("queued", "running"):
                    cancel_acquisition(job)
                    if job["state"] == "queued":
                        job.update(state="cancelled", message="Cancelled")
        app.intake.CONTROL.cancel = cancel
        try:
            for attempt in range(3):
                if cancel.is_set():
                    raise ApiError("A newer search replaced this request.", 409)
                try:
                    result = app.intake.cmd_search(SimpleNamespace(query=q, limit=30, offset=block, main_only=True))
                    found = result["results"]
                    complete = result.get("complete", True)
                    break
                except app.intake.IntakeError as e:
                    if cancel.is_set():
                        raise ApiError("A newer search replaced this request.", 409)
                    transient = re.search(r"http(?:\s+error)?\s*[:=]?\s*(?:403|429|5\d\d)\b|timed?\s*out|timeout|unable to download api page", str(e), re.I)
                    if not transient:
                        raise
                    if attempt == 2:
                        raise ApiError("YouTube is limiting searches right now. Try again in a moment.", 503)
                    if cancel.wait((1.5, 4)[attempt]):
                        raise ApiError("A newer search replaced this request.", 409)
        except ApiError:
            raise
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
            search_cache[cache_key] = (time.time(), found, complete)
            while len(search_cache) > 32:
                search_cache.popitem(last=False)
        if not complete:
            owner = g.user
            def enrich():
                if cancel.is_set():
                    return
                app.intake.CONTROL.cancel = cancel
                deadline = time.monotonic() + 120
                def budget():
                    if time.monotonic() >= deadline:
                        raise app.intake.IntakeError("search enrichment timed out")
                app.intake.CONTROL.budget = budget
                try:
                    final = app.intake.cmd_search(SimpleNamespace(query=q, limit=30, offset=block,
                        main_only=False, youtube_caller="search", youtube_background=True))["results"]
                except Exception as e:
                    log.warning("search enrichment failed: %s", type(e).__name__)
                    final = found
                finally:
                    app.intake.CONTROL.cancel = None
                    app.intake.CONTROL.budget = None
                with lock:
                    current = search_cache.get(cache_key)
                    if current and current[1] is found and not cancel.is_set():
                        search_cache[cache_key] = (current[0], final, True)
                        selected = selections.setdefault(owner, {})
                        selected.update({r["id"]: r for r in final})
                        selections[owner] = dict(list(selected.items())[-100:])
            threading.Thread(target=enrich, daemon=True, name="search-enrichment").start()
        return page(found, complete)

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
        # Register newer requests through the same lock that guards job mutation.
        with lock, session_lock:
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
        prefetch = d.get("prefetch", False)
        if type(prefetch) is not bool:
            raise ApiError("Invalid prefetch request.")
        if not prefetch:
            generation(d, "listen")
        action = d.get("play_action")
        if action is not None and not playback_diagnostics.valid(action):
            raise ApiError("Invalid playback action.")
        try:
            vid = app.intake.video_id(d.get("url") if isinstance(d.get("url"), str) and len(d["url"]) <= 200 else "")
        except app.intake.IntakeError:
            raise ApiError("Enter one YouTube video link.")
        m = fetch_metadata(d, vid)
        feedback.note(song=m.get("title"), artist=m.get("artist"), video=vid, prefetch=prefetch)
        allowed = d.get("allow_new") is not False or saved_source(vid)
        explicit = any(k in d for k in ("artist", "album", "track"))
        with lock:
            if not prefetch:
                generation(d, "listen")
            if not allowed:
                raise ApiError("Enable Allow new music downloads and discovery to listen to this recording.", 403)
            if not prefetch and not background_activity():
                resources.presence(listener_identity(), "listening")
            job = new_job(g.user, "fetch", m, vid, priority=10 if prefetch else 0, preserve_priority=prefetch)
            if action and not prefetch:
                job["play_action"] = action
                playback_diagnostics.record(g.user, action, "job_accepted", begin=True)
                if job["preview_state"] == "ready":
                    job_playback_stage(job, "preview_ready")
                    if job.get("windows_preview_ready"):
                        job_playback_stage(job, "windows_preview_ready")
                if job.get("source_ready"):
                    job_playback_stage(job, "source_ready")
            if explicit and job["meta"] != m:
                if job.get("committed") or job.get("metadata_locked"):
                    raise ApiError("Import has started. Track details can no longer be changed.", 409)
                job.update(meta=m, artist=m["artist"], title=m["title"])
            if explicit or "automatic_meta" not in job:
                job["automatic_meta"] = not explicit
            if job["state"] == "done" and job.get("item") and job["message"] == "Prepared":
                # Promotion reuses the validated complete original, never fetches it again.
                job.update(state="queued", message=STEP_TEXT["import"])
            if prefetch:
                job['background_requested'] = True
                return start(job, app.intake.WATCH + vid, None, m)
            for other in jobs.values():
                if other["owner"] == g.user:
                    other["current"] = other is job
                    if other is not job and (other.get('background_requested') or other.get('library_addition')):
                        other['priority'] = max(10, other['priority'])
                obsolete_current = other.get("priority", 0) == 0
                needs_slot = job["preview_state"] != "ready" and not job.get("source_ready") and other["state"] == "running"
                if (not other.get("playlist_import") and not other.get("analyzing") and other is not job
                        and not other.get("library_addition")
                        and not other.get("background_requested")
                        and not other.get("committed")
                        and other["owner"] == g.user and other.get("source_id") and (obsolete_current or needs_slot)):
                    cancel_acquisition(other)
                    if other["state"] == "queued":
                        other.update(state="cancelled", message="Cancelled")
            return start(job, app.intake.WATCH + vid, None, m)

    def addition_playlist(user, target):
        if target is None:
            return None
        if not isinstance(target, dict) or set(target) != {"owner_id", "id"} or any(
                not isinstance(value, str) for value in target.values()):
            raise ApiError("Choose a playlist to add songs to.")
        owner, pid = target["owner_id"], target["id"]
        if not owner:
            owner = user
        playlist = playlist_store.read(owner, pid)
        if owner != user and (not family_mode or user not in playlist.get("co_authors", [])):
            raise ApiError("Only the owner or a co-author can add songs to this playlist.", 403)
        return owner, pid, playlist

    def append_library_song(user, target, source):
        # Workers recheck current access. Retrying an addition after a restart can reuse the saved entry.
        try:
            owner, pid, playlist = addition_playlist(user, target)
            if any((row.get("source_id") or (row.get("match") or {}).get("id")) == source
                   for row in playlist["tracks"]):
                return None
            if playlist_preparation.is_active(owner, pid):
                return "Pause playlist preparation, then add the saved song from your library."
            item = saved_source(source)
            if not item or len(playlist["tracks"]) >= 10000:
                return "Could not add the saved song to the playlist. Check the playlist and try again."
            append_saved_entry(playlist["tracks"], user, source, item)
            playlist["revision"] += 1
            playlist_store.save(owner, playlist)
        except (ApiError, ValueError, OSError, app.intake.IntakeError):
            return "Could not add the saved song to the playlist. Check the playlist and try again."
        return None

    def watch_job_status(snapshot):
        sid = session.get("sid")
        previous = None
        deadline = time.monotonic() + 15 * 60

        def updates():
            nonlocal previous
            while time.monotonic() < deadline:
                with job_changed:
                    value, active = None, False

                    def updated():
                        nonlocal value, active
                        if not (identity := sessions.get(sid)) or identity["expiry"] <= time.time():
                            value, active = None, False
                            return True
                        value, active = snapshot()
                        return value != previous or not active

                    job_changed.wait_for(updated, timeout=15)
                    if value is None:
                        return
                    changed = value != previous
                    previous = value
                if changed:
                    yield json.dumps(value) + "\n"
                elif active:
                    yield "\n"
                if not active:
                    return

        return Response(updates(), mimetype="application/x-ndjson", headers={"X-Accel-Buffering": "no"})

    @app.get("/api/library/additions")
    def library_additions():
        user = g.user
        watching = request.args.get("watch") == "1"

        def snapshot():
            rows = {}
            for job in jobs.values():
                if job["owner"] == user and (job.get("library_addition") or job.get("show_in_additions")):
                    key = job.get("source_id") if job.get("library_addition") else job["id"]
                    rows[key] = public(job, include_media=not watching)
            return dict(jobs=list(rows.values())), any(row["state"] in ("queued", "running") for row in rows.values())

        if watching:
            return watch_job_status(snapshot)
        with lock:
            return jsonify(snapshot()[0])

    @app.post("/api/library/additions")
    def library_add():
        data = body(64 * 1024)
        links = data.get("urls")
        if not isinstance(links, list) or not 1 <= len(links) <= 200:
            raise ApiError("Paste 1 to 200 YouTube video links.")
        sources = []
        for url in links:
            try:
                if not isinstance(url, str) or len(url) > 200: raise app.intake.IntakeError("Invalid link")
                source = app.intake.video_id(url)
            except app.intake.IntakeError:
                raise ApiError("Enter YouTube video links separated by spaces or new lines.")
            if source not in sources: sources.append(source)
        result = []
        with catalogue_lock:
            target = data.get("playlist")
            addition_playlist(g.user, target)
            modified = []
            saved = []
            with lock:
                pending = sum(1 for j in jobs.values() if j["owner"] == g.user
                              and j.get("library_addition") and j["state"] in ("queued", "running"))
                active_sources = {j.get("source_id") for j in jobs.values() if j["owner"] == g.user
                                  and j["state"] in ("queued", "running") and not j["cancel"].is_set()}
            additions = sum(source not in active_sources and not saved_source(source) for source in sources)
            if pending + additions > 200:
                raise ApiError("Your library queue is full. Wait for songs to finish before adding more.", 429)
            for source in sources:
                if item := saved_source(source):
                    track, _ = library_record(item)
                    row = dict(source_id=source, state="done", saved=True, title=track["title"], message="Saved")
                    result.append(row)
                    saved.append(row)
                    continue
                with lock:
                    job = next((j for j in list(jobs.values()) if j["owner"] == g.user and j.get("source_id") == source
                                and j["state"] in ("queued", "running") and not j["cancel"].is_set()), None)
                    if job is None:
                        try:
                            m = fetch_metadata({}, source)
                            job = new_job(g.user, "fetch", m, source, 20, True, library_addition=True)
                        except ApiError as error:
                            result.append(dict(source_id=source, state="error", saved=False, title=source, message=error.message))
                            continue
                        job.update(library_addition=True, playlist_import=True, automatic_meta=True, pending_persistence=True)
                        if job["state"] == "done" and not job.get("committed"):
                            job.update(state="queued", message=STEP_TEXT["import"])
                        if "url" not in job:
                            job.update(url=app.intake.WATCH + source, tmp=None, state="queued")
                        modified.append((job, None))
                    else:
                        modified.append((job, {key: job[key] for key in ("save", "library_addition", "addition_playlists") if key in job}))
                        job["save"] = True
                        job["library_addition"] = True
                    if target is not None and target not in job.get("addition_playlists", []):
                        job["addition_playlists"] = [*job.get("addition_playlists", []), target]
                    result.append(public(job))
            if modified:
                if not save_bulk_queue():
                    with lock:
                        for job, previous in modified:
                            if previous is None:
                                jobs.pop(job["id"], None)
                            else:
                                for key in ("save", "library_addition", "addition_playlists"):
                                    job.pop(key, None)
                                job.update(previous)
                    raise ApiError("Could not save the library queue. Try again.", 503)
                with lock:
                    for job, _ in modified:
                        job.pop('pending_persistence', None)
                wake_dispatch()
            if target is not None:
                for row in saved:
                    error = append_library_song(g.user, target, row["source_id"])
                    if error:
                        row["playlist_error"] = error
            with job_changed:
                job_changed.notify_all()
        return jsonify(jobs=result), 202

    @app.post("/api/jobs/<job_id>/cancel")
    def cancel_job(job_id):
        with lock:
            job = jobs.get(job_id)
            if not job or job["owner"] != g.user:
                raise ApiError(HTTP_TEXT[404], 404)
        with job["publish"]:
            if job.get("committed"):
                cancel_acquisition(job)
                return jsonify(job={**public(job), "state": "done", "message": DONE_TEXT})
            if job["state"] != "done":
                cancel_acquisition(job)
                if job["state"] == "queued":
                    settle(job, "cancelled", "Cancelled")
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
                with PROVIDERS["youtube-images"].request(max_wait=2), urllib.request.build_opener(NoRedirect).open(url, timeout=5) as response:
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

    loudness_directory = state_path(cfg, ".library-loudness-v1")

    def library_measurement(digest):
        return library_loudness.read_measurement(app.intake, library_loudness.measurement_path(loudness_directory, digest))

    def library_record(result, *, allow_unfinished=False, source_only=False):
        manifest = result["manifest"]
        record, source = manifest["import"], manifest["source"]
        recording_id = manifest["id"] if source["kind"] == "local" else source["id"]
        target = os.path.join(lib, *record["path"].split("/"))
        stat = app.intake.regular_file(target, "library audio")
        if not app.intake.inside(target, lib):
            raise ApiError("Recording unavailable.", 404)
        metadata = catalogue_review.overrides(recording_id,record["library_sha256"])
        title, artist = recording_labels(source, record)
        track = {"id": recording_id, "url": source.get("url", ""), "title": metadata.get("title",title),
                 "channel": metadata.get("artist",artist), "library_album": metadata.get("album",record["album"]),
                 "genre": metadata.get("genre") or genre_labels.get(metadata.get("artist") or artist_name(source, record)), "duration": manifest["audio"]["duration"],
                 "saved": True, "added_at": record.get("added_at"), "download_url": "/api/library/" + recording_id + "/download",
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
        finished = None if source_only else finished_audio.select(track["download_sha256"])
        if not finished and cfg["REQUIRE_FINISHED_AUDIO"]:
            if not allow_unfinished:
                raise ApiError("This recording is still being prepared. Try playing it again.", 503)
            track["download_url"] = f"/api/library/{recording_id}/playback-source/{track['download_sha256']}"
        if finished:
            version, target = finished
            offset = track.get("source_start", 0)
            track.update(duration=version["duration"], download_size=version["size"],
                         download_sha256=version["sha256"], download_extension=".flac",
                         listening_version="finished", original_duration=manifest["audio"]["duration"],
                         source_start=offset + version["start"], source_end=offset + version["end"],
                         loudness_lufs=version["lufs"], true_peak_db=version["true_peak"])
        original = library_measurement(record["library_sha256"])
        if finished:
            measured = version
        else:
            digest = track["download_sha256"]
            measured = (original if digest == record["library_sha256"] else library_measurement(digest))
            if measured is None:
                measured = profile(app.intake, result["item"], {
                    "audio": {"sha256": digest, "duration": track["duration"], "file": target}})
        lufs, peak = measured.get("lufs"), measured.get("true_peak")
        track.update(lufs=lufs, true_peak=peak,
                     over_peak=(peak or 0) > 0 or ((original or {}).get("true_peak") or 0) > 0)
        # Preserve the legacy gain for installed clients.
        track["playback_gain_db"] = 0
        if not finished and lufs is not None and peak is not None:
            track["playback_gain_db"] = measured.get("gain_db", min(12, -16 - lufs, -1.5 - peak))
        track.update(song_analysis.metadata(recording_id, record['library_sha256']))
        catalogue_review.observe(track,source,record["library_sha256"],automatic_title=record.get('automatic_title'))
        metadata=catalogue_review.overrides(recording_id,record["library_sha256"])
        track.update(title=metadata.get('title',track['title']),channel=metadata.get('artist',track['channel']),
                     library_album=metadata.get('album',track['library_album']),genre=metadata.get('genre',track['genre']))
        return track, target

    phone_encodes = threading.BoundedSemaphore(2)

    def mobile_record(source_id, digest=None, quality="normal", lead=0, streaming=False):
        if quality not in mobile_audio.TIERS:
            raise ApiError("Invalid audio quality.", 400)
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id):
            raise ApiError("Recording unavailable.", 404)
        item = saved_source(source_id)
        if not item:
            raise ApiError("Recording unavailable.", 404)
        track, original = library_record(item, allow_unfinished=streaming)
        source_hash = track["download_sha256"]
        if digest is not None and digest != source_hash:
            raise ApiError("Recording changed. Refresh the library.", 409)
        if streaming and "/playback-source/" in track["download_url"]:
            return track, original
        path = mobile_audio.copy_path(item["item"], source_hash, quality)
        needs_encode = not os.path.lexists(path)
        original_track = dict(track, playback_source_sha256=source_hash)
        # A listener pressing play never waits for (or is refused by) a missing phone copy: the
        # verified original streams while the copy warms. Background downloads still get the copy.
        urgent = not background_activity() and lead <= 0
        if needs_encode and urgent:
            if opus_warmer:
                opus_warmer.now_playing(source_id, quality)
            return original_track, original
        # The next song in a listener's queue (lead > 0) never fails on a busy or failing encoder either: the
        # original plays instead (a phone gave up on its next song with the screen off, 27 Nov 2026).
        # Offline downloads (no lead) still wait for the smaller copy.
        fallback = urgent or lead > 0
        if needs_encode and not phone_encodes.acquire(blocking=False):
            if fallback:
                return original_track, original
            raise ApiError("Mobile audio preparation is busy. Try again.", 503)
        previous_background = getattr(app.intake.CONTROL, 'background', False)
        previous_priority = getattr(app.intake.CONTROL, 'priority', None)
        app.intake.CONTROL.background = not urgent
        app.intake.CONTROL.priority = lambda: 0 if urgent else 1
        try:
            if needs_encode or lead > 0:
                path = mobile_audio.prepare(app.intake, item["item"], original, source_hash, requested=True,
                                            quality=quality, title=track['title'], lead=lead)
            else:
                app.intake.regular_file(path, "mobile audio")
            track["playback_version"] = mobile_audio.TIERS[quality][1]
            if os.path.getsize(path) >= track["download_size"]:
                return original_track, original
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
                if fallback:
                    return original_track, original
                raise ApiError("Could not measure mobile audio. Try again.", 503)
            track.update(lufs=measured["lufs"], true_peak=measured["true_peak"],
                         over_peak=track["over_peak"] or measured["true_peak"] > 0,
                         playback_gain_db=min(12, -16 - measured["lufs"], -1.5 - measured["true_peak"]))
            return track, path
        except (OSError, ValueError, app.intake.IntakeError):
            if fallback:
                return original_track, original
            raise ApiError("Could not prepare mobile audio. Try again.", 503)
        finally:
            if needs_encode:
                phone_encodes.release()
            app.intake.CONTROL.background = previous_background
            app.intake.CONTROL.priority = previous_priority

    @app.get("/api/library/<source_id>/playback-info")
    def playback_info(source_id):
        quality = request.args.get("quality", "normal")
        action = request.args.get("play_action")
        streaming = request.args.get("stream") == "1"
        playback_diagnostics.record(g.user, action, "playback_info_started", begin=True)
        # Seconds until the listener needs this song: 0 when they are waiting, the time left in the current song for the next one.
        try: lead = min(3600.0, max(0.0, float(request.args.get("lead", 0))))
        except ValueError: raise ApiError("Invalid lead time.", 400)
        if not background_activity():
            resources.presence(listener_identity(), "listening")
        if quality == "max":
            item = saved_source(source_id) if re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id) else None
            if not item:
                raise ApiError("Recording unavailable.", 404)
            track, _ = library_record(item, allow_unfinished=streaming)
        else:
            track, _ = mobile_record(source_id, quality=quality, lead=lead, streaming=streaming)
        url = track["download_url"]
        if playback_diagnostics.valid(action):
            url += ("&" if "?" in url else "?") + "play_action=" + action
        track["stream_url"] = stream_url(url)
        playback_diagnostics.record(g.user, action, "playback_info_ready")
        return jsonify(track)

    lyrics_cache = LyricsCache(cfg, cfg.get("LYRICS_LOOKUP"))
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
            result = lyrics_cache.get(source_id, track["title"], track["channel"],
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
        if not background_activity():
            resources.presence(listener_identity(), "listening")
        quality = request.args.get("quality", "normal")
        action = request.args.get("play_action") if request.method == "GET" else None
        playback_diagnostics.record(g.user, action, "stream_requested")
        track, path = mobile_record(source_id, digest, quality=quality)
        playback_diagnostics.record(g.user, action, "stream_response_ready")
        return send_file(path, conditional=True,
                         etag=track["download_sha256"], max_age=0)

    @app.route("/api/library/<source_id>/download", methods=["GET", "HEAD"])
    @app.route("/api/library/<source_id>/playback-source/<digest>", methods=["GET", "HEAD"])
    def download_library_recording(source_id, digest=None):
        if not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id):
            raise ApiError("Recording unavailable.", 404)
        if digest is not None and ("ticket" not in request.args or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            raise ApiError("Recording unavailable.", 404)
        item = saved_source(source_id)
        if not item:
            raise ApiError("Recording unavailable.", 404)
        track, path = library_record(item, allow_unfinished=digest is not None, source_only=digest is not None)
        if digest is not None and digest != track["download_sha256"]:
            raise ApiError("Recording changed. Refresh the library.", 409)
        action = request.args.get("play_action") if request.method == "GET" else None
        playback_diagnostics.record(g.user, action, "stream_requested")
        playback_diagnostics.record(g.user, action, "stream_response_ready")
        return send_file(path, conditional=True, etag=track["download_sha256"], max_age=0,
                         as_attachment=True, download_name=source_id + track["download_extension"])

    scan_lock = threading.Lock()
    pending_scan = None

    def library_dependencies(folders):
        found = []
        for folder in folders:
            try:
                _, manifest = app.intake.read_manifest(os.path.join(ws, folder))
                record = manifest.get('import')
                if record and manifest['edit'] is None and manifest['source']['kind'] in ('youtube', 'local'):
                    found.append([folder, manifest['audio']['file'], record['path'], record['library_sha256'],
                                  artist_name(manifest['source'], record)])
            except (OSError, ValueError, app.intake.IntakeError):
                continue
        return found

    def library_dependency_stamp(identifier, dependencies):
        stamps = []
        for folder, audio, path, digest, artist in dependencies:
            overrides = catalogue_review.overrides(identifier, digest)
            genre = genre_labels.cache.get((overrides.get('artist') or artist).casefold(), {}).get('genre')
            edition = listening_versions.versions.get(identifier, {})
            if edition.get('source_sha256') != digest:
                edition = {}
            selected = edition.get('sha256', digest)
            finished = os.path.join(finished_audio.directory, finished_audio.key(selected))
            stamps.append([file_stamp(os.path.join(ws, folder, audio)), file_stamp(os.path.join(lib, path)),
                           file_stamp(os.path.join(ws, edition['file'])) if edition else None,
                           file_stamp(finished + '.json'), file_stamp(finished + '.flac'),
                           file_stamp(os.path.join(ws, '.playback-' + selected + '.json')),
                           file_stamp(library_loudness.measurement_path(loudness_directory, digest)),
                           file_stamp(library_loudness.measurement_path(loudness_directory, selected)) if selected != digest else None,
                           overrides, genre, edition, song_analysis.rows.get(identifier + ':' + digest)])
        return stamps

    def project_library_record(identifier, candidates):
        try:
            result = saved_source(identifier, candidates=candidates)
            if result:
                manifest = result['manifest']
                record, source = manifest['import'], manifest['source']
                track, _ = library_record(result)
                digest = record['library_sha256']
                return track, record.get('added_at'), digest, source['kind'], catalogue_review.overrides(identifier, digest)
        except (OSError, ValueError, ApiError, app.intake.IntakeError):
            pass

    def refresh_library_item(path):
        if library_index is not None:
            folder = os.path.basename(path)
            if app.intake.ID_RE.fullmatch(folder) and (identifier := folder_source_id(folder)):
                library_index.update({identifier: (folder,)})

    def library_tracks(keep_going=None):
        nonlocal pending_scan
        if library_index is not None and (tracks := library_index.query()) is not None:
            return tracks
        if keep_going is not None:
            return scan_library(keep_going, background=True)
        with scan_lock:
            leader = pending_scan is None
            if leader:
                pending_scan = Future()
            scan = pending_scan
        if leader:
            try:
                scan.set_result(scan_library(lambda: True))
            except Exception as error:
                scan.set_exception(error)
            finally:
                with scan_lock:
                    pending_scan = None
        return [track.copy() for track in scan.result()]

    def scan_library(keep_going, *, background=False):
        rows = []
        sources = library_folders(ws, app.intake.ID_RE)
        for identifier, candidates in sorted(sources.items()):
            if background:
                resources.yield_to_requests(lambda: not keep_going())
            if not keep_going():
                break
            if projected := project_library_record(identifier, sorted(candidates)):
                rows.append(projected[0])
        return rows

    def history_metadata(ids):
        tracks = {}
        for manifest in music_manifests(Path(ws), ids):
            source, record = manifest['source'], manifest.get('import')
            identifier = source.get('id', manifest['id'])
            if identifier not in ids or identifier in tracks and not record:
                continue
            overrides = catalogue_review.overrides(identifier, record['library_sha256']) if record else {}
            record = record or {}
            title, artist = recording_labels(source, record)
            artist = overrides.get('artist') or artist
            with genre_labels.lock:
                genre = genre_labels.cache.get(artist.casefold(), {}).get('genre')
            album = record.get('album')
            tracks[identifier] = dict(title=overrides.get('title') or title,
                                      channel=artist, library_album=overrides.get('album') or (album if album != 'Selected recordings' else None) or source.get('album'),
                                      genre=overrides.get('genre') or genre)
        return tracks

    @app.get("/api/library")
    def library():
        query, artist, album, genre, after, identifier = (request.args.get(key, '').strip()
            for key in ('q', 'artist', 'album', 'genre', 'after', 'id'))
        if (any(len(value) > 200 or any(ord(c) < 32 for c in value) for value in (query, artist, album, genre))
                or any(value and not SOURCE_ID.fullmatch(value) for value in (after, identifier))):
            raise ApiError('Invalid library filter.')
        paged = bool(query) or 'limit' in request.args or 'after' in request.args
        raw_limit = request.args.get('limit', '50')
        if paged and (not re.fullmatch(r'[0-9]{1,3}', raw_limit) or not 1 <= int(raw_limit) <= 200):
            raise ApiError('Choose a page size from 1 to 200.')
        limit = int(raw_limit) if paged else None
        genre = genre_key(genre) if genre else ''
        words = search_words(query)
        if query and not words:
            raise ApiError('Enter a title, artist, or album to search.')
        criteria = dict(words=words, artist=artist, album=album, genre=genre, after=after, identifier=identifier)
        tracks = (library_index.query(**criteria, limit=limit + 1 if paged else None)
                  if library_index is not None else None)
        all_tracks = None
        if tracks is None:
            all_tracks = library_tracks()
            tracks = [track for track in all_tracks if matches(track, **criteria)] if any(criteria.values()) else all_tracks
        payload = dict(results=tracks[:limit] if paged else tracks)
        if paged:
            payload['next_after'] = tracks[limit - 1]['id'] if len(tracks) > limit else None
        if request.args.get("genre_filters") != "1":
            return jsonify(payload)
        counts = library_index.genres() if library_index is not None and all_tracks is None else None
        metadata = None
        if counts is not None:
            ids = {event['recording_id'] for event in listening_history.events(g.user)}
            metadata = library_index.history_metadata(ids)
        if metadata is None:
            all_tracks = library_tracks() if all_tracks is None else all_tracks
            counts = Counter(track.get('genre') or '' for track in all_tracks).items()
            metadata = {t['id']: {'genre': t.get('genre'), 'channel': t.get('channel', '')} for t in all_tracks}
        keys, votes = {}, defaultdict(Counter)
        for raw, count in sorted(counts):
            key = keys[raw] = genre_key(raw)
            votes[key][genre_label(raw)] += count
        history = listening_history.summary(g.user, metadata)
        plays = {genre_key(label): row["plays"] for label, row in history["genres"].items()}
        genres = [dict(key=key, label=most_common_genre(group), plays=plays.get(key, 0))
                  for key, group in votes.items()]
        return jsonify(**payload, genre_keys=keys, genres=genres)

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
        requested, candidates = set(), []
        for i, row in enumerate(rows + (previews if preload_search else [])):
            if not isinstance(row, dict):
                raise ApiError("Invalid recording.")
            explicit = row.get("requested", False)
            if type(explicit) is not bool:
                raise ApiError("Invalid queue selection.")
            is_preview = i >= len(rows)
            if is_preview and (type(row.get("duration")) not in (int, float) or not 0 < row["duration"] <= 600):
                continue
            if row.get("url") in (None, ""):
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
            position = len(candidates)
            priority = (1 if position == 0 else 18 + position) if not is_preview else 2 + i - len(rows)
            if not is_preview and position > 0 and preload_search:
                visible = next((n for n, p in enumerate(previews) if isinstance(p, dict) and p.get("url") == row.get("url")), None)
                if visible is not None:
                    priority = 2 + visible
            automatic = not any(k in row for k in ("artist", "album", "track"))
            candidates.append((vid, m, priority, is_preview, explicit, automatic))
        prepared = []
        with lock:
            generation(d, "queue")
            for vid, m, priority, is_preview, explicit, automatic in candidates:
                if explicit and not is_preview and not background_activity():
                    resources.presence(listener_identity(), "listening")
                job = new_job(g.user, "fetch", m, vid, priority, False)
                job.update(search_preview=is_preview, explicit_preview=explicit)
                job.setdefault("automatic_meta", automatic)
                enqueue_acquisition(job, app.intake.WATCH + vid, None)
                prepared.append(public(job))
            for job in jobs.values():
                if not job.get("playlist_import") and not job.get("library_addition") and job["owner"] == g.user and job.get("priority", 0) > 0 and job.get("source_id") not in requested:
                    if not job.get("committed") and job["state"] in ("queued", "running"):
                        cancel_acquisition(job)
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

    def append_saved_entry(tracks, user, source_id, item):
        track, _ = library_record(item)
        tracks.append({"added_at": datetime.now(timezone.utc).isoformat(), "added_by": user,
                       "album": track.get("library_album", ""), "title": track["title"], "artist": track["channel"],
                       "duration": track["duration"], "source_id": source_id, "spotify_uri": "",
                       "match": track, "candidates": [track], "state": "saved"})

    @app.post("/api/uploads")
    def create_upload():
        if not allow("audio-upload:" + g.user, 30, 3600):
            raise ApiError("Too many uploads. Try again later.", 429)
        f = request.files.get("file")
        if not f or not f.filename or f.filename.lstrip().startswith("-"):
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
        target_id = request.form.get("playlist_id")
        if target_id is not None:
            target = dict(id=target_id, owner_id=request.form.get("playlist_owner", g.user))
            with catalogue_lock:
                addition_playlist(g.user, target)
        job = new_job(g.user, "stage", m, priority=20)
        job.update(playlist_import=True, requested_download=True)
        if request.form.get("show_in_additions") == "true":
            job["show_in_additions"] = True
        if target_id is not None:
            job["addition_playlists"] = [target]
        if automatic: job.update(read_local_tags=True, local_fields=fields, playlist_import=True, message="Queued for server preparation")
        tmp = os.path.join(ws, f".upload-{secrets.token_hex(16)}.{ext}")
        try:
            with open(tmp, "xb") as out:
                f.save(out)
            size = os.path.getsize(tmp)
            if not 0 < size <= max_upload:
                raise ApiError("The file is empty." if not size else "The upload is too large.", 400 if not size else 413)
        except BaseException as e:
            remove_upload(tmp)
            settle(job, "error", "Upload failed.")
            raise e if isinstance(e, ApiError) else ApiError("Upload failed.", 500)
        with job_changed:
            if job["cancel"].is_set():
                remove_upload(tmp)
                settle(job, "cancelled", "Cancelled")
                return jsonify(job=public(job)), 202
            response = start(job, None, tmp, m)
            job_changed.notify_all()
            return response

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
            if request.args.get("watch") == "1":
                return watch_job_status(lambda: (dict(job=public(job, include_media=False)),
                                                 job["state"] in ("queued", "running")))
            if job["state"] not in ("queued", "running") and time.time() - job.get("accessed", job["created"]) > PREVIEW_TTL:
                raise ApiError(HTTP_TEXT[404], 404)
            return jsonify(job=public(job))

    @app.route("/api/jobs/<job_id>/media/<asset>", methods=["GET", "HEAD"])
    def job_media(job_id, asset):
        # Asset names are generated by the intake worker and explicitly published in this job.
        def preparing():
            return jsonify(error="Preparing playback."), 503, {"Retry-After": "0"}

        with lock:
            job = jobs.get(job_id)
            if not job or job["owner"] != g.user:
                raise ApiError(HTTP_TEXT[404], 404)
            if job["state"] not in ("queued", "running") and time.time() - job.get("accessed", job["created"]) > PREVIEW_TTL:
                raise ApiError("Preview expired. Start this saved recording again to prepare playback.", 410)
            if asset == "source":
                if not job.get("source_ready") or job["state"] == "cancelled":
                    if job["state"] in ("queued", "running"):
                        return preparing()
                    raise ApiError(HTTP_TEXT[404], 404)
                item = job["item"]
                job["accessed"] = time.time()
        if asset == "source":
            job_playback_stage(job, "source_stream_requested")
            try:
                _, manifest, path = app.intake.load_item(item)
            except (OSError, app.intake.IntakeError):
                raise ApiError(HTTP_TEXT[404], 404)
            response = send_file(path, conditional=True, etag=manifest["audio"]["sha256"], max_age=0)
            if request.method == "GET" and response.status_code in (200, 206):
                job_playback_stage(job, "source_stream_response_ready")
            return response
        with lock:
            if job["preview_state"] == "expired":
                raise ApiError("Preview expired. Listen again to prepare playback.", 410)
            if not re.fullmatch(r"(?:index\.m3u8|init\.mp4|seg\d{5}\.m4s)", asset):
                raise ApiError(HTTP_TEXT[404], 404)
            if asset not in job["assets"] or asset == "index.m3u8" and job["preview_state"] != "ready":
                if job["state"] in ("queued", "running") and not job.get("preview_failed"):
                    return preparing()
                if asset == "index.m3u8" and job["preview_state"] != "ready":
                    return jsonify(error="Preview unavailable."), 503
                raise ApiError(HTTP_TEXT[404], 404)
            text = job.get("preview_manifest") if asset == "index.m3u8" else None
            root = os.path.join(ws, ".preview-" + job_id)
            path = os.path.join(root, asset)
            job["accessed"] = time.time()
        if not background_activity():
            resources.presence(listener_identity(), "listening")
            if asset.startswith("seg"):
                job_playback_stage(job, "preview_segment_requested")
        if not app.intake.inside(path, root):
            raise ApiError(HTTP_TEXT[404], 404)
        try:
            app.intake.real_dir(root, "preview directory")
            app.intake.regular_file(path, "preview asset")
        except app.intake.IntakeError:
            raise ApiError(HTTP_TEXT[404], 404)
        if asset == "index.m3u8":
            # Serve the snapshot published together with its validated segment paths.
            if text is None:
                raise ApiError(HTTP_TEXT[404], 404)
            if "ticket" in request.args:
                text = text.replace('URI="init.mp4"', 'URI="' + stream_url(f"/api/jobs/{job_id}/media/init.mp4") + '"')
                text = "\n".join(stream_url(f"/api/jobs/{job_id}/media/{line}")
                                 if line and not line.startswith("#") else line for line in text.splitlines()) + "\n"
            text = text.replace("#EXTM3U", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES", 1)
            return app.response_class(text, mimetype="application/vnd.apple.mpegurl")
        response = send_file(path, mimetype="audio/mp4", conditional=True, etag=True, max_age=0)
        if asset.startswith("seg") and request.method == "GET" and response.status_code in (200, 206) and not background_activity():
            job_playback_stage(job, "preview_segment_response_ready")
        return response

    from .listening_history import register as register_listening_history
    listening_history = register_listening_history(app, cfg, body, profile_store, cfg["ADMIN_USERS"],
        lambda: {t["id"]: t for t in library_tracks()}, catalogue_lock, track_metadata=history_metadata,
        chart=deezer_chart, songs_added=songs_added, clear_totals=listening_stats.clear,
        yearly_daily=listening_stats.yearly_daily)
    home_albums.register(app, body, allow, library_tracks, playlist_store, playlist_preparation, catalogue_lock, visible_playlist)
    home_radio.register(app, allow, library_tracks, lambda: library_index, listening_history, profile_store if family_mode else None)
    from .discovery import register as register_discovery
    register_discovery(app, cfg, body, cfg["ADMIN_USERS"], library_tracks,
                       cfg.get("DISCOVERY_WORKER", cfg["PUBLIC_ORIGIN"] != "https://music.test"), background_idle)
    from .listening_rooms import register_listening_rooms
    from .movies import register_movies

    def session_is_live(sid, user):
        with session_lock:
            active = sessions.get(sid)
            return bool(active and active['user'] == user and active['expiry'] > time.time()
                        and (not require_profile_passwords or user in password_hashes))

    def movie_dismissals(profile, kind=None, item=None, marker=None):
        if profile_store is None:
            return {}
        if kind is None:
            return profile_store.movie_dismissals(profile)
        with catalogue_lock:
            return profile_store.movie_dismissals(profile, kind, item, marker)

    register_movies(app, cfg, body, allow, session_is_live, movie_dismissals, activity.report)
    from .files import register_files
    register_files(app, cfg, body, allow, lambda: g.user in cfg['ADMIN_USERS'],
                   lambda: not family_mode or g.user in password_hashes, csrf.exempt)
    register_listening_rooms(app, body, profile_store, resources)
    from .playback_devices import register_playback_devices
    register_playback_devices(app, body, playback_devices)

    try:
        with open(bulk_path, encoding="utf-8") as stream:
            bulk_rows = json.load(stream)
        with lock:
            for row in bulk_rows:
                source = row["source_id"]
                if not re.fullmatch(r"[A-Za-z0-9_-]{11}", source):
                    continue
                job = new_job(row["owner"], "fetch", meta(row["meta"]), source, 20, True, library_addition=True)
                jobs.pop(job["id"])
                job.update(id=row["id"], created=row["created"], retry_at=row.get("retry_at", 0),
                           retries=row.get("retries", 0), state="queued", phase="queued", message="Waiting for background slot",
                           url=app.intake.WATCH + source, tmp=None, library_addition=True, playlist_import=True,
                           automatic_meta=True, addition_playlists=row.get("addition_playlists", []))
                jobs[job["id"]] = job
            if jobs:
                wake_dispatch()
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError, KeyError, ApiError):
        log.warning("Could not restore the library addition queue")
    if automatic_downloads or metadata_lookup:
        auto_thread.start()
    from .snapshots import bounded_snapshot
    if cfg.get('STATUS_SNAPSHOTS', cfg['PUBLIC_ORIGIN'] != 'https://music.test'):
        server_work = bounded_snapshot(server_work)
        for rule in app.url_map.iter_rules():
            if 'GET' in rule.methods and rule.rule in ('/api/catalogue/review', '/api/catalogue/source-quality', '/api/catalogue/reports'):
                app.view_functions[rule.endpoint] = bounded_snapshot(app.view_functions[rule.endpoint])

    index_stop = threading.Event()
    index_thread = None
    if cfg.get('LIBRARY_INDEX_WORKER', cfg['PUBLIC_ORIGIN'] != 'https://music.test'):
        library_index = LibraryIndex(state_path(cfg, '.library-index.sqlite3'), ws, app.intake.ID_RE,
                                     [ws, lib, cfg['REQUIRE_FINISHED_AUDIO']], library_dependencies,
                                     library_dependency_stamp, project_library_record)
        app.extensions['music'].library_index = library_index
        loudness_retry = {}

        def measure_library_loudness(proceed):
            rows = library_index.read('SELECT id, folders, dependencies FROM sources ORDER BY id')
            if rows is None:
                return False
            deadline = time.monotonic() + 15
            attempted = False

            def pending(digest):
                return time.monotonic() >= loudness_retry.get(digest, 0) and library_measurement(digest) is None

            for identifier, folders, dependencies in rows:
                if not background_idle() or library_index.wake.is_set() or not proceed():
                    return False
                edition = listening_versions.versions.get(identifier, {})
                entry_digests = {row[3] for row in json.loads(dependencies)}
                if edition.get('source_sha256') in entry_digests:
                    entry_digests.add(edition['sha256'])
                if not any(pending(digest) for digest in entry_digests):
                    continue
                result = saved_source(identifier, candidates=json.loads(folders))
                if not result:
                    continue
                record = result['manifest']['import']
                original_digest = record['library_sha256']
                sources = [(original_digest, os.path.join(lib, *record['path'].split('/')))]
                if edition.get('source_sha256') == original_digest and pending(edition['sha256']):
                    try:
                        if selected := listening_versions.select(identifier, original_digest):
                            sources.append((selected[0]['sha256'], selected[1]))
                    except (OSError, ValueError, app.intake.IntakeError):
                        loudness_retry[edition['sha256']] = time.monotonic() + 600
                for digest, path in sources:
                    if not pending(digest):
                        continue
                    if not background_idle() or index_stop.is_set() or (attempted and time.monotonic() >= deadline):
                        return False
                    attempted = True
                    try:
                        library_loudness.measure(app.intake, path, library_loudness.measurement_path(loudness_directory, digest))
                    except (OSError, ValueError, app.intake.IntakeError):
                        loudness_retry[digest] = time.monotonic() + 600
                    else:
                        loudness_retry.pop(digest, None)
                        library_index.update({identifier: ()})
            return True

        def reconcile_library():
            lower_background_priority()
            background_request.set(True)

            def proceed():
                resources.yield_to_requests(index_stop.is_set)
                return not index_stop.is_set()

            while not index_stop.is_set():
                library_index.wake.clear()
                if background_idle():
                    with app.app_context():
                        complete = library_index.reconcile(proceed)
                        if complete:
                            with suppress(OSError):
                                catalogue_review.flush()
                            if cfg.get('LIBRARY_LOUDNESS_WORKER', cfg['PUBLIC_ORIGIN'] != 'https://music.test'):
                                app.intake.CONTROL.background = True
                                app.intake.CONTROL.cancel = index_stop
                                try:
                                    complete = measure_library_loudness(proceed)
                                finally:
                                    app.intake.CONTROL.background = False
                                    app.intake.CONTROL.cancel = None
                else:
                    complete = False
                library_index.wake.wait(30 if complete else 2)

        index_thread = threading.Thread(target=reconcile_library, name='library-index', daemon=True)
        index_thread.start()

    def close_state():
        index_stop.set()
        if index_thread is not None:
            library_index.wake.set()
            index_thread.join(2)
        listening_stats.flush()
        state_writer.close()

    app.extensions["music"].close_state = close_state
    start_backups(cfg)
    return app
