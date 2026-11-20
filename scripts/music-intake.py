#!/usr/bin/env python3
"""FamilyHub administrator music intake: search, fetch, stage, trim and import audio.

Stdlib orchestration around yt-dlp, ffprobe and ffmpeg (all found on PATH).
Each staged item is one directory holding the audio bytes and manifest.json.
Staged bytes are never modified; a trim derives a new item. See docs/MUSIC_INTAKE.md.
"""
import argparse, collections, logging, contextlib, hashlib, json, math, os, queue, re, shutil, signal, stat, subprocess, sys, tempfile, threading, time, urllib.parse
from datetime import datetime, timezone

IMPORT_DIR = "Local Imports"
WATCH = "https://www.youtube.com/watch?v="
YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
EXTENSIONS = {"flac", "mp3", "m4a", "opus", "ogg", "oga", "wav", "aac", "webm", "mka", "wv", "aiff", "aif"}
MAX_SECONDS = 4 * 3600  # longer uploads are treated as archives or streams, not songs
MAX_STDOUT = 32 << 20
SEARCH_POOL = 30  # metadata-only results ranked before the requested limit is applied
KINDS = ["topic", "audio", "other", "video"]
TOPIC_RE = re.compile(r"\S\s*[-‐-―]\s*topic$")  # auto-generated "Artist - Topic" channels
AUDIO_MARK_RE = re.compile(r"official audio|audio only|album version|studio version|[(\[]\s*audio\s*[)\]]")
LYRIC_MARK_RE = re.compile(r"\blyrics?\b")
VIDEO_MARK_RE = re.compile(r"music[ -]video|official(?: (?:hd|4k|8k|remastered))* video|short film|director.s cut")
STORY_MARK_RE = re.compile(r"short film|director.s cut|behind the scenes|\b(?:interview|reaction|tutorial)\b|with (?:intro|dialogue|story)", re.I)
VARIANTS = (
    (r"\blive\b|\bconcert\b", r"\blive (?:at|from|in|performance)\b|[\[(]live\b|\bconcert\b"),
    (r"\bremix\b", r"\bremix\b"),
    (r"\bacoustic\b", r"\bacoustic\b"),
    (r"\bacapella\b|a cappella", r"\bacapella\b|a cappella"),
    (r"\bextended\b", r"\bextended (?:mix|version)\b"),
    (r"\bkaraoke\b", r"\bkaraoke\b"),
    (r"\binstrumental\b", r"\binstrumental\b"),
    (r"\bcover\b|\btribute\b", r"[\[(]cover\b|\bcover by\b|\b(?:piano|guitar|vocal) cover\b|\btribute to\b|\bmade popular by\b"),
    (r"\bsped up\b|\bslowed\b", r"\bsped up\b|\bslowed\b"),
)
COLLECTION_RE = re.compile(r"\b(?:full album|complete album|greatest hits|compilation)\b", re.I)
VID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
ID_RE = re.compile(r"local-[0-9a-f]{16}|edit-[0-9a-f]{16}|yt-[A-Za-z0-9_-]{11}-[0-9a-f]{12}")
AUDIO_RE = re.compile(r"audio\.[a-z0-9]{1,5}")
SHA_RE = re.compile(r"[0-9a-f]{64}")
NUM_RE = re.compile(r"\d{1,6}(\.\d{1,6})?")
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"{p}{n}" for p in ("COM", "LPT") for n in range(1, 10)}
CONTROL = threading.local()
RESOURCE_TRACK = lambda stage: contextlib.nullcontext()
RESOURCE_COMPUTE = lambda background: contextlib.nullcontext(True)
RESOURCE_CHANGED = lambda: None
BACKGROUND_COMMAND = None
AUDIO_COMMAND = None
RESOURCE_WAIT = lambda reason: contextlib.nullcontext()
SAFE_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist",
              "aac,aiff,flac,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3,ogg,wav,wv"]


class IntakeError(Exception):
    pass


# ---- paths and hashing ----
def is_link(path):
    return os.path.islink(path) or getattr(os.path, "isjunction", lambda p: False)(path)


def real_dir(path, what):
    path = os.path.abspath(path)
    if is_link(path) or not os.path.isdir(path):
        raise IntakeError(f"{what} must be an existing directory and not a link: {path}")
    return path


def regular_file(path, what):
    try:
        st = os.lstat(path)
    except OSError:
        raise IntakeError(f"{what} is missing: {path}")
    if is_link(path) or not stat.S_ISREG(st.st_mode):
        raise IntakeError(f"{what} must be a regular file and not a link: {path}")
    return st


def inside(child, parent):
    c, p = (os.path.normcase(os.path.realpath(x)) for x in (child, parent))
    try:
        return os.path.commonpath([c, p]) == p
    except ValueError:  # different drives
        return False


def extension(name):
    ext = os.path.splitext(name)[1][1:].lower()
    if ext not in EXTENSIONS:
        raise IntakeError(f"unsupported audio file extension {ext!r}; expected one of {', '.join(sorted(EXTENSIONS))}")
    return ext


def copy_hash(src, out=None):
    h = hashlib.sha256()
    for chunk in iter(lambda: src.read(1 << 20), b""):
        h.update(chunk)
        if out:
            out.write(chunk)
    return h.hexdigest()


def sha256_file(path):
    with open(path, "rb") as fh:
        return copy_hash(fh)


def clip(value, n=300):
    return None if value is None else str(value)[:n]


def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


# ---- subprocesses: argument lists only, timeout, bounded captured output ----
def tool(name):
    path = shutil.which(name)
    if not path:
        raise IntakeError(f"{name} was not found on PATH")
    return path


def run(args, timeout, what, want_stdout=False, cwd=None, progress=None, stderr_limit=600):
    """Return (returncode, stdout bytes, short stderr excerpt).

    Output uses bounded temporary files. Timeout/cancellation reaps the supervised process tree;
    By default only the last 600 stderr bytes are returned with URLs removed.
    Internal audio measurement can request the bounded complete diagnostic output.
    """
    executable = os.path.splitext(os.path.basename(args[0]))[0].lower()
    heavy = (executable in ("ffmpeg", "ffprobe")
             or "music_web.analysis" in args or "--extract-audio" in args)
    permit = audio_permit() if heavy else contextlib.nullcontext()
    with permit, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = None
        try:
            options = {}
            if "music_web.analysis" in args:
                options["env"] = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
                                      MKL_NUM_THREADS="1", NUMBA_NUM_THREADS="1")
            proc = spawn(AUDIO_COMMAND(args) if heavy and AUDIO_COMMAND else args, stdin=subprocess.DEVNULL,
                         stdout=out if want_stdout else subprocess.DEVNULL, stderr=err, cwd=cwd, **options)
            deadline = time.monotonic() + timeout
            checked = 0
            while proc.poll() is None:
                cancel = getattr(CONTROL, "cancel", None)
                if (cancel and cancel.is_set()) or time.monotonic() > deadline:
                    raise IntakeError(f"{what} cancelled or timed out")
                if os.fstat(err.fileno()).st_size > 2 << 20 or os.fstat(out.fileno()).st_size > MAX_STDOUT:
                    raise IntakeError(f"{what} produced too much output")
                budget = getattr(CONTROL, "budget", None)
                if budget and time.monotonic() - checked > .25:
                    budget()
                    checked = time.monotonic()
                if progress:
                    progress()
                time.sleep(.05)
            rc = proc.returncode
        except OSError as e:
            raise IntakeError(f"{what} could not start ({type(e).__name__})")
        finally:
            if proc:
                stop_process(proc)
        if out.seek(0, os.SEEK_END) > MAX_STDOUT:
            raise IntakeError(f"{what} produced more output than expected")
        out.seek(0)
        err.seek(max(0, err.seek(0, os.SEEK_END) - stderr_limit))
        text = " ".join(err.read().decode("utf-8", "replace").split())
        # Upstream messages can quote signed stream URLs; keep them out of terminals and logs.
        return rc, out.read(), re.sub(r"https?://\S+", "[url]", text)


