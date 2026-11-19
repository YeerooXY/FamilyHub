"""Playlist links from SoundCloud and Deezer, read into the same track rows as Spotify imports.

Both give title, artist and length only; matching then finds each song on YouTube like a
Spotify import. No account, cookie or credential is used.
"""
import hashlib
import json
import re
import urllib.request
from urllib.parse import urlsplit

from .playlists import PlaylistError
from .resources import PROVIDERS


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PlaylistError("Deezer redirected this request. Try the playlist's full deezer.com link.")

MAX_TRACKS = 1000
SOURCES = ("spotify", "youtube", "soundcloud", "deezer")


def detect(url):
    """The playlist source a link belongs to, or None. The app shows this before importing."""
    try:
        parsed = urlsplit(url if isinstance(url, str) and len(url) <= 2048 else "")
        host = (parsed.hostname or "").lower()
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        return None
    if host == "open.spotify.com": return "spotify"
    if host in ("www.youtube.com", "youtube.com", "music.youtube.com", "youtu.be"): return "youtube"
    if host in ("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"): return "soundcloud"
    if host in ("www.deezer.com", "deezer.com"): return "deezer"
    return None


def _row(title, artist, duration, key, album=""):
    return {"title": str(title or "")[:300], "artist": str(artist or "")[:300],
            "duration": round(duration) if type(duration) in (int, float) and duration >= 0 else 0,
            "spotify_uri": key, "album": str(album or "")[:300], "candidates": [], "state": "unmatched"}


def soundcloud_link(url):
    parsed = urlsplit(url)
    match = re.fullmatch(r"/([A-Za-z0-9_-]{1,100})/sets/([A-Za-z0-9_-]{1,200})/?", parsed.path)
    if detect(url) != "soundcloud" or not match:
        raise PlaylistError("Use a public SoundCloud set link, like soundcloud.com/artist/sets/name.")
    return "https://soundcloud.com/%s/sets/%s" % match.groups()


def fetch_soundcloud_playlist(url, intake, progress=None):
    canonical = soundcloud_link(url)
    # Full entries carry artist and length; reading them takes about two seconds a song.
    with PROVIDERS["soundcloud"].request():
        rc, output, _ = intake.run([intake.tool("yt-dlp"), "--ignore-config", "--skip-download", "--dump-single-json",
                                   "--playlist-end", str(MAX_TRACKS), "--", canonical], 1800, "SoundCloud set", True)
    if rc:
        raise PlaylistError("Could not read this SoundCloud set. Check that it is public and try again.")
    try:
        data = json.loads(output)
        tracks = []
        for row in data["entries"]:
            if not isinstance(row, dict) or not re.fullmatch(r"\d{1,20}", str(row.get("id", ""))):
                continue
            artist = row.get("artist") or row.get("uploader") or ""
            title = str(row.get("title") or "")
            # Uploads often name the song "Artist - Title"; keep only the title part.
            if artist and title.casefold().startswith(str(artist).casefold() + " - "):
                title = title[len(artist) + 3:]
            if title:
                tracks.append(_row(title, artist, row.get("duration"), "soundcloud:" + str(row["id"])))
        if not tracks:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise PlaylistError("No readable songs found in this SoundCloud set.")
    if progress: progress(len(tracks), len(tracks))
    return {"id": hashlib.sha256(canonical.encode()).hexdigest()[:22], "name": str(data.get("title") or "SoundCloud set")[:200],
            "url": canonical, "tracks": tracks, "notice": ""}


def deezer_link(url):
    parsed = urlsplit(url)
    match = re.fullmatch(r"/(?:[a-z]{2}/)?(playlist|album)/(\d{1,20})/?", parsed.path)
    if detect(url) != "deezer" or not match:
        raise PlaylistError("Use a public Deezer playlist or album link, like deezer.com/playlist/123.")
    return match.groups()


def _deezer(path, *, timeout=15, max_wait=8):
    request = urllib.request.Request("https://api.deezer.com/" + path, headers={"Accept": "application/json"})
    with PROVIDERS["deezer"].request(max_wait=max_wait), urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
        data = response.read(2 << 20)
    if len(data) > (2 << 20): raise PlaylistError("The Deezer response is too large.")
    value = json.loads(data)
    if not isinstance(value, dict) or "error" in value:
        raise PlaylistError("Deezer could not find this playlist. Check that it is public.")
    return value


def fetch_deezer_playlist(url, progress=None, read=_deezer):
    kind, identifier = deezer_link(url)
    about = read(f"{kind}/{identifier}")
    total = min(int(about.get("nb_tracks") or 0), MAX_TRACKS)
    tracks, index = [], 0
    while index < max(total, 1) and len(tracks) < MAX_TRACKS:
        page = read(f"{kind}/{identifier}/tracks?limit=100&index={index}").get("data") or []
        if not page: break
        for row in page:
            if not isinstance(row, dict) or not row.get("title"): continue
            album = (row.get("album") or {}).get("title") or (about.get("title") if kind == "album" else "")
            tracks.append(_row(row.get("title"), (row.get("artist") or {}).get("name"), row.get("duration"), "deezer:" + str(row.get("id", "")), album))
        index += len(page)
        if progress: progress(len(tracks), max(total, len(tracks)))
    if not tracks:
        raise PlaylistError("No readable songs found in this Deezer link.")
    return {"id": hashlib.sha256(f"deezer:{kind}:{identifier}".encode()).hexdigest()[:22],
            "name": str(about.get("title") or "Deezer playlist")[:200],
            "url": f"https://www.deezer.com/{kind}/{identifier}", "tracks": tracks, "notice": ""}


OEMBED = {"spotify": "https://open.spotify.com/oembed?url=", "youtube": "https://www.youtube.com/oembed?format=json&url=",
          "soundcloud": "https://soundcloud.com/oembed?format=json&url="}


def _json(address):
    request = urllib.request.Request(address, headers={"Accept": "application/json", "User-Agent": "FamilyHubMusic/0.1"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=8) as response:
        data = response.read(256 << 10)
    value = json.loads(data)
    if not isinstance(value, dict): raise ValueError("Unexpected response.")
    return value


def link_name(url, read=None, intake=None):
    """The playlist's name from a public link, for the Create playlist name field. '' when unknown."""
    from urllib.parse import quote
    provider = detect(url)
    if provider is None: raise PlaylistError("Paste a public Spotify, YouTube, SoundCloud or Deezer playlist link.")
    if read is None:
        def read(address):
            gate = intake.YOUTUBE.request("playlist") if provider == "youtube" else PROVIDERS[provider].request()
            with gate:
                try:
                    return _json(address)
                except urllib.error.HTTPError as error:
                    if provider == "youtube":
                        intake.YOUTUBE.result("playlist", 1, f"HTTP {error.code}")
                    raise
    try:
        if provider == "deezer":
            kind, identifier = deezer_link(url)
            title = read("https://api.deezer.com/" + kind + "/" + identifier).get("title", "")
        else:
            about = read(OEMBED[provider] + quote(url, safe=""))
            title = about.get("title", "")
            author = about.get("author_name", "")
            # SoundCloud names sets "Name by Artist"; the import itself keeps only "Name".
            if provider == "soundcloud" and author and isinstance(title, str) and title.endswith(" by " + author):
                title = title[: -len(" by " + author)]
    except (OSError, ValueError, PlaylistError):
        return provider, ""
    title = re.sub(r"[\x00-\x1f\x7f]", " ", title if isinstance(title, str) else "").strip()
    return provider, title[:200]
