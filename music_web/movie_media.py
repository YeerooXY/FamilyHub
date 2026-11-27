"""Stream Jellyfin media using an expiring media grant and upstream header authentication."""
import http.client
import json
import logging
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from threading import Lock
from dataclasses import dataclass

from flask import Response, abort, g, jsonify, request, session

from .catalog_search import NoRedirect
from . import movie_metadata


ITEM = r'[0-9a-f-]{32,36}'
MEDIA_PATH = re.compile(
    rf'videos/{ITEM}/(?:stream(?:\.[a-z0-9]{{2,5}})?|[a-z0-9_-]+\.m3u8|'
    rf'(?:[a-z0-9_-]+/)*[a-z0-9_-]+\.(?:mp4|m4s|ts|aac)|{ITEM}/subtitles/[0-9]{{1,4}}/stream\.vtt)', re.I)
TICKET = re.compile(r'[A-Za-z0-9_-]{43}')
QUERY_SECRET = re.compile(r'^(?:api[_-]?key|token|access[_-]?token|x-emby-token|x-mediabrowser-token)$', re.I)
URI_ATTRIBUTE = re.compile(r'\bURI="([^"\r\n]+)"')
WEBVIEW_ORIGINS = {'https://0.0.0.1', 'http://0.0.0.1', 'app://0.0.0.1', 'https://app.localhost', 'null'}
LIBRARY_READ = re.compile(rf'(?:Items(?:/{ITEM})?|UserItems/Resume|Genres|Shows/NextUp|Shows/{ITEM}/Episodes|Items/{ITEM}/RemoteSearch/Subtitles/[a-z]{{3}})')
DISMISS_ID = r'(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})'
PLAYBACK_METADATA = re.compile(rf'(MediaSegments|ParentalGuide)/({DISMISS_ID})')
HIDE_RESUME = re.compile(rf'UserItems/({DISMISS_ID})/HideFromResume')
LIBRARY_WRITE = re.compile(rf'(?:{HIDE_RESUME.pattern}|Items/{ITEM}/PlaybackInfo|Sessions/Playing(?:/Progress|/Stopped)?|Items/{ITEM}/RemoteSearch/Subtitles/[A-Za-z0-9._~%+-]{{1,500}})')
FAVORITE = re.compile(rf'UserFavoriteItems/({ITEM})')
LIBRARY_PRIVATE_FIELDS = {'path', 'encoderpath', 'directstreamurl', 'password', 'pw'}
# A two-hour film has thousands of segment lines and each carries Jellyfin's full query string (about 1.4 MB for 4,300 lines).
MAX_PLAYLIST_BYTES = 8 << 20
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Grant:
    expires: float
    profile: str
    sid: str
    device: str
    viewer: str
    authorization: str


def clean_query(query):
    return urllib.parse.urlencode([(key, value) for key, value in urllib.parse.parse_qsl(query, max_num_fields=100)
                                   if not QUERY_SECRET.fullmatch(key)])


def strip_base_path(path, base_path):
    return path[len(base_path):] if base_path and path.startswith(base_path + '/') else path


def playlist_urls(text, resource, ticket, base_path=''):
    def rewrite(value):
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            raise ValueError('Unexpected media URL')
        path = urllib.parse.urljoin('/' + resource, strip_base_path(parsed.path, base_path)).lstrip('/')
        if not MEDIA_PATH.fullmatch(path) or path.split('/')[1].lower() != resource.split('/')[1].lower():
            raise ValueError('Unexpected media path')
        query = clean_query(parsed.query)
        return f'/api/movies/media/{ticket}/{path}' + (f'?{query}' if query else '')

    def line(value):
        if not value or value.startswith('#'):
            return URI_ATTRIBUTE.sub(lambda match: f'URI="{rewrite(match[1])}"', value)
        return rewrite(value)

    return '\n'.join(map(line, text.splitlines())) + '\n'


