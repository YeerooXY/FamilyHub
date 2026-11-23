"""Issue a regular Jellyfin session for the active FamilyHub profile."""
import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from flask import g, jsonify

from . import feedback, movie_search


log = logging.getLogger('music_web.movies')
# Client reports use fixed labels plus a title and a minute count; URLs and tokens are never accepted.
REPORT_KINDS = {'playback-error', 'open-failed', 'progress-save-failed', 'cannot-resume', 'started', 'stopped'}
PROBLEMS = REPORT_KINDS - {'started', 'stopped'}
REPORT_METHODS = {'', 'DirectPlay', 'DirectStream', 'Transcode'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def register_movies(app, cfg, body, allow):
    base = cfg.get('JELLYFIN_INTERNAL_URL', 'http://127.0.0.1:8096').rstrip('/')
    releases = cfg.get('MOVIE_RELEASE_SEARCH') or {}
    prowlarr = releases.get('url', 'http://127.0.0.1:9696').rstrip('/')
    indexers = tuple(dict.fromkeys(i for i in releases.get('indexer_ids', []) if type(i) is int and i > 0))[:4]
    requests = cfg.get('MOVIE_REQUESTS') or {}
    seerr = requests.get('url', '').rstrip('/')
    seerr_key = requests.get('api_key', '')
    try:
        seerr_origin = urllib.parse.urlsplit(seerr)
    except ValueError:
        seerr_origin = urllib.parse.urlsplit('')

    def request_user():
        if (requests.get('enabled') is not True or not seerr_key
                or seerr_origin.scheme not in ('http', 'https') or not seerr_origin.hostname
                or seerr_origin.username is not None or seerr_origin.query or seerr_origin.fragment
                or g.user not in cfg.get('JELLYFIN_PROFILES', {})):
            return None
        user = requests.get('profiles', {}).get(g.user)
        return user if type(user) is int and user > 1 else None

    def release_access():
        return bool(releases.get('api_key') and indexers and g.user in releases.get('profiles', [])
                    and g.user in cfg.get('JELLYFIN_PROFILES', {}))

    @app.post('/api/movies/releases')
    def movie_releases():
        if not release_access():
            return jsonify(error='Release search is disabled for this profile.'), 404
        query = movie_search.clean_query(body().get('query'))
        if query is None:
            return jsonify(error='Enter a title of 2 to 120 characters.'), 400
        if not allow('movie-release-search:' + g.user, 6, 60):
            return jsonify(error='Wait a minute before searching again.'), 429

        def lookup(indexer):
            params = urllib.parse.urlencode({'query': query, 'type': 'search', 'indexerIds': indexer, 'limit': 50})
            req = urllib.request.Request(prowlarr + '/api/v1/search?' + params,
                headers={'X-Api-Key': releases['api_key'], 'Accept': 'application/json'})
            try:
                with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as reply:
                    rows = json.loads(reply.read(1024 * 1024))
                return [dict(title=row['title'][:250], source=row.get('indexer', '')[:80], size=row.get('size'),
                             seeders=row.get('seeders'), leechers=row.get('leechers')) for row in rows
                        if isinstance(row.get('title'), str) and row['title'].strip()]
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                return None

        with ThreadPoolExecutor(max_workers=len(indexers)) as pool:
            pages = list(pool.map(lookup, indexers))
        unavailable = pages.count(None)
        if unavailable == len(indexers):
            return jsonify(error='The sources did not respond. Try again.'), 503
        return jsonify(results=[row for page in pages if page is not None for row in page], unavailable=unavailable)

    def seerr_call(path, user, payload=None):
        req = urllib.request.Request(seerr + '/api/v1/' + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={'X-Api-Key': seerr_key, 'X-Api-User': str(user), 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=6) as reply:
            return reply.status, json.loads(reply.read(1024 * 1024))

    @app.post('/api/movies/request-search')
    def movie_request_search():
        user = request_user()
        if user is None:
            return jsonify(error='Movie and TV requests are disabled for this profile.'), 404
        query = movie_search.clean_query(body().get('query'))
        if query is None:
            return jsonify(error='Enter a title of 2 to 120 characters.'), 400
        if not allow('movie-request-search:' + g.user, 12, 60):
            return jsonify(error='Wait a minute before searching again.'), 429
        try:
            _, reply = seerr_call('search?' + urllib.parse.urlencode({'query': query, 'page': 1}), user)
            results = []
            for item in reply['results']:
                kind, ident = item.get('mediaType'), item.get('id')
                if kind not in ('movie', 'tv') or type(ident) is not int or not 0 < ident <= 2**31 - 1:
                    continue
                title, date = (item.get('title'), item.get('releaseDate')) if kind == 'movie' else (item.get('name'), item.get('firstAirDate'))
                if not isinstance(title, str) or not title:
                    continue
                status = (item.get('mediaInfo') or {}).get('status')
                results.append(dict(kind=kind, id=ident, title=title[:250], year=date[:4] if isinstance(date, str) else '', status=status))
            return jsonify(results=results)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            log.warning('Seerr title search failed')
            return jsonify(error='Title search is unavailable. Try again.'), 503

    @app.post('/api/movies/request')
    def movie_request():
        user = request_user()
        if user is None:
            return jsonify(error='Movie and TV requests are disabled for this profile.'), 404
        data = body()
        kind, ident = data.get('kind'), data.get('id')
        if kind not in ('movie', 'tv') or type(ident) is not int or not 0 < ident <= 2**31 - 1:
            return jsonify(error='Search again and select a movie or series.'), 400
        if not allow('movie-request:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before requesting another title.'), 429
        payload = {'mediaType': kind, 'mediaId': ident, 'is4k': False}
        if kind == 'tv':
            payload['seasons'] = 'all'
        try:
            status, reply = seerr_call('request', user, payload)
            if status == 202 and kind == 'tv':
                return jsonify(state='no_seasons')
            if status == 201 and reply.get('id'):
                return jsonify(state={1: 'pending', 2: 'approved', 4: 'failed', 5: 'available'}.get(reply.get('status'), 'requested'))
        except urllib.error.HTTPError as error:
            error.close()
            if error.code == 409:
                return jsonify(state='existing')
            if error.code in (401, 403):
                return jsonify(error='Seerr could not accept this request. Check your request permissions and limits with the server owner.'), 403
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        log.warning('Seerr request could not be confirmed')
        return jsonify(error='Could not confirm the request. Try again.'), 503

    @app.get('/api/movies/health')
    def movie_health():
        if not cfg.get('JELLYFIN_PUBLIC_URL') or g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are not set up for this profile.'), 404
        try:
            with urllib.request.build_opener(NoRedirect).open(base + '/health', timeout=2) as reply:
                healthy = reply.read(64).strip() == b'Healthy'
        except (OSError, ValueError):
            healthy = False
        if not healthy:
            log.warning('Jellyfin health check failed for profile=%s', g.user)
        return jsonify(healthy=healthy)

    @app.post('/api/movies/report')
    def movie_report():
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are not set up for this profile.'), 404
        if not allow('movie-report:' + g.user, 30, 60):
            return jsonify(error='Too many reports.'), 429
        data = body()
        kind, method = data.get('kind'), data.get('method', '')
        if kind not in REPORT_KINDS or method not in REPORT_METHODS:
            return jsonify(error='Unknown report.'), 400
        title, minutes = data.get('title', ''), data.get('minutes')
        if not isinstance(title, str) or len(title) > 200 or (minutes is not None and (type(minutes) is not int or not 0 <= minutes <= 1000)):
            return jsonify(error='Unknown report.'), 400
        feedback.note(movie_event=kind, method=method, title=title, minutes=minutes if minutes is not None else '')
        (log.warning if kind in PROBLEMS else log.info)('movie client %s profile=%s method=%s', kind, g.user, method or '-')
        return '', 204

    @app.post('/api/movies/find')
    def movie_find():
        """Where a film that is not in the library can be watched. The search text is never logged."""
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are not set up for this profile.'), 404
        query = movie_search.clean_query(body().get('query'))
        if query is None:
            return jsonify(error='Type a film title of 2 to %d characters.' % movie_search.MAX_QUERY), 400
        if not allow('movie-find:' + g.user, 6, 60) or not allow('movie-find-hour:' + g.user, 40, 3600):
            return jsonify(error='Wait a minute before searching the web again.'), 429
        try:
            found = movie_search.find(query, cfg)
        except LookupError:
            return jsonify(error='Searching the web is not set up on this server.'), 503
        feedback.note(movie_event='web-search', results=len(found['results']), ranking=found['ranking'])
        log.info('movie web search profile=%s results=%d ranking=%s', g.user, len(found['results']), found['ranking'])
        return jsonify(found)

    @app.post('/api/movies/session')
    def movie_session():
        accounts = cfg.get('JELLYFIN_PROFILES', {})
        account = accounts.get(g.user)
        public = cfg.get('JELLYFIN_PUBLIC_URL', '').rstrip('/')
        origin = urllib.parse.urlsplit(public)
        if not account:
            log.warning('movie session refused: profile=%s has no Jellyfin account', g.user)
        if not account or origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
            return jsonify(error='Movies are not set up for this profile.'), 503
        device = body().get('device', '')
        if not isinstance(device, str) or not re.fullmatch('[a-f0-9]{32}', device):
            return jsonify(error='Invalid movie device.'), 400
        if not allow('movie-session:' + g.user, 20, 60):
            return jsonify(error='Wait a minute before opening movies again.'), 429
        username = account['username']
        if sum(a['username'].casefold() == username.casefold() for a in accounts.values()) != 1:
            log.warning('movie session refused: profile=%s shares a Jellyfin user', g.user)
            return jsonify(error='Each profile needs a separate Jellyfin user.'), 503
        auth = f'MediaBrowser Client="FamilyHub", Device="FamilyHub Movies", DeviceId="{device}", Version="1"'
        opener = urllib.request.build_opener(NoRedirect)
        req = urllib.request.Request(base + '/Users/AuthenticateByName',
            data=json.dumps({'Username': username, 'Pw': account['password']}).encode(),
            headers={'Authorization': auth, 'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=6) as reply:
                data = json.load(reply)
            user = data['User']
            if user['Policy']['IsAdministrator'] is not False or user['Name'].casefold() != username.casefold():
                logout = urllib.request.Request(base + '/Sessions/Logout', data=b'',
                    headers={'Authorization': auth + ', Token="' + data['AccessToken'] + '"'})
                with opener.open(logout, timeout=6):
                    pass
                log.warning('movie session refused: profile=%s is linked to an administrator or mismatched account', g.user)
                return jsonify(error='Link a regular Jellyfin account to this profile.'), 403
            log.info('movie session opened: profile=%s device=%s', g.user, device[:8])
            connection = dict(url=public, user=user['Id'], token=data['AccessToken'], device=device)
            if request_user() is not None:
                connection['requests_enabled'] = True
            if release_access():
                connection['release_search_enabled'] = True
            response = jsonify(connection)
            response.headers['Cache-Control'] = 'no-store'
            return response
        except (OSError, ValueError, KeyError, TypeError) as error:
            log.warning('movie session failed: profile=%s cause=%s', g.user, type(error).__name__)
            return jsonify(error='Could not connect this profile to Jellyfin.'), 503
