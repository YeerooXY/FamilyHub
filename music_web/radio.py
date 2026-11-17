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

SIZE = 50
PER_ARTIST = 4
URL = re.compile(r"familyhub-radio:(artist|track):(\d{1,15})")
VARIANT = re.compile(r"\b(remix|live|acoustic|instrumental|karaoke|sped up|slowed|nightcore|mix|edit|version)\b", re.I)


def _key(value):
    value = "".join(c for c in unicodedata.normalize("NFKD", value or "") if not unicodedata.combining(c))
    return re.sub(r"[^\w]+", " ", value.casefold()).strip()


def seed(artist, title="", read=_deezer):
    """Finds the Deezer artist (and song) for a radio; returns (url, name)."""
    artist = (artist or "").split(",")[0].strip()
    if not artist or len(artist) > 200 or len(title or "") > 300:
        raise PlaylistError("Choose a song or an artist for the radio.")
    from urllib.parse import urlencode
    # "Artist - Song (Official Video)" names the song "Song".
    title = re.sub(r"^" + re.escape(artist) + r"\s*[-–—]\s*", "", (title or "").strip(), flags=re.I)
    title = re.sub(r"\s*[\[(][^\])]*[\])]", "", title).strip() or title
    if title:
        clean = title
        for row in read("search?" + urlencode(dict(q=artist + " " + clean, limit=10))).get("data") or []:
            if _key(row.get("artist", {}).get("name")) == _key(artist) and _key(clean) in _key(row.get("title")):
                return f"familyhub-radio:track:{int(row['id'])}", f"{title} Radio"
    # Several artists can share a name; the one with the most fans is meant.
    named = [row for row in read("search/artist?" + urlencode(dict(q=artist, limit=10))).get("data") or [] if _key(row.get("name")) == _key(artist)]
    if named:
        row = max(named, key=lambda r: r.get("nb_fan") or 0)
        return f"familyhub-radio:artist:{int(row['id'])}", f"{row['name']} Radio" if not title else f"{title} Radio"
    raise PlaylistError("No radio found for this artist.")


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
    mix = read(f"artist/{artist_id}/radio?limit=50").get("data") or []
    related = (read(f"artist/{artist_id}/related?limit=8").get("data") or [])[:8]
    tops = []
    for position, artist in enumerate(related):
        tops.append(read(f"artist/{int(artist['id'])}/top?limit=5").get("data") or [])
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
    if not rows: raise PlaylistError("No songs found for this radio.")
    return {"id": hashlib.sha256(url.encode()).hexdigest()[:22], "name": name[:200], "url": url, "tracks": rows,
            "notice": f"{len(rows)} similar songs.", "description": "Songs like " + name.removesuffix(" Radio")}
