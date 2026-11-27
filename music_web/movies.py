"""Issue a regular Jellyfin session for the active FamilyHub profile."""
import http.client
import html
import ipaddress
import io
import json
import time
import logging
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import struct
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from time import monotonic

from flask import Response, g, jsonify, request, session

from . import audio_tracks, feedback, movie_import, movie_media, movie_search, movie_subtitles, tmdb, tmdb_stills, torrent_seeding
from .catalog_search import NoRedirect
from .movie_youtube_downloads import DEFAULT_DIR, MAX_PENDING, YouTubeDownloads
from .state import state_path

try:
    from PIL import Image
except ImportError:
    Image = None


log = logging.getLogger('music_web.movies')
# Playback diagnostics use fixed labels and a restricted media-error vocabulary.
REPORT_KINDS = {'playback-error', 'open-failed', 'progress-save-failed', 'cannot-resume', 'started', 'stopped'}
PROBLEMS = REPORT_KINDS - {'started', 'stopped'}
REPORT_METHODS = {'', 'DirectPlay', 'DirectStream', 'Transcode'}
HLS_ERROR_TYPES = {'networkError', 'mediaError', 'keySystemError', 'muxError', 'otherError'}
HLS_ERROR_DETAILS = set("""
manifestLoadError manifestLoadTimeOut manifestParsingError manifestIncompatibleCodecsError
levelEmptyError levelLoadError levelLoadTimeOut levelParsingError levelSwitchError
audioTrackLoadError audioTrackLoadTimeOut subtitleTrackLoadError subtitleTrackLoadTimeOut
fragLoadError fragLoadTimeOut fragDecryptError fragParsingError fragGapError remuxAllocError
keyLoadError keyLoadTimeOut bufferAddCodecError bufferIncompatibleCodecsError bufferAppendError
bufferAppendingError bufferStalledError bufferFullError bufferSeekOverHole bufferNudgeOnStall
assetListLoadError assetListLoadTimeout assetListParsingError interstitialAssetItemError
internalException internalAborted attachMediaError unknown
""".split())
MEDIA_ERROR_WORDS = set("""
media_err_aborted media_err_network media_err_decode media_err_src_not_supported
pipeline_error_decode pipeline_error_network pipeline_error_initialization_failed
demuxer_error_could_not_open demuxer_error_could_not_parse demuxer_error_no_supported_streams
decode decoder decoding demuxer pipeline media video audio error failed failure format unsupported
supported stream network aborted source invalid could not no to open parse initialize
""".split())
SEASON_QUERY = re.compile(r'(.+?)\s+(?:season\s+|s)(\d{1,3})$', re.I)
SEASON_MARKER = re.compile(r'\b(?:season[\s._-]+|s)(\d{1,3})(?!\d)', re.I)
VIDEA_LINK = re.compile(r'https://videa\.hu/videok/(?:[^/\s?#"<>]+/)+[^/\s?#"<>]+-([A-Za-z0-9]{16})')
VIDEA_RESULT = re.compile(r'<h2 class="title">\s*<a href="([^"]+)"[^>]*>([^<]+)</a>\s*</h2>')
VIDEA_PAGE_TITLE = re.compile(r'<meta property="og:title" content="([^"]+)"')
VIDEA_EPISODE = re.compile(r'\b(?:s(\d{1,2})[ ._-]*e(\d{1,3})|(\d{1,2})x(\d{1,3})|'
                           r'(\d{1,2})\.?\s*evad\s+(\d{1,3})\.?\s*resz)\b')
VIDEA_EPISODE_CODE = re.compile(r'\bs(\d{2})e(\d{2,3})\b')
VIDEA_HUNGARIAN_SEASON = re.compile(r'(.+?)\s+(\d{1,2})\.?\s+[ée]vad$', re.I)


def videa_player_url(ident):
    return 'https://videa.hu/player?v=' + ident


def videa_title(title):
    def episode_code(match):
        season, episode = (int(part) for part in match.groups() if part is not None)
        return f's{season:02d}e{episode:02d}'

    title = VIDEA_EPISODE.sub(episode_code, movie_search.plain(title))
    return ' '.join(re.findall(r'[a-z0-9]+', title))


def videa_matches(page, wanted, seed=None, season=None):
    cards = VIDEA_RESULT.findall(page)
    if seed and (title := VIDEA_PAGE_TITLE.search(page)):
        cards.insert(0, (seed, title[1]))
    results = {}
    for link, title in cards:
        link, title = html.unescape(link), html.unescape(title).strip()[:250]
        match = VIDEA_LINK.fullmatch(link)
        normalized = videa_title(title)
        if season is not None:
            episode = VIDEA_EPISODE_CODE.search(normalized)
            if not episode or int(episode[1]) != season:
                continue
        if match and len(link) <= 512 and wanted <= movie_search.words(normalized):
            results.setdefault(match[1], dict(url=link, title=title))
            if len(results) == (MAX_PENDING if season is not None else 5):
                break
    return results


def videa_search_url(query):
    return 'https://videa.hu/kereses/' + urllib.parse.quote(query, safe='', errors='replace')


def videa_download_item(data):
    if not isinstance(data, dict):
        return None
    url, title = data.get('url'), data.get('title')
    match = VIDEA_LINK.fullmatch(url) if isinstance(url, str) and len(url) <= 512 else None
    if match and isinstance(title, str) and 0 < len(title.strip()) <= 250:
        ident = match[1]
        return ident, ' '.join(title.split()), None, videa_player_url(ident)


def videa_season(title, season, results):
    episodes = {}
    for row in results.values():
        episode = int(VIDEA_EPISODE_CODE.search(videa_title(row['title']))[2])
        if episode not in episodes or (row['height'] or 0) > (episodes[episode]['height'] or 0):
            episodes[episode] = row
    rows = [episodes[number] for number in sorted(episodes)]
    heights = [row['height'] or 0 for row in rows]
    return dict(title=title, number=season, height=min(heights), max_height=max(heights), episodes=rows)


def season_pack(title, wanted_words, season):
    if not wanted_words <= movie_search.words(title):
        return False
    markers = list(SEASON_MARKER.finditer(title))
    if len(markers) != 1 or int(markers[0][1]) != season:
        return False
    suffix = title[markers[0].end():]
    return not re.match(r'(?:[\s._-]*(?:e(?:p(?:isode)?)?[\s._-]*\d|x\d)|\s*(?:[-–/&+,]|and\b|to\b)\s*\d)', suffix, re.I)


