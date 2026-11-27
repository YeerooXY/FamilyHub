"""Fetch an OpenSubtitles SRT and publish it beside a Jellyfin video."""
import base64
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
import json
import logging
import os
from pathlib import Path
import re
import shutil
import stat
import struct
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic, time
import urllib.error
import urllib.parse
import urllib.request

from flask import abort, g, jsonify, request

from .audio_tracks import fingerprint, opened, target_path
from .catalog_search import NoRedirect
from .movie_media import ITEM


API = 'https://api.opensubtitles.com/api/v1'
log = logging.getLogger(__name__)
USER_AGENT = 'FamilyHub v1.5.2'
MAX_FILE = 2 << 20
MAX_JSON = 4 << 20
LANGUAGES = {'en': {'en', 'eng', 'english'}, 'hu': {'hu', 'hun', 'hungarian', 'magyar'}}
NO_RESULTS = 'No subtitles found for this title and language. Try another language.'
UNREACHABLE = 'The subtitle provider is unreachable. Try again later.'
SIGN_IN = 'The subtitle provider could not sign in. Ask an admin to check the OpenSubtitles account settings.'
RATE_LIMIT = 'Too many subtitle requests. Wait a moment and try again.'
LIBRARY_UNAVAILABLE = 'The movie library is unavailable. Try again later.'
TIMESTAMP = r'[0-9]{2}:[0-5][0-9]:[0-5][0-9],[0-9]{3}'
SRT_START = re.compile(rf'[ \t]*[0-9]+[ \t]*\n[ \t]*({TIMESTAMP})[ \t]+-->[ \t]+({TIMESTAMP})[^\n]*\n[ \t]*\S')


