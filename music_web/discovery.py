"""Shared Deezer metadata cache. Discovery never contacts YouTube."""
import json
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.error
from email.utils import parsedate_to_datetime
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from . import catalog_search


def normal(value):
    return re.sub(r'\W+', ' ', str(value).casefold()).strip()


def recent_release(row, today):
    if not isinstance(row, dict) or type(row.get('id')) is not int or row['id'] <= 0:
        return False
    if row.get('record_type') not in ('album', 'single', 'ep'):
        return False
    if re.search(r'\b(remaster\w*|reissue\w*|compilation|deluxe|anniversary|greatest hits|best of)\b', str(row.get('title', '')), re.I):
        return False
    try:
        released = date.fromisoformat(row.get('release_date', ''))
    except (ValueError, TypeError):
        return False
    return today - timedelta(days=60) <= released <= today


class Discovery:
    def __init__(self, workspace, get=None):
        # Durable store, kept out of the acquisition scratch quota (see scratch_size).
        (Path(workspace) / '.discovery').mkdir(mode=0o700, exist_ok=True)
        self.path = str(Path(workspace) / '.discovery' / 'discovery.sqlite3')
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        try:
            self.mbids = json.loads((Path(workspace) / '.artist-genres.json').read_text(encoding='utf-8'))
        except (OSError, ValueError): self.mbids = {}
        if not isinstance(self.mbids, dict): self.mbids = {}
        self.get = get or (lambda path: catalog_search._get('deezer', 'https://api.deezer.com/' + path))
        self.next_request = 0
        self.wake = threading.Event()
        self.thread = None
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS refresh_state (key TEXT PRIMARY KEY, value REAL);
                CREATE TABLE IF NOT EXISTS artists (name TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, artist_id INTEGER, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS interests (profile TEXT, name TEXT, PRIMARY KEY(profile,name));
                CREATE TABLE IF NOT EXISTS follows (profile TEXT, name TEXT, PRIMARY KEY(profile,name));
                CREATE TABLE IF NOT EXISTS states (profile TEXT, id TEXT, state TEXT, PRIMARY KEY(profile,id));
            ''')

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=20)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def artists(self):
        with self.db() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT data FROM artists ORDER BY name')]

    def put_artist(self, row):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO artists VALUES (?,?)', (normal(row['name']), json.dumps(row)))

    def save_refresh(self, row):
        # Admin corrections made during a slow provider request take precedence.
        with self.lock:
            current = next((a for a in self.artists() if normal(a['name']) == normal(row['name'])), {})
            if current.get('revision', 0) != row.get('revision', 0): return False
            self.put_artist(row)
            return True

    def request(self, path):
        time.sleep(max(0, self.next_request - time.monotonic()))
        self.next_request = time.monotonic() + 1.05
        result = self.get(path)
        if not isinstance(result, dict) or result.get('error'):
            raise ValueError('Catalogue unavailable')
        return result

    def pages(self, path):
        # Bounded pagination; provider-supplied URLs never become request destinations.
        for page in range(10):
            data = self.request(path + ('&' if '?' in path else '?') + 'limit=100&index=' + str(page * 100))
            rows = data.get('data')
            if not isinstance(rows, list):
                raise ValueError('Invalid catalogue page')
            yield from (r for r in rows if isinstance(r, dict))
            if not data.get('next'):
                break

    def select(self, profile, summary, tracks):
        with self.db() as db:
            follows = [r[0] for r in db.execute('SELECT name FROM follows WHERE profile=? ORDER BY name', (profile,))]
        scores = summary.get('artists', {})
        names = follows + sorted((n for n, s in scores.items() if s.get('completes', 0) >= 2),
                                 key=lambda n: scores[n].get('score', 0), reverse=True)
        selected = list(dict.fromkeys(normal(n) for n in names if normal(n)))[:30]
        with self.db() as db:
            db.execute('DELETE FROM interests WHERE profile=?', (profile,))
            db.executemany('INSERT INTO interests VALUES (?,?)', [(profile, key) for key in selected])
        known = {normal(a['name']): a for a in self.artists()}
        for key in selected:
            songs = [t['title'] for t in tracks if normal(t.get('channel')) == key][:10]
            if key not in known:
                display = next((t.get('channel') for t in tracks if normal(t.get('channel')) == key), next((n for n in scores if normal(n) == key), key))
                self.put_artist(dict(name=display, aliases=list(dict.fromkeys([display, key])), deezer_id=None, mbid=self.mbids.get(key, {}).get('musicbrainz_id'), confidence='uncertain',
                                     songs=songs, next_refresh=0, updated_at=None))
            elif songs and known[key].get('songs') != songs:
                known[key]['songs'] = songs
                self.put_artist(known[key])
        return selected, set(follows)

    def refresh_one(self, now=None):
        now = now or time.time()
        with self.refresh_lock:
            with self.db() as db:
                retry = db.execute("SELECT value FROM refresh_state WHERE key='retry_at'").fetchone()
                interested = {r[0] for r in db.execute('SELECT DISTINCT name FROM interests')}
            if retry and retry[0] > now: return False
            due = sorted((a for a in self.artists() if normal(a['name']) in interested and a.get('next_refresh', 0) <= now),
                         key=lambda a: a.get('next_refresh', 0))
            if not due:
                return False
            artist = due[0]
            # Reserve the day before network work, including failed identity checks.
            artist['next_refresh'] = now + 86400
            artist['attempted_at'] = now
            self.save_refresh(artist)
            try:
                if not artist.get('deezer_id'):
                    matches = set()
                    for song in artist.get('songs', [])[:3]:
                        query = urllib.parse.urlencode({'q': artist['name'] + ' ' + song, 'limit': 25})
                        data = self.request('search/track?' + query)
                        rows = data.get('data')
                        if not isinstance(rows, list):
                            raise ValueError('Invalid identity results')
                        for row in rows:
                            if not isinstance(row, dict): continue
                            who = row.get('artist') or {}
                            if (isinstance(who, dict) and normal(who.get('name')) in {normal(n) for n in artist['aliases']}
                                    and normal(row.get('title')) == normal(song) and type(who.get('id')) is int):
                                matches.add(who['id'])
                    artist['candidates'] = sorted(matches)
                    if len(matches) != 1:
                        self.save_refresh(artist)
                        return True
                    artist.update(deezer_id=matches.pop(), confidence='song_verified')
                identifier = artist['deezer_id']
                shared = next((a for a in self.artists() if a['name'] != artist['name'] and a.get('deezer_id') == identifier and a.get('attempted_at', a.get('updated_at')) and now - a.get('attempted_at', a.get('updated_at')) < 86400), None)
                if shared:
                    artist.update(updated_at=shared.get('updated_at'), next_refresh=shared['next_refresh'])
                    self.save_refresh(artist)
                    return True
                today = date.today()
                existing = {}
                with self.db() as db:
                    existing = {r[0]: json.loads(r[1]) for r in db.execute('SELECT id,data FROM releases WHERE artist_id=?', (identifier,))}
                additions = []
                for album in self.pages('artist/%d/albums' % identifier):
                    if not recent_release(album, today): continue
                    prefix = str(album['id']) + ':'
                    if any(key.startswith(prefix) for key in existing): continue
                    detail = self.request('album/%d' % album['id'])
                    if detail.get('artist', {}).get('id') != identifier or not recent_release({**album, **detail}, today): continue
                    for track in self.pages('album/%d/tracks' % album['id']):
                        if type(track.get('id')) is not int or not isinstance(track.get('title'), str): continue
                        if (track.get('artist') or {}).get('id') != identifier: continue
                        additions.append(dict(id=prefix + str(track['id']), title=track['title'][:200], artist=artist['name'],
                                              artist_id=identifier, album=str(album.get('title', ''))[:200],
                                              release_date=detail.get('release_date', album['release_date']), date_precision='day',
                                              source='Deezer', source_ids=dict(artist=identifier, album=album['id'], track=track['id'])))
                with self.db() as db:
                    for key, old in existing.items():
                        if old.get('release_date', '') < (today - timedelta(days=60)).isoformat():
                            db.execute('DELETE FROM releases WHERE id=?', (key,))
                    for row in additions:
                        db.execute('INSERT OR REPLACE INTO releases VALUES (?,?,?)', (row['id'], identifier, json.dumps(row)))
                artist.update(updated_at=now, failures=0)
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                artist['failures'] = artist.get('failures', 0) + 1
                artist['next_refresh'] = now + min(7 * 86400, 86400 * 2 ** min(artist['failures'] - 1, 3))
                until = now + min(3600, 60 * 2 ** min(artist['failures'], 5))
                if isinstance(error, urllib.error.HTTPError):
                    retry = error.headers.get('Retry-After', '')
                    try:
                        until = now + max(0, int(retry))
                    except ValueError:
                        try: until = parsedate_to_datetime(retry).timestamp()
                        except (ValueError, TypeError, OverflowError): pass
                    artist['next_refresh'] = max(artist['next_refresh'], until)
                with self.db() as db:
                    db.execute('INSERT OR REPLACE INTO refresh_state VALUES (?,?)', ('retry_at', until))
            self.save_refresh(artist)
            return True

    def items(self, profile, selected, follows, tracks):
        all_artists = self.artists()
        artists = {a['deezer_id']: a for a in all_artists if normal(a['name']) in selected and a.get('deezer_id')}
        aliases_by_id = {}
        for artist in all_artists:
            aliases_by_id.setdefault(artist.get('deezer_id'), set()).update(normal(n) for n in artist.get('aliases', [artist['name']]))
        known = {(normal(t.get('channel')), normal(t.get('title'))) for t in tracks}
        with self.db() as db:
            states = dict(db.execute('SELECT id,state FROM states WHERE profile=?', (profile,)))
            releases = [json.loads(r[0]) for r in db.execute('SELECT data FROM releases')]
        result, seen = [], set()
        for row in sorted(releases, key=lambda r: r["release_date"], reverse=True):
            artist = artists.get(row['artist_id'])
            if not artist or states.get(row['id']) == 'dismissed': continue
            aliases = aliases_by_id.get(row['artist_id'], set())
            if any((alias, normal(row['title'])) in known for alias in aliases): continue
            key = (row['artist_id'], normal(row['title']))
            if key in seen: continue
            seen.add(key)
            if not recent_release(dict(id=row['source_ids']['album'], record_type='single', title=row['album'], release_date=row['release_date']), date.today()): continue
            row = dict(row, artist=artist['name'], source_url='https://www.deezer.com/track/' + str(row['source_ids']['track']))
            result.append(dict(row, seen=states.get(row['id']) == 'seen', updated_at=artist.get('updated_at'),
                               stale=time.time() - (artist.get('updated_at') or 0) > 86400,
                               reason='Followed artist' if normal(artist['name']) in follows else 'Artist you play'))
        return sorted(result, key=lambda r: (r['reason'] == 'Followed artist', r['release_date']), reverse=True)[:100]

    def start(self):
        with self.lock:
            if self.thread: return
            def run():
                while True:
                    try: self.refresh_one()
                    except (OSError, sqlite3.Error): pass
                    self.wake.wait(60)
                    self.wake.clear()
            self.thread = threading.Thread(target=run, name='release-discovery', daemon=True)
            self.thread.start()


def register(app, workspace, body, admins, tracks, worker=True):
    from flask import g, jsonify, abort, request
    store = Discovery(workspace)
    app.extensions['discovery'] = store
    if worker:
        store.start()

    def selection():
        library = tracks()
        summary = app.extensions['listening_history'].summary(g.user, {t['id']: t for t in library})
        with store.lock:
            selected, follows = store.select(g.user, summary, library)
        if worker:
            store.start()
        return store.items(g.user, selected, follows, library)

    @app.get('/api/discovery')
    def discovery_get():
        return jsonify(items=selection())

    @app.post('/api/discovery/<identifier>/state')
    def discovery_state(identifier):
        state = body().get('state')
        if state not in ('seen', 'dismissed'): return jsonify(error='Choose seen or dismissed.'), 400
        if not any(r['id'] == identifier for r in selection()): abort(404)
        with store.db() as db:
            db.execute('INSERT OR REPLACE INTO states VALUES (?,?,?)', (g.user, identifier, state))
        return jsonify(state=state)

    @app.post('/api/discovery/<identifier>/play')
    def discovery_play(identifier):
        item = next((r for r in selection() if r['id'] == identifier), None)
        if not item: abort(404)
        with store.db() as db:
            db.execute('INSERT OR REPLACE INTO states VALUES (?,?,?)', (g.user, identifier, 'seen'))
        # The client explicitly searches only after this tap, then offers recording choices.
        return jsonify(query=item['artist'] + ' ' + item['title'])

    @app.get('/api/discovery/follow')
    def discovery_follows():
        with store.db() as db:
            return jsonify(artists=[r[0] for r in db.execute('SELECT name FROM follows WHERE profile=?', (g.user,))])

    @app.post('/api/discovery/follow')
    def discovery_follow():
        data = body()
        name = data.get('artist')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120: return jsonify(error='Choose an artist.'), 400
        if type(data.get('follow', True)) is not bool: return jsonify(error='Invalid follow state.'), 400
        with store.db() as db:
            if data.get('follow', True):
                if db.execute('SELECT count(*) FROM follows WHERE profile=?', (g.user,)).fetchone()[0] >= 200:
                    return jsonify(error='Follow up to 200 artists.'), 400
                db.execute('INSERT OR IGNORE INTO follows VALUES (?,?)', (g.user, normal(name)))
            else: db.execute('DELETE FROM follows WHERE profile=? AND name=?', (g.user, normal(name)))
        return jsonify(followed=data.get('follow', True))

    @app.get('/api/admin/discovery')
    def discovery_admin():
        if g.user not in admins: abort(403)
        return jsonify(artists=store.artists())

    @app.post('/api/admin/discovery')
    def discovery_confirm():
        if g.user not in admins: abort(403)
        data = body()
        name, identifier = data.get('name'), data.get('deezer_id')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120 or type(identifier) is not int or identifier <= 0:
            return jsonify(error='Enter an artist name and a positive Deezer artist ID.'), 400
        with store.lock:
            row = next((a for a in store.artists() if normal(a['name']) == normal(name)), dict(name=name.strip(), aliases=[name.strip()], mbid=None, songs=[]))
            row.update(deezer_id=identifier, confidence='admin_confirmed', next_refresh=0, updated_at=None, revision=row.get('revision', 0) + 1)
            store.put_artist(row)
        return jsonify(artist=row)
