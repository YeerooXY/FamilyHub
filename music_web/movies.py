"""Issue a regular Jellyfin session for the active FamilyHub profile."""
import http.client
import http.cookiejar
import json
import logging
import re
import secrets
import shutil
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from time import monotonic

from flask import g, jsonify

from . import feedback, movie_search
from .movie_youtube_downloads import DEFAULT_DIR, YouTubeDownloads


log = logging.getLogger('music_web.movies')
# Client reports use fixed labels plus a title and a minute count; URLs and tokens are never accepted.
REPORT_KINDS = {'playback-error', 'open-failed', 'progress-save-failed', 'cannot-resume', 'started', 'stopped'}
PROBLEMS = REPORT_KINDS - {'started', 'stopped'}
REPORT_METHODS = {'', 'DirectPlay', 'DirectStream', 'Transcode'}
SEASON_QUERY = re.compile(r'(.+?)\s+(?:season\s+|s)(\d{1,2})$', re.I)
SEASON_MARKER = re.compile(r'\b(?:season[\s._-]+|s)(\d{1,2})(?!\d)', re.I)


def season_pack(title, wanted_words, season):
    if not wanted_words <= movie_search.words(title):
        return False
    markers = list(SEASON_MARKER.finditer(title))
    if len(markers) != 1 or int(markers[0][1]) != season:
        return False
    suffix = title[markers[0].end():]
    return not re.match(r'(?:[\s._-]*(?:e(?:p(?:isode)?)?[\s._-]*\d|x\d)|\s*(?:[-–/&+,]|and\b|to\b)\s*\d)', suffix, re.I)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def download_item(row):
    progress = max(0, min(1, float(row['progress'])))
    state, name = row['state'], row['name']
    if not isinstance(name, str) or not isinstance(state, str):
        raise ValueError()
    if state in {'error', 'missingFiles', 'unknown'}:
        label = 'Problem'
    elif state == 'moving':
        label = 'Almost done'
    elif progress == 1:
        label = 'Finished'
    elif state in {'pausedDL', 'stoppedDL'}:
        label = 'Paused'
    elif state == 'stalledDL':
        label = 'Stalled'
    elif state in {'downloading', 'forcedDL'}:
        label = 'Almost done' if progress >= 0.95 else 'Downloading'
    else:
        label = 'Waiting'
    eta = row.get('eta')
    return dict(name=name, progress=progress, size=max(0, int(row['size'])),
                state=label, eta=eta if type(eta) is int and 0 <= eta < 8640000 else None,
                speed=max(0, int(row.get('dlspeed', 0))))


def read_downloads(qb):
    url = (qb.get('url') or '').rstrip('/')
    if not all((url, qb.get('user'), qb.get('password'))):
        return dict(available=False, reason='Server downloads are not set up.')
    try:
        origin = urllib.parse.urlsplit(url)
        if (origin.scheme not in ('http', 'https') or not origin.hostname
                or origin.username is not None or origin.query or origin.fragment):
            raise ValueError()
        opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        login = urllib.request.Request(url + '/api/v2/auth/login',
            data=urllib.parse.urlencode({'username': qb['user'], 'password': qb['password']}).encode(),
            headers={'Referer': url + '/'})
        with opener.open(login, timeout=2) as reply:
            if reply.read(64).strip() != b'Ok.':
                raise ValueError()
        with opener.open(url + '/api/v2/torrents/info?category=familyhub', timeout=2) as reply:
            rows = json.loads(reply.read(1024 * 1024))
        if not isinstance(rows, list):
            raise ValueError()
        return dict(available=True, items=[download_item(row) for row in rows])
    except urllib.error.HTTPError as error:
        error.close()
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError, OverflowError):
        pass
    return dict(available=False, reason='The download server is unavailable.')


