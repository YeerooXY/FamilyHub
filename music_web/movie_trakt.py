"""Title ratings from MDBList and per-profile Trakt linking through the Jellyfin Trakt plugin."""
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock

from flask import g, has_request_context, jsonify, request

from . import feedback
from .catalog_search import NoRedirect
from .state import state_path

log = logging.getLogger('music_web.movie_trakt')
SOURCES = {'imdb': ('IMDb', 10, '{:.1f}'), 'tomatoes': ('Rotten Tomatoes', 100, '{:.0f}%'),
           'metacritic': ('Metacritic', 100, '{:.0f}')}
RATING_TTL = 7 * 86400
# The free tier allows 1000 requests a day; stay below it so a restart or a clock slip cannot cross it.
DAILY_BUDGET = 900
MAX_CACHED = 3000
PLUGIN_ID = '4fe3201e-d6ae-4f2e-8917-e12bda571281'
KINDS = {'movie': 'movie', 'tv': 'show', 'episode': 'episode'}
TRAKT_ACTIVATE = 'https://trakt.tv/activate'


def parse(reply):
    """Keep only the three known sources with a plausible value, in a fixed order."""
    rows = reply.get('ratings') if isinstance(reply, dict) else None
    found = {}
    for row in rows if isinstance(rows, list) else ():
        spec = SOURCES.get(row.get('source')) if isinstance(row, dict) else None
        value = row.get('value') if spec else None
        if spec and row['source'] not in found and type(value) in (int, float) and 0 < value <= spec[1]:
            found[row['source']] = dict(source=row['source'], name=spec[0], value=spec[2].format(value))
    return [found[name] for name in SOURCES if name in found]


def field(data, name):
    return next((value for key, value in data.items() if key.lower() == name.lower()), None) if isinstance(data, dict) else None


def plain_id(value):
    return value.replace('-', '').lower() if isinstance(value, str) else ''


class RatingStore:
    """Seven-day cache and daily request count kept in one small file so a restart keeps both."""

    def __init__(self, path, key, fetch, clock=time.time):
        self.path, self.key, self.fetch, self.clock = Path(path), key, fetch, clock
        self.lock = Lock()
        self.failed = {}
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
            self.data = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            self.data = {}
        self.data.setdefault('cache', {})
        self.data.setdefault('used', 0)

    def save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile('w', dir=self.path.parent, delete=False, encoding='utf-8') as stream:
                json.dump(self.data, stream)
            Path(stream.name).replace(self.path)
        except OSError as error:
            log.warning('ratings cache not saved: cause=%s', type(error).__name__)

    def get(self, kind, provider, ident):
        """Return the ratings list, or None when nothing can be said (no key, budget used up, lookup failed)."""
        if not self.key:
            return None
        name, now = f'{kind}:{provider}:{ident}', self.clock()
        with self.lock:
            stored = self.data['cache'].get(name)
            if stored and stored[0] > now:
                return stored[1]
            if self.failed.get(name, 0) > now:
                return None
            day = time.strftime('%Y-%m-%d', time.gmtime(now))
            if self.data.get('day') != day:
                self.data.update(day=day, used=0)
            if self.data['used'] >= DAILY_BUDGET:
                if not self.data.get('logged'):
                    self.data['logged'] = True
                    log.warning('MDBList daily budget reached: used=%d', self.data['used'])
                return None
            self.data['logged'] = False
            self.data['used'] += 1
        try:
            ratings = parse(self.fetch(kind, provider, ident, self.key))
        except Exception as error:  # a rating lookup must never break a title page
            with self.lock:
                self.failed[name] = now + 300
            log.warning('MDBList lookup failed: cause=%s', type(error).__name__)
            if has_request_context():
                feedback.note(movie_event='ratings-failed', cause=type(error).__name__)
            return None
        with self.lock:
            cache = self.data['cache']
            cache[name] = [now + RATING_TTL, ratings]
            while len(cache) > MAX_CACHED:
                del cache[next(iter(cache))]
            self.save()
        return ratings