def probe(path, tags=False):
    rc, out, err = run([tool("ffprobe"), "-v", "error", *SAFE_INPUT, "-show_format", "-show_streams", "-of", "json", path],
                       60, "ffprobe", True)
    try:
        info = json.loads(out) if rc == 0 else None
    except ValueError:
        info = None
    if not isinstance(info, dict):
        raise IntakeError(f"ffprobe cannot read this file as audio: {err or 'no details'}")
    streams = info.get("streams") or []
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if any(s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic") for s in streams):
        raise IntakeError("file contains a video stream; only audio files are accepted")
    if len(audio) != 1:
        raise IntakeError(f"expected exactly one audio stream, found {len(audio)}")
    a, fmt = audio[0], info.get("format") or {}
    try:
        result = {"codec": str(a["codec_name"]), "format": clip(fmt.get("format_name"), 80),
                  "sample_rate": int(a["sample_rate"]), "channels": int(a["channels"]),
                  "duration": float(fmt.get("duration") or a.get("duration") or 0),
                  "bit_rate": int(a.get("bit_rate") or fmt.get("bit_rate") or 0) or None}
    except (KeyError, TypeError, ValueError):
        raise IntakeError("ffprobe reported incomplete audio stream properties")
    if not (math.isfinite(result["duration"]) and result["duration"] > 0 and result["sample_rate"] > 0
            and result["channels"] > 0):
        raise IntakeError("audio stream has no usable duration, sample rate or channel count")
    if tags:  # container and stream tags, lower-cased; Ogg and Matroska keep theirs on the stream
        result["tags"] = {str(k).lower(): str(v) for src in (fmt, a) for k, v in (src.get("tags") or {}).items()}
    return result


def decode_check(path):
    rc, out, err = run([tool("ffmpeg"), "-nostdin", "-v", "error", "-xerror", *SAFE_INPUT, "-i", path, "-map", "0:a:0",
                        "-progress", "pipe:1", "-nostats", "-f", "null", "-"], 900, "ffmpeg decode check", True)
    if rc or err:
        raise IntakeError(f"audio does not decode cleanly (corrupt or truncated): {err or f'exit {rc}'}")
    times = re.findall(rb"out_time_us=(\d+)", out)
    if not times:
        raise IntakeError("decoder did not report a completed audio timeline")
    return int(times[-1]) / 1_000_000


def packet_hash(path):
    """SHA-256 of the compressed audio packets, independent of container and tags."""
    rc, out, err = run([tool("ffmpeg"), "-nostdin", "-v", "error", *SAFE_INPUT, "-i", path, "-map", "0:a:0", "-c", "copy",
                        "-f", "hash", "-hash", "sha256", "-"], 900, "ffmpeg packet hash", True)
    if rc or not out.startswith(b"SHA256="):
        raise IntakeError(f"cannot hash the audio packets: {err or f'exit {rc}'}")
    return out.strip().decode()


def tag_copy(audio, out, tags):
    """Write audio to out with only these tags, copying the audio stream; refuse if the audio or a tag did not survive."""
    args = [tool("ffmpeg"), "-nostdin", "-v", "error", "-n", *SAFE_INPUT, "-i", audio, "-map", "0:a:0", "-map_metadata", "-1",
            "-map_chapters", "-1", "-c:a", "copy"]
    for k, v in tags.items():
        args += ["-metadata", f"{k}={v}"]
    rc, _, err = run(args + [out], 900, "ffmpeg tag copy")
    if rc:
        raise IntakeError(f"cannot copy the audio with tags into this container: {err or f'exit {rc}'}")
    got = probe(out, tags=True)["tags"]
    wrong = [k for k in ("title", "artist", "album", "track") if k in tags and got.get(k) != tags[k]]
    if wrong:
        raise IntakeError(f"this container cannot carry the tags ({', '.join(wrong)}); use a FLAC, MP3, M4A or Ogg item")
    if packet_hash(out) != packet_hash(audio):
        raise IntakeError("the audio changed while tags were written; nothing was published")
    decode_check(out)


# ---- manifest ----
def validate(m, dirname):
    def need(ok, field):
        if not ok:
            raise IntakeError(f"malformed manifest: {field}")
    need(isinstance(m, dict) and m.get("schema") == 1, "schema")
    need(isinstance(m.get("id"), str) and ID_RE.fullmatch(m["id"]) and m["id"] == dirname, "id must match the item directory")
    a, s, e, imp = m.get("audio"), m.get("source"), m.get("edit"), m.get("import")
    need(isinstance(a, dict), "audio")
    need(isinstance(a.get("file"), str) and AUDIO_RE.fullmatch(a["file"])
         and a["file"].split(".")[1] in EXTENSIONS, "audio.file")
    need(isinstance(a.get("sha256"), str) and SHA_RE.fullmatch(a["sha256"]), "audio.sha256")
    need(isnum(a.get("duration")) and a["duration"] > 0, "audio.duration")
    need(all(type(a.get(k)) is int and a[k] > 0 for k in ("sample_rate", "channels", "size")), "audio numbers")
    need(isinstance(a.get("codec"), str) and (a.get("bit_rate") is None or type(a["bit_rate"]) is int), "audio.codec")
    need(isinstance(s, dict) and s.get("kind") in ("youtube", "local"), "source.kind")
    if s["kind"] == "youtube":
        need(isinstance(s.get("id"), str) and VID_RE.fullmatch(s["id"]) and s.get("url") == WATCH + s["id"], "source.url")
    need(m["id"].startswith("edit-") == (e is not None), "edit")
    if e is not None:
        need(isinstance(e, dict) and isinstance(e.get("parent"), str) and ID_RE.fullmatch(e["parent"])
             and isinstance(e.get("parent_sha256"), str) and SHA_RE.fullmatch(e["parent_sha256"]), "edit.parent")
        need(isinstance(e.get("keep"), list) and e["keep"] and all(
            isinstance(k, list) and len(k) == 2 and isnum(k[0]) and isnum(k[1]) and 0 <= k[0] < k[1]
            for k in e["keep"]), "edit.keep")
    if imp is not None:
        parts = imp.get("path").split("/") if isinstance(imp, dict) and isinstance(imp.get("path"), str) else []
        need(len(parts) == 4 and parts[0] == IMPORT_DIR and "\\" not in imp["path"]
             and not any(p in ("", ".", "..") for p in parts), "import.path")
        need(imp.get("sha256") == a["sha256"], "import.sha256")
        need(isinstance(imp.get("library_sha256"), str) and SHA_RE.fullmatch(imp["library_sha256"]), "import.library_sha256")
        need("automatic_title" not in imp or type(imp["automatic_title"]) is bool, "import.automatic_title")


def read_manifest(path):
    """Read and validate a manifest without opening the staged audio."""
    d = real_dir(path, "item")
    mf = os.path.join(d, "manifest.json")
    if regular_file(mf, "manifest").st_size > 1 << 20:
        raise IntakeError("malformed manifest: too large")
    try:
        with open(mf, encoding="utf-8") as fh:
            m = json.load(fh)
    except ValueError:
        raise IntakeError("malformed manifest: not valid JSON")
    validate(m, os.path.basename(d))
    return d, m


def load_item(path):
    """Return (item dir, manifest, audio path) after checking structure, links and the staged SHA-256."""
    d, m = read_manifest(path)
    audio = os.path.join(d, m["audio"]["file"])
    regular_file(audio, "staged audio")
    if sha256_file(audio) != m["audio"]["sha256"]:
        raise IntakeError("staged audio no longer matches the SHA-256 in its manifest")
    return d, m, audio


def write_manifest(d, m):
    fd, tmp = tempfile.mkstemp(prefix=".manifest-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=1, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, os.path.join(d, "manifest.json"))
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp)


@contextlib.contextmanager
def scratch(workspace):
    d = tempfile.mkdtemp(prefix=".tmp-", dir=workspace)
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)  # already renamed away after a successful publish


