"""Private feedback threads and bounded, structured diagnostics."""
import base64
import binascii
from collections import deque
from contextlib import closing
import json
import logging
from logging.handlers import RotatingFileHandler, TimedRotatingFileHandler
from pathlib import Path
import re
import sqlite3
from threading import Lock
import time
import uuid

from flask import g, jsonify, request


MAX_IMAGE = 3 * 1024 * 1024
MAX_IMAGES = 4
FEEDBACK_BODY_LIMIT = MAX_IMAGES * (MAX_IMAGE + 2) // 3 * 4 + 128 * 1024
MAX_EVENTS = 200
WINDOW = 900
EVENTS = {"click", "change", "drag", "key", "scroll", "screen", "submit", "error", "context"}
KEYS = {"Enter", "Escape", "Space", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"}
# Endpoints a client polls while a view is open. The activity log keeps the first request and then one
# summary per window, so the interesting rows stay readable.
POLLING = {"playback_activity", "listening_pokes", "playback_devices", "get_job", "job_media", "prepare_playlist",
           "artwork", "playback_audio", "playback_diagnostic_events", "listening_summary"}
POLL_WINDOW = 30
SONG_WINDOW = 60
ACTIVITY_DAYS = 14
TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_./#-]{0,119}\Z")
URL_TEXT = re.compile(r"(?i)\b(?:https?|wss?)://\S+")
CREDENTIAL_TEXT = re.compile(r"(?i)\b(?:api[_ -]?key|access[_ -]?token|token|password|authorization)\s*[:=]\s*\S+")


def log_text(value, limit):
    clean = "".join(c for c in value if c >= " " and c != "\x7f").strip()
    return CREDENTIAL_TEXT.sub('[credential]', URL_TEXT.sub('[url]', clean))[:limit]


def note(**fields):
    """Attach readable context (a song title, a job, a profile action) to the current request's activity row.

    The activity log is a separate administrator file. Search text and free-form user input are never passed here,
    and nothing noted reaches the diagnostics attached to feedback reports.
    """
    clean = {}
    for key, value in fields.items():
        if isinstance(value, bool) or isinstance(value, (int, float)):
            clean[key] = value
        elif isinstance(value, str) and value.strip():
            clean[key] = log_text(value, 120)
    if clean:
        g.activity_note = {**getattr(g, "activity_note", {}), **clean}


def register(app, workspace, body, api_error, profiles, is_admin):
    database = Path(workspace) / ".feedback.sqlite3"
    recent = deque(maxlen=12000)
    lock = Lock()
    journal = RotatingFileHandler(Path(workspace) / ".feedback-server.log", maxBytes=2 * 1024 * 1024,
                                  backupCount=3, encoding="utf-8", delay=True)

    # One file per day, kept for two weeks: .activity.log, .activity.log.2026-11-22, ...
    activity = TimedRotatingFileHandler(Path(workspace) / ".activity.log", when="midnight", backupCount=ACTIVITY_DAYS,
                                        encoding="utf-8", delay=True)
    polled = {}

    def write_activity(response, trace, started):
        endpoint = request.endpoint
        owner = getattr(g, "user", None)
        row = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "owner": owner, "endpoint": endpoint,
               "method": request.method, "status": response.status_code, "trace": trace,
               "ms": round(1000 * (time.monotonic() - started)) if started is not None else None}
        try:
            row["profile"] = log_text(profiles.get(owner)["name"], 64) if owner else None
        except Exception:
            row["profile"] = None
        row.update(getattr(g, "activity_note", {}))
        if response.status_code >= 400 and response.is_json:
            error = (response.get_json(silent=True) or {}).get("error")
            if isinstance(error, str):
                row["error"] = log_text(error, 200)
        if endpoint in POLLING and response.status_code < 400:
            # A new song always gets its own row; the same song is summarized once a minute.
            key = (owner, endpoint, row.get("song"))
            now = time.monotonic()
            last = polled.get(key)
            if last and now - last[0] < (SONG_WINDOW if "song" in row else POLL_WINDOW):
                polled[key] = (last[0], last[1] + 1)
                return
            if last and last[1]:
                row["skipped_since_last"] = last[1]
            polled[key] = (now, 0)
        with lock:
            activity.handle(logging.LogRecord("familyhub.activity", logging.INFO, "", 0,
                                              json.dumps(row, ensure_ascii=False), (), None))
            activity.close()

    def connect():
        db = sqlite3.connect(database, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    with closing(connect()) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
                created INTEGER NOT NULL, updated INTEGER NOT NULL, status TEXT NOT NULL,
                client_events TEXT NOT NULL, server_events TEXT NOT NULL, device TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS feedback_owner_updated ON feedback(owner, updated DESC);
            CREATE TABLE IF NOT EXISTS feedback_image (
                report TEXT REFERENCES feedback(id), index_no INTEGER NOT NULL, name TEXT NOT NULL,
                mime TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(report, index_no)
            );
            CREATE TABLE IF NOT EXISTS feedback_reply (
                id INTEGER PRIMARY KEY, report TEXT REFERENCES feedback(id), author TEXT NOT NULL,
                developer INTEGER NOT NULL, message TEXT NOT NULL, created INTEGER NOT NULL
            );
        """)

    def record(event, **fields):
        item = {"at": int(time.time()), "event": event, **fields}
        with lock:
            recent.append(item)
            journal.handle(logging.LogRecord("familyhub.feedback", logging.INFO, "", 0, json.dumps(item), (), None))
            journal.close()

    record("server_started")

    @app.before_request
    def start_feedback_request():
        g.feedback_started = time.monotonic()

    @app.after_request
    def log_feedback_request(response):
        endpoint = request.endpoint
        if endpoint and endpoint != "static" and request.method not in {"HEAD", "OPTIONS"}:
            trace = request.headers.get("X-FamilyHub-Trace-Id", "")
            if not re.fullmatch(r"[a-f0-9]{32}", trace):
                trace = uuid.uuid4().hex
            started = getattr(g, "feedback_started", None)
            record("request", owner=getattr(g, "user", None), endpoint=endpoint,
                   method=request.method, status=response.status_code, trace=trace,
                   elapsed_ms=round(1000 * (time.monotonic() - started)) if started is not None else None)
            try:
                write_activity(response, trace, started)
            except Exception:
                logging.getLogger("music_web").warning("activity log write failed")
        return response

    def text(value, label, capacity):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > capacity:
            raise api_error(f"Enter {label} up to {capacity:,} characters long.")
        return value.strip()

    def client_events(value, now):
        if not isinstance(value, list):
            return []
        clean = []
        for item in value[-MAX_EVENTS:]:
            if not isinstance(item, dict):
                continue
            at, event = item.get("at"), item.get("event")
            if type(at) is not int or not now - WINDOW <= at <= now + 60 or not isinstance(event, str) or event not in EVENTS:
                continue
            entry = {"at": at, "event": event}
            for key in ("screen", "control"):
                field = item.get(key)
                if isinstance(field, str) and TOKEN.fullmatch(field):
                    entry[key] = field
            if event == "key" and isinstance(item.get("key"), str) and item["key"] in KEYS:
                entry["key"] = item["key"]
            clean.append(entry)
        return clean

    def images(value):
        if not isinstance(value, list) or len(value) > MAX_IMAGES:
            raise api_error("Attach up to four screenshots.")
        decoded = []
        for image in value:
            if not isinstance(image, dict):
                raise api_error("Choose PNG, JPEG, or WebP screenshots.")
            name, encoded = image.get("name"), image.get("data")
            if not isinstance(name, str) or not 1 <= len(name) <= 160 or any(ord(c) < 32 or c in "/\\" for c in name):
                raise api_error("A screenshot has an invalid filename.")
            if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE + 2) // 3 * 4:
                raise api_error("Each screenshot can be up to 3 MB.", 413)
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise api_error("A screenshot could not be read.") from None
            if len(data) > MAX_IMAGE:
                raise api_error("Each screenshot can be up to 3 MB.", 413)
            if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
                mime = "image/png"
            elif data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
                mime = "image/jpeg"
            elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
                mime = "image/webp"
            else:
                raise api_error("Choose PNG, JPEG, or WebP screenshots.")
            decoded.append((name, mime, data))
        return decoded

    def names():
        return {profile["id"]: profile["name"] for profile in profiles.list()}

    def authorized(db, report):
        row = db.execute("SELECT * FROM feedback WHERE id=?", (report,)).fetchone()
        if row is None or row["owner"] != g.user and not is_admin():
            raise api_error("Feedback not found.", 404)
        return row

    @app.get("/api/feedback")
    def feedback_list():
        inbox = request.args.get("inbox") == "1"
        if inbox and not is_admin():
            raise api_error("The developer inbox is private.", 403)
        with closing(connect()) as db:
            rows = db.execute("""
                SELECT id, owner, kind, description, updated, status FROM feedback
                WHERE ? OR owner=? ORDER BY updated DESC, id LIMIT 100
            """, (inbox, g.user)).fetchall()
        display = names()
        return jsonify(can_manage=is_admin(), reports=[{
            "id": row["id"], "author": display.get(row["owner"], "Former profile"), "kind": row["kind"],
            "summary": row["description"].splitlines()[0][:160], "updated": row["updated"], "status": row["status"]
        } for row in rows])

    @app.post("/api/feedback")
    def feedback_create():
        payload = body(limit=FEEDBACK_BODY_LIMIT)
        report, kind = payload.get("id"), payload.get("kind")
        if not isinstance(report, str) or not re.fullmatch(r"[a-f0-9]{32}", report) or kind not in ("problem", "feature"):
            raise api_error("Choose a feedback type and try again.")
        description = text(payload.get("description"), "a description", 4000)
        files = images(payload.get("images", []))
        now = int(time.time())
        diagnostics = client_events(payload.get("events"), now)
        device = payload.get("device")
        device = {key: value for key, value in device.items() if key in {"version", "platform", "culture", "decimal"}
                  and isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9 .,+()-]{1,65}", value)} if isinstance(device, dict) else {}
        requests = payload.get("request_ids")
        ids = {trace for trace in requests[-MAX_EVENTS:] if isinstance(trace, str) and re.fullmatch(r"[a-f0-9]{32}", trace)} if isinstance(requests, list) else set()
        with lock:
            server = [dict(event, from_device=event.get("trace") in ids) for event in recent
                      if event.get("owner") == g.user and now - WINDOW <= event["at"]][-MAX_EVENTS:]
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT owner FROM feedback WHERE id=?", (report,)).fetchone()
            if previous is not None:
                if previous["owner"] != g.user:
                    raise api_error("Feedback not found.", 404)
                return jsonify(id=report)
            if db.execute("SELECT count(*) FROM feedback WHERE owner=? AND created>?", (g.user, now - 86400)).fetchone()[0] >= 12:
                raise api_error("You reached today's feedback limit. Keep this draft and try again tomorrow.", 429)
            db.execute("INSERT INTO feedback VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)",
                       (report, g.user, kind, description, now, now, json.dumps(diagnostics), json.dumps(server), json.dumps(device)))
            db.executemany("INSERT INTO feedback_image VALUES (?, ?, ?, ?, ?)",
                           ((report, index, *file) for index, file in enumerate(files)))
        return jsonify(id=report), 201

    @app.get("/api/feedback/<report>")
    def feedback_thread(report):
        display = names()
        with closing(connect()) as db:
            row = authorized(db, report)
            attachments = [dict(item) for item in db.execute("""
                SELECT index_no AS 'index', name FROM feedback_image WHERE report=? ORDER BY index_no
            """, (report,))]
            replies = [dict(message=item["message"], created=item["created"],
                            author="Developer" if item["developer"] else display.get(item["author"], "Former profile"))
                       for item in db.execute("SELECT * FROM feedback_reply WHERE report=? ORDER BY id", (report,))]
            detail = {key: row[key] for key in ("id", "kind", "description", "status", "created")}
            detail.update(author=display.get(row["owner"], "Former profile"), images=attachments, replies=replies)
            if is_admin():
                detail.update(events=json.loads(row["client_events"]), server_events=json.loads(row["server_events"]),
                              device=json.loads(row["device"]))
        return jsonify(detail)

    @app.get("/api/feedback/<report>/images/<int:index>")
    def feedback_image(report, index):
        with closing(connect()) as db:
            authorized(db, report)
            image = db.execute("SELECT mime, data FROM feedback_image WHERE report=? AND index_no=?", (report, index)).fetchone()
            if image is None:
                raise api_error("Screenshot not found.", 404)
        return jsonify(mime=image["mime"], data=base64.b64encode(image["data"]).decode("ascii"))

    @app.post("/api/feedback/<report>/replies")
    def feedback_reply(report):
        message = text(body(limit=20_000).get("message"), "a reply", 4000)
        staff = is_admin()
        now = int(time.time())
        with closing(connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = authorized(db, report)
            if row["status"] == "closed":
                raise api_error("This feedback thread is closed.", 409)
            if db.execute("SELECT count(*) FROM feedback_reply WHERE report=?", (report,)).fetchone()[0] >= 100:
                raise api_error("This thread is full. Send new feedback to add more details.", 409)
            db.execute("INSERT INTO feedback_reply(report, author, developer, message, created) VALUES (?, ?, ?, ?, ?)",
                       (report, g.user, staff, message, now))
            db.execute("UPDATE feedback SET status=?, updated=? WHERE id=?", ("waiting" if staff else "new", now, report))
        return jsonify(ok=True)

    @app.patch("/api/feedback/<report>")
    def feedback_status(report):
        if not is_admin():
            raise api_error("The developer inbox is private.", 403)
        status = body(limit=256).get("status")
        if status not in ("new", "waiting", "closed"):
            raise api_error("Choose a feedback status.")
        with closing(connect()) as db, db:
            authorized(db, report)
            db.execute("UPDATE feedback SET status=?, updated=? WHERE id=?", (status, int(time.time()), report))
        return jsonify(ok=True)

    return record
