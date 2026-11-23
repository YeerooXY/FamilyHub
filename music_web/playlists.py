from datetime import datetime, timezone
"""Public Spotify playlist metadata. Audio always uses the existing intake coordinator."""
import hashlib
import math
import json
import re
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urlsplit
from difflib import SequenceMatcher
import unicodedata
from types import SimpleNamespace
from collections import defaultdict, deque
from .state import state_path
from .resources import background_request
from .review_confidence import close_duration, normal, presentation_title, recording_labels

def track_identities(track):
    """Keys that make two playlist entries the same song: recording, Spotify URI or normalized title and artist."""
    source = track.get("source_id") or (track.get("match") or {}).get("id")
    uri = track.get("spotify_uri")
    result = {("source", source)} if source else set()
    if uri: result.add(("uri", uri))
    # Duplicate checks must retain non-Latin titles that search normalization strips.
    title, artist = (re.sub(r"[^\w]+", " ", unicodedata.normalize("NFKC", value).casefold()).strip()
                     for value in (track["title"], track["artist"]))
    if title and artist: result.add(("song", title, artist))
    return result


class PlaylistError(ValueError):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PlaylistError("Spotify redirected this playlist. Use its full open.spotify.com playlist link.")

class EmbeddedData(HTMLParser):
    def __init__(self):
        super().__init__(); self.active=False; self.parts=[]
    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("id") == "__NEXT_DATA__": self.active=True
    def handle_endtag(self, tag):
        if tag == "script": self.active=False
    def handle_data(self, data):
        if self.active: self.parts.append(data)

def playlist_id(url):
    if not isinstance(url,str) or len(url)>300: raise PlaylistError("Enter a Spotify playlist link.")
    try:
        parsed=urlsplit(url)
        match=re.fullmatch(r"/(?:intl-[a-z]+/)?playlist/([A-Za-z0-9]{22})/?",parsed.path)
        valid=parsed.scheme=="https" and parsed.hostname=="open.spotify.com" and parsed.port in (None,443) and not parsed.username and not parsed.password
    except ValueError: valid=False; match=None
    if not valid or not match: raise PlaylistError("Use an https://open.spotify.com/playlist/ link.")
    return match[1]

