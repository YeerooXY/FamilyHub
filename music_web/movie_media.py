"""Stream Jellyfin media using an expiring media grant and upstream header authentication."""
import http.client
import json
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


ITEM = r'[0-9a-f-]{32,36}'
MEDIA_PATH = re.compile(
    rf'videos/{ITEM}/(?:stream(?:\.[a-z0-9]{{2,5}})?|[a-z0-9_-]+\.m3u8|'
    rf'(?:[a-z0-9_-]+/)*[a-z0-9_-]+\.(?:mp4|m4s|ts|aac)|{ITEM}/subtitles/[0-9]{{1,4}}/stream\.vtt)', re.I)
TICKET = re.compile(r'[A-Za-z0-9_-]{43}')
QUERY_SECRET = re.compile(r'^(?:api[_-]?key|token|access[_-]?token|x-emby-token|x-mediabrowser-token)$', re.I)
URI_ATTRIBUTE = re.compile(r'\bURI="([^"\r\n]+)"')
WEBVIEW_ORIGINS = {'https://0.0.0.1', 'http://0.0.0.1', 'app://0.0.0.1', 'https://app.localhost', 'null'}
LIBRARY_READ = re.compile(rf'(?:Items(?:/{ITEM})?|UserItems/Resume|Genres|Shows/NextUp|Shows/{ITEM}/Episodes|Items/{ITEM}/RemoteSearch/Subtitles/[a-z]{{3}})')
LIBRARY_WRITE = re.compile(rf'(?:Items/{ITEM}/PlaybackInfo|Sessions/Playing(?:/Progress|/Stopped)?|Items/{ITEM}/RemoteSearch/Subtitles/[A-Za-z0-9._~%+-]{{1,500}})')
FAVORITE = re.compile(rf'UserFavoriteItems/({ITEM})')
LIBRARY_PRIVATE_FIELDS = {'path', 'encoderpath', 'directstreamurl', 'password', 'pw'}
# A two-hour film has thousands of segment lines and each carries Jellyfin's full query string (about 1.4 MB for 4,300 lines).
MAX_PLAYLIST_BYTES = 8 << 20


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


def register(app, base, body, allow, session_is_live, refresh_key=None, subtitle_imported=None):
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

    def audio_library(ticket, *, server_refresh=False):
        grant = live_grant(ticket)
        if not grant or (grant.profile, grant.sid) != (g.user, session.get('sid')):
            abort(404)

        def call(resource, params=None, refresh=False):
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
            with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as upstream:
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
        if not isinstance(resource, str) or not (favorite or rule.fullmatch(resource)) or not isinstance(query, str):
            abort(400)
        if payload is not None and not isinstance(payload, dict):
            abort(400)
        if favorite and (query or not isinstance(payload, dict) or set(payload) != {'favorite'} or type(payload['favorite']) is not bool):
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
            else:
                req = urllib.request.Request(base + '/' + resource + '?' + urllib.parse.urlencode(params), headers=headers,
                                             data=json.dumps(payload).encode() if payload is not None else None)
            with urllib.request.build_opener(NoRedirect).open(req, timeout=8) as upstream:
                raw = upstream.read((4 << 20) + 1)
            if len(raw) > 4 << 20:
                raise ValueError('Movie library response is too large')
            result = json.loads(raw) if raw else None
            if subtitle_imported and re.fullmatch(rf'Items/{ITEM}(?:/PlaybackInfo)?', resource) and isinstance(result, dict):
                for source in result.get('MediaSources') or []:
                    if not isinstance(source, dict) or not subtitle_imported(source.get('Path')):
                        continue
                    source['FamilyHubSubtitleImport'] = True
                    video = source['Path'].rsplit('/', 1)[-1].rsplit('.', 1)[0]
                    sidecars = {video + '.en.srt', video + '.hu.srt'}
                    for track in source.get('MediaStreams') or []:
                        path = track.get('Path') if isinstance(track, dict) else None
                        if (isinstance(path, str) and track.get('IsExternal') and track.get('Type') == 'Subtitle'
                                and path.rsplit('/', 1)[-1] in sidecars):
                            track['FamilyHubSubtitleSidecar'] = True
            return jsonify(result=library_json(result, base_path))
        except (OSError, ValueError, RecursionError):
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