def service_url(value, schemes=('http', 'https')):
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return ''
    try:
        url = urllib.parse.urlsplit(value)
        if (url.scheme in schemes and url.hostname and url.username is None and url.password is None
                and not url.query and not url.fragment and (url.port is None or 0 < url.port <= 65535)):
            return value.rstrip('/')
    except ValueError:
        pass
    return ''


ICON_BYTES = 64 * 1024
ICON_AGE = 30 * 86400


def icon_type(data):
    if len(data) > ICON_BYTES:
        return None
    if (len(data) >= 45 and data.startswith(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR')
            and all(0 < n <= 512 for n in struct.unpack_from('>II', data, 16))
            and data.endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82')):
        mime, formats = 'image/png', ('PNG',)
    elif len(data) >= 22 and data.startswith(b'\0\0\1\0'):
        count, = struct.unpack_from('<H', data, 4)
        end = 6 + count * 16
        if not 0 < count <= 32 or end > len(data):
            return None
        for pos in range(6, end, 16):
            size, offset = struct.unpack_from('<II', data, pos + 8)
            if offset < end or size < 12 or offset + size > len(data):
                return None
            entry = data[offset:offset + size]
            if entry.startswith(b'\x89PNG'):
                if icon_type(entry) != 'image/png':
                    return None
            elif struct.unpack_from('<I', entry)[0] not in (12, 40, 52, 56, 108, 124):
                return None
        mime, formats = 'image/x-icon', ('ICO',)
    else:
        return None
    if Image is not None:
        try:
            with Image.open(io.BytesIO(data), formats=formats) as raster:
                raster.load()
        except (OSError, ValueError, SyntaxError, IndexError, struct.error, Image.DecompressionBombError):
            return None
    return mime


def fetch_source_icon(base):
    origin = urllib.parse.urlsplit(base)
    port = origin.port or (443 if origin.scheme == 'https' else 80)
    if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username is not None or port not in (80, 443):
        return None
    addresses = [ipaddress.ip_address(info[4][0]) for info in
                 socket.getaddrinfo(origin.hostname, port, type=socket.SOCK_STREAM)]
    # Pin the resolved address so a DNS change or redirect cannot send the request to a private service.
    if not addresses or any(not address.is_global or address.is_multicast or address.is_reserved for address in addresses):
        return None
    connection = http.client.HTTPConnection(str(addresses[0]), port, timeout=4)
    try:
        connection.connect()
        if origin.scheme == 'https':
            connection.sock = ssl.create_default_context().wrap_socket(connection.sock, server_hostname=origin.hostname)
        connection.request('GET', '/favicon.ico', headers={'Host': origin.netloc, 'Accept': 'image/png, image/x-icon'})
        reply = connection.getresponse()
        if reply.status != 200:
            return None
        return reply.read(ICON_BYTES + 1)
    finally:
        connection.close()


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
    uploaded = row.get('uploaded')
    return dict(name=name, progress=progress, size=max(0, int(row['size'])),
                state=label, eta=eta if type(eta) is int and 0 <= eta < 8640000 else None,
                speed=max(0, int(row.get('dlspeed', 0))),
                ratio=torrent_seeding.ratio(row.get('ratio')),
                uploaded=max(0, uploaded) if type(uploaded) is int else 0, goal=torrent_seeding.GOAL,
                seeding_state=torrent_seeding.STATES.get(state, 'Unknown'))


def read_downloads(qb, cfg=None):
    url = service_url(qb.get('url'))
    if not all((url, qb.get('user'), qb.get('password'))):
        return dict(available=False, reason='Server downloads are not set up.')
    try:
        opener = movie_import.torrent_login(url, qb, timeout=2)
        rows = movie_import.torrent_rows(opener, url + '/api/v2/torrents/info?category=' + movie_import.CATEGORY, 2)
        items = [download_item(row) for row in rows]
        tracks = movie_import.pending_tracks(cfg or {}, [row for row, item in zip(rows, items) if item['progress'] == 1])
        for item in items:
            if tracks.get(item['name']):
                item['fetching'] = tracks[item['name']]
        return dict(available=True, items=items)
    except urllib.error.HTTPError as error:
        error.close()
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError, OverflowError):
        pass
    return dict(available=False, reason='The download server is unavailable.')


def register_movies(app, cfg, body, allow, session_is_live, movie_dismissals):
    base = service_url(cfg.get('JELLYFIN_INTERNAL_URL', 'http://127.0.0.1:8096'))
    public = service_url(cfg.get('JELLYFIN_PUBLIC_URL'), ('https',))
    subtitle_imported = None
    issue_media, audio_library = movie_media.register(app, base, body, allow, session_is_live, movie_dismissals,
        cfg.get('JELLYFIN_API_KEY'), lambda path: subtitle_imported(path) if subtitle_imported else False)
    releases = cfg.get('MOVIE_RELEASE_SEARCH') or {}
    prowlarr = service_url(releases.get('url', 'http://127.0.0.1:9696'))
    normal_ids = tuple(dict.fromkeys(i for i in releases.get('indexer_ids', []) if type(i) is int and i > 0))
    indexers = normal_ids[:8]
    slow_ids = releases.get('slow_indexer_ids') or []
    slow_indexers = tuple(dict.fromkeys(i for i in slow_ids if type(i) is int and i > 0 and i not in normal_ids))[:4] if isinstance(slow_ids, list) else ()
    configured_indexers = indexers + slow_indexers
    slow_followups = {}
    requests = cfg.get('MOVIE_REQUESTS') or {}
    downloads = cfg.get('MOVIE_DOWNLOADS') or {}
    qb = downloads.get('qbittorrent') or {}
    youtube = YouTubeDownloads(downloads.get('youtube_dir') or DEFAULT_DIR, app.intake.spawn, app.intake.stop_process)
    seeds = downloads.get('videa_seeds')
    videa_seeds = {videa_title(title): link for title, link in (seeds.items() if isinstance(seeds, dict) else ())
                   if isinstance(link, str) and len(link) <= 512 and VIDEA_LINK.fullmatch(link)}
    grab_refs = {}
    grab_lock, queue_lock = Lock(), Lock()
    queue_cache, queue_expires = None, 0
    seerr = service_url(requests.get('url'))
    seerr_key = requests.get('api_key', '')
    tmdb_token = requests.get('tmdb_read_token')
    poster_key = cfg.get('TMDB_API_KEY')
    posters_enabled = bool(tmdb_token or isinstance(poster_key, str) and poster_key)
    search_cache, search_pending = {}, {}
    search_lock = Lock()
    def request_user():
        if (requests.get('enabled') is not True or not seerr_key or not seerr
                or g.user not in cfg.get('JELLYFIN_PROFILES', {})):
            return None
        profiles = requests.get('profiles', {})
        user = profiles.get(g.user)
        return user if type(user) is int and user > 1 and list(profiles.values()).count(user) == 1 else None

    def release_access():
        return bool(prowlarr and releases.get('api_key') and configured_indexers and g.user in releases.get('profiles', [])
                    and g.user in cfg.get('JELLYFIN_PROFILES', {}))

    def download_access():
        return (g.user in cfg['ADMIN_USERS'] and g.user in downloads.get('profiles', [])
                and g.user in cfg.get('JELLYFIN_PROFILES', {}))

    audio_items = audio_tracks.register(app, cfg, body, allow, download_access, audio_library)
    subtitle_provider = movie_subtitles.register(app, cfg, body, allow, audio_library)
    subtitle_imported = movie_import.start(cfg, service_url(qb.get('url')), base, subtitle_provider)

    def cached_search(key, ttl, fetch):
        with search_lock:
            stored = search_cache.get(key)
            if stored and stored[0] > monotonic():
                return stored[1]
            pending = search_pending.get(key)
            if pending is None:
                pending = search_pending[key] = Future()
                owner = True
            else:
                owner = False
        if not owner:
            return pending.result()
        try:
            value = fetch()
            with search_lock:
                search_cache[key] = (monotonic() + (ttl if value is not None else 15), value)
                while len(search_cache) > 256:
                    del search_cache[next(iter(search_cache))]
            pending.set_result(value)
            return value
        except Exception as error:
            pending.set_exception(error)
            raise
        finally:
            with search_lock:
                del search_pending[key]

    @app.get('/api/movies/downloads')
    def movie_downloads():
        nonlocal queue_cache, queue_expires
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        with queue_lock:
            if monotonic() >= queue_expires:
                queue_cache = read_downloads(qb, cfg)
                queue_expires = monotonic() + 3
            snapshot = queue_cache
        jobs = [*audio_items(g.user), *youtube.items()]
        if jobs:
            snapshot = dict(available=True, items=[*jobs, *snapshot.get('items', [])])
        response = jsonify(snapshot)
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/api/server/seeding')
    def server_seeding():
        if g.user not in cfg['ADMIN_USERS']:
            return jsonify(error='Only an admin can view seeding.'), 403
        result = torrent_seeding.snapshot(cfg)
        if 'poster' in request.args:
            ident = request.args['poster']
            item = next((item for item in result.get('items', ()) if item['hash'] == ident), None)
            if not item or not posters_enabled:
                return jsonify(poster=None)
            title, year = movie_import.release_title(item['name'])
            title = movie_search.clean_query(title)
            if title is None:
                return jsonify(poster=None)
            series = bool(movie_import.SEASON.search(item['name']) or movie_import.EPISODE.search(item['name']))
            matches = cached_search(('torrent-poster', title.casefold()), 3600, lambda: (
                tmdb.parse(tmdb_get('search/multi', params={'query': title, 'include_adult': 'false'}))
                if tmdb_token else tmdb.search(poster_key, title)))
            def words(value):
                return re.findall(r'[^\W_]+', movie_search.plain(value))

            exact = [match for match in matches or () if words(match['title']) == words(title)
                     and (not year or match['year'] == int(year)) and (not series or match['kind'] == 'tv')]
            return jsonify(poster=exact[0]['poster'] if len(exact) == 1 else None)
        if result.get('available'):
            result['posters_enabled'] = posters_enabled
            for item in result['items']:
                title, year = movie_import.release_title(item['name'])
                season = movie_import.SEASON.search(item['name'])
                item['title'] = title or item['name']
                if season:
                    item['subtitle'] = 'Season ' + str(int(re.search(r'\d+', season[0])[0]))
                elif year:
                    item['subtitle'] = year
        response = jsonify(result)
        response.status_code = 200 if result['available'] else 503
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.post('/api/movies/youtube-download')
    def movie_youtube_download():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        data = body()
        ident = movie_search.video_id(data.get('url'))
        title = data.get('title')
        if not ident or not isinstance(title, str) or not 0 < len(title.strip()) <= 250 or title.lstrip().startswith('-'):
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

    @app.post('/api/movies/videa-download')
    def movie_videa_download():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        data = body(limit=32 * 1024)
        season = 'episodes' in data
        title = data.get('title')
        episodes = data.get('episodes') if season else [data]
        if (not isinstance(episodes, list) or not 0 < len(episodes) <= MAX_PENDING
                or not isinstance(title, str) or not 0 < len(title.strip()) <= 250):
            return jsonify(error='Search again and select a Videa release.'), 400
        items = [videa_download_item(episode) for episode in episodes]
        if not all(items) or len({item[0] for item in items}) != len(items):
            return jsonify(error='Search again and select a Videa release.'), 400
        if not allow('movie-download:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before starting another download.'), 429
        tool = shutil.which('yt-dlp')
        if not tool:
            return jsonify(error='Videa downloads are unavailable. Ask the server admin to check yt-dlp.'), 503
        if season:
            queued = youtube.enqueue_many(tool, items, ' '.join(title.split()))
        else:
            ident, name, height, url = items[0]
            queued = youtube.enqueue(tool, ident, name, height, url=url)
        if not queued:
            return jsonify(error='The download queue is full. Try again later.'), 503
        return jsonify(state='sent'), 202

    @app.post('/api/movies/videa-search')
    def movie_videa_search():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        query = movie_search.clean_query(body().get('query'))
        normalized = videa_title(query) if query else ''
        season_query = (SEASON_QUERY.fullmatch(query) or VIDEA_HUNGARIAN_SEASON.fullmatch(query)) if query else None
        season = int(season_query[2]) if season_query else None
        wanted = movie_search.words(season_query[1] if season_query else normalized)
        if not wanted:
            return jsonify(results=[])
        if not allow('movie-videa-search:' + g.user, 12, 60):
            return jsonify(error='Wait a minute before searching Videa again.'), 429
        opener = urllib.request.build_opener(NoRedirect())

        def lookup(url, *, seed=None):
            with opener.open(url, timeout=4) as reply:
                page = reply.read(768 * 1024).decode('utf-8', errors='replace')
            return videa_matches(page, wanted, seed, season)

        try:
            results = lookup(videa_search_url(query))
            episode = VIDEA_EPISODE_CODE.search(normalized)
            if not results and (season_query or episode):
                series = videa_title(season_query[1]) if season_query else normalized[:episode.start()].strip()
                seed = videa_seeds.get(series)
                if seed:
                    results = lookup(seed, seed=seed)
                else:
                    if season_query:
                        alternate = (f'{series} S{season:02d}' if VIDEA_HUNGARIAN_SEASON.fullmatch(query)
                                     else f'{series} {season}. évad')
                    else:
                        alternate = normalized if episode[0] not in query.lower() else (
                            f'{series} {int(episode[1])}. évad {int(episode[2])}. rész {normalized[episode.end():]}').strip()
                    results = lookup(videa_search_url(alternate))
        except (OSError, http.client.HTTPException):
            return jsonify(error='Videa did not respond. Try again.'), 503
        if results:
            details = movie_search.enrich(results, make_url=videa_player_url)
            for ident, row in results.items():
                row['height'] = details.get(ident, {}).get('height')
        reply = dict(results=list(results.values()))
        if season_query and results:
            reply['season'] = videa_season(season_query[1].strip(), season, results)
        return jsonify(reply)

    @app.post('/api/movies/download')
    def movie_download():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        data = body()
        ref, indexer, title = data.get('guid'), data.get('indexer_id'), data.get('title')
        options = (data.get('hungarian_audio', False), data.get('hungarian_subtitles', False))
        if (not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9_-]{24}', ref)
                or type(indexer) is not int or not isinstance(title, str) or not 0 < len(title) <= 250
                or any(type(option) is not bool for option in options)):
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
            forget_options = movie_import.record_options(cfg, entry[4], entry[5], options)
        except (OSError, ValueError, sqlite3.Error):
            return jsonify(error='Could not save download options. Try again.'), 503
        try:
            code, detail = grab([release])
            # Prowlarr's single-grab route on current versions binds a JSON object.
            if code == 400 and any(problem in detail for problem in (b'convert', b'"release"', b"body can't be empty")):
                code, detail = grab(release)
        except (OSError, http.client.HTTPException, ValueError):
            return jsonify(error='Could not confirm the download. Check On the server before trying again.'), 503
        if code and code < 500 and forget_options:
            forget_options()
        if b'download client' in detail and any(word in detail for word in (b'configur', b'no download client')):
            return jsonify(error='Prowlarr has no download client set up for this release.'), 503
        if code == 404 or b'getting release from indexer failed' in detail:
            return jsonify(error='This release is no longer available. Search again.'), 404
        if code:
            return jsonify(error='Prowlarr could not send this release. Try again.'), 503
        return jsonify(state='sent')

    @app.get('/api/movies/source-icon/<int:indexer_id>')
    def movie_source_icon(indexer_id):
        if not release_access() or indexer_id not in configured_indexers:
            return '', 404

        def fetch():
            stored = state_path(cfg, '.movie-source-icons') / f'{indexer_id}.icon'
            try:
                if stored.is_file() and time.time() - stored.stat().st_mtime < ICON_AGE:
                    with stored.open('rb') as stream:
                        data = stream.read(ICON_BYTES + 1)
                    if mime := icon_type(data):
                        return data, mime
                req = urllib.request.Request(f'{prowlarr}/api/v1/indexer/{indexer_id}',
                    headers={'X-Api-Key': releases['api_key'], 'Accept': 'application/json'})
                with urllib.request.build_opener(NoRedirect).open(req, timeout=4) as reply:
                    settings = json.loads(reply.read(65537))
                bases = settings.get('indexerUrls') if isinstance(settings, dict) else None
                base_url = bases[0] if isinstance(bases, list) and bases and isinstance(bases[0], str) else ''
                if not base_url or len(base_url) > 2048:
                    return None
                data = fetch_source_icon(base_url)
                mime = icon_type(data) if data else None
                if not mime:
                    return None
                stored.parent.mkdir(parents=True, exist_ok=True)
                with NamedTemporaryFile(dir=stored.parent, delete=False) as stream:
                    partial = Path(stream.name)
                    try:
                        stream.write(data)
                        stream.close()
                        partial.replace(stored)
                    finally:
                        stream.close()
                        partial.unlink(missing_ok=True)
                return data, mime
            except (OSError, ValueError, http.client.HTTPException):
                return None

        icon = cached_search(('source-icon', indexer_id), 15, fetch)
        if not icon:
            return '', 404
        data, mime = icon
        return Response(data, content_type=mime, headers={'Cache-Control': f'private, max-age={ICON_AGE}',
                        'X-Content-Type-Options': 'nosniff'})

    @app.post('/api/movies/releases')
    def movie_releases():
        if not release_access():
            return jsonify(error='Release search is disabled for this profile.'), 404
        query = movie_search.clean_query(body().get('query'))
        if query is None:
            return jsonify(error='Enter a title of 2 to 120 characters.'), 400
        slow = request.args.get('slow') == '1'
        phase_key = g.user, query.casefold()
        if slow:
            with search_lock:
                permitted = slow_followups.pop(phase_key, 0) > monotonic()
            if not permitted or not slow_indexers:
                return jsonify(error='Search for the title before checking more sources.'), 404
        elif not allow('movie-release-search:' + g.user, 6, 60):
            return jsonify(error='Wait a minute before searching again.'), 429
        phase_indexers = slow_indexers if slow else indexers
        deadline = monotonic() + 30

        season_query = SEASON_QUERY.fullmatch(query)
        title = season_query[1] if season_query else query
        season = int(season_query[2]) if season_query else None
        wanted_words = movie_search.words(title)

        def search_indexer(ids, term):
            timeout = deadline - monotonic() if slow else 4 if season is not None else 8
            if timeout <= 0:
                return None
            params = urllib.parse.urlencode({'query': term, 'type': 'search', 'indexerIds': ids, 'limit': 50}, doseq=True)
            req = urllib.request.Request(prowlarr + '/api/v1/search?' + params,
                headers={'X-Api-Key': releases['api_key'], 'Accept': 'application/json'})
            try:
                with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as reply:
                    rows = json.loads(reply.read(1024 * 1024))
                return [dict(title=cleaned[:250], source=row.get('indexer', '')[:80], size=row.get('size'),
                             seeders=row.get('seeders'), leechers=row.get('leechers'),
                             torrent_hash=movie_import.release_hash(row.get('infoHash'), row.get('magnetUrl')),
                             torrent_title=cleaned[:4096],
                             guid=row.get('guid'), indexerId=row.get('indexerId', ids[0] if len(ids) == 1 else None)) for row in rows
                        if isinstance(row.get('title'), str) and (cleaned := movie_search.plain_title(row['title']))]
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                return None

        def lookup(indexer):
            if season is None:
                return search_indexer((indexer,), query)
            rows = search_indexer((indexer,), f'{title} S{season:02d}')
            if rows is None:
                return None
            matches = [row for row in rows if season_pack(row['title'], wanted_words, season)]
            if matches:
                return matches
            rows = search_indexer((indexer,), title)
            if rows is None:
                return None
            return [row for row in rows if season_pack(row['title'], wanted_words, season)]

        def lookup_hungarian(user):
            metadata = source_details(query, user)
            alias = metadata.get('hungarian_title')
            if not alias or not phase_indexers:
                return metadata, []
            term = alias if season is None else f'{alias} S{season:02d}'
            page = cached_search(('releases', phase_indexers, term), 60, lambda: search_indexer(phase_indexers, term))
            if page is not None and season is not None:
                words = movie_search.words(alias)
                page = [row for row in page if season_pack(row['title'], words, season)]
            return metadata, page

        with ThreadPoolExecutor(max_workers=len(phase_indexers) + 1) as pool:
            alternate = pool.submit(lookup_hungarian, user) if (user := request_user()) is not None else None
            pages = list(pool.map(lookup, phase_indexers))
            metadata, extra = alternate.result() if alternate else ({}, [])
        unavailable = pages.count(None)
        all_failed = bool(phase_indexers) and unavailable == len(phase_indexers) and not extra
        unavailable += extra is None
        rows, seen = [], set()
        for page in [*pages, extra]:
            for stored in page or ():
                guid = stored['guid']
                if isinstance(guid, str) and guid:
                    if guid in seen:
                        continue
                    seen.add(guid)
                rows.append(stored.copy())
        log.info('Release search results=%d unavailable_sources=%d', len(rows), unavailable)
        if all_failed and (slow or not slow_indexers):
            return jsonify(error='The sources did not respond. Try again.'), 503
        with grab_lock:
            now = monotonic()
            for ref in list(grab_refs):
                if grab_refs[ref][3] <= now:
                    del grab_refs[ref]
            for row in rows:
                guid, indexer = row.pop('guid'), row.pop('indexerId')
                torrent_title, torrent_hash = row.pop('torrent_title'), row.pop('torrent_hash')
                if type(indexer) is int and indexer in phase_indexers:
                    row['indexerId'] = indexer
                if isinstance(guid, str) and 0 < len(guid) <= 8192 and 'indexerId' in row:
                    ref = secrets.token_urlsafe(18)
                    grab_refs[ref] = (g.user, indexer, guid, now + 1800, torrent_title, torrent_hash)
                    row.update(guid=ref, indexerId=indexer)
            while len(grab_refs) > 10000:
                del grab_refs[next(iter(grab_refs))]
        reply = dict(results=rows, unavailable=unavailable)
        if metadata:
            reply['title_details'] = metadata
        if not slow and slow_indexers:
            with search_lock:
                slow_followups[phase_key] = monotonic() + 120
                while len(slow_followups) > 256:
                    del slow_followups[next(iter(slow_followups))]
            reply['slow_sources'] = len(slow_indexers)
        return jsonify(reply)

    @app.post('/api/movies/matches')
    def movie_matches():
        key = cfg.get('TMDB_API_KEY')
        query = movie_search.clean_query(body().get('query'))
        season_id = re.fullmatch(r'tmdb:tv:([1-9][0-9]{0,9})', query or '')
        season_title = re.fullmatch(r'tmdb:tv:title:([0-9]{4})?:(.+)', query or '')
        if season_id or season_title:
            if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
                return jsonify(error='Movies are unavailable for this profile.'), 403
            if not allow('movie-seasons:' + g.user, 30, 60):
                return jsonify(error='Wait a minute before opening the season list again.'), 429
            if not isinstance(key, str):
                key = None
            if not key and not tmdb_token:
                return jsonify(error='The full season list is unavailable.'), 503
            ident = int(season_id[1]) if season_id else cached_search(
                ('tmdb-tv-title', season_title[1], season_title[2].casefold()), 3600,
                lambda: catalogue_series_id(key, season_title[1], season_title[2]))
            if ident is None:
                return jsonify(error='Could not match the series in TMDB.'), 503
            seasons = cached_search(('tmdb-tv', ident), 3600, lambda: catalogue_seasons(ident, key))
            if seasons is None:
                return jsonify(error='The full season list is unavailable.'), 503
            return jsonify(seasons=seasons, series_id=ident)
        if not release_access() or not posters_enabled:
            return jsonify(matches=[])
        if query is None:
            return jsonify(error='Enter a title of 2 to 120 characters.'), 400
        if not allow('movie-matches:' + g.user, 20, 60):
            return jsonify(error='Wait a minute before searching again.'), 429
        season_query = SEASON_QUERY.fullmatch(query)
        term = season_query[1] if season_query else query
        def find_matches():
            if isinstance(key, str) and key:
                return tmdb.search_with_runtime(key, term)
            reply = tmdb_get('search/multi', params={'query': term, 'include_adult': 'false', 'language': 'en-US'})
            return tmdb.parse(reply) if reply else None

        found = cached_search(('tmdb', term.casefold()), 3600, find_matches)
        if found is None:
            return jsonify(error='Posters are unavailable right now.'), 503
        return jsonify(matches=found)

    stills = tmdb_stills.StillCache(cfg)

    @app.post('/api/movies/season-episodes')
    def movie_season_episodes():
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are unavailable for this profile.'), 403
        data = body()
        series, season = data.get('series'), data.get('season')
        if set(data) != {'series', 'season'} or stills.file(series, season, 0) is None:
            return jsonify(error='Choose a season from the list.'), 400
        if not allow('movie-stills:' + g.user, 60, 60):
            return jsonify(error='Wait a minute before opening the episodes again.'), 429
        key = cfg.get('TMDB_API_KEY')
        key = key if isinstance(key, str) and key else None
        if not key and not tmdb_token:
            return jsonify(error='Episode pictures are unavailable.'), 503
        detail = cached_search(('tmdb-season', series, season), 3600,
                               lambda: tmdb_get(f'tv/{series}/season/{season}', key) or None)
        rows = detail.get('episodes') if isinstance(detail, dict) else None
        if not isinstance(rows, list):
            return jsonify(error='Episode pictures are unavailable.'), 503
        rows = [row for row in rows[:100] if isinstance(row, dict)
                and type(row.get('episode_number')) is int and 0 <= row['episode_number'] <= 9999]
        deadline = time.monotonic() + 2

        def episode(row):
            number = row['episode_number']
            picture = stills.read(series, season, number)
            if picture is None and time.monotonic() < deadline:
                picture = stills.fetch(series, season, number, row.get('still_path'))
            name = row.get('name')
            overview = row.get('overview')
            runtime = row.get('runtime')
            return dict(number=number, name=name[:200] if isinstance(name, str) else '',
                        overview=overview[:2000] if isinstance(overview, str) else '',
                        runtime=runtime if type(runtime) is int and 0 < runtime < 1000 else None,
                        still=stills.data_url(picture))

        with ThreadPoolExecutor(max_workers=6) as pool:
            episodes = list(pool.map(episode, rows))
        return jsonify(episodes=episodes)

    def seerr_call(path, user, payload=None):
        req = urllib.request.Request(seerr + '/api/v1/' + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={'X-Api-Key': seerr_key, 'X-Api-User': str(user), 'Content-Type': 'application/json'})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=6) as reply:
            return reply.status, json.loads(reply.read(1024 * 1024))

    def lookup_titles(query, user):
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
                original = item.get('originalTitle') if kind == 'movie' else item.get('originalName')
                results.append(dict(kind=kind, id=ident, title=title[:250], year=date[:4] if isinstance(date, str) else '',
                                    status=status, original=original))
            return results
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            log.warning('Seerr title search failed')
            return None

    def seerr_details(path, user):
        try:
            _, result = seerr_call(path, user)
            return result if isinstance(result, dict) else {}
        except (OSError, ValueError):
            return {}

    def tmdb_get(path, api_key=None, params=None):
        if not tmdb_token and not api_key:
            return {}
        try:
            target = 'https://api.themoviedb.org/3/' + path
            headers = {'Accept': 'application/json'}
            if tmdb_token:
                headers['Authorization'] = 'Bearer ' + tmdb_token
            else:
                params = {**(params or {}), 'api_key': api_key}
            if params:
                target += '?' + urllib.parse.urlencode(params)
            req = urllib.request.Request(target, headers=headers)
            with urllib.request.build_opener(NoRedirect).open(req, timeout=4) as reply:
                result = json.loads(reply.read(1024 * 1024))
            return result if isinstance(result, dict) else {}
        except (OSError, ValueError):
            return {}

    @app.get('/api/movies/title-details')
    def movie_title_details():
        if not download_access():
            return jsonify(error='Downloading is not switched on for your profile.'), 403
        kind, ident = request.args.get('kind', ''), request.args.get('tmdb', '')
        if kind not in ('movie', 'tv') or not re.fullmatch(r'[1-9][0-9]{0,9}', ident):
            return jsonify(error='Choose a title from the results.'), 400
        if not allow('movie-title-details:' + g.user, 30, 60):
            return jsonify(error='Wait a minute before opening another title.'), 429
        key = poster_key if isinstance(poster_key, str) else None

        def lookup():
            detail = tmdb_get(f'{kind}/{ident}', key, {
                'append_to_response': 'images,credits', 'include_image_language': 'en,null'
            })
            matches = tmdb.parse({'results': [{**detail, 'media_type': kind}]})
            if not matches:
                return None
            match = matches[0]
            match['poster'] = tmdb.image_url('https://image.tmdb.org/t/p/w500', detail.get('poster_path'))
            match['backdrop'] = tmdb.image_url('https://image.tmdb.org/t/p/w1280', detail.get('backdrop_path'))
            images, credits = detail.get('images'), detail.get('credits')
            logos = images.get('logos') if isinstance(images, dict) else None
            cast = credits.get('cast') if isinstance(credits, dict) else None
            match['logo'] = next((url for logo in logos or [] if isinstance(logo, dict)
                                  and (url := tmdb.image_url('https://image.tmdb.org/t/p/w500', logo.get('file_path')))), None)
            match['cast'] = [
                dict(name=actor['name'][:150], role=str(actor.get('character') or '')[:150],
                     portrait=tmdb.image_url('https://image.tmdb.org/t/p/w185', actor.get('profile_path')))
                for actor in (cast[:12] if isinstance(cast, list) else [])
                if isinstance(actor, dict) and isinstance(actor.get('name'), str)
            ]
            genres = detail.get('genres')
            match['genres'] = [genre['name'][:100] for genre in (genres[:10] if isinstance(genres, list) else [])
                               if isinstance(genre, dict) and isinstance(genre.get('name'), str)]
            overview = detail.get('overview')
            match['overview'] = overview[:2000] if isinstance(overview, str) else ''
            return match

        detail = cached_search(('tmdb-download-detail', kind, ident), 3600, lookup)
        return jsonify(detail) if detail else (jsonify(error='Title details are unavailable.'), 503)

    @app.get('/api/movies/related')
    def movie_related():
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are unavailable for this profile.'), 403
        ident = request.args.get('tmdb', '')
        kind = request.args.get('kind')
        if kind not in ('movie', 'tv') or not re.fullmatch(r'[1-9][0-9]{0,9}', ident):
            return jsonify(error='Choose a film from the library.'), 400
        if not allow('movie-related:' + g.user, 30, 60):
            return jsonify(error='Wait a minute before loading related titles again.'), 429
        key = poster_key if isinstance(poster_key, str) else None
        if not key and not tmdb_token:
            return jsonify(matches=[])

        def related():
            detail = tmdb_get(f'{kind}/{ident}', key, {'append_to_response': 'recommendations'})
            if not detail:
                return None
            collection = detail.get('belongs_to_collection') if kind == 'movie' else None
            collection_id = collection.get('id') if isinstance(collection, dict) else None
            parts = (tmdb_get(f'collection/{collection_id}', key).get('parts')
                     if type(collection_id) is int and 0 < collection_id < 10**10 else [])
            recommendations = detail.get('recommendations')
            recommendations = recommendations.get('results') if isinstance(recommendations, dict) else []
            rows, library_matches = [], {}
            seen = {int(ident)}
            for group in (parts, recommendations):
                for row in group[:100] if isinstance(group, list) else ():
                    if not isinstance(row, dict) or row.get('adult') is True:
                        continue
                    if row.get('media_type', kind) != kind:
                        continue
                    parsed = tmdb.parse({'results': [{**row, 'media_type': kind}]})
                    if not parsed or parsed[0]['id'] <= 0 or parsed[0]['id'] in seen:
                        continue
                    match = parsed[0]
                    release = row if kind == 'movie' else {'release_date': row.get('first_air_date')}
                    if not tmdb.released_film(release, match):
                        library_matches.setdefault(match['id'], {key: match[key] for key in ('id', 'title', 'year')})
                        continue
                    library_matches.pop(match['id'], None)
                    seen.add(match['id'])
                    if len(rows) < 20:
                        match['backdrop'] = tmdb.image_url(tmdb.BACKDROP, row.get('backdrop_path'))
                        rows.append(match)
            return dict(matches=rows, library_matches=list(library_matches.values()))

        matches = cached_search(('tmdb-related', kind, ident), 3600, related)
        if matches is None:
            label = 'films' if kind == 'movie' else 'series'
            return jsonify(error=f'Related {label} are unavailable.'), 503
        return jsonify(matches)

    def catalogue_seasons(ident, key):
        rows = tmdb_get(f'tv/{ident}', key).get('seasons')
        if not isinstance(rows, list):
            return None
        return [{'number': row['season_number'], 'episode_count': row.get('episode_count')}
                for row in rows if isinstance(row, dict) and type(row.get('season_number')) is int
                and 0 < row['season_number'] <= 999 and type(row.get('episode_count')) is int
                and row['episode_count'] >= 0]

    def catalogue_series_id(key, year, title):
        rows = (tmdb.parse(tmdb_get('search/multi', params={
            'query': title, 'include_adult': 'false', 'language': 'en-US'})) if tmdb_token else tmdb.search(key, title))
        exact = [match['id'] for match in rows or []
                 if match['kind'] == 'tv' and movie_search.plain(match['title']) == movie_search.plain(title)
                 and (not year or match['year'] == int(year))]
        return exact[0] if len(exact) == 1 else None

    def title_details(item, season, user):
        path = f"{item['kind']}/{item['id']}"
        localized = seerr_details(path + '?language=hu', user)
        if not localized:
            return None
        kind = item['kind']
        hungarian = movie_search.clean_query(localized.get('title' if kind == 'movie' else 'name'))
        details = dict(runtime_minutes=None, episode_count=None, hungarian_title=hungarian)
        for field, base in (('poster', tmdb.IMAGE), ('backdrop', tmdb.BACKDROP)):
            if art := tmdb.image_url(base, localized.get(field + 'Path')):
                details[field] = art
        positive = lambda value: value if type(value) is int and value > 0 else None
        certifications = localized.get('releases' if kind == 'movie' else 'contentRatings')
        regions = certifications.get('results') if isinstance(certifications, dict) else None
        if isinstance(regions, list):
            for country in ('HU', 'US', 'GB'):
                region = next((entry for entry in regions
                               if isinstance(entry, dict) and entry.get('iso_3166_1') == country), {})
                dates = region.get('release_dates') if kind == 'movie' else [region]
                if not isinstance(dates, list):
                    continue
                field = 'certification' if kind == 'movie' else 'rating'
                rating = next((entry[field].strip() for entry in dates if isinstance(entry, dict)
                               and isinstance(entry.get(field), str) and 0 < len(entry[field].strip()) <= 12), None)
                if rating:
                    details['official_rating'] = rating
                    break
        if kind == 'movie':
            details['runtime_minutes'] = positive(localized.get('runtime'))
            return details

        seasons = {entry['seasonNumber']: positive(entry.get('episodeCount')) for entry in localized.get('seasons') or []
                   if isinstance(entry, dict) and type(entry.get('seasonNumber')) is int}
        count = sum(n for number, n in seasons.items() if number > 0 and n)
        count = count or positive(localized.get('numberOfEpisodes'))
        typical = next((n for n in localized.get('episodeRunTime') or [] if positive(n)), None)
        details.update(series_minutes=count * typical if count and typical else None, series_episode_count=count,
                       series_estimated=bool(count and typical))
        numbered = [n for n in seasons if n > 0]

        def season_runtime(number):
            season_path = path + f'/season/{number}'
            episodes = (tmdb_get(season_path).get('episodes') or seerr_details(season_path, user).get('episodes') or [])
            times = [positive(episode.get('runtime')) for episode in episodes if isinstance(episode, dict)]
            count = max(len(times), seasons.get(number) or 0) or None
            return (sum(times) if times and len(times) == count and all(times) else None), count

        if season is None and len(numbered) == 1:
            season = numbered[0]
        if season is None:
            if tmdb_token and 1 < len(numbered) <= 12:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    totals = list(pool.map(season_runtime, numbered))
                if all(minutes for minutes, _ in totals):
                    count = sum(count for _, count in totals)
                    details.update(series_minutes=sum(minutes for minutes, _ in totals),
                                   series_episode_count=count, series_estimated=False)
            details.update(runtime_minutes=details['series_minutes'], episode_count=count,
                           runtime_estimated=details['series_estimated'])
            return details

        minutes, count = season_runtime(season)
        details.update(runtime_minutes=minutes or (count * typical if count and typical else None),
                       episode_count=count, runtime_estimated=not minutes and bool(count and typical))
        if minutes and details['series_episode_count'] == count:
            details.update(series_minutes=minutes, series_estimated=False)
        return details

    def search_details(query, user):
        results = cached_search(('titles', user, query), 45, lambda: lookup_titles(query, user))
        if not results:
            return results, {}
        parsed = SEASON_QUERY.fullmatch(query)
        title = parsed[1] if parsed else query
        season = int(parsed[2]) if parsed else None
        term = re.sub(r'[\W_]+', ' ', movie_search.plain(title)).strip()

        def matches(name, year):
            if not name:
                return False
            name = re.sub(r'[\W_]+', ' ', movie_search.plain(name)).strip()
            return term == name or bool(year and term == f'{name} {year}')

        item = next((item for item in results if matches(item['title'], item['year']) or matches(item['original'], item['year'])), results[0])
        catalog = cached_search(('details', item['kind'], item['id'], season), 6 * 3600,
                                lambda: title_details(item, season, user)) or {}
        alias = catalog.get('hungarian_title')
        if not any(matches(name, item['year']) for name in (item['title'], item['original'], alias)):
            return results, {}
        metadata = {**catalog, 'title': item['title'], 'year': item['year'], 'kind': item['kind'], 'season': season,
                    'tmdb_id': item['id']}
        if alias and (matches(alias, item['year']) or alias.casefold() == item['title'].casefold()):
            metadata.pop('hungarian_title')
        return results, metadata

    def source_details(query, user):
        return search_details(query, user)[1] if user is not None else {}

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
        results, metadata = search_details(query, user)
        if results is None:
            return jsonify(error='Title search is unavailable. Try again.'), 503
        season = SEASON_QUERY.fullmatch(query)
        return jsonify(results=[{key: value for key, value in item.items() if key != 'original'} for item in results],
                       runtime_minutes=metadata.get('runtime_minutes'), episode_count=metadata.get('episode_count'),
                       title_details=metadata, **({'season': int(season[2])} if season else {}))

    @app.post('/api/movies/request')
    def movie_request():
        user = request_user()
        if user is None:
            return jsonify(error='Movie and TV requests are disabled for this profile.'), 404
        data = body()
        kind, ident, season = data.get('kind'), data.get('id'), data.get('season')
        if (kind not in ('movie', 'tv') or type(ident) is not int or not 0 < ident <= 2**31 - 1
                or season is not None and (kind != 'tv' or type(season) is not int or not 0 <= season <= 999)):
            return jsonify(error='Search again and select a movie or series.'), 400
        if not allow('movie-request:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before requesting another title.'), 429
        payload = {'mediaType': kind, 'mediaId': ident, 'is4k': False}
        if kind == 'tv':
            payload['seasons'] = 'all' if season is None else [season]
        try:
            status, reply = seerr_call('request', user, payload)
            with search_lock:
                for key in [key for key in search_cache if key[:2] == ('titles', user)]:
                    del search_cache[key]
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
        if not base or not public or g.user not in cfg.get('JELLYFIN_PROFILES', {}):
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
        if not isinstance(kind, str) or kind not in REPORT_KINDS or not isinstance(method, str) or method not in REPORT_METHODS:
            return jsonify(error='Unknown report.'), 400
        title, minutes = data.get('title', ''), data.get('minutes')
        if not isinstance(title, str) or len(title) > 200 or (minutes is not None and (type(minutes) is not int or not 0 <= minutes <= 1000)):
            return jsonify(error='Unknown report.'), 400
        feedback.note(movie_event=kind, method=method, title=title, minutes=minutes if minutes is not None else '')
        report_log = log.warning if kind in PROBLEMS else log.info
        diagnostics = data.get('diagnostics')
        if kind in {'playback-error', 'open-failed'} and isinstance(diagnostics, dict):
            def number(key, low, high):
                value = diagnostics.get(key)
                return value if type(value) is int and low <= value <= high else None

            def flag(key):
                value = diagnostics.get(key)
                return value if type(value) is bool else None

            def label(key, allowed):
                value = diagnostics.get(key)
                return value if isinstance(value, str) and value in allowed else '-'

            message = diagnostics.get('mediaMessage')
            words = message[:160].split() if isinstance(message, str) else []
            message = ' '.join(word for word in words if word.lower() in MEDIA_ERROR_WORDS)
            report_log('movie client %s profile=%s method=%s media_code=%s media_message=%r '
                       'hls_type=%s hls_details=%s hls_fatal=%s audio_index=%s hls_loaded=%s http_status=%s forced=%s',
                       kind, g.user, method or '-', number('mediaCode', 1, 4), message,
                       label('hlsType', HLS_ERROR_TYPES), label('hlsDetails', HLS_ERROR_DETAILS), flag('hlsFatal'),
                       number('audioIndex', -1, 65535), flag('hlsLoaded'), number('httpStatus', 100, 599), flag('forced'))
        else:
            report_log('movie client %s profile=%s method=%s', kind, g.user, method or '-')
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
            metadata, extra = {}, []
            user = request_user()
            if user is None:
                found = movie_search.find(query, cfg)
            else:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    primary = pool.submit(movie_search.find, query, cfg)
                    metadata = source_details(query, user)
                    alias = metadata.get('hungarian_title')
                    if alias:
                        season = metadata['season']
                        term = alias if season is None else f'{alias} S{season:02d}'
                        extra = cached_search(('youtube', term), 300,
                                              lambda: movie_search.youtube_candidates(term, single=True))
                    found = primary.result()
            seen = {item['id'] for item in found['results']}
            found['results'].extend(dict(item, label=movie_search.basic_label(item), reason='')
                                    for item in extra if item['id'] not in seen)
            if metadata:
                found['title_details'] = metadata
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
        if (not isinstance(ids, list) or not 0 < len(ids) <= movie_search.MAX_SEARCH_VIDEOS
                or any(not isinstance(ident, str) or not movie_search.VIDEO_ID.fullmatch(ident) for ident in ids)):
            return jsonify(error='Search again to refresh video details.'), 400
        if not allow('movie-youtube-metadata:' + g.user, 8, 60):
            return jsonify(error='Wait a minute before refreshing video details.'), 429
        return jsonify(results=movie_search.enrich(dict.fromkeys(ids)))

    @app.post('/api/movies/session')
    def movie_session():
        accounts = cfg.get('JELLYFIN_PROFILES', {})
        account = accounts.get(g.user)
        if not account:
            log.warning('movie session refused: profile=%s has no Jellyfin account', g.user)
        if not account or not base or not public:
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
                raw = reply.read((1 << 20) + 1)
                if len(raw) > 1 << 20:
                    raise ValueError('Invalid movie session response')
                data = json.loads(raw)
            user = data['User']
            token = data['AccessToken']
            if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', token):
                return jsonify(error='Could not connect this profile to Jellyfin.'), 503
            if user['Policy']['IsAdministrator'] is not False or user['Name'].casefold() != username.casefold():
                logout = urllib.request.Request(base + '/Sessions/Logout', data=b'',
                    headers={'Authorization': auth + ', Token="' + token + '"'})
                with opener.open(logout, timeout=6):
                    pass
                log.warning('movie session refused: profile=%s is linked to an administrator or mismatched account', g.user)
                return jsonify(error='Link a regular Jellyfin account to this profile.'), 403
            log.info('movie session opened: profile=%s device=%s', g.user, device[:8])
            connection = dict(url=public, user=user['Id'])
            ticket = issue_media(g.user, session['sid'], device, user['Id'], auth + ', Token="' + token + '"')
            connection['media_url'] = cfg['PUBLIC_ORIGIN'].rstrip('/') + '/api/movies/media/' + ticket + '/'
            connection['media_ticket'] = ticket
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