class SubtitleError(Exception):
    def __init__(self, message, status, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def provider_id(item):
    ids = item.get('ProviderIds')
    if isinstance(ids, dict):
        ids = {key.lower(): value for key, value in ids.items()}
        for key in ('tmdb', 'imdb'):
            value = str(ids.get(key, '')).removeprefix('tt') if key == 'imdb' else str(ids.get(key, ''))
            if re.fullmatch(r'[0-9]{1,12}', value) and int(value):
                return {key + '_id': int(value)}
    return {}


def moviehash(file):
    chunk = 64 << 10
    size = os.fstat(file.fileno()).st_size
    if size < 2 * chunk:
        return None
    file.seek(0)
    beginning = file.read(chunk)
    file.seek(size - chunk)
    ending = file.read(chunk)
    if len(beginning) != chunk or len(ending) != chunk:
        return None
    total = size + sum(word for (word,) in struct.iter_unpack('<Q', beginning + ending))
    return f'{total & 0xffffffffffffffff:016x}'


def search_parameters(item, library, language, movie_hash=None):
    params = dict(languages=language, type='movie')
    if movie_hash:
        params['moviehash'] = movie_hash
    ids = provider_id(item)
    if item.get('Type') == 'Episode':
        season, episode = item.get('ParentIndexNumber'), item.get('IndexNumber')
        if type(season) is not int or season < 0 or type(episode) is not int or episode < 1:
            raise SubtitleError(NO_RESULTS, 404)
        params.update(type='episode', season_number=season, episode_number=episode)
        series = item.get('SeriesId')
        if not ids and isinstance(series, str) and re.fullmatch(ITEM, series, re.I):
            try:
                parent = library(f'Items/{series}', {'fields': 'ProviderIds'})
            except (OSError, HTTPException, ValueError, RecursionError):
                raise SubtitleError(LIBRARY_UNAVAILABLE, 502) from None
            if isinstance(parent, dict) and parent.get('Type') == 'Series':
                ids = {'parent_' + key: value for key, value in provider_id(parent).items()}
    if not ids and not movie_hash:
        raise SubtitleError(NO_RESULTS, 404)
    return dict(params, **ids)


def release_name(value):
    return ''.join(re.findall(r'[a-z0-9]+', value.lower())) if isinstance(value, str) else ''


def best_file(results, stem, language):
    best = None
    target = release_name(stem)
    for result in results:
        attrs = result.get('attributes') if isinstance(result, dict) else None
        if not isinstance(attrs, dict) or attrs.get('language') != language:
            continue
        files = attrs.get('files')
        if not isinstance(files, list):
            continue
        downloads = attrs.get('download_count')
        release_matches = bool(target and release_name(attrs.get('release')) == target)
        for file in files:
            if not isinstance(file, dict) or type(file.get('file_id')) is not int or file['file_id'] <= 0:
                continue
            name = file.get('file_name')
            if not isinstance(name, str) or not name.lower().endswith('.srt'):
                continue
            filename = release_name(re.sub(r'[._-]' + language + r'$', '', Path(name).stem, flags=re.I))
            score = (attrs.get('moviehash_match') is True, release_matches or bool(target and filename == target),
                     attrs.get('hearing_impaired') is False,
                     downloads if type(downloads) is int else 0, -file['file_id'])
            if best is None or score > best:
                best = score
    return -best[-1] if best is not None else None


def retry_delay(headers):
    value = headers.get('Retry-After') or headers.get('RateLimit-Reset', '')
    if re.fullmatch(r'[0-9]{1,10}', value):
        return max(1, int(value))
    try:
        return max(1, int(parsedate_to_datetime(value).timestamp() - time()) + 1)
    except (TypeError, ValueError, OverflowError):
        return 60


def quota_reset(reply):
    value = reply.get('reset_time_utc')
    if isinstance(value, str) and len(value) <= 40:
        try:
            reset = datetime.fromisoformat(value.replace('Z', '+00:00'))
            reset = reset.replace(tzinfo=timezone.utc) if reset.tzinfo is None else reset.astimezone(timezone.utc)
            return reset.timestamp(), reset.strftime('%Y-%m-%d %H:%M UTC')
        except (ValueError, OverflowError, OSError):
            pass
    value = reply.get('reset_time')
    if isinstance(value, str):
        match = re.fullmatch(r'(?:(\d{1,2}) hours?(?: and )?)?(?:(\d{1,2}) minutes?)?', value, re.ASCII)
        if match and value:
            return time() + 3600 * int(match[1] or 0) + 60 * int(match[2] or 0), value
    return time() + 86400, None


class OpenSubtitles:
    # The route lock serializes use of the shared provider account.
    def __init__(self, cfg, http=None):
        self.key = cfg.get('OPENSUBTITLES_API_KEY')
        self.username = cfg.get('OPENSUBTITLES_USERNAME')
        self.password = cfg.get('OPENSUBTITLES_PASSWORD')
        # The API key alone is enough: a consumer created with "Allow anonymous downloads" (and "Under dev" while testing)
        # downloads without an account sign-in. Account credentials are optional and give the account's own quota.
        self.configured = isinstance(self.key, str) and bool(self.key.strip())
        self.signs_in = all(isinstance(value, str) and value.strip() for value in (self.username, self.password))
        self.http = http if http is not None else urllib.request.build_opener(NoRedirect)
        self.base = API
        self.token = None
        self.token_until = self.rate_until = self.quota_until = 0
        self.reset = None

    def quota_error(self):
        message = 'Daily subtitle limit reached, try again tomorrow.'
        if self.reset:
            message += ' The limit resets ' + ('at ' if self.reset.endswith('UTC') else 'in ') + self.reset + '.'
        return SubtitleError(message, 429)

    def request(self, url, *, api=True, payload=None, token=None, download=False):
        headers = {'User-Agent': USER_AGENT}
        limit = MAX_JSON if api else MAX_FILE
        if api:
            headers.update({'Api-Key': self.key, 'Accept': 'application/json'})
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        try:
            req = urllib.request.Request(url, json.dumps(payload).encode() if payload is not None else None, headers)
            try:
                with self.http.open(req, timeout=4) as response:
                    raw = response.read(limit + 1)
            except urllib.error.HTTPError as error:
                with error:
                    if download and error.code in (406, 429):
                        try:
                            reply = json.loads(error.read(8192))
                        except (ValueError, RecursionError):
                            reply = {}
                        if not isinstance(reply, dict):
                            reply = {}
                        if error.code == 406 or reply.get('remaining') == 0:
                            self.quota_until, self.reset = quota_reset(reply)
                            raise self.quota_error() from None
                    if error.code == 429 or (error.code == 503 and error.headers.get('Retry-After')):
                        delay = retry_delay(error.headers)
                        self.rate_until = monotonic() + delay
                        raise SubtitleError(RATE_LIMIT, 429, delay) from None
                    if api and error.code in (401, 403):
                        if token:
                            self.token = None
                        raise SubtitleError(SIGN_IN, 503) from None
                    raise SubtitleError(UNREACHABLE, 502) from None
            if len(raw) > limit:
                raise ValueError('Response too large')
            if not api:
                return raw
            reply = json.loads(raw)
            if not isinstance(reply, dict):
                raise ValueError('Invalid response')
            return reply
        except (OSError, HTTPException, ValueError, RecursionError):
            raise SubtitleError(UNREACHABLE, 502) from None

    def login(self):
        if self.token and self.token_until > time():
            return
        reply = self.request(API + '/login', payload=dict(username=self.username, password=self.password))
        token = reply.get('token')
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token):
            raise SubtitleError(SIGN_IN, 503)
        # Expiry only controls local caching. OpenSubtitles verifies the token.
        try:
            claims = token.split('.')[1]
            expiry = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4))).get('exp')
        except (AttributeError, ValueError, RecursionError):
            expiry = None
        now = time()
        self.token_until = min(now + 86400, expiry - 30) if type(expiry) in (int, float) else now + 3600
        self.base = 'https://vip-api.opensubtitles.com/api/v1' if reply.get('base_url') == 'vip-api.opensubtitles.com' else API
        self.token = token

    def fetch(self, params, stem):
        if self.quota_until > time():
            raise self.quota_error()
        remaining = self.rate_until - monotonic()
        if remaining > 0:
            raise SubtitleError(RATE_LIMIT, 429, int(remaining) + 1)
        if self.signs_in:
            self.login()
        search = self.request(self.base + '/subtitles?' + urllib.parse.urlencode(params), token=self.token)
        results = search.get('data')
        if not isinstance(results, list):
            raise SubtitleError(UNREACHABLE, 502)
        file_id = best_file(results, stem, params['languages'])
        if file_id is None:
            raise SubtitleError(NO_RESULTS, 404)
        reply = self.request(self.base + '/download', payload={'file_id': file_id, 'sub_format': 'srt'},
                             token=self.token, download=True)
        link = reply.get('link')
        if reply.get('remaining') == 0:
            self.quota_until, self.reset = quota_reset(reply)
            if not link:
                raise self.quota_error()
        # The temporary file URL gets no API credentials and cannot redirect to other hosts.
        try:
            parsed = urllib.parse.urlsplit(link if isinstance(link, str) else '')
            if (parsed.scheme != 'https' or parsed.netloc not in ('www.opensubtitles.com', 'dl.opensubtitles.com',
                                                                 'opensubtitles.com')
                    or not parsed.path.startswith('/download/')):
                raise ValueError('Invalid file URL')
        except ValueError:
            raise SubtitleError(UNREACHABLE, 502) from None
        return subtitle_bytes(self.request(link, api=False), params['languages'])


