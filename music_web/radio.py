"""Song and artist radio: a playlist of similar songs, like Spotify's "<song> Radio".

The track list comes from Deezer's public API (an artist's radio mix plus the top songs of
related artists). The rows are then matched and downloaded like any imported playlist.
Only artist names, titles and Deezer ids are sent; no account is used.
"""
import hashlib
import re
import unicodedata

from .link_playlists import _deezer, _row
from .playlists import PlaylistError
from .catalog_search import first_artist, clean_title

SIZE = 50
PER_ARTIST = 4
URL = re.compile(r"familyhub-radio:(artist|track):(\d{1,15})")
VARIANT = re.compile(r"\b(remix|live|acoustic|instrumental|karaoke|sped up|slowed|nightcore|mix|edit|version)\b", re.I)
_TITLE_NOISE = r"(?:official (?:music |lyric )?(?:audio|video)|lyrics?|lyric video|hd|hq|4k|original(?: [^()[\]]+ inspired)? song)"
_TITLE_SUFFIX = re.compile(rf"(?:\s*(?:\(\s*{_TITLE_NOISE}\s*\)|\[\s*{_TITLE_NOISE}\s*\]))+\Z", re.I)


def _key(value):
    value = "".join(c for c in unicodedata.normalize("NFKD", value or "") if not unicodedata.combining(c))
    return re.sub(r"[^\w]+", " ", value.casefold()).strip()


def _named_in(name, artist):
    """True when a Deezer artist is named in the requested artist text: the app sends
    collaborations as one normalized name, such as "koven shockone"."""
    name = _key(name)
    return bool(name) and f" {name} " in f" {_key(artist)} "


def seed(artist, title="", read=_deezer):
    """Finds the Deezer artist (and song) for a radio; returns (url, name).
    Raises PlaylistError when nothing matches and OSError when Deezer fails."""
    original_artist = (artist or "").split(",")[0].strip()
    title = clean_title(original_artist, title)
    artist = first_artist(original_artist)
    if not artist or len(artist) > 200 or len(title or "") > 300:
        raise PlaylistError("Choose a song or an artist for the radio.")
    from urllib.parse import urlencode

    def search(path):
        # A Deezer error reply here is an outage or quota limit, not a missing artist.
        try:
            result = read(path)
            if not isinstance(result, dict) or result.get('error') or not isinstance(result.get('data'), list):
                raise OSError('Deezer search failed')
            return result['data']
        except PlaylistError as error: raise OSError("Deezer search failed") from error
    title = (title or "").strip()
    parts = re.split(r"\s+[-–—]\s+", title, maxsplit=1)
    if len(parts) == 2 and _key(parts[0]) == _key(artist):
        title = parts[1]
    else:
        title = re.sub(r"^" + re.escape(artist) + r"\s*[-–—]\s*", "", title, flags=re.I)
    title = _TITLE_SUFFIX.sub("", title).rstrip() or title
    if title:
        # Deezer search can find the base song when the upload names an edition.
        query = re.sub(r"\s*[\[(][^\])]*[\])]", "", title).strip() or title
        query = re.sub(r"\s+\b(?:HD|HQ|4K)$", "", query, flags=re.I).strip() or query
        rows = search("search?" + urlencode(dict(q=artist + " " + query, limit=10)))
        songs = [row for row in rows if _key(query) in _key(row.get("title"))]
        for row in [r for r in songs if _key(r.get("artist", {}).get("name")) == _key(artist)] \
                 + [r for r in songs if _named_in(r.get("artist", {}).get("name"), artist)]:
            return f"familyhub-radio:track:{int(row['id'])}", f"{title} Radio"
    # Several artists can share a name; the one with the most fans is meant.
    found = search("search/artist?" + urlencode(dict(q=artist, limit=10)))
    named = [row for row in found if _key(row.get("name")) == _key(artist)] \
        or [row for row in found if _named_in(row.get("name"), artist)]
    if named:
        row = max(named, key=lambda r: r.get("nb_fan") or 0)
        return f"familyhub-radio:artist:{int(row['id'])}", f"{row['name']} Radio" if not title else f"{title} Radio"
    raise PlaylistError("No radio found for this song. Try a song by another artist.")


