"""Complete Deezer albums for Home, with library matches applied at read time."""

from collections import OrderedDict, defaultdict
from http.client import HTTPException
import re
from secrets import token_hex
from threading import BoundedSemaphore, Lock
from time import monotonic
from urllib.parse import urlencode

from flask import g, jsonify

from .link_playlists import MAX_TRACKS, _deezer, fetch_deezer_playlist
from .playlists import PlaylistError, library_match_key, reuse_library_match
from .radio import _key


class AlbumCatalogue:
    def __init__(self):
        self.cache = OrderedDict()
        self.lock = Lock()
        self.requests = BoundedSemaphore(2)

    def lookup(self, name, artist, *, read=None):
        key = (_key(name), _key(artist))
        with self.lock:
            cached = self.cache.get(key)
            if cached and cached[0] > monotonic():
                self.cache.move_to_end(key)
                return cached[1]
        if not self.requests.acquire(blocking=False):
            raise PlaylistError("Album lookup is busy. Try again.")
        try:
            album = self._fetch(name, artist, key, read)
            with self.lock:
                self.cache[key] = (monotonic() + 86400, album)
                self.cache.move_to_end(key)
                if len(self.cache) > 128:
                    self.cache.popitem(last=False)
            return album
        finally:
            self.requests.release()

    @staticmethod
    def _fetch(name, artist, key, read):
        deadline = monotonic() + 8
        expected = None

        def bounded(path):
            nonlocal expected
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise OSError("Album lookup timed out")
            result = read(path) if read else _deezer(path, timeout=min(3, remaining), max_wait=min(.5, remaining))
            if re.fullmatch(r"album/[0-9]+", path):
                expected = result.get("nb_tracks")
                if type(expected) is not int or not 1 <= expected <= MAX_TRACKS or _key(result.get("title")) != key[0]:
                    raise PlaylistError("Deezer returned an incomplete album.")
            return result

        found = bounded("search/album?" + urlencode(dict(q=f"{artist} {name}", limit=25)))
        for row in found["data"][:25]:
            identifier = row.get("id")
            if not re.fullmatch(r"[0-9]{1,20}", str(identifier)):
                continue
            if (_key(row.get("title")), _key((row.get("artist") or {}).get("name"))) == key:
                album = fetch_deezer_playlist(f"https://www.deezer.com/album/{identifier}", read=bounded)
                if len(album["tracks"]) != expected or any(
                    not t["artist"].strip() or not re.fullmatch(r"deezer:[0-9]{1,15}", t["spotify_uri"])
                    for t in album["tracks"]
                ):
                    raise PlaylistError("Deezer returned an incomplete album.")
                return album
        raise PlaylistError("Deezer could not find this album.")


def match_tracks(rows, library):
    candidates = defaultdict(list)
    for track in library:
        candidates[library_match_key(track["title"], track["channel"])].append(track)
    tracks = []
    for row in rows:
        track = dict(row)
        match = reuse_library_match(track, candidates[library_match_key(row["title"], row["artist"])])
        if match is not None:
            track.update(state="saved", source_id=match["id"], match=match)
        tracks.append(track)
    return tracks


def register(app, body, allow, library_tracks, store, preparation, lock, visible):
    catalogue = AlbumCatalogue()

    def load(data):
        recording = data.get("recording_id")
        if not isinstance(recording, str) or not 1 <= len(recording) <= 160:
            return None, (jsonify(error="Choose an album from your library."), 400)
        if not allow("home-album:" + g.user, 24, 60):
            return None, (jsonify(error="Wait a minute before retrying the album."), 429)
        library = library_tracks()
        anchor = next((t for t in library if t["id"] == recording), None)
        if not anchor or not anchor.get("library_album") or not anchor.get("channel"):
            return None, (jsonify(error="This album could not be found in your library."), 404)
        try:
            album = catalogue.lookup(anchor["library_album"], anchor["channel"])
        except (OSError, HTTPException, ValueError, OverflowError, TypeError, AttributeError, KeyError):
            return None, (jsonify(error="The full album could not load from Deezer. Retry the album or play your library songs."), 503)
        return {**album, "tracks": match_tracks(album["tracks"], library)}, None

    @app.post("/api/home/album")
    def home_album():
        album, failure = load(body(4096))
        return failure or jsonify(playlist=album)

    @app.post("/api/home/album/play")
    def prepare_home_album():
        data = body(4096)
        album, failure = load(data)
        if failure:
            return failure
        if album["id"] != data.get("album_id"):
            return jsonify(error="The album changed. Reopen it from Home and try again."), 409
        with lock:
            playlists = store.list(g.user)
            entries = [t["spotify_uri"] for t in album["tracks"]]
            previous = next((p for p in playlists if p.get("home_album") == album["id"]
                             and [t.get("spotify_uri") for t in p["tracks"]] == entries), None)
            if previous is None and len(playlists) >= 100:
                return jsonify(error="Delete a playlist before preparing another album. You can save up to 100 playlists."), 409
            if previous is None:
                playlist = {**album, "home_album": album["id"], "id": token_hex(11), "shared": False, "revision": 1}
                store.save(g.user, playlist)
            else:
                playlist = previous
            pid = playlist["id"]
            try:
                if any(t["state"] != "saved" for t in playlist["tracks"]):
                    preparation.start(g.user, pid, "download", actor=g.user)
            except ValueError as error:
                return jsonify(error=str(error)), 409
            return jsonify(playlist=visible(store.read(g.user, pid), g.user))