def subtitle_text(raw, language):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        text = raw.decode('utf-16')
    else:
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('cp1250' if language in {'hu', 'pl', 'cs', 'sk', 'sl', 'hr', 'ro'} else 'cp1252')
    return text.replace('\r\n', '\n').replace('\r', '\n').strip()


def subtitle_bytes(raw, language):
    try:
        text = subtitle_text(raw, language)
        if SRT_START.match(text) and not re.search(r'[\x00-\x08\x0b-\x1f\x7f]', text):
            return (text + '\n').encode('utf-8')
    except UnicodeError:
        pass
    raise SubtitleError('The provider returned an unreadable subtitle. Try another language or try again later.', 502)


def sidecar_exists(folder, name):
    try:
        info = os.stat(name, dir_fd=folder, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode) or not info.st_size:
        raise SubtitleError('A subtitle file already uses this name. Ask an admin to check the library folder.', 409)
    return True


def read_sidecar(folder, name, limit=MAX_FILE):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=folder)
    with open(fd, 'rb') as file:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError('Invalid subtitle file.')
        data = file.read(limit + 1)
        if len(data) > limit or fingerprint(os.fstat(fd)) != fingerprint(info):
            raise ValueError('The subtitle changed while reading.')
        return data, info


def write_sidecar(video, folder, owner, name, data, *, expected=None):
    # Stage in the pinned directory and publish exclusively unless replacing a known file.
    parent = Path(f'/proc/{os.getpid()}/fd/{folder}')
    with TemporaryDirectory(prefix='.subtitle-', dir=parent) as temporary:
        staging = Path(temporary) / name
        with staging.open('xb') as output:
            output.write(data)
            output.flush()
            fd = output.fileno()
            info = os.fstat(fd)
            if (info.st_uid, info.st_gid) != (owner.st_uid, owner.st_gid):
                os.fchown(fd, owner.st_uid, owner.st_gid)
            os.fchmod(fd, 0o660)
            os.fsync(fd)
            if fingerprint(os.stat(video.name, dir_fd=folder, follow_symlinks=False)) != fingerprint(owner):
                raise SubtitleError('The video changed while fetching subtitles. Reopen the title and try again.', 409)
            if expected is not None:
                if fingerprint(os.stat(name, dir_fd=folder, follow_symlinks=False)) != fingerprint(expected):
                    raise SubtitleError('The subtitle changed while syncing. Try again.', 409)
                os.replace(staging, name, dst_dir_fd=folder)
            else:
                os.link(staging, name, dst_dir_fd=folder, follow_symlinks=False)
            os.fsync(folder)
            return os.fstat(fd)