def library_json(value, base_path):
    if isinstance(value, list):
        return [library_json(item, base_path) for item in value]
    if isinstance(value, dict):
        safe = {}
        for key, item in value.items():
            if QUERY_SECRET.fullmatch(key) or key.lower() in LIBRARY_PRIVATE_FIELDS:
                continue
            if key == 'TranscodingUrl' and isinstance(item, str):
                url = urllib.parse.urlsplit(item)
                path = strip_base_path(url.path, base_path).lstrip('/')
                if url.scheme or url.netloc or not MEDIA_PATH.fullmatch(path):
                    continue
                item = urllib.parse.urlunsplit(('', '', '/' + path, clean_query(url.query), ''))
            safe[key] = library_json(item, base_path)
        return safe
    return value


def mark_dismissed_items(result, hidden, resource, params):
    if not hidden or not isinstance(result, dict):
        return
    resume = hidden.get('resume', {})
    next_up = hidden.get('next_up', {})
    items = result.get('Items')
    is_feed = resource in ('UserItems/Resume', 'Shows/NextUp') or (
        resource == 'Items' and ('filters', 'isresumable') in [(key.lower(), val.lower()) for key, val in params])
    visible = []
    for item in items if isinstance(items, list) else [result]:
        if isinstance(item, dict):
            item_id = item.get('Id')
            user_data = item.get('UserData')
            ticks = (user_data.get('PlaybackPositionTicks') or 0) if isinstance(user_data, dict) else 0
            if isinstance(item_id, str) and resume.get(item_id.lower()) == ticks:
                item['FamilyHubResumeHidden'] = True
                if is_feed:
                    continue
            series = item.get('SeriesId')
            if (resource == 'Shows/NextUp' and isinstance(series, str) and isinstance(item_id, str)
                    and next_up.get(series.lower()) == item_id.lower()):
                continue
        visible.append(item)
    if isinstance(items, list) and len(items) != len(visible):
        result['Items'] = visible
        if isinstance(result.get('TotalRecordCount'), int):
            result['TotalRecordCount'] = max(0, result['TotalRecordCount'] - len(items) + len(visible))


