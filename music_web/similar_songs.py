"""Deezer suggestions use the same recording metadata as playlist imports."""

import re
import time

from . import radio
from .link_playlists import _deezer, _row
from .playlists import PlaylistError, reuse_library_match


def suggestions(artist, title, library, *, read=None):
    deadline = time.monotonic() + 25

    def bounded_read(path):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OSError("Deezer lookup timed out.")
        return _deezer(path, timeout=min(5, remaining), max_wait=min(1, remaining))

    reader = read or bounded_read
    url, name = radio.seed(artist, title, read=reader)
    playlist = radio.read_radio(url, name, read=reader)
    kind, seed_id = radio.URL.fullmatch(url).groups()
    results = []
    for row in playlist["tracks"]:
        identifier = row.get("spotify_uri", "")
        if (kind == "track" and identifier == f"deezer:{seed_id}") or not re.fullmatch(r"deezer:[0-9]{1,15}", identifier):
            continue
        saved = reuse_library_match(row, library)
        results.append(saved if saved is not None else {
            "id": identifier, "title": row["title"], "channel": row["artist"],
            "duration": row["duration"], "saved": False,
        })
    return results


def recording(identifier):
    if not re.fullmatch(r"deezer:[0-9]{1,15}", identifier):
        raise PlaylistError("Invalid Deezer song.")
    song = _deezer("track/" + identifier.split(":")[1])
    artist = (song.get("artist") or {}).get("name")
    if not song.get("title") or not artist:
        raise PlaylistError("This song is unavailable in Deezer.")
    return _row(song["title"], artist, song.get("duration"), identifier, (song.get("album") or {}).get("title"))