def ensure_sidecar(item, library, provider, language, start_sync):
    from .subtitle_sync import record_timing

    try:
        video = target_path(item)
        name = f'{video.stem}.{language}.srt'
        with opened(video.parent, directory=True) as folder, opened(video) as video_fd:
            owner = os.fstat(video_fd)
            if sidecar_exists(folder, name):
                return True
            try:
                with open(video_fd, 'rb', closefd=False) as file:
                    hashed = moviehash(file)
            except OSError:
                hashed = None
            params = search_parameters(item, library, language, hashed)
            data = provider.fetch(params, video.stem)
            try:
                expected = write_sidecar(video, folder, owner, name, data)
            except FileExistsError:
                if not sidecar_exists(folder, name):
                    raise
                return True
            record_timing(video, folder, owner, name, 'pending')
            start_sync(video, language, owner, expected)
            return False
    except (OSError, ValueError):
        raise SubtitleError('Could not save subtitles beside this video. Ask an admin to check the library file and folder permissions.', 409) from None


def fetch_for_import(provider, lock, mark_tried, title, year, episode, source, language):
    if not provider.configured or not title or not mark_tried(language):
        return None
    params = dict(query=title, languages=language, type='episode' if episode else 'movie')
    if year:
        params['year'] = year
    if episode:
        params.update(season_number=episode[0], episode_number=episode[1])
    try:
        with opened(source) as fd, open(fd, 'rb', closefd=False) as file:
            if hashed := moviehash(file):
                params['moviehash'] = hashed
    except (OSError, ValueError, AttributeError):
        pass
    try:
        with lock:
            return provider.fetch(params, source.stem)
    except SubtitleError:
        return None