def mdblist_fetch(kind, provider, ident, key):
    url = f'https://api.mdblist.com/{provider}/{kind}/{ident}?' + urllib.parse.urlencode({'apikey': key})
    with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'FamilyHub/2.0'}),
                                                      timeout=4) as reply:
        return json.loads(reply.read(1 << 20))


def register(app, cfg, body, allow, base, fetch=mdblist_fetch):
    profiles = cfg.get('JELLYFIN_PROFILES', {})
    jellyfin_key = cfg.get('JELLYFIN_API_KEY')
    mdblist_key = cfg.get('MDBLIST_API_KEY')
    store = RatingStore(state_path(cfg, '.mdblist-ratings.json'), mdblist_key if isinstance(mdblist_key, str) else '',
                        lambda *args: fetch(*args))
    plugin_lock, ids, names = Lock(), {}, {}

    def fail(stage, error):
        cause = type(error).__name__
        log.warning('trakt %s failed: profile=%s cause=%s', stage, g.user, cause)
        feedback.note(movie_event='trakt-failed', stage=stage, cause=cause)

    def plugin(method, path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else (b'' if method == 'POST' else None)
        req = urllib.request.Request(base + path, data=data, method=method, headers={
            'Authorization': f'MediaBrowser Token="{jellyfin_key}"', 'Accept': 'application/json',
            'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=6) as reply:
            raw = reply.read((1 << 20) + 1)
        if len(raw) > 1 << 20:
            raise ValueError('oversized reply')
        return json.loads(raw) if raw.strip() else {}

    def jellyfin_user():
        account = profiles.get(g.user)
        if not account or not base or not jellyfin_key:
            return None
        if g.user not in ids:
            users = plugin('GET', '/Users')
            wanted = account['username'].casefold()
            ids[g.user] = next((plain_id(user.get('Id')) for user in users if isinstance(user, dict)
                                and isinstance(user.get('Name'), str) and user['Name'].casefold() == wanted), None)
        return ids[g.user]

    def available():
        if g.user not in profiles:
            return jsonify(error='Movies are not set up for this profile.'), 404
        if not base or not jellyfin_key:
            return jsonify(error='Trakt linking is not set up on this server.'), 503
        return None

    def stored_user(config, uid):
        users = field(config, 'TraktUsers')
        return next((user for user in users if isinstance(user, dict) and plain_id(field(user, 'LinkedMbUserId')) == uid),
                    None) if isinstance(users, list) else None

    def trakt_name(uid, entry):
        client = cfg.get('TRAKT_CLIENT_ID')
        token = field(entry, 'AccessToken')
        if uid in names or not isinstance(client, str) or not client or not isinstance(token, str) or not token:
            return names.get(uid)
        req = urllib.request.Request('https://api.trakt.tv/users/settings', headers={
            'Authorization': 'Bearer ' + token, 'trakt-api-version': '2', 'trakt-api-key': client})
        try:
            with urllib.request.build_opener(NoRedirect).open(req, timeout=4) as reply:
                name = field(field(json.loads(reply.read(1 << 20)), 'user'), 'username')
            names[uid] = name[:60] if isinstance(name, str) and name.strip() else None
        except (OSError, ValueError) as error:
            fail('name', error)
        return names.get(uid)

    def guarded(stage, work):
        """Run one plugin step; a failed step answers with a plain message and reports its cause."""
        refused = available()
        if refused:
            return refused
        try:
            uid = jellyfin_user()
            if not uid:
                return jsonify(error='Link a Jellyfin account to this profile first.'), 503
            return work(uid)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            fail(stage, error)
            return jsonify(error='Could not reach Trakt through Jellyfin. Try again in a minute.'), 503

    @app.get('/api/movies/ratings')
    def movie_ratings():
        if g.user not in profiles:
            return jsonify(error='Movies are not set up for this profile.'), 404
        kind = KINDS.get(request.args.get('kind', ''))
        imdb, tmdb = request.args.get('imdb', ''), request.args.get('tmdb', '')
        if not kind or not (re.fullmatch(r'tt[0-9]{1,10}', imdb) or re.fullmatch(r'[1-9][0-9]{0,9}', tmdb)
                            and kind != 'episode'):
            return jsonify(error='Choose a title from the library.'), 400
        if not allow('movie-ratings:' + g.user, 60, 60):
            return jsonify(error='Wait a minute before opening more titles.'), 429
        provider, ident = ('imdb', imdb) if imdb else ('tmdb', tmdb)
        return jsonify(ratings=store.get(kind, provider, ident) or [])

    @app.get('/api/trakt/status')
    def trakt_status():
        def work(uid):
            with plugin_lock:
                entry = stored_user(plugin('GET', f'/Plugins/{PLUGIN_ID}/Configuration'), uid)
            token = field(entry, 'AccessToken') if entry else None
            if not isinstance(token, str) or not token:
                return jsonify(linked=False)
            response = jsonify(linked=True, send=field(entry, 'Scrobble') is True, name=trakt_name(uid, entry))
            response.headers['Cache-Control'] = 'no-store'
            return response
        return guarded('status', work)

    @app.post('/api/trakt/link')
    def trakt_link():
        def work(uid):
            if not allow('trakt-link:' + g.user, 6, 300):
                return jsonify(error='Wait a few minutes before linking again.'), 429
            reply = plugin('POST', f'/Trakt/Users/{uid}/Authorize')
            code, expires, interval = (field(reply, 'userCode'), field(reply, 'expiresIn'), field(reply, 'interval'))
            if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9]{4,16}', code):
                raise ValueError('no device code')
            return jsonify(user_code=code, url=TRAKT_ACTIVATE,
                           expires_in=expires if type(expires) is int and 0 < expires <= 1800 else 600,
                           interval=interval if type(interval) is int and 1 <= interval <= 30 else 5)
        return guarded('link', work)

    @app.post('/api/trakt/link/poll')
    def trakt_poll():
        def work(uid):
            if not allow('trakt-poll:' + g.user, 40, 60):
                return jsonify(error='Wait a minute before checking again.'), 429
            reply = plugin('GET', f'/Trakt/Users/{uid}/PollAuthorizationStatus')
            return jsonify(linked=field(reply, 'isAuthorized') is True)  # the plugin answers {"isAuthorized": bool}
        return guarded('poll', work)

    def change_entry(uid, edit):
        with plugin_lock:
            config = plugin('GET', f'/Plugins/{PLUGIN_ID}/Configuration')
            users = field(config, 'TraktUsers')
            if not isinstance(users, list) or stored_user(config, uid) is None:
                return jsonify(error='Link your Trakt account first.'), 409
            key = next(key for key in config if key.lower() == 'traktusers')
            config[key] = edit(users, uid)
            plugin('POST', f'/Plugins/{PLUGIN_ID}/Configuration', config)
        return jsonify(ok=True)

    @app.post('/api/trakt/send')
    def trakt_send():
        data = body()
        if type(data.get('send')) is not bool:
            return jsonify(error='Choose on or off.'), 400
        send = data['send']

        def edit(users, uid):
            for user in users:
                if isinstance(user, dict) and plain_id(field(user, 'LinkedMbUserId')) == uid:
                    user.update(Scrobble=send, PostSetWatched=send, PostSetUnwatched=send)
            return users
        return guarded('send', lambda uid: change_entry(uid, edit))

    @app.post('/api/trakt/disconnect')
    def trakt_disconnect():
        # The plugin's Deauthorize revokes the token at Trakt and removes the user from its configuration.
        def work(uid):
            with plugin_lock:
                plugin('POST', f'/Trakt/Users/{uid}/Deauthorize')
            names.pop(uid, None)
            return jsonify(ok=True)
        return guarded('disconnect', work)
