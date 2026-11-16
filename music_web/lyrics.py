"""Song lyrics from LRCLIB (https://lrclib.net): free, keyless, often time-synced.

Library titles often come from video uploads ("Artist feat. X - Song (Official Video)" by a
fan channel), so the lookup tries a few cleaned name pairs and accepts a match only when its
length is within a few seconds of the recording.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://lrclib.net/api/'
TOLERANCE = 4.0
_lock = threading.Lock()
_next = 0.0

_NOISE = re.compile(r'\s*[\(\[](?:[^()\[\]]*?(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster|full version|clip|music video|explicit|out now|free download|premiere)[^()\[\]]*)[\)\]]', re.I)
_BRACKETS = re.compile(r'\s*[\(\[][^()\[\]]*[\)\]]')
_FEAT = re.compile(r'\s+(?:feat\.?|ft\.?|featuring|with)\s+.*$', re.I)
_SPLIT_ARTISTS = re.compile(r'\s*(?:,|&|\bx\b|\band\b|\bvs\.?)\s*', re.I)
_CHANNEL = re.compile(r'\s*(?:- Topic|VEVO|Official|Music|Records)$', re.I)
_TAIL = re.compile(r'\s*(?:\||//).*$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Lyrics service redirected the request.')


def _read(path, **parameters):
    global _next
    request = urllib.request.Request(API + path + '?' + urllib.parse.urlencode(parameters),
        headers={'User-Agent': 'FamilyHubMusic/0.1 (https://github.com/YeerooXY)', 'Accept': 'application/json'})
    for attempt in range(4):
        with _lock:
            time.sleep(max(0, _next - time.monotonic()))
            _next = time.monotonic() + 1.0
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
                data = response.read(2097153)
            break
        except urllib.error.HTTPError as error:
            if error.code == 404: return None
            if error.code != 429 or attempt == 3: raise
            # Rate limited: everyone waits, longer each time.
            with _lock: _next = time.monotonic() + 15 * (attempt + 1)
    if len(data) > 2097152: raise ValueError('Lyrics response is too large.')
    return json.loads(data)


def _tidy(text):
    return re.sub(r'\s+', ' ', text.replace('"', '').replace('“', '').replace('”', '')).strip(' -_')


def candidates(title, channel='', artist=''):
    """Ordered (artist, track) guesses for a library title, most specific first."""
    title = _TAIL.sub('', _NOISE.sub('', title or ''))
    pairs = []
    if artist: pairs.append((artist, title))
    if ' - ' in title:
        left, right = title.split(' - ', 1)
        pairs.append((left, right))
    elif ' – ' in title:
        left, right = title.split(' – ', 1)
        pairs.append((left, right))
    uploader = _CHANNEL.sub('', channel or '')
    if uploader: pairs.append((uploader, title))
    out = []
    for who, what in pairs:
        who, what = _tidy(who), _tidy(what)
        lead = _tidy(_FEAT.sub('', who))
        first = _tidy(_SPLIT_ARTISTS.split(lead)[0]) if lead else ''
        bare = _tidy(_FEAT.sub('', _BRACKETS.sub('', what)))
        for guess in ((who, what), (lead, what), (lead, bare), (first, bare)):
            if guess[0] and guess[1] and guess not in out: out.append(guess)
    return out


def _pick(results, duration):
    close = [r for r in results or [] if isinstance(r, dict) and r.get('duration') and abs(r['duration'] - duration) <= TOLERANCE
             and (r.get('syncedLyrics') or r.get('plainLyrics') or r.get('instrumental'))]
    close.sort(key=lambda r: (not r.get('syncedLyrics'), abs(r['duration'] - duration)))
    return close[0] if close else None


_LRC = re.compile(r'\[(\d+):(\d+(?:\.\d+)?)\]')


def lines(synced):
    """LRC text to [{'t': seconds, 'text': line}], sorted, without empty timing tags."""
    out = []
    for row in (synced or '').splitlines():
        stamps = _LRC.findall(row)
        text = _LRC.sub('', row).strip()
        out.extend({'t': round(int(m) * 60 + float(s), 2), 'text': text} for m, s in stamps)
    return sorted(out, key=lambda line: line['t'])


class LyricsCache:
    """One JSON file per recording. Misses are kept for a week before trying again."""
    RETRY_MISS = 7 * 24 * 3600

    def __init__(self, workspace, lookup=None):
        self.root = os.path.join(workspace, '.lyrics')
        self.lookup = lookup or find
        self.locks, self.guard = {}, threading.Lock()

    def get(self, recording_id, title, channel, duration, artist=''):
        path = os.path.join(self.root, recording_id + '.json')
        with self.guard: lock = self.locks.setdefault(recording_id, threading.Lock())
        with lock:
            try:
                with open(path, encoding='utf-8') as handle: cached = json.load(handle)
                if cached.get('state') != 'none' or time.time() - cached.get('checked', 0) < self.RETRY_MISS: return cached
            except (OSError, ValueError): pass
            hit = self.lookup(title, channel, duration, artist)
            if not hit: result = {'state': 'none'}
            elif hit['instrumental']: result = {'state': 'instrumental'}
            elif hit['synced']: result = {'state': 'synced', 'lines': lines(hit['synced']), 'source_id': hit['source_id']}
            else: result = {'state': 'plain', 'text': hit['plain'][:20000], 'source_id': hit['source_id']}
            result['checked'] = int(time.time())
            os.makedirs(self.root, exist_ok=True)
            temporary = path + '.tmp'
            with open(temporary, 'w', encoding='utf-8') as handle: json.dump(result, handle, ensure_ascii=False)
            os.replace(temporary, path)
            with self.guard: self.locks.pop(recording_id, None)
            return result


def find(title, channel, duration, artist=''):
    """Returns {'synced','plain','instrumental','artist','track','source_id'} or None."""
    guesses = candidates(title, channel, artist)
    found = None
    for who, what in guesses[:4]:
        hit = _read('get', artist_name=who, track_name=what, duration=round(duration))
        found = _pick([hit] if hit else [], duration)
        if found: break
    if not found:
        for who, what in guesses[:3]:
            found = _pick(_read('search', track_name=what, artist_name=who), duration)
            if found: break
    if not found and guesses:
        who, what = guesses[-1]
        found = _pick(_read('search', q=f'{who} {what}'), duration)
    if not found: return None
    return {'synced': found.get('syncedLyrics') or '', 'plain': found.get('plainLyrics') or '',
            'instrumental': bool(found.get('instrumental')), 'artist': found.get('artistName', ''),
            'track': found.get('trackName', ''), 'source_id': found.get('id')}
