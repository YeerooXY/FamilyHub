"""Cached artist genre labels; metadata requests never block library or audio playback."""
import json
from pathlib import Path
import re
import threading
import time
import urllib.parse
import urllib.request
from .musicbrainz import read as musicbrainz

GROUPS = {
    'Hip-hop': ('hip hop', 'hip-hop', 'rap'),
    'Electronic': ('electronic', 'edm', 'house', 'trance', 'drum and bass', 'dubstep', 'electro'),
    'R&B / Soul': ('r&b', 'soul', 'rhythm and blues', 'funk'),
    'Rock': ('rock', 'metal', 'punk', 'grunge'),
    'Pop': ('pop',), 'Jazz': ('jazz',), 'Classical': ('classical', 'orchestra'),
    'Country / Folk': ('country', 'folk', 'americana'), 'Reggae': ('reggae', 'dancehall'),
}

def group(tags):
    for tag in sorted(tags, key=lambda t: t.get('count', 0), reverse=True):
        name = str(tag.get('name', '')).casefold()
        for label, terms in GROUPS.items():
            if any(term in name for term in terms):
                return label
    return 'Unsorted'

def artist_name(source, record):
    name = source.get('artist') or record.get('artist', '')
    title = source.get('title', '')
    if not source.get('artist') and ' - ' in title:
        name = title.split(' - ', 1)[0]
    return re.sub(r'\s*(?:- Topic|VEVO)$', '', name, flags=re.I).strip()[:120]

class GenreLabels:
    def __init__(self, workspace, enabled=True):
        self.path = Path(workspace) / '.artist-genres.json'
        self.enabled = enabled
        self.lock = threading.Lock()
        self.pending = []
        self.worker = None
        try:
            self.cache = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(self.cache, dict): self.cache = {}
            self.cache = {key: value for key, value in self.cache.items() if isinstance(value, dict) and value.get('genre') in GROUPS}
        except (OSError, ValueError): self.cache = {}

    def get(self, artist):
        key = artist.casefold()
        with self.lock:
            if key in self.cache: return self.cache[key].get('genre', 'Unsorted')
            if artist and self.enabled and artist not in self.pending:
                self.pending.append(artist)
                if not self.worker or not self.worker.is_alive():
                    self.worker = threading.Thread(target=self._drain, daemon=True)
                    self.worker.start()
        return 'Unsorted'

    def _drain(self):
        while True:
            with self.lock:
                if not self.pending:
                    self.worker = None
                    return
                artist = self.pending[0]
            genre, artist_id = 'Unsorted', None
            try:
                matches = musicbrainz('artist/',query='artist:"'+artist.replace('"','')+'"',limit=3).get('artists',[])
                exact = [a for a in matches if a.get('name', '').casefold() == artist.casefold()]
                votes = lambda a: sum(max(0, t.get('count', 0)) for t in a.get('tags', []))
                exact.sort(key=votes, reverse=True)
                if len(exact) == 1 or len(exact) > 1 and votes(exact[0]) >= max(5, votes(exact[1]) * 3):
                    genre = group(exact[0].get('tags', [])); artist_id = exact[0]['id']
            except (OSError, ValueError, KeyError): pass
            with self.lock:
                self.cache[artist.casefold()] = {'genre': genre, 'musicbrainz_id': artist_id}
                self.pending.pop(0)
                try:
                    temp = self.path.with_suffix('.tmp')
                    temp.write_text(json.dumps(self.cache), encoding='utf-8'); temp.replace(self.path)
                except OSError: pass
            time.sleep(1.1)