def parse_page(page, pid):
    parser=EmbeddedData();parser.feed(page)
    try: entity=json.loads("".join(parser.parts))["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError,TypeError,ValueError): raise PlaylistError("Spotify did not expose a public track list. Private playlists need a Spotify connection.")
    if not isinstance(entity,dict): raise PlaylistError("Invalid Spotify metadata.")
    if entity.get("id")!=pid or entity.get("type")!="playlist": raise PlaylistError("Spotify returned a different playlist.")
    rows=entity.get("trackList")
    if not isinstance(rows,list) or not rows: raise PlaylistError("No public tracks were found in this playlist.")
    tracks=[]
    for row in rows[:500]:
        if not isinstance(row,dict) or row.get("entityType")!="track": continue
        title,artist=row.get("title"),row.get("subtitle")
        if not isinstance(title,str) or not isinstance(artist,str): continue
        tracks.append({"title":title[:300],"artist":artist.replace("\u00a0"," ")[:300],"duration":round(row.get("duration",0)/1000) if type(row.get("duration")) in (int,float) else 0,"spotify_uri":row.get("uri",""),"candidates":[],"state":"unmatched"})
    if not tracks: raise PlaylistError("No music tracks were found.")
    return {"id":pid,"name":str(entity.get("title") or entity.get("name") or "Spotify playlist")[:200],"url":"https://open.spotify.com/playlist/"+pid,"tracks":tracks,"notice":"Spotify exposes these entries publicly; the embed may omit tracks from larger playlists."}

def spotify_source(url):
    if not isinstance(url, str) or len(url) > 300:
        raise PlaylistError("Enter a Spotify playlist or artist link.")
    try:
        parsed = urlsplit(url)
        match = re.fullmatch(r"/(?:intl-[a-z]+/)?(playlist|artist)/([A-Za-z0-9]{22})/?", parsed.path)
        valid = parsed.scheme == "https" and parsed.hostname == "open.spotify.com" and parsed.port in (None, 443) and not parsed.username and not parsed.password
    except ValueError:
        valid, match = False, None
    if not valid or not match:
        raise PlaylistError("Use a public open.spotify.com playlist or artist link.")
    return match.groups()


def fetch_playlist(url, progress=None):
    from .public_playlists import fetch_public_playlist, fetch_public_artist
    kind, _ = spotify_source(url)
    return (fetch_public_artist if kind == "artist" else fetch_public_playlist)(url, progress=progress)

def normalized(value):
    return re.sub(r"[^\w]+"," ",unicodedata.normalize("NFKD",value).encode("ascii","ignore").decode().lower()).strip()

def duration_matches(track, recording):
    """Compare catalogue length with either the source or its purified playback edition."""
    expected = track.get("duration")
    if type(expected) not in (int, float) or not math.isfinite(expected) or expected <= 0:
        return False
    return any(type(value) in (int, float) and math.isfinite(value) and value > 0
               and abs(value - expected) <= max(8, expected * .07)
               for value in (recording.get("duration"), recording.get("original_duration")))


def library_match_key(title, artist):
    return normal(presentation_title(title, artist)), normal(artist)


def reuse_library_match(track, recordings):
    title, artist = library_match_key(track['title'], track['artist'])
    if not title or artist in ('', 'youtube', 'unknown', 'unknown artist', 'local imports', 'various artists'):
        return None
    matches = [row for row in recordings if library_match_key(row['title'], row['channel']) == (title, artist)
               and any(close_duration(track.get('duration'), row.get(key)) for key in ('duration', 'original_duration'))]
    return matches[0] if len(matches) == 1 else None

def matching_title(value):
    # Preserve named remixes and versions; remove only presentation/featured-credit labels.
    # Distributor metadata sometimes repeats the same edition label twice.
    value = re.sub(r"(\([^()]{1,80}\))(?:\s+\1)+", r"\1", value, flags=re.I)
    value = re.sub(r"[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]", " ", value, flags=re.I)
    value = re.sub(r"\b(?:feat\.?|ft\.?|featuring)\s+.*$", " ", value, flags=re.I)
    value = re.sub(r"[([][^)\]]*\b(?:release|official audio|official video|lyrics?|visualizer)\b[^)\]]*[)\]]", " ", value, flags=re.I)
    value = re.sub(r"\b(official|audio|video|music|lyrics?|hd|4k|visualizer)\b", " ", value, flags=re.I)
    return normalized(value)


def preferred_match(candidates):
    eligible = [row for row in candidates if row.get("recommended")]
    return min(eligible, key=lambda row: row.get("source_tier", 1 if row.get("kind") == "topic" else 3), default=None)


def source_tier(candidate, artist):
    channel = normalized(candidate.get("channel") or "")
    artist = normalized(artist.split(",")[0])
    if candidate.get("kind") == "topic" or channel.endswith(" topic"):
        return 1
    # Fan, lyrics and tribute channels often carry the artist's name ("pendulumfanmusic").
    if re.search(r"fan(s|music|channel|page)?\b|unofficial|lyrics?\b|tribute", channel):
        return 3
    if (channel.endswith(("vevo", "official", "records"))
            or artist and artist.replace(" ", "") in channel.replace(" ", "")
            or re.search(r"\b(universal|sony music|warner music|atlantic|columbia|polydor|parlophone|republic|def jam|interscope|spinnin|armada|monstercat)\b", channel)):
        return 2
    return 3


def rank_matches(track, candidates, search=None):
    candidates = list(candidates)
    if search is not None and not any(source_tier(row, track["artist"]) <= 2 for row in candidates):
        query = (track["artist"].split(",")[0] + " - Topic " + track["title"])[:200]
        candidates.extend(search(SimpleNamespace(query=query, limit=30, offset=0))["results"])
    title = matching_title(track["title"])
    artist = normalized(track["artist"].split(",")[0])
    variants = r"\b(remix|nightcore|slowed|cover|live|sped|speedup|spedup|8d|boosted|reverb|rebass|mashup|bootleg|edit|version|reversed|instrumental|karaoke|acoustic)\b"
    expected_versions = set(re.findall(variants, normalized(track["title"])))
    ranked = []
    seen = set()
    for row in candidates:
        if row.get("id") and row["id"] in seen:
            continue
        seen.add(row.get("id"))
        candidate = {k: row.get(k) for k in ("id", "url", "title", "channel", "duration", "original_duration", "kind")}
        raw_title = row.get("title") or ""
        text = normalized(raw_title + " " + (row.get("channel") or ""))
        parts = re.split(r"\s+[-\u2013\u2014]\s+", raw_title)
        # Try artist-prefixed and bare titles without throwing away remix names after a dash.
        titles = [matching_title(" - ".join(parts[i:])) for i in range(len(parts))]
        title_match = bool(title) and title in titles
        channel_artist = re.sub(r"(?:\s*-\s*Topic|VEVO|Official)$", "", row.get("channel") or "", flags=re.I)
        artist_match = bool(artist) and (all(word in text.split() for word in artist.split())
            or normalized(channel_artist).replace(" ", "") == artist.replace(" ", ""))
        close = duration_matches(track, row)
        altered = set(re.findall(variants, normalized(raw_title))) != expected_versions
        candidate["recommended"] = bool(title_match and artist_match and close and not altered)
        candidate["source_tier"] = source_tier(row, track["artist"])
        score = title_match * 5 + artist_match * 4 + close * 3 - altered * 10 + SequenceMatcher(None, title, normalized(raw_title)).ratio()
        ranked.append((candidate["recommended"], -candidate["source_tier"], score, candidate))
    return [row for _, _, _, row in sorted(ranked, key=lambda item: item[:3], reverse=True)[:5]]


def repoint_recording(track, old_id, replacement):
    if replacement.get('automatic') or replacement.get('explicit'):
        original = {field: track[field] for field in ('source_id', 'match', 'state') if field in track}
        track.setdefault('replacement_origins', {})[old_id] = original
    track.update(source_id=replacement['new_id'], match=replacement['match'], state='saved')
    track.pop('job_id', None)

def entry_identity(track):
    match = track.get("match") or {}
    return [track.get(key) for key in ("title", "artist", "duration", "spotify_uri", "added_at", "source_id")] + [
        match.get("id"), match.get("url")]


class PlaylistStore:
    def __init__(self, workspace):
        self.root = state_path(workspace, ".playlists")
        self.replacement_journal = state_path(workspace, ".replacements.json")
        self.changed = lambda owner, pid: None
    def directory(self,user):
        return self.root/hashlib.sha256(user.encode()).hexdigest()
    def read(self,user,pid, *, snapshot=False):
        if not re.fullmatch(r"[A-Za-z0-9]{22}",pid): raise PlaylistError("Invalid playlist.")
        try:
            data=json.loads((self.directory(user)/(pid+".json")).read_text(encoding="utf-8"))
            data.setdefault("revision",0)
            if self._backfill_added_at(data) and not snapshot: self.save(user, data)
            return data
        except (OSError,ValueError): raise PlaylistError("Playlist not found.")
    @staticmethod
    def _backfill_added_at(data):
        stamp = None
        for track in data["tracks"]:
            if not track.get("added_at"):
                if stamp is None: stamp = datetime.now(timezone.utc).isoformat()
                track["added_at"] = stamp
        return stamp is not None
    def save(self,user,data):
        self._backfill_added_at(data)
        journal = self.replacement_journal
        replacements = json.loads(journal.read_text(encoding='utf-8')) if journal.exists() else {}
        for track in data['tracks']:
            for _ in range(len(replacements)):
                old_id = track.get('source_id') or (track.get('match') or {}).get('id')
                replacement = replacements.get(old_id, {})
                if replacement.get('state') != 'done': break
                repoint_recording(track, old_id, replacement)
            retry = track.get("backlog_retry")
            if retry and (track.get("state") == "saved" or retry["entry"] != entry_identity(track)):
                track.pop("backlog_retry")
        folder=self.directory(user);folder.mkdir(parents=True,exist_ok=True)
        target=folder/(data["id"]+".json");temporary=target.with_suffix(".tmp")
        temporary.write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8");temporary.replace(target)
        self.changed(user, data["id"])
    def import_playlist(self,user,data,append=False,actor=None):
        try: previous=self.read(user,data["id"])
        except PlaylistError:
            if append: raise
            previous={"tracks":[]}
        if append:
            seen = {key for track in previous["tracks"] for key in track_identities(track)}
            fresh = []
            for track in data["tracks"]:
                identities = track_identities(track)
                duplicate = bool(identities & seen)
                seen.update(identities)
                if not duplicate: fresh.append(track)
            if len(previous["tracks"]) + len(fresh) > 10000:
                raise PlaylistError("A playlist can contain up to 10,000 entries.")
            for track in fresh:
                track["added_at"] = datetime.now(timezone.utc).isoformat()
                track["added_by"] = actor or user
            data = {**previous, "tracks": previous["tracks"] + fresh,
                    "preparation": data.get("preparation", previous.get("preparation", {}))}
            data["revision"] = previous.get("revision", 0) + 1
            self.save(user, data)
            return data
        # A source can list one song twice (Spotify allows it); a playlist keeps the first.
        seen = set()
        unique = []
        for track in data["tracks"]:
            # Only the same recording or Spotify entry repeats; two different recordings may share title and artist.
            identities = {key for key in track_identities(track) if key[0] != "song"}
            if identities & seen: continue
            seen.update(identities)
            unique.append(track)
        data["tracks"] = unique
        occurrences=defaultdict(deque)
        for track in previous["tracks"]:
            if track.get("spotify_uri"): occurrences[track["spotify_uri"]].append(track)
        for track in data["tracks"]:
            matches=occurrences[track["spotify_uri"]]
            if matches:
                old=matches.popleft()
                track["added_at"]=old.get("added_at")
                track["added_by"]=old.get("added_by")
                for field in ("candidates","state","match","job_id","source_id","replacement_origins","backlog_retry"):
                    if field in old: track[field]=old[field]
            else:
                track["added_at"]=datetime.now(timezone.utc).isoformat()
                track["added_by"]=actor or user
        data["description"]=previous.get("description", "")
        data["revision"]=previous.get("revision",0)+1
        data["shared"]=previous.get("shared", True)
        data["co_authors"]=previous.get("co_authors", [])
        # An owner's choice not to download this playlist survives re-reading its source.
        if previous.get("auto_download_paused"): data["auto_download_paused"]=True
        if 'cover_sha256' in previous: data['cover_sha256']=previous['cover_sha256']
        self.save(user,data)
        return data
    def delete(self,user,pid):
        self.read(user,pid)
        (self.directory(user)/(pid+".json")).unlink()
        self.changed(user, pid)
    def list(self,user, *, snapshot=False):
        folder=self.directory(user)
        return [self.read(user,p.stem,snapshot=snapshot) for p in sorted(folder.glob("*.json"))[:100]]


def fetch_youtube_playlist(url, intake):
    """Read public playlist metadata through the bounded intake subprocess runner."""
    from urllib.parse import parse_qs
    try:
        parsed = urlsplit(url if isinstance(url, str) and len(url) <= 2048 else "")
        values = parse_qs(parsed.query).get("list", [])
        valid = (parsed.scheme == "https" and parsed.hostname in ("www.youtube.com", "youtube.com", "music.youtube.com", "youtu.be")
                 and parsed.port in (None, 443) and not parsed.username and not parsed.password
                 and (parsed.path in ("/playlist", "/watch") or parsed.hostname == "youtu.be" and re.fullmatch(r"/[A-Za-z0-9_-]{11}", parsed.path)) and len(values) == 1
                 and re.fullmatch(r"[A-Za-z0-9_-]{10,100}", values[0]))
    except ValueError:
        valid = False
    if not valid:
        raise PlaylistError("Enter a public YouTube playlist link.")
    canonical = "https://www.youtube.com/playlist?list=" + values[0]
    if values[0].startswith("RD"):
        videos = [parsed.path[1:]] if parsed.hostname == "youtu.be" else parse_qs(parsed.query).get("v", [])
        if len(videos) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{11}", videos[0]):
            raise PlaylistError("YouTube Mixes can't be read from the link alone. Open the mix, play a song in it, then share that link.")
        canonical = "https://www.youtube.com/watch?v=" + videos[0] + "&list=" + values[0]
    try:
        rc, output, _ = intake.youtube_run([intake.tool("yt-dlp"), "--ignore-config", "--flat-playlist",
                                           "--dump-single-json", "--playlist-end", "10001", "--", canonical],
                                          240, "YouTube playlist", True, caller="playlist",
                                          background=background_request.get())
    except intake.YouTubeDeferred:
        rc = 1
    if rc:
        raise PlaylistError("Could not read this playlist. Check that it is public and try again.")
    try:
        data = json.loads(output)
        entries = data["entries"]
        if not isinstance(entries, list) or len(entries) > 10000:
            raise ValueError()
        tracks = []
        for row in entries:
            if not isinstance(row, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", str(row.get("id", ""))):
                continue
            match = {"id": row["id"], "url": "https://www.youtube.com/watch?v=" + row["id"],
                     "title": str(row.get("title") or "Unavailable recording")[:300],
                     "channel": str(row.get("channel") or row.get("uploader") or "")[:300],
                     "duration": row.get("duration") or 0}
            match["title"], match["channel"] = recording_labels({**match, "kind": "youtube"})
            tracks.append({"title": match["title"], "artist": match["channel"], "duration": match["duration"],
                           "spotify_uri": "youtube:" + row["id"], "source_id": row["id"], "match": match,
                           "candidates": [match], "state": "ready"})
        if not tracks:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise PlaylistError("No readable tracks found, or the playlist exceeds 10,000 songs.")
    return {"id": hashlib.sha256(canonical.encode()).hexdigest()[:22],
            "name": str(data.get("title") or "YouTube playlist")[:200], "url": canonical,
            "tracks": tracks, "notice": ""}