def register(app, base, body, allow, session_is_live, movie_dismissals, refresh_key=None, subtitle_imported=None,
             cached_lookup=None):
    from .audio_tracks import opened, target_path
    from .movie_subtitles import LANGUAGES
    from .subtitle_sync import timing_snapshot

    grants = {}
    lock = Lock()
    base_path = urllib.parse.urlsplit(base).path

    def issue(user, sid, device, viewer, authorization):
        ticket = secrets.token_urlsafe(32)
        now = time.monotonic()
        with lock:
            for key, grant in list(grants.items()):
                if grant.expires <= now or (grant.profile, grant.sid, grant.device) == (user, sid, device):
                    del grants[key]
            if len(grants) >= 128:
                del grants[next(iter(grants))]
            grants[ticket] = Grant(now + 8 * 3600, user, sid, device, viewer, authorization)
        return ticket

    def live_grant(ticket):
        if not isinstance(ticket, str) or not TICKET.fullmatch(ticket):
            return None
        with lock:
            grant = grants.get(ticket)
        if grant and grant.expires > time.monotonic() and session_is_live(grant.sid, grant.profile):
            return grant

    def audio_library(ticket, *, server_refresh=False, current_grant=False):
        owner = g.user, session.get('sid')
        if current_grant:
            with lock:
                ticket = max((key for key, grant in grants.items() if (grant.profile, grant.sid) == owner),
                             key=lambda key: grants[key].expires, default=None)
        grant = live_grant(ticket)
        if not grant or (grant.profile, grant.sid) != owner:
            abort(404)

        def call(resource, params=None, refresh=False, *, timeout=8):
            if live_grant(ticket) is not grant:
                raise PermissionError('Movie session ended')
            query = urllib.parse.urlencode(dict(params or {}, userId=grant.viewer))
            headers = {'Accept': 'application/json'}
            if refresh and server_refresh and isinstance(refresh_key, str) and refresh_key:
                headers['Authorization'] = 'MediaBrowser Token="' + refresh_key + '"'  # Jellyfin 12 no longer reads X-Emby-Token
            else:
                headers['Authorization'] = grant.authorization
            req = urllib.request.Request(base + '/' + resource + '?' + query,
                                         data=b'' if refresh else None, headers=headers)
            with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as upstream:
                raw = upstream.read((4 << 20) + 1)
            if len(raw) > 4 << 20:
                raise ValueError('Movie library response is too large')
            return json.loads(raw) if raw else None

        return call

    @app.post('/api/movies/library')
    def movie_library():
        data = body(32768)
        grant = live_grant(data.get('ticket'))
        if not grant or grant.profile != g.user or grant.sid != session.get('sid'):
            abort(404)
        resource, query, payload = (data.get(key) for key in ('path', 'query', 'payload'))
        rule = LIBRARY_READ if payload is None else LIBRARY_WRITE
        favorite = FAVORITE.fullmatch(resource) if isinstance(resource, str) else None
        hide_resume = HIDE_RESUME.fullmatch(resource) if isinstance(resource, str) else None
        hide_next = resource == 'Shows/NextUp' and payload is not None
        metadata = PLAYBACK_METADATA.fullmatch(resource) if isinstance(resource, str) else None
        if not isinstance(resource, str) or not (metadata or favorite or hide_next or rule.fullmatch(resource)) or not isinstance(query, str):
            abort(400)
        if metadata and (payload is not None or query):
            abort(400)
        if payload is not None and not isinstance(payload, dict):
            abort(400)
        if favorite and (query or not isinstance(payload, dict) or set(payload) != {'favorite'} or type(payload['favorite']) is not bool):
            abort(400)
        if hide_resume and (query != 'hide=true' or set(payload) != {'positionTicks'}
                            or type(payload['positionTicks']) is not int or not 0 <= payload['positionTicks'] <= 2**53 - 1):
            abort(400)
        if hide_next and (query or set(payload) != {'seriesId', 'episodeId'} or
                          any(not isinstance(value, str) or not re.fullmatch(DISMISS_ID, value) for value in payload.values())):
            abort(400)
        if '/RemoteSearch/Subtitles/' in resource:
            subtitle = urllib.parse.unquote(resource.rsplit('/', 1)[1])
            if subtitle in ('.', '..') or any(c in '/\\%' or ord(c) < 32 for c in subtitle):
                abort(400)
            if not allow('movie-subtitles:' + g.user, 12, 60):
                abort(429)
        if not allow('movie-library:' + g.user, 240, 60):
            abort(429)
        headers = {'Authorization': grant.authorization, 'Accept': 'application/json', 'Content-Type': 'application/json'}
        try:
            if metadata:
                kind, item_id = metadata.groups()
                library = audio_library(data['ticket'])
                # Resolve the item as the grant's viewer before querying item-level or external metadata.
                item = library('Items/' + item_id, timeout=2.5)
                if not isinstance(item, dict) or item.get('Type') not in ('Movie', 'Episode'):
                    log.warning('movie metadata unavailable kind=%s cause=missing_item', kind)
                    abort(404)

                def series():
                    series_id = item.get('SeriesId')
                    if item['Type'] == 'Episode' and isinstance(series_id, str) and re.fullmatch(DISMISS_ID, series_id):
                        try:
                            parent = library('Items/' + series_id, timeout=1.5)
                            if isinstance(parent, dict) and parent.get('Type') == 'Series':
                                return parent
                        except (OSError, ValueError, RecursionError) as error:
                            log.warning('movie metadata unavailable kind=%s cause=series_%s', kind, type(error).__name__)
                    return {}

                if kind == 'MediaSegments':
                    return jsonify(result=movie_metadata.media_segments(library, item_id, item, cached_lookup, series))
                rating = item.get('OfficialRating') or series().get('OfficialRating')
                return jsonify(result={'Rating': rating if isinstance(rating, str) and len(rating) <= 32 else None,
                                       'Categories': movie_metadata.parental_guide(item, cached_lookup)})
            if hide_next:
                movie_dismissals(grant.profile, 'next_up', payload['seriesId'], payload['episodeId'])
                return jsonify(result=None)
            params = [('userId', grant.viewer) if key.casefold() == 'userid' else (key, val)
                      for key, val in urllib.parse.parse_qsl(query, max_num_fields=100) if not QUERY_SECRET.fullmatch(key)]
            if payload is None and resource.startswith('Shows/'):
                # RunTimeTicks is returned by default and is not a valid Jellyfin ItemFields value.
                params = [(key, ','.join(field for field in val.split(',') if field.strip().casefold() != 'runtimeticks')
                           if key.casefold() == 'fields' else val) for key, val in params]
                params = [(key, val) for key, val in params if key.casefold() != 'fields' or val]
            if favorite:
                # The grant supplies the viewer. The client supplies only an item ID and the desired state.
                viewer = urllib.parse.quote(grant.viewer, safe='')
                req = urllib.request.Request(f'{base}/Users/{viewer}/FavoriteItems/{favorite[1]}', headers=headers,
                                             method='POST' if payload['favorite'] else 'DELETE')
            elif hide_resume:
                params = [('hide', 'true'), ('userId', grant.viewer)]
                req = urllib.request.Request(base + '/' + resource + '?' + urllib.parse.urlencode(params),
                                             headers=headers, data=b'')
            else:
                req = urllib.request.Request(base + '/' + resource + '?' + urllib.parse.urlencode(params), headers=headers,
                                             data=json.dumps(payload).encode() if payload is not None else None)
            try:
                with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as upstream:
                    raw = upstream.read((4 << 20) + 1)
            except urllib.error.HTTPError as error:
                if not hide_resume or error.code not in (404, 405):
                    raise
                # Stock Jellyfin versions without this action still allow a profile-only dismissal.
                error.close()
                raw = b''
            if len(raw) > 4 << 20:
                raise ValueError('Movie library response is too large')
            result = json.loads(raw) if raw else None
            if hide_resume:
                movie_dismissals(grant.profile, 'resume', hide_resume[1], payload['positionTicks'])
            if payload is None:
                mark_dismissed_items(result, movie_dismissals(grant.profile), resource, params)
            if re.fullmatch(rf'Items/{ITEM}(?:/PlaybackInfo)?', resource) and isinstance(result, dict):
                for source in result.get('MediaSources') or []:
                    if not isinstance(source, dict) or not isinstance(source.get('Path'), str):
                        continue
                    managed = bool(subtitle_imported and subtitle_imported(source['Path']))
                    if managed:
                        source['FamilyHubSubtitleImport'] = True
                    parent, _, filename = source['Path'].rpartition('/')
                    stem = filename.rsplit('.', 1)[0]
                    timing = {f'{stem}.{code}.srt': {'method': 'unknown', 'state': 'idle'} for code in LANGUAGES} if managed else {}
                    try:
                        video = target_path(source)
                        with opened(video.parent, directory=True) as folder:
                            timing = timing_snapshot(video, folder, include_unrecorded=managed)
                    except (OSError, ValueError, AttributeError):
                        pass
                    for track in source.get('MediaStreams') or []:
                        if not isinstance(track, dict) or track.get('Type') != 'Subtitle':
                            continue
                        path = track.get('Path')
                        if isinstance(path, str) and track.get('IsExternal'):
                            track_parent, _, name = path.rpartition('/')
                            if track_parent != parent or name not in timing:
                                continue
                            track['FamilyHubSubtitleSidecar'] = True
                            track['FamilyHubSubtitleTiming'] = timing[name]
                        elif managed and not track.get('IsExternal') and track.get('IsTextSubtitleStream'):
                            language = track.get('Language')
                            if isinstance(language, str) and any(language.lower() in codes for codes in LANGUAGES.values()):
                                track['FamilyHubSubtitleTiming'] = {'method': 'release', 'state': 'idle'}
            return jsonify(result=library_json(result, base_path))
        except (OSError, ValueError, RecursionError) as error:
            if metadata:
                log.warning('movie metadata unavailable kind=%s cause=%s', metadata[1], type(error).__name__)
            abort(502)

    @app.post('/api/movies/media/close')
    def movie_media_close():
        ticket = body().get('ticket')
        grant = live_grant(ticket)
        if grant and grant.profile == g.user and grant.sid == session.get('sid'):
            with lock:
                if grants.pop(ticket, None) is None:
                    return jsonify(closed=True)
            try:
                logout = urllib.request.Request(base + '/Sessions/Logout', b'', {'Authorization': grant.authorization})
                with urllib.request.build_opener(NoRedirect).open(logout, timeout=3):
                    pass
            except (OSError, ValueError):
                pass
        return jsonify(closed=True)

    @app.route('/api/movies/media/<ticket>/<path:resource>', methods=['GET', 'HEAD', 'OPTIONS'])
    def movie_media(ticket, resource):
        if not MEDIA_PATH.fullmatch(resource):
            abort(404)
        grant = live_grant(ticket)
        if not grant:
            abort(404)
        origin = request.headers.get('Origin')
        cors = {'Vary': 'Origin'}
        if origin in WEBVIEW_ORIGINS:
            cors['Access-Control-Allow-Origin'] = origin
            cors['Access-Control-Expose-Headers'] = 'Accept-Ranges, Content-Range, Content-Length'
        if request.method == 'OPTIONS':
            return '', 204, {**cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range'}

        upstream_headers = {'Authorization': grant.authorization, 'Accept-Encoding': 'identity'}
        if request.range is not None:
            upstream_headers['Range'] = request.headers['Range']
        try:
            query = clean_query(request.query_string.decode('ascii'))
            req = urllib.request.Request(base + '/' + resource + ('?' + query if query else ''),
                                         headers=upstream_headers, method=request.method)
            upstream = urllib.request.build_opener(NoRedirect).open(req, timeout=15)
        except urllib.error.HTTPError as error:
            with error:
                return '', error.code if error.code in (404, 416) else 502, cors
        except (OSError, ValueError):
            return '', 502, cors
        response_headers = {**cors, **{name: upstream.headers[name] for name in ('Accept-Ranges', 'Content-Range', 'Content-Length')
                                      if name in upstream.headers}}
        if resource.lower().endswith('.m3u8'):
            with upstream:
                response_headers.pop('Content-Length', None)
                if request.method == 'HEAD':
                    return Response(status=upstream.status, headers=response_headers, mimetype='application/vnd.apple.mpegurl')
                try:
                    raw = upstream.read(MAX_PLAYLIST_BYTES + 1)
                    if len(raw) > MAX_PLAYLIST_BYTES or not raw.startswith(b'#EXTM3U'):
                        raise ValueError('Invalid media playlist')
                    content = playlist_urls(raw.decode('utf-8'), resource, ticket, base_path)
                except (OSError, ValueError):
                    return '', 502, cors
                return Response(content, upstream.status, response_headers, mimetype='application/vnd.apple.mpegurl')
        content_type = upstream.headers.get_content_type()
        if not content_type.startswith(('audio/', 'video/')) and content_type not in ('text/vtt', 'application/octet-stream'):
            upstream.close()
            return '', 502, cors

        def stream():
            with upstream:
                try:
                    while chunk := upstream.read(256 << 10):
                        yield chunk
                except (OSError, http.client.HTTPException):
                    return

        response = Response(stream(), upstream.status, response_headers, mimetype=content_type)
        response.call_on_close(upstream.close)
        return response

    return issue, audio_library
