"""Deezer and iTunes song search for metadata review. Only titles, artists and lengths leave the server."""
import json
import re
import urllib.parse
import urllib.request
from .resources import PROVIDERS

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Store search redirected the request.')

_genres = {}

def _get(service, url):
    request = urllib.request.Request(url, headers={'User-Agent': 'FamilyHubMusic/0.1', 'Accept': 'application/json', 'Accept-Language': 'en'})
    with PROVIDERS[service].request(), urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        data = response.read(1048577)
    if len(data) > 1048576: raise ValueError('Store response is too large.')
    return json.loads(data)

def first_artist(artist):
    return re.split(r'\s*(?:,|&| x | feat\.?\s| ft\.?\s)\s*', artist or '', flags=re.I)[0].strip()

def album_key(normal, title):
    # "Song - Single", "Song (Single)" and "Song" name the same release across stores.
    title = re.sub(r'\s*[\[(][^\])]*(?:deluxe|remaster|expanded|edition|bonus)[^\])]*[\])]', '', title or '', flags=re.I)
    return normal(re.sub(r'\s*(?:-\s*(?:single|ep)|\((?:single|ep)\))$', '', title, flags=re.I))

def candidates(seed, core_title, normal):
    """Store results matching the song's title and length within 4 s, at most 3 per store."""
    title, artist, duration = seed.get('title', ''), first_artist(seed.get('artist', '')), seed.get('duration') or 0
    wanted = core_title(title)
    if not wanted or not artist or duration <= 0: return []
    term = artist + ' ' + re.sub(r'\s*[\[(][^\])]*[\])]', '', title).strip()
    found = []
    try:
        for row in (_get('deezer', 'https://api.deezer.com/search?' + urllib.parse.urlencode(dict(q=term, limit=10))).get('data') or [])[:10]:
            if wanted not in (core_title(row.get('title', '')), core_title(row.get('title_short', ''))): continue
            if abs((row.get('duration') or 0) - duration) > 4: continue
            album = row.get('album') or {}
            identifier = album.get('id')
            if identifier not in _genres and type(identifier) is int:
                record = _get('deezer', 'https://api.deezer.com/album/%d' % identifier)
                names = [g.get('name', '') for g in (record.get('genres') or {}).get('data', [])]
                _genres[identifier] = (names[0][:80] if names else '', record.get('record_type', ''))
            genre, kind = _genres.get(identifier, ('', ''))
            found.append(dict(source='Deezer', artist=str((row.get('artist') or {}).get('name', ''))[:120], album=str(album.get('title', ''))[:120],
                              album_type=kind, genre=genre, url=str(row.get('link', ''))[:200]))
            if sum(c['source'] == 'Deezer' for c in found) >= 3: break
    except (OSError, ValueError): pass
    try:
        for row in (_get('itunes', 'https://itunes.apple.com/search?' + urllib.parse.urlencode(dict(term=term, entity='song', limit=10))).get('results') or [])[:10]:
            if core_title(row.get('trackName', '')) != wanted: continue
            if abs((row.get('trackTimeMillis') or 0) / 1000 - duration) > 4: continue
            album = str(row.get('collectionName', ''))[:120]
            kind = 'compile' if row.get('collectionArtistName', '').casefold() == 'various artists' else ('single' if album.endswith(' - Single') else 'ep' if album.endswith(' - EP') else 'album')
            found.append(dict(source='iTunes', artist=str(row.get('artistName', ''))[:120], album=album, album_type=kind,
                              genre=str(row.get('primaryGenreName', ''))[:80], url=str(row.get('trackViewUrl', '')).split('?')[0][:200]))
            if sum(c['source'] == 'iTunes' for c in found) >= 3: break
    except (OSError, ValueError): pass
    return found

def agreed_album(found, normal):
    """The album every non-compilation match names, or ''."""
    albums = [c for c in found if c['album'] and c['album_type'] != 'compile']
    keys = {album_key(normal, c['album']) for c in albums}
    if len(keys) != 1: return ''
    # Prefer the store title without the " - Single" suffix.
    return re.sub(r'\s+-\s+(?:Single|EP)$', '', min((c['album'] for c in albums), key=len))