def existing_item(workspace, item_id):
    d = os.path.join(workspace, item_id)
    if os.path.lexists(d):
        d, m, _ = load_item(d)
        return {"item": d, "existing": True, "manifest": m}


def finish(workspace, tmp, audio, sha, item_id, source, edit, expect_duration=None, source_duration=None):
    """Probe and fully decode the audio in tmp, write its manifest, then publish tmp as the item directory."""
    found = existing_item(workspace, item_id)
    if found:
        return found
    info = probe(audio)
    decoded_duration = decode_check(audio)
    if source_duration is not None and abs(decoded_duration - source_duration) > max(2, source_duration * .02):
        raise IntakeError("decoded duration does not match extraction metadata")
    if expect_duration is not None and abs(info["duration"] - expect_duration) > 0.1:
        raise IntakeError(f"trimmed audio lasts {info['duration']} s, expected {expect_duration} s")
    name = os.path.basename(audio)
    m = {"schema": 1, "id": item_id, "source": source, "edit": edit, "import": None,
         "audio": {"file": name, "sha256": sha, "size": os.path.getsize(audio), **info}}
    validate(m, item_id)
    write_manifest(tmp, m)
    dest = os.path.join(workspace, item_id)
    os.rename(tmp, dest)
    os.chmod(os.path.join(dest, name), 0o444)
    return {"item": dest, "existing": False, "manifest": m}


# ---- commands ----
def video_id(url):
    vid = None
    try:
        u = urllib.parse.urlsplit(url)
        host = (u.hostname or "").lower()
        if u.scheme == "https" and not u.username and u.port is None:
            if host == "youtu.be":
                vid = u.path[1:]
            elif host in YT_HOSTS and u.path == "/watch":
                vid = (urllib.parse.parse_qs(u.query).get("v") or [""])[0]
    except ValueError:
        pass
    if not vid or not VID_RE.fullmatch(vid):
        raise IntakeError(f"expected one video URL such as {WATCH}VIDEO_ID or https://youtu.be/VIDEO_ID")
    return vid


def kind(entry):
    """Rank class from metadata alone: topic, audio, other, video. A heuristic, not proof of identity or quality."""
    channel = " ".join(str(entry.get("channel") or entry.get("uploader") or "").casefold().split())
    title = " ".join(str(entry.get("title") or "").casefold().split())
    if TOPIC_RE.search(channel) or str(entry.get("description") or "").casefold().startswith("provided to youtube by "):
        return "topic"
    if VIDEO_MARK_RE.search(title):
        return "video"
    return "audio" if AUDIO_MARK_RE.search(title) or LYRIC_MARK_RE.search(title) else "other"


def listening_rank(entry, query, artist_terms=()):
    """Prefer listening editions; labels are evidence, never a guarantee of clean audio."""
    title = str(entry.get("title") or "").casefold()
    query = query.casefold()
    duration = entry.get("duration")
    collection = bool(COLLECTION_RE.search(title)) or (isnum(duration) and duration >= 15 * 60)
    requested_collection = bool(COLLECTION_RE.search(query))
    unwanted_version = any(re.search(label, title) and not re.search(requested, query)
                          for requested, label in VARIANTS)
    story = bool(STORY_MARK_RE.search(title)) and not STORY_MARK_RE.search(query)
    category = kind(entry)
    if artist_terms and category == "topic":
        channel = re.sub(r"\s*[-\u2010-\u2015]\s*topic$", "", str(entry.get("channel") or entry.get("uploader") or ""), flags=re.I)
        channel_words = re.findall(r"\w+", channel.casefold())
        shared = min(len(channel_words), len(artist_terms))
        unwanted_version |= shared < min(2, len(artist_terms)) or channel_words[:shared] != list(artist_terms[:shared])
    # Lyric uploads can be useful fallbacks, after studio/official audio.
    lyric_fallback = category == "audio" and not AUDIO_MARK_RE.search(title)
    return (bool(collection and not requested_collection), unwanted_version, bool(story),
            KINDS.index(category), lyric_fallback)


def listening_query(query):
    explicit = re.search(r"\b(?:video|film|live|concert|remix|acoustic|karaoke|instrumental|cover|lyrics?)\b", query, re.I)
    if explicit or AUDIO_MARK_RE.search(query.casefold()) or COLLECTION_RE.search(query):
        return query
    return query + " official audio"


class YouTubeGate:
    """Process-wide request queue; foreground waiters precede background work."""
    def __init__(self):
        self.condition = threading.Condition()
        self.active = False
        self.listener_active = False
        self.users = 0
        self.last = float('-inf')
        self.spacing = 1.0
        self.until = self.backoff = 0
        self.counts = collections.Counter()
        self.refusals = collections.Counter()
        self.reported = time.monotonic()

    @contextlib.contextmanager
    def request(self, caller, background=False, media=False):
        with self.condition:
            self.users += not background
            try:
                while True:
                    cancel = getattr(CONTROL, "cancel", None)
                    if cancel and cancel.is_set():
                        raise IntakeError("YouTube request cancelled")
                    budget = getattr(CONTROL, "budget", None)
                    if budget:
                        budget()
                    if caller == "fetch":
                        current_background = getattr(CONTROL, "background", background)
                        self.users += int(background) - int(current_background)
                        background = current_background
                    now = time.monotonic()
                    delay = max(self.last + self.spacing - now if not media else 0,
                                self.until - now if background else 0)
                    defer = getattr(CONTROL, "defer_youtube", None)
                    if defer and background:
                        defer(self.until > now)
                    listener = caller == "fetch" and not background
                    available = not self.listener_active if listener else not self.active and not self.listener_active and not (background and self.users)
                    if (media or available) and delay <= 0:
                        break
                    reason = "YouTube cooldown" if background and self.until > now else "YouTube pacing"
                    with RESOURCE_WAIT(reason):
                        self.condition.wait(.2)
                if not media:
                    if listener:
                        self.listener_active = True
                    else:
                        self.active = True
                    self.last = now
                self.counts[caller] += 1
            finally:
                self.users -= not background
        try:
            yield
        finally:
            with self.condition:
                now = time.monotonic()
                if now - self.reported >= 600:
                    logging.getLogger(__name__).info(
                        "youtube requests last 10 min: %s; refused %s (%s)",
                        ", ".join(f"{key} {self.counts[key]}" for key in ("search", "matching", "quality", "fetch")),
                        sum(self.refusals.values()), dict(self.refusals))
                    self.counts.clear()
                    self.refusals.clear()
                    self.reported = now
                if not media:
                    if listener:
                        self.listener_active = False
                    else:
                        self.active = False
                self.condition.notify_all()

    def result(self, caller, rc, error, media=False):
        refused = rc and re.search(r"\b(?:403|429)\b|too many requests|rate.?limit|forbidden", error, re.I)
        with self.condition:
            if refused:
                self.refusals[caller] += 1
                self.backoff = min(1800, self.backoff * 2 or 300)
                self.until = time.monotonic() + self.backoff
            elif not rc and (not media or time.monotonic() >= self.until):
                self.until = self.backoff = 0
            self.condition.notify_all()
        RESOURCE_CHANGED()
        return bool(refused)