def register(app, cfg, body, allow, library_for, http=None):
    from . import movie_subtitle_import, subtitle_sync

    provider = OpenSubtitles(cfg, http)
    automatic = provider if not provider.signs_in else OpenSubtitles({'OPENSUBTITLES_API_KEY': provider.key}, http)
    lock = Lock()
    library_errors = (OSError, HTTPException, ValueError, RecursionError)

    def item_request(ident):
        if not isinstance(ident, str) or not re.fullmatch(ITEM, ident, re.I):
            abort(400)

    def check_language(language):
        if not isinstance(language, str) or language not in LANGUAGES:
            abort(400)

    def library_item(library, ident):
        item = library(f'Items/{ident}', {'fields': 'Path,ProviderIds'})
        if not isinstance(item, dict) or item.get('Type') not in ('Movie', 'Episode'):
            raise SubtitleError(NO_RESULTS, 404)
        return item

    def error_reply(error):
        headers = {'Retry-After': str(error.retry_after)} if error.retry_after else {}
        return jsonify(error=str(error)), error.status, headers

    def start_sync(video, language, owner, expected, *, queue=False):
        name = f'{video.stem}.{language}.srt'

        def work():
            try:
                with opened(video.parent, directory=True) as folder, opened(video) as video_fd:
                    raw, current = read_sidecar(folder, name)
                    if (fingerprint(current) != fingerprint(expected)
                            or fingerprint(os.fstat(video_fd)) != fingerprint(owner)):
                        return False
                    data = subtitle_bytes(raw, language)
                    aligned, method = movie_subtitle_import.time_subtitle(
                        video, folder, language, data, shutil.which('ffmpeg'), shutil.which('ffprobe'))
                    if not method:
                        if queue:
                            subtitle_sync.record_timing(video, folder, owner, name, 'unknown')
                        return False
                    if aligned != data:
                        # Jellyfin opens and converts an indexed external SRT on each request.
                        write_sidecar(video, folder, owner, name, aligned, expected=expected)
                    elif fingerprint(os.stat(name, dir_fd=folder, follow_symlinks=False)) != fingerprint(expected):
                        return False
                    return subtitle_sync.record_timing(video, folder, owner, name, method)
            except movie_subtitle_import.MEDIA_ERRORS + (SubtitleError,):
                log.warning('Could not resync movie subtitles.')
                return False

        return subtitle_sync.start_job(video, name, work, queue=queue)

    @app.post('/api/movies/subtitle')
    def movie_subtitle():
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            abort(403)
        data = body(2048)
        ident, language = data.get('item'), data.get('language', 'en')
        item_request(ident)
        check_language(language)
        library = library_for(data.get('ticket'), server_refresh=True)
        if not allow('movie-subtitle-fetch:' + g.user, 6, 60):
            return jsonify(error=RATE_LIMIT), 429, {'Retry-After': '60'}
        if not provider.configured:
            return jsonify(error='Subtitle provider is not set up'), 503
        if not lock.acquire(blocking=False):
            return jsonify(error='Another subtitle download is in progress. Try again in a moment.'), 409
        try:
            item = library_item(library, ident)
            existing = ensure_sidecar(item, library, provider, language,
                                      lambda *args: start_sync(*args, queue=True))
            try:
                library(f'Items/{ident}/Refresh', {'MetadataRefreshMode': 'FullRefresh'}, refresh=True)
            except library_errors:
                return jsonify(added=True, existing=existing, refresh_pending=True)
            return jsonify(added=True, existing=existing, refresh_pending=False)
        except SubtitleError as error:
            return error_reply(error)
        except library_errors:
            return jsonify(error=LIBRARY_UNAVAILABLE), 502
        finally:
            lock.release()

    @app.route('/api/movies/subtitle/sync', methods=['GET', 'POST'])
    def movie_subtitle_sync():
        if g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            abort(403)
        write = request.method == 'POST'
        data = body(2048) if write else request.args
        ident, language = data.get('item'), data.get('language')
        item_request(ident)
        if write:
            check_language(language)
        library = library_for(data['ticket']) if write and 'ticket' in data else library_for(None, current_grant=True)
        if not allow(('movie-subtitle-sync:' if write else 'movie-subtitle-status:') + g.user, 6 if write else 30, 60):
            return jsonify(error=RATE_LIMIT), 429, {'Retry-After': '60'}
        try:
            item = library_item(library, ident)
            video = target_path(item)
            with opened(video.parent, directory=True) as folder, opened(video) as video_fd:
                if write:
                    name = f'{video.stem}.{language}.srt'
                    if not sidecar_exists(folder, name):
                        return jsonify(error='This subtitle is unavailable. Reopen the title and try again.'), 404
                    expected = os.stat(name, dir_fd=folder, follow_symlinks=False)
                    if not start_sync(video, language, os.fstat(video_fd), expected):
                        return jsonify(error=subtitle_sync.BUSY), 409
                    return jsonify(state='running'), 202
                timing = subtitle_sync.timing_snapshot(video, folder, include_unrecorded=True)
                states = {}
                for code in LANGUAGES:
                    name = f'{video.stem}.{code}.srt'
                    try:
                        if sidecar_exists(folder, name):
                            states[code] = timing[name]
                    except (OSError, SubtitleError):
                        continue
                return jsonify(states), 200, {'Cache-Control': 'no-store'}
        except SubtitleError as error:
            return error_reply(error)
        except library_errors:
            return jsonify(error='Could not check subtitle timing. Try again later.'), 502

    return automatic, lock