def register_movies(app, cfg, body, allow):
    base = cfg.get('JELLYFIN_INTERNAL_URL', 'http://127.0.0.1:8096').rstrip('/')
    releases = cfg.get('MOVIE_RELEASE_SEARCH') or {}
    prowlarr = releases.get('url', 'http://127.0.0.1:9696').rstrip('/')
    indexers = tuple(dict.fromkeys(i for i in releases.get('indexer_ids', []) if type(i) is int and i > 0))[:4]
    requests = cfg.get('MOVIE_REQUESTS') or {}
    downloads = cfg.get('MOVIE_DOWNLOADS') or {}
    youtube = YouTubeDownloads(downloads.get('youtube_dir') or DEFAULT_DIR)
    grab_refs = {}
    grab_lock, queue_lock = Lock(), Lock()
    queue_cache, queue_expires = None, 0
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

    def download_access():
        return g.user in downloads.get('profiles', []) and g.user in cfg.get('JELLYFIN_PROFILES', {})

    @app.get('/api/movies/downloads')
    def movie_downloads():
        nonlocal queue_cache, queue_expires
        with queue_lock:
            if monotonic() >= queue_expires:
                queue_cache = read_downloads(downloads.get('qbittorrent') or {})
                queue_expires = monotonic() + 3
            snapshot = queue_cache
        jobs = youtube.items()
        if jobs:
            snapshot = dict(available=True, items=[*jobs, *snapshot.get('items', [])])
        response = jsonify(snapshot)
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.post('/api/movies/youtube-download')
    def movie_youtube_download():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        data = body()
        ident = movie_search.video_id(data.get('url'))
        title = data.get('title')
        if not ident or not isinstance(title, str) or not 0 < len(title.strip()) <= 250:
            return jsonify(error='Select a YouTube video with a title.'), 400
        if not allow('movie-download:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before starting another download.'), 429
        tool = shutil.which('yt-dlp')
        if not tool:
            return jsonify(error='YouTube downloads are not set up on this server.'), 503
        height = (movie_search.cached_metadata(ident) or {}).get('height')
        if not youtube.enqueue(tool, ident, ' '.join(title.split()), height):
            return jsonify(error='The download queue is full. Try again later.'), 503
        return jsonify(state='sent'), 202

    @app.post('/api/movies/download')
    def movie_download():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        data = body()
        ref, indexer, title = data.get('guid'), data.get('indexer_id'), data.get('title')
        if (not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9_-]{24}', ref)
                or type(indexer) is not int or not isinstance(title, str) or not 0 < len(title) <= 250):
            return jsonify(error='Search again and select a release.'), 400
        if not allow('movie-download:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before starting another download.'), 429
        with grab_lock:
            entry = grab_refs.get(ref)
        if not entry or entry[:2] != (g.user, indexer) or entry[3] <= monotonic():
            return jsonify(error='This release is no longer available. Search again.'), 404
        release = {'guid': entry[2], 'indexerId': indexer}

        def grab(payload):
            req = urllib.request.Request(prowlarr + '/api/v1/search', data=json.dumps(payload).encode(),
                headers={'X-Api-Key': releases['api_key'], 'Content-Type': 'application/json'})
            try:
                with urllib.request.build_opener(NoRedirect).open(req, timeout=6):
                    return None, b''
            except urllib.error.HTTPError as error:
                with error:
                    return error.code, error.read(8192).lower()

        try:
            code, detail = grab([release])
            # Prowlarr's single-grab route on current versions binds a JSON object.
            if code == 400 and any(problem in detail for problem in (b'convert', b'"release"', b"body can't be empty")):
                code, detail = grab(release)
        except (OSError, http.client.HTTPException, ValueError):
            return jsonify(error='Could not confirm the download. Check On the server before trying again.'), 503
        if b'download client' in detail and any(word in detail for word in (b'configur', b'no download client')):
            return jsonify(error='Prowlarr has no download client set up for this release.'), 503
        if code == 404 or b'getting release from indexer failed' in detail:
            return jsonify(error='This release is no longer available. Search again.'), 404
        if code:
            return jsonify(error='Prowlarr could not send this release. Try again.'), 503
        return jsonify(state='sent')

    @app.post('/api/movies/releases')
    def movie_releases():
        if not release_access():
            return jsonify(error='Release search is disabled for this profile.'), 404
        query = movie_search.clean_query(body().get('query'))
        if query is None:
            return jsonify(error='Enter a title of 2 to 120 characters.'), 400
        if not allow('movie-release-search:' + g.user, 6, 60):
            return jsonify(error='Wait a minute before searching again.'), 429

        season_query = SEASON_QUERY.fullmatch(query)
        title = season_query[1] if season_query else query
        season = int(season_query[2]) if season_query else None
        wanted_words = movie_search.words(title)

        def search_indexer(indexer, term):
            params = urllib.parse.urlencode({'query': term, 'type': 'search', 'indexerIds': indexer, 'limit': 50})
            req = urllib.request.Request(prowlarr + '/api/v1/search?' + params,
                headers={'X-Api-Key': releases['api_key'], 'Accept': 'application/json'})
            try:
                with urllib.request.build_opener(NoRedirect).open(req, timeout=4 if season is not None else 8) as reply:
                    rows = json.loads(reply.read(1024 * 1024))
                return [dict(title=row['title'][:250], source=row.get('indexer', '')[:80], size=row.get('size'),
                             seeders=row.get('seeders'), leechers=row.get('leechers'),
                             guid=row.get('guid'), indexerId=row.get('indexerId', indexer)) for row in rows
                        if isinstance(row.get('title'), str) and row['title'].strip()]
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                return None

        def lookup(indexer):
            if season is None:
                return search_indexer(indexer, query)
            rows = search_indexer(indexer, f'{title} S{season:02d}')
            if rows is None:
                return None
            matches = [row for row in rows if season_pack(row['title'], wanted_words, season)]
            if matches:
                return matches
            rows = search_indexer(indexer, title)
            if rows is None:
                return None
            return [row for row in rows if season_pack(row['title'], wanted_words, season)]

        with ThreadPoolExecutor(max_workers=len(indexers)) as pool:
            pages = list(pool.map(lookup, indexers))
        unavailable = pages.count(None)
        if unavailable == len(indexers):
            return jsonify(error='The sources did not respond. Try again.'), 503
        rows = [row for page in pages if page is not None for row in page]
        with grab_lock:
            now = monotonic()
            for ref in list(grab_refs):
                if grab_refs[ref][3] <= now:
                    del grab_refs[ref]
            for row in rows:
                guid, indexer = row.pop('guid'), row.pop('indexerId')
                if isinstance(guid, str) and 0 < len(guid) <= 8192 and type(indexer) is int and indexer in indexers:
                    ref = secrets.token_urlsafe(18)
                    grab_refs[ref] = (g.user, indexer, guid, now + 1800)
                    row.update(guid=ref, indexerId=indexer)
            while len(grab_refs) > 10000:
                del grab_refs[next(iter(grab_refs))]
        return jsonify(results=rows, unavailable=unavailable)

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
        season_query = SEASON_QUERY.fullmatch(query)
        title_query = season_query[1] if season_query else query
        try:
            _, reply = seerr_call('search?' + urllib.parse.urlencode({'query': title_query, 'page': 1}), user)
            results = []
            for item in reply['results']:
                kind, ident = item.get('mediaType'), item.get('id')
                if kind not in ('movie', 'tv') or type(ident) is not int or not 0 < ident <= 2**31 - 1:
                    continue
                if season_query and kind != 'tv':
                    continue
                title, date = (item.get('title'), item.get('releaseDate')) if kind == 'movie' else (item.get('name'), item.get('firstAirDate'))
                if not isinstance(title, str) or not title:
                    continue
                status = (item.get('mediaInfo') or {}).get('status')
                results.append(dict(kind=kind, id=ident, title=title[:250], year=date[:4] if isinstance(date, str) else '', status=status))
            return jsonify(results=results, **({'season': int(season_query[2])} if season_query else {}))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            log.warning('Seerr title search failed')
            return jsonify(error='Title search is unavailable. Try again.'), 503

    @app.post('/api/movies/request')
    def movie_request():
        user = request_user()
        if user is None:
            return jsonify(error='Movie and TV requests are disabled for this profile.'), 404
        data = body()
        kind, ident, season = data.get('kind'), data.get('id'), data.get('season')
        if (kind not in ('movie', 'tv') or type(ident) is not int or not 0 < ident <= 2**31 - 1
                or season is not None and (kind != 'tv' or type(season) is not int or not 0 <= season <= 99)):
            return jsonify(error='Search again and select a movie or series.'), 400
        if not allow('movie-request:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before requesting another title.'), 429
        payload = {'mediaType': kind, 'mediaId': ident, 'is4k': False}
        if kind == 'tv':
            payload['seasons'] = 'all' if season is None else [season]
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

    @app.post('/api/movies/youtube-metadata')
    def movie_youtube_metadata():
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are not set up for this profile.'), 404
        ids = body().get('ids')
        if (not isinstance(ids, list) or not 0 < len(ids) <= movie_search.MAX_RESULTS
                or any(not isinstance(ident, str) or not movie_search.VIDEO_ID.fullmatch(ident) for ident in ids)):
            return jsonify(error='Search again to refresh video details.'), 400
        if not allow('movie-youtube-metadata:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before refreshing video details.'), 429
        return jsonify(results=movie_search.enrich(dict.fromkeys(ids)))

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
            connection['downloads_enabled'] = download_access()
            response = jsonify(connection)
            response.headers['Cache-Control'] = 'no-store'
            return response
        except (OSError, ValueError, KeyError, TypeError) as error:
            log.warning('movie session failed: profile=%s cause=%s', g.user, type(error).__name__)
            return jsonify(error='Could not connect this profile to Jellyfin.'), 503