YOUTUBE = YouTubeGate()
SEARCH_CACHE = collections.OrderedDict()
SEARCH_CACHE_LOCK = threading.Lock()
SEARCH_CACHE_TTL = 6 * 3600


class YouTubeDeferred(IntakeError):
    pass


def youtube_run(command, timeout, what, want_stdout=False, caller="fetch", background=None, media=False):
    if background is None:
        background = getattr(CONTROL, "background", False)
    # Background refusals are retried after cooldown, never persisted as failed matches.
    while True:
        turn = media_turn(caller, background) if media else YOUTUBE.request(caller, background)
        with turn:
            result = run(command, timeout, what, want_stdout)
            refused = YOUTUBE.result(caller, result[0], result[2], media)
        if background and refused:
            if media:
                if expired_media(result[2]):
                    return result
                raise MediaRetry()
            if caller == "fetch":
                continue
            raise YouTubeDeferred("YouTube cooldown")
        return result


def search_entries(query, offset, caller, background, main_only=False):
    if background:
        with YOUTUBE.condition:
            while YOUTUBE.until > time.monotonic():
                cancel = getattr(CONTROL, "cancel", None)
                if cancel and cancel.is_set():
                    raise IntakeError("search cancelled")
                budget = getattr(CONTROL, "budget", None)
                if budget:
                    budget()
                with RESOURCE_WAIT("YouTube cooldown"):
                    YOUTUBE.condition.wait(.2)
    direct = WATCH + video_id(query) if query.startswith("https://") else None
    query = direct or query
    key = query if direct else " ".join(query.casefold().split())
    # Reserve a query without holding the cache lock during pacing or network work.
    while True:
        with SEARCH_CACHE_LOCK:
            now = time.monotonic()
            for old in list(SEARCH_CACHE):
                if now - SEARCH_CACHE[old]["created"] >= SEARCH_CACHE_TTL:
                    del SEARCH_CACHE[old]
            cached = SEARCH_CACHE.get(key)
            if cached is None:
                cached = dict(created=now, entries=[], depth=0, extra=None, busy=threading.Lock())
                SEARCH_CACHE[key] = cached
            SEARCH_CACHE.move_to_end(key)
            while len(SEARCH_CACHE) > 200:
                SEARCH_CACHE.popitem(last=False)
        with RESOURCE_WAIT("same query"):
            if cached["busy"].acquire(timeout=.1):
                break
        cancel = getattr(CONTROL, "cancel", None)
        if cancel and cancel.is_set():
            raise IntakeError("search cancelled")
    try:
        depth = offset + SEARCH_POOL
        if cached["depth"] < depth:
            rc, out, err = youtube_run([tool("yt-dlp"), "--ignore-config", "--flat-playlist", "--dump-single-json",
                *(["--no-playlist", "-f", "bestaudio/best*", "--", direct] if direct else [f"ytsearch{depth}:{query}"])], 120, "yt-dlp search", True, caller, background)
            try:
                data = json.loads(out) if rc == 0 else None
                entries = [data] if direct and isinstance(data, dict) else (data.get("entries") or [] if isinstance(data, dict) else None)
            except (ValueError, AttributeError):
                entries = None
            if not isinstance(entries, list):
                raise IntakeError(f"yt-dlp search failed: {err or f'exit {rc}'}")
            # Keep previously served provider positions stable when extending the pool.
            cached["entries"].extend(entries[len(cached["entries"]):])
            cached["depth"] = depth
        entries = list(cached["entries"][offset:depth])
        if not direct and not offset and listening_query(query) != query and sum(kind(e) == "topic" for e in entries if isinstance(e, dict)) < 3:
            if cached["extra"] is None and main_only:
                return entries, False
            if cached["extra"] is None:
                try:
                    rc, out, _ = youtube_run([tool("yt-dlp"), "--ignore-config", "--flat-playlist", "--dump-single-json",
                        f'ytsearch15:{query} "Provided to YouTube"'], 45, "art track search", True, caller, background)
                    extra = json.loads(out).get("entries", []) if rc == 0 else []
                    cached["extra"] = extra[:15] if isinstance(extra, list) else []
                except YouTubeDeferred:
                    raise
                except (IntakeError, ValueError, AttributeError):
                    cancel = getattr(CONTROL, "cancel", None)
                    if cancel and cancel.is_set():
                        raise IntakeError("search cancelled")
            entries.extend(cached["extra"] or [])
        return entries, True
    finally:
        cached["busy"].release()


def cmd_search(args):
    with RESOURCE_TRACK("search"):
        return _search(args)


def _search(args):
    query = args.query.strip()
    if not query or len(query) > 200 or any(ord(c) < 32 for c in query):
        raise IntakeError("search query must be 1 to 200 printable characters")
    if not 1 <= args.limit <= SEARCH_POOL:
        raise IntakeError(f"--limit must be between 1 and {SEARCH_POOL}")
    offset = getattr(args, "offset", 0)
    if type(offset) is not int or not 0 <= offset <= 3000:
        raise IntakeError("invalid search offset")
    caller = getattr(args, "youtube_caller", "search")
    background = getattr(args, "youtube_background", caller != "search")
    while True:
        try:
            entries, complete = search_entries(query, offset, caller, background, getattr(args, "main_only", False))
            break
        except YouTubeDeferred:
            continue
    positions, found = {}, []
    for e in entries:
        if not isinstance(e, dict) or not VID_RE.fullmatch(str(e.get("id") or "")):
            continue
        if e["id"] in positions:
            index = positions[e["id"]]
            merged = {**e, **{k:v for k,v in found[index][0].items() if v is not None}}
            found[index] = (merged, kind(merged))
        else:
            positions[e["id"]] = len(found)
            found.append((e, kind(e)))
    query_words = re.findall(r"\w+", query.casefold())
    artist_terms = ()
    for entry, _ in found:
        channel = str(entry.get("channel") or entry.get("uploader") or "")
        channel = re.sub(r"\s*[-\u2010-\u2015]\s*topic$", "", channel, flags=re.I)
        words = re.findall(r"\w+", channel.casefold())
        from difflib import SequenceMatcher
        prefix = query_words[:len(words)]
        close_artist = len(words) >= 2 and len(prefix) == len(words) and prefix[:-1] == words[:-1] and SequenceMatcher(None, prefix[-1], words[-1]).ratio() >= .85
        if words and (prefix == words or close_artist) and len(words) > len(artist_terms):
            artist_terms = tuple(words)
    terms = set(query_words[len(artist_terms):]) - {"official", "audio", "video", "provided", "youtube", "by", "the", "to", "be", "and", "me", "feat", "ft"}
    def rank(pair):
        title_words = set(re.findall(r"\w+", str(pair[0].get("title") or "").casefold()))
        weak_title_match = bool(terms) and len(terms & title_words) < min(2, len(terms))
        return (weak_title_match, *listening_rank(pair[0], query, artist_terms))
    found.sort(key=rank)  # Stable provider order within a tier.
    return {"query": query, "complete": complete, "results": [
        {"id": e["id"], "url": WATCH + e["id"], "title": clip(e.get("title")),
         "channel": clip(e.get("channel") or e.get("uploader")), "duration": e.get("duration"), "kind": k}
        for e, k in found[:args.limit]]}