def read_radio(url, name, progress=None, read=_deezer):
    """Builds the radio's track rows: the seed song first, then a mix of similar songs."""
    match = URL.fullmatch(url or "")
    if not match: raise PlaylistError("Invalid radio.")
    kind, identifier = match.groups()
    rows, first = [], None
    if kind == "track":
        first = read(f"track/{identifier}")
        artist_id = (first.get("artist") or {}).get("id")
    else:
        artist_id = int(identifier)
    if type(artist_id) is not int: raise PlaylistError("No radio found for this song.")
    failures = []

    def optional(path):
        try:
            result = read(path)
            if not isinstance(result, dict) or result.get('error') or not isinstance(result.get('data'), list):
                raise OSError('Deezer radio failed')
            return result['data']
        except (OSError, ValueError, PlaylistError) as error:
            failures.append(error)
            return []

    mix = optional(f"artist/{artist_id}/radio?limit=50")
    if not mix:
        mix = optional(f"artist/{artist_id}/top?limit=50")
    related = optional(f"artist/{artist_id}/related?limit=8")[:8]
    tops = []
    for position, artist in enumerate(related):
        tops.append(optional(f"artist/{int(artist['id'])}/top?limit=5"))
        if progress: progress(position + 1, len(related))
    # Interleave: two radio picks, then one related-artist top song, so the radio is not one artist.
    queue, tops_flat = [], [song for group in zip(*[t + [None] * (5 - len(t)) for t in tops]) for song in group if song] if tops else []
    for index in range(max(len(mix), len(tops_flat))):
        if index < len(mix): queue.append(mix[index])
        if index * 2 + 1 < len(mix) and index < len(tops_flat): queue.append(tops_flat[index])
    queue.extend(tops_flat[len(mix) // 2:])
    keep_variants = bool(first and VARIANT.search(first.get("title", "")))
    seen, per_artist = set(), {}
    for song in ([first] if first else []) + queue:
        if not song or not song.get("title"): continue
        artist = (song.get("artist") or {}).get("name", "")
        key = (_key(artist), _key(re.sub(r"\s*[\[(][^\])]*[\])]", "", song["title"])))
        if key in seen or (not keep_variants and song is not first and VARIANT.search(song["title"])): continue
        if per_artist.get(key[0], 0) >= PER_ARTIST and song is not first: continue
        seen.add(key); per_artist[key[0]] = per_artist.get(key[0], 0) + 1
        rows.append(_row(song["title"], artist, song.get("duration"), "deezer:" + str(song.get("id", "")), (song.get("album") or {}).get("title", "")))
        if len(rows) >= SIZE: break
    if not rows or first and len(rows) == 1:
        if failures:
            raise OSError('Radio catalogue is unavailable. Try again later.')
        raise PlaylistError("No songs found for this radio. Try another artist or choose songs from your library.")
    return {"id": hashlib.sha256(url.encode()).hexdigest()[:22], "name": name[:200], "url": url, "tracks": rows,
            "notice": f"{len(rows)} similar songs.", "description": "Songs like " + name.removesuffix(" Radio")}


def related_library(artist, genre, tracks):
    """Saved recordings remain useful when an external catalogue is empty or down."""
    from .genres import genre_key
    credit = _key(first_artist(artist))
    wanted_genre = genre_key(genre or '')
    result = []
    for track in tracks:
        name = track.get('channel', '')
        parts = re.split(r'\s+[-\u2013\u2014]\s+', track.get('title', ''), maxsplit=1)
        if len(parts) == 2:
            name = parts[0]
        same_artist = credit and _key(first_artist(name)) == credit
        same_genre = wanted_genre not in ('', 'unsorted') and genre_key(track.get('genre') or '') == wanted_genre
        if same_artist or same_genre:
            result.append(track)
    return result[:SIZE]