class MediaExpired(IntakeError):
    pass


class MediaRetry(IntakeError):
    pass


def expired_media(error):
    return re.search(r"\b(?:401|403|410)\b", error) is not None


@contextlib.contextmanager
def media_turn(caller, background):
    acquire = getattr(CONTROL, "transfer", None)
    while True:
        with YOUTUBE.request(caller, background, media=True):
            reserve = getattr(CONTROL, "reserve_attempt", None)
            if reserve:
                reserve()
            with acquire() if acquire else contextlib.nullcontext():
                # A refusal can arrive while this job is waiting for a transfer slot.
                with YOUTUBE.condition:
                    cooling = getattr(CONTROL, "background", background) and YOUTUBE.until > time.monotonic()
                if not cooling:
                    yield
                    return
            if reserve:
                raise MediaRetry()


def resolved_audio(url, vid):
    with SEARCH_CACHE_LOCK:
        cached = SEARCH_CACHE.get(url)
        if not cached or time.monotonic() - cached["created"] >= 300 or not cached["entries"]:
            return None
        data = cached["entries"][0]
    if (isinstance(data, dict) and data.get("id") == vid and data.get("vcodec") == "none"
            and data.get("acodec") not in (None, "none") and data.get("format_id")
            and str(data.get("url", "")).startswith("https://")):
        expiry = urllib.parse.parse_qs(urllib.parse.urlsplit(data["url"]).query).get("expire", [""])[0]
        if not expiry.isdecimal() or (len(expiry) <= 12 and int(expiry) > time.time() + 30):
            return data
    return None


@contextlib.contextmanager
def media_info(tmp, metadata):
    # yt-dlp otherwise re-extracts webpage_url on a failed --load-info-json transfer.
    prepared = json.dumps({k: v for k, v in metadata.items() if k != "webpage_url"}).encode("utf-8")
    if len(prepared) > MAX_STDOUT:
        raise IntakeError("selected audio metadata exceeds size limit")
    fd, path = tempfile.mkstemp(prefix=".source-", suffix=".json", dir=tmp)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(prepared)
        yield path
    finally:
        os.unlink(path)


def cmd_fetch(args):
    vid = video_id(args.url)
    metadata = resolved_audio(WATCH + vid, vid)
    with RESOURCE_TRACK("fetch"):
        try:
            return fetch_audio(args, vid, metadata)
        except MediaExpired:
            return fetch_audio(args, vid, None)


def fetch_audio(args, vid, meta):
    ws = real_dir(args.workspace, "workspace")
    url = WATCH + vid  # canonical form drops playlist and tracking parameters
    tool("ffmpeg"), tool("ffprobe")
    # bestaudio only: without an audio-only format yt-dlp fails here; nothing substitutes a video download.
    base = [tool("yt-dlp"), "--ignore-config", "--no-playlist", "-f", "bestaudio"]
    err = ""
    if meta is None:
        rc, out, err = youtube_run(base + ["--dump-single-json", "--", url], 120, "yt-dlp metadata", True)
        try:
            meta = json.loads(out) if rc == 0 else None
        except ValueError:
            meta = None
    if not isinstance(meta, dict) or meta.get("id") != vid:
        raise IntakeError(f"yt-dlp could not read this video: {err or 'unexpected metadata'}")
    if meta.get("is_live") or meta.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        raise IntakeError("live and upcoming streams are not accepted")
    if not (isnum(meta.get("duration")) and 0 < meta["duration"] <= MAX_SECONDS):
        raise IntakeError(f"video duration is unknown or longer than {MAX_SECONDS} s")
    source = {"kind": "youtube", "url": url, "id": vid, "title": clip(meta.get("title")),
              "channel": clip(meta.get("channel") or meta.get("uploader")), "lossy": True,
              "artist": clip(meta.get("artist")), "album": clip(meta.get("album")), "track_title": clip(meta.get("track")),
              "reported_format": {"format_id": clip(meta.get("format_id"), 40), "acodec": clip(meta.get("acodec"), 40),
                                  "abr": meta.get("abr") if isnum(meta.get("abr")) else None}}
    reserve = getattr(CONTROL, "reserve", None)
    source_limit = min(2 << 30, exact_download_size(meta) or (2 << 30))
    preview = getattr(args, "preview", None)
    needed = 2 * source_limit + (64 << 20) + (int(meta["duration"] * 32000) if preview else 0)
    while True:
        with contextlib.ExitStack() as cleanup:
            # Reserve only after provider admission. Release after the spool and render clean up.
            CONTROL.reserve_attempt = (lambda: cleanup.enter_context(reserve(needed))) if reserve else None
            try:
                if preview:
                    return progressive_fetch(args, meta, source, max_bytes=source_limit, scratch_limit=needed)
                return download_audio(ws, base, meta, source, source_limit, needed)
            except MediaRetry:
                pass
            except BaseException:
                cleanup_preview = getattr(args, "cleanup_preview", None)
                if cleanup_preview:
                    with contextlib.suppress(OSError, IntakeError):
                        cleanup_preview()
                raise
            finally:
                CONTROL.reserve_attempt = None


def download_audio(ws, base, meta, source, max_bytes, scratch_limit):
    with scratch(ws) as tmp, scratch_guard(tmp, None, scratch_limit) as budget:
        dl = os.path.join(tmp, "dl")
        os.mkdir(dl)
        # --extract-audio with --audio-format best keeps the source codec; it changes the container at most.
        with media_info(tmp, meta) as info_path:
            rc, _, err = youtube_run(base + ["--no-overwrites", "--no-progress", "--match-filter", "!is_live",
                                     "--max-filesize", str(max_bytes), "--extract-audio", "--audio-format", "best",
                                     "--paths", dl, "--output", "source.%(ext)s", "--load-info-json", info_path],
                                     1800, "yt-dlp download", media=True)
            budget(force=True)
        if rc and expired_media(err):
            raise MediaExpired("selected audio URL expired")
        files = os.listdir(dl)
        if rc or len(files) != 1:
            raise IntakeError(f"yt-dlp download failed: {err or 'no single audio file was produced'}")
        src = os.path.join(dl, files[0])
        regular_file(src, "downloaded audio")
        audio = os.path.join(tmp, "audio." + extension(files[0]))
        os.rename(src, audio)
        os.rmdir(dl)
        sha = sha256_file(audio)
        return finish(ws, tmp, audio, sha, f"yt-{source['id']}-{sha[:12]}", source, None)


def stop_process(proc):
    """Terminate only this supervised process tree, then reap its leader."""
    if os.name == "nt" and getattr(proc, "music_job", None):
        import ctypes
        ctypes.windll.kernel32.TerminateJobObject(proc.music_job, 1)
    elif os.name != "nt":
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
    if proc.poll() is None:
        if os.name == "nt":
            if not getattr(proc, "music_job", None):
                proc.kill()
    proc.wait(timeout=15)
    if os.name == "nt" and getattr(proc, "music_job", None):
        import ctypes
        ctypes.windll.kernel32.CloseHandle(proc.music_job)
        proc.music_job = None


@contextlib.contextmanager
def audio_permit():
    priority = getattr(CONTROL, "priority", None) or getattr(CONTROL, "background", False)
    with RESOURCE_COMPUTE(priority) as granted:
        if not granted:
            raise IntakeError("Audio processing requires a CPU slot")
        yield


def spawn(args, **kw):
    # Work no listener is waiting on yields the CPU: niceness 10 on Linux.
    priority = getattr(CONTROL, "priority", None)
    if priority() if priority else getattr(CONTROL, "background", False):
        if BACKGROUND_COMMAND:
            args = BACKGROUND_COMMAND(args)
        elif os.name != "nt" and shutil.which("nice"):
            args = ["nice", "-n", "10", *args]
    proc = subprocess.Popen(args, start_new_session=os.name != "nt",
                            creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP | 4) if os.name == "nt" else 0, **kw)
    if os.name == "nt":
        # A job object owns encoder/downloader descendants; taskkill cannot open sandbox children.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.windll.kernel32
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        if not handle or not kernel.AssignProcessToJobObject(handle, int(proc._handle)):
            proc.kill()
            proc.wait()
            if handle:
                kernel.CloseHandle(handle)
            raise IntakeError("cannot supervise process tree")
        proc.music_job = handle
        # CREATE_SUSPENDED closes the race where the venv launcher spawns before job assignment.
        class ThreadEntry(ctypes.Structure):
            _fields_ = [(name, wintypes.DWORD) for name in (
                "size", "usage", "thread_id", "process_id", "priority", "delta", "flags")]
        kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel.OpenThread.restype = wintypes.HANDLE
        kernel.ResumeThread.argtypes = [wintypes.HANDLE]
        snapshot = kernel.CreateToolhelp32Snapshot(4, 0)
        entry = ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        resumed = False
        try:
            more = kernel.Thread32First(wintypes.HANDLE(snapshot), ctypes.byref(entry))
            while more:
                if entry.process_id == proc.pid:
                    thread = kernel.OpenThread(2, False, entry.thread_id)
                    if thread:
                        resumed = kernel.ResumeThread(thread) != 0xFFFFFFFF
                        kernel.CloseHandle(thread)
                    break
                more = kernel.Thread32Next(wintypes.HANDLE(snapshot), ctypes.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        if not resumed:
            stop_process(proc)
            raise IntakeError("cannot resume supervised process")
    return proc


def hls_command(audio, root):
    return [tool("ffmpeg"), "-nostdin", "-v", "error", *SAFE_INPUT,
            "-i", audio, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k",
            "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "event",
            "-hls_flags", "temp_file", "-hls_segment_type", "fmp4",
            "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename",
            "seg%05d.m4s", "index.m3u8"]


def pump_preview(command, *args, **kwargs):
    # Each attempt owns these newly created paths; a refusal leaves a partial spool.
    spool = args[0] if args else kwargs["spool"]
    root = args[1] if len(args) > 1 else kwargs["root"]
    while True:
        background = getattr(CONTROL, "background", False)
        retry_paths = not os.path.lexists(root) and not os.path.lexists(spool)
        with media_turn("fetch", background):
            try:
                result = _pump_preview(command, *args, **kwargs)
            except IntakeError as error:
                refused = YOUTUBE.result("fetch", 1, str(error), media=True)
                expired = expired_media(str(error))
                if not retry_paths or not (expired or (background and refused)):
                    raise
                # The pump has stopped its processes before these owned paths are removed.
                root_path = os.path.abspath(root)
                if os.path.realpath(root) != root_path or os.path.dirname(root_path) == root_path:
                    raise
                if expired and os.path.exists(os.path.join(root_path, "index.m3u8")):
                    raise
                if os.path.isdir(root_path):
                    shutil.rmtree(root_path)
                if os.path.exists(spool):
                    os.unlink(spool)
                if expired:
                    raise MediaExpired("selected audio URL expired") from error
                if getattr(CONTROL, "reserve_attempt", None):
                    raise MediaRetry() from error
            else:
                YOUTUBE.result("fetch", 0, "", media=True)
                return result


def _pump_preview(command, spool, root, cancel, notify=lambda: None, budget=lambda: None,
                 max_bytes=2 << 30, timeout=1800, idle=45, progress=lambda **fields: None, total_bytes=None):
    """One source, exact spool and a detachable bounded encoder branch; no browser owns the pipe."""
    os.mkdir(root, 0o700)
    started = last = time.monotonic()
    chunks, encoded = queue.Queue(8), queue.Queue(8)
    stopped = threading.Event()
    errors = []
    procs, threads = [], []
    permit = contextlib.ExitStack()
    source_error = tempfile.TemporaryFile()
    digest, size, preview_ok = hashlib.sha256(), 0, False
    def read_source():
        try:
            while not stopped.is_set():
                data = os.read(source.stdout.fileno(), 65536)
                while not stopped.is_set():
                    try:
                        chunks.put(data, timeout=.1)
                        break
                    except queue.Full:
                        pass
                if not data:
                    break
        except (OSError, ValueError) as e:
            errors.append(e)
    def write_encoder():
        try:
            while not stopped.is_set():
                try:
                    data = encoded.get(timeout=.1)
                except queue.Empty:
                    continue
                if data is None:
                    break
                encoder.stdin.write(data)
                encoder.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            with contextlib.suppress(OSError):
                encoder.stdin.close()
    try:
        permit.enter_context(audio_permit())
        source = spawn(command, stdout=subprocess.PIPE, stderr=source_error, stdin=subprocess.DEVNULL)
        procs.append(source)
        encoder_command = hls_command("pipe:0", root)
        encoder = spawn(AUDIO_COMMAND(encoder_command) if AUDIO_COMMAND else encoder_command, cwd=root, stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append(encoder)
        for fn in (read_source, write_encoder):
            thread = threading.Thread(target=fn, daemon=True)
            threads.append(thread)
            thread.start()
        attached = True
        with open(spool, "xb") as out:
            while True:
                now = time.monotonic()
                if cancel.is_set() or now - started > timeout or now - last > idle:
                    raise IntakeError("acquisition cancelled or timed out")
                budget()
                notify()
                if errors:
                    raise IntakeError("source pipe failed")
                try:
                    data = chunks.get(timeout=.1)
                except queue.Empty:
                    continue
                if not data:
                    break
                last = now
                size += len(data)
                if size > max_bytes:
                    raise IntakeError("source exceeds byte limit")
                out.write(data)
                out.flush()
                digest.update(data)
                if total_bytes is not None and size > total_bytes:
                    total_bytes = None
                progress(download_bytes=size, download_total_bytes=total_bytes)
                if attached:
                    try:
                        encoded.put(data, timeout=.5)
                    except queue.Full:
                        # A stalled/non-sequential decoder must not block the exact original.
                        attached = False
                        stop_process(encoder)
            out.flush()
            os.fsync(out.fileno())
        remaining = max(.1, timeout - (time.monotonic() - started))
        if source.wait(timeout=min(30, remaining)) or not size:
            source_error.seek(max(0, source_error.seek(0, os.SEEK_END) - 600))
            error = re.sub(r"https?://\S+", "[url]", source_error.read().decode("utf-8", "replace"))
            raise IntakeError(f"source acquisition failed: {error}")
        progress(download_bytes=size, download_total_bytes=size)
        if attached:
            while encoder.poll() is None:
                if cancel.is_set() or time.monotonic() - started > timeout:
                    raise IntakeError("preview cancelled or timed out")
                try:
                    encoded.put(None, timeout=.1)
                    break
                except queue.Full:
                    pass
            while encoder.poll() is None:
                budget()
                notify()
                if cancel.wait(.1) or time.monotonic() - started > timeout:
                    raise IntakeError("preview cancelled or timed out")
            preview_ok = encoder.returncode == 0
        notify()
        return {"sha256": digest.hexdigest(), "bytes": size, "preview_complete": preview_ok}
    finally:
        stopped.set()
        try:
            for proc in procs:
                stop_process(proc)
        finally:
            permit.close()
        source_error.close()
        for thread in threads:
            thread.join(timeout=5)
        for proc in procs:
            if proc.stdout:
                proc.stdout.close()
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()


def exact_download_size(metadata):
    size = metadata.get("filesize")
    if (type(size) is int and size > 0 and metadata.get("protocol") in ("http", "https")
            and not metadata.get("requested_formats") and not metadata.get("fragments")):
        return size
    return None


@contextlib.contextmanager
def scratch_guard(tmp, preview, cap, check=None):
    old = getattr(CONTROL, "budget", None)
    checked = float("-inf")

    def budget(force=False):
        nonlocal checked
        if check or old:
            (check or old)()
        now = time.monotonic()
        if cap and (force or now - checked >= .5):
            checked = now
            used = 0
            for path in (tmp, preview):
                if path:
                    for root, dirs, files in os.walk(path):
                        for name in files:
                            # HLS files can be replaced between the listing and stat.
                            with contextlib.suppress(FileNotFoundError):
                                used += os.path.getsize(os.path.join(root, name))
            if used > cap:
                raise IntakeError("scratch capacity exceeded")

    CONTROL.budget = budget
    try:
        yield budget
    finally:
        CONTROL.budget = old


def progressive_fetch(args, metadata, source, max_bytes=2 << 30, scratch_limit=0):
    ws = real_dir(args.workspace, "workspace")
    cancel = args.cancel
    with scratch(ws) as tmp, scratch_guard(tmp, args.preview, scratch_limit, args.budget) as budget:
        spool = os.path.join(tmp, "original.spool")
        fmt = metadata.get("format_id")
        if not isinstance(fmt, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", fmt):
            raise IntakeError("no unambiguous selected audio format")
        command = [tool("yt-dlp"), "--ignore-config", "--no-playlist", "--no-progress", "--downloader", "native",
                   "--socket-timeout", "30", "--retries", "2", "--fragment-retries", "2", "-f", fmt,
                   "-o", "-"]
        with media_info(tmp, metadata) as info_path, RESOURCE_TRACK("preview"):
            # Reuse extraction, including signed URLs, only during this acquisition.
            result = pump_preview(command + ["--load-info-json", info_path], spool,
                                  args.preview, cancel, args.notify, budget,
                                  progress=getattr(args, "progress", lambda **fields: None),
                                  max_bytes=max_bytes,
                                  total_bytes=exact_download_size(metadata))
        if cancel.is_set():
            raise IntakeError("cancelled")
        info = probe(spool)
        if abs(info["duration"] - metadata["duration"]) > max(2, metadata["duration"] * .02):
            raise IntakeError("source duration does not match extraction metadata")
        ext = {"opus": "opus", "aac": "m4a", "mp3": "mp3", "vorbis": "ogg", "flac": "flac"}.get(info["codec"])
        if not ext:
            raise IntakeError("selected codec has no packet-preserving import container")
        audio = os.path.join(tmp, "audio." + ext)
        rc, _, _ = run([tool("ffmpeg"), "-nostdin", "-v", "error", *SAFE_INPUT, "-i", spool,
                        "-map", "0:a:0", "-c:a", "copy", audio], 900, "original remux")
        if rc or packet_hash(spool) != packet_hash(audio):
            raise IntakeError("original packets changed during remux")
        source["original_sha256"], source["original_bytes"] = result["sha256"], result["bytes"]
        if not result["preview_complete"]:
            # Complete-file fallback uses the same acquisition and selected quality.
            if any(re.fullmatch(r"seg\d{5}\.m4s", n) for n in os.listdir(args.preview)):
                # Already published segments are immutable, including after an encoder failure.
                args.preview_failed()
            else:
                shutil.rmtree(real_dir(args.preview, "preview"))
                os.mkdir(args.preview, 0o700)
                rc, _, _ = run(hls_command(audio, args.preview), 900, "complete preview", cwd=args.preview)
                if rc:
                    args.preview_failed()
        args.notify()
        budget(force=True)
        sha = sha256_file(audio)
        return finish(ws, tmp, audio, sha, f"yt-{source['id']}-{sha[:12]}", source, None,
                      source_duration=metadata["duration"])


def cmd_preview(args):
    with RESOURCE_TRACK("preview"):
        return preview_audio(args)


def preview_audio(args):
    """Encode validated local audio, publishing complete HLS segments while encoding continues."""
    item, manifest, audio = load_item(args.item)
    root = os.path.abspath(args.output)
    if os.path.lexists(root):
        raise IntakeError("preview destination already exists")
    os.mkdir(root, 0o700)
    try:
        rc, _, err = run(hls_command(audio, root),
                         900, "HLS preview", cwd=root, progress=getattr(args, "notify", None))
        if rc:
            raise IntakeError(f"HLS preview failed: {err or f'exit {rc}'}")
        regular_file(os.path.join(root, "index.m3u8"), "preview playlist")
        return {"assets": sorted(n for n in os.listdir(root) if re.fullmatch(r"(?:index\.m3u8|init\.mp4|seg\d{5}\.m4s)", n))}
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise


def cmd_stage(args):
    ws = real_dir(args.workspace, "workspace")
    path = os.path.abspath(args.file)
    ext = extension(path)
    regular_file(path, "source")  # before open(): opening a FIFO would block
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(fd, "rb") as src:
        if not stat.S_ISREG(os.fstat(src.fileno()).st_mode):
            raise IntakeError(f"source must be a regular file: {path}")
        tool("ffmpeg"), tool("ffprobe")
        with scratch(ws) as tmp:
            audio = os.path.join(tmp, "audio." + ext)
            with open(audio, "xb") as out:
                sha = copy_hash(src, out)
            # lossy is unknown for local files: a lossless codec does not prove a lossless origin.
            source = {"kind": "local", "original_name": clip(os.path.basename(path)), "lossy": None}
            return finish(ws, tmp, audio, sha, f"local-{sha[:16]}", source, None)


def parse_keep(specs, duration):
    keep, last = [], 0.0
    if len(specs) > 50:
        raise IntakeError("at most 50 --keep intervals")
    for spec in specs:
        a, sep, b = spec.partition(":")
        if not (sep and NUM_RE.fullmatch(a) and NUM_RE.fullmatch(b)):
            raise IntakeError(f"--keep {spec!r}: expected START:END in seconds, for example 12.5:201")
        s, e = float(a), float(b)
        if not last <= s < e <= duration + 0.001:
            raise IntakeError(f"--keep {spec!r}: intervals must be ordered, nonoverlapping, longer than zero "
                              f"and within 0 to {duration} s")
        keep.append([s, e])
        last = e
    if len(keep) == 1 and keep[0][0] == 0 and keep[0][1] >= duration - 0.001:
        raise IntakeError("--keep covers the whole file; nothing would be removed")
    return keep


def cmd_trim(args):
    d, m, audio = load_item(args.item)
    keep = parse_keep(args.keep, m["audio"]["duration"])
    ws = os.path.dirname(d)
    canon = ",".join(f"{s:.6f}-{e:.6f}" for s, e in keep)
    item_id = "edit-" + hashlib.sha256(f"{m['audio']['sha256']}|{canon}".encode()).hexdigest()[:16]
    found = existing_item(ws, item_id)
    if found:
        return found
    ffmpeg = tool("ffmpeg")
    # The first asetpts makes times count from the start of the audio even when the container starts at a nonzero time.
    graph = ";".join(f"[0:a:0]asetpts=PTS-STARTPTS,atrim=start={s:.6f}:end={e:.6f},asetpts=PTS-STARTPTS[a{i}]"
                     for i, (s, e) in enumerate(keep))
    graph += ";" + "".join(f"[a{i}]" for i in range(len(keep))) + f"concat=n={len(keep)}:v=0:a=1[out]"
    with scratch(ws) as tmp:
        out = os.path.join(tmp, "audio.flac")
        # FLAC output: the edit adds no second lossy encode. Float decoder output is still converted to integer
        # samples, and quality lost before staging stays lost.
        rc, _, err = run([ffmpeg, "-nostdin", "-v", "error", "-i", audio, "-filter_complex", graph, "-map", "[out]",
                          "-map_metadata", "-1", "-map_chapters", "-1", "-c:a", "flac", "-f", "flac", out],
                         1800, "ffmpeg trim")
        if rc:
            raise IntakeError(f"ffmpeg trim failed: {err or f'exit {rc}'}")
        edit = {"parent": m["id"], "parent_sha256": m["audio"]["sha256"], "keep": keep}
        return finish(ws, tmp, out, sha256_file(out), item_id, m["source"], edit, sum(e - s for s, e in keep))


def safe_name(text, what):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", text).strip().rstrip(". ")
    if not name or len(name) > 120 or name.startswith(".") or name.split(".")[0].upper() in RESERVED:
        raise IntakeError(f"--{what} {text!r} cannot be used as a file or directory name")
    return name


def cmd_import(args):
    d, m, audio = load_item(args.item)
    lib = real_dir(args.library, "library")
    if inside(d, lib):
        raise IntakeError("the item is staged inside the library; stage items in a workspace outside it")
    if args.track is not None and not 1 <= args.track <= 999:
        raise IntakeError("--track must be between 1 and 999")
    parts = [IMPORT_DIR, safe_name(args.artist, "artist"), safe_name(args.album, "album")]
    name = (f"{args.track:02d} - " if args.track else "") + safe_name(args.title, "title") + "." + m["audio"]["file"].split(".")[1]
    rel, sha, prev = "/".join(parts + [name]), m["audio"]["sha256"], m.get("import")
    if prev and prev["path"] != rel and os.path.lexists(os.path.join(lib, *prev["path"].split("/"))):
        raise IntakeError(f"this item is already imported as {prev['path']}; remove that file before importing it elsewhere")
    dest_dir = lib
    for part in parts:
        dest_dir = os.path.join(dest_dir, part)
        if os.path.lexists(dest_dir):
            real_dir(dest_dir, "library directory")
        else:
            os.mkdir(dest_dir)
    dest = os.path.join(dest_dir, name)
    record = {"path": rel, "sha256": sha, "artist": args.artist, "album": args.album, "title": args.title,
              "track": args.track}
    existing = os.path.lexists(dest)
    if existing:
        # Tagging may remux differently each time, so a repeat is recognised by the recorded metadata and library hash.
        regular_file(dest, "existing library file")
        if not (prev and {k: prev.get(k) for k in record} == record and sha256_file(dest) == prev["library_sha256"]):
            raise IntakeError(f"a different file already exists at {dest}; nothing was changed")
    else:
        tags = {"title": args.title, "artist": args.artist, "album_artist": args.artist, "album": args.album}
        if args.track:
            tags["track"] = str(args.track)
        # A fresh hidden directory gives ffmpeg a path with the real extension; it is removed afterwards.
        tmpd = tempfile.mkdtemp(prefix=".import-", dir=dest_dir)
        try:
            tmp = os.path.join(tmpd, "audio." + m["audio"]["file"].split(".")[1])
            tag_copy(audio, tmp, tags)
            # A new inode inherits the library's default ACL; the staged file keeps its own permissions.
            os.chmod(tmp, 0o644)
            record["library_sha256"] = sha256_file(tmp)
            with getattr(CONTROL, "publish", None) or contextlib.nullcontext():
                cancel = getattr(CONTROL, "cancel", None)
                if cancel and cancel.is_set():
                    raise IntakeError("import cancelled before publication")
                try:
                    os.link(tmp, dest)  # atomic and never replaces an existing name
                except FileExistsError:
                    raise IntakeError(f"a file appeared at {dest} during import; nothing was changed") from None
                if prev:
                    record.update({key: prev[key] for key in ('added_by', 'added_at', 'automatic_title') if key in prev})
                else:
                    record['added_at'] = datetime.now(timezone.utc).isoformat()
                    if getattr(args, 'added_by', None):
                        record['added_by'] = args.added_by
                    record['automatic_title'] = getattr(args, 'automatic_title', False)
                m['import'] = record
                try:
                    write_manifest(d, m)
                except OSError:
                    os.unlink(dest)
                    raise
                committed = getattr(CONTROL, "committed", None)
                if committed:
                    committed()
        finally:
            shutil.rmtree(tmpd, ignore_errors=True)
    return {"item": d, "imported": dest, "existing": existing, "manifest": m}


def dispatch(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("search", help="list public YouTube results; downloads nothing")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=5)
    p.set_defaults(fn=cmd_search)
    p = sub.add_parser("fetch", help="download the best audio of one YouTube video into a staged item")
    p.add_argument("url")
    p.add_argument("--workspace", required=True)
    p.set_defaults(fn=cmd_fetch)
    p = sub.add_parser("stage", help="copy a local audio file into a staged item")
    p.add_argument("file")
    p.add_argument("--workspace", required=True)
    p.set_defaults(fn=cmd_stage)
    p = sub.add_parser("trim", help="derive a new FLAC item that keeps the given intervals")
    p.add_argument("item", help="path of a staged item directory")
    p.add_argument("--keep", action="append", required=True, metavar="START:END", help="seconds; repeat to keep several parts")
    p.set_defaults(fn=cmd_trim)
    p = sub.add_parser("import", help=f"copy a staged item into '{IMPORT_DIR}' in the music library")
    p.add_argument("item", help="path of a staged item directory")
    p.add_argument("--library", required=True)
    p.add_argument("--artist", required=True)
    p.add_argument("--album", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--track", type=int)
    p.set_defaults(fn=cmd_import)
    args = ap.parse_args(argv)
    return args.fn(args)


def main(argv=None):
    try:
        print(json.dumps(dispatch(argv), indent=1))
        return 0
    except IntakeError as e:
        print(f"music-intake: {e}", file=sys.stderr)
    except OSError as e:
        print(f"music-intake: {type(e).__name__}: {e}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
