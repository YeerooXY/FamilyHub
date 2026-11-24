"""Import completed FamilyHub torrents into the existing Jellyfin libraries."""
from contextlib import closing
import errno
import http.client
import http.cookiejar
from itertools import combinations
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
from tempfile import NamedTemporaryFile
from threading import Thread
from time import sleep
import urllib.parse
import urllib.request

from .catalog_search import NoRedirect
from .movie_youtube_downloads import FREE_RESERVE
from .resources import lower_background_priority
from .state import state_path


log = logging.getLogger(__name__)
CATEGORY = 'familyhub'
DATABASE = '.movie-imports.sqlite3'
COMPLETE_STATES = {'uploading', 'stalledUP', 'forcedUP', 'queuedUP', 'pausedUP', 'stoppedUP'}
VIDEO = {'.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.m2ts', '.mpg', '.mpeg', '.webm'}
EPISODE = re.compile(r'(?<![a-z0-9])(?:s(\d{1,2})[ ._-]*e(\d{1,3})|(\d{1,2})x(\d{2,3}))(?!\d)', re.I)
SEASON = re.compile(r'(?<![a-z0-9])(?:s\d{1,2}|season[ ._-]*\d{1,2})(?![a-z0-9])', re.I)
YEAR = re.compile(r'(?<![a-z0-9])((?:19|20)\d{2})(?![a-z0-9])', re.I)
QUALITY = re.compile(r'(?<![a-z0-9])(?:2160p|1080[pi]|720p|480p|4k|uhd|blu-?ray|bdrip|brrip|web[ ._-]?(?:dl|rip)|hdtv|dvdrip|remux|x26[45]|hevc|complete)(?![a-z0-9])', re.I)
EXTRAS = {'sample', 'samples', 'trailer', 'trailers', 'extras', 'featurettes'}
TORRENT_ERRORS = (OSError, http.client.HTTPException, ValueError, KeyError, TypeError, OverflowError)


def torrent_login(base, config, timeout):
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request = urllib.request.Request(base + '/api/v2/auth/login', headers={'Referer': base + '/'},
        data=urllib.parse.urlencode({'username': config['user'], 'password': config['password']}).encode())
    with opener.open(request, timeout=timeout) as reply:
        answer = reply.read(64).strip()
        if answer != b'Ok.' and (getattr(reply, 'status', None) != 204 or answer):
            raise ValueError('qBittorrent rejected the login.')
    return opener


def torrent_rows(opener, url, timeout):
    with opener.open(url, timeout=timeout) as reply:
        raw = reply.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('The qBittorrent reply is too large.')
    rows = json.loads(raw)
    if not isinstance(rows, list):
        raise ValueError('qBittorrent returned an invalid list.')
    return rows


def episode_code(name):
    match = EPISODE.search(name)
    return tuple(int(part) for part in match.groups() if part is not None) if match else None


def release_title(name):
    suffix = PurePosixPath(name).suffix
    if suffix.lower() in VIDEO:
        name = name[:-len(suffix)]
    name = re.sub(r'^\s*(?:\[[^\]]+\]\s*)+', '', name)
    cuts = [match.start() for pattern in (EPISODE, SEASON, QUALITY) if (match := pattern.search(name))]
    stem = name[:min(cuts)] if cuts else name
    year = next((match for match in YEAR.finditer(stem) if match.start() > 0 and
                 re.fullmatch(r'[\s._()\[\]-]*', stem[match.end():])), None)
    if year:
        stem = stem[:year.start()]
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f._]+', ' ', stem)
    stem = ' '.join(stem.split()).strip(' -([.')
    stem = stem.encode('utf-8')[:180].decode('utf-8', errors='ignore').rstrip(' .')
    if re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])', stem):
        stem = '_' + stem
    return stem, year[1] if year else None


def safe_parts(value, *, absolute=False):
    if not isinstance(value, str) or '\\' in value or '\x00' in value or ':' in value:
        raise ValueError('Invalid torrent path.')
    path = PurePosixPath(value)
    if path.is_absolute() != absolute or '..' in value.split('/') or not path.parts or path.anchor == '//':
        raise ValueError('Invalid torrent path.')
    return path


def plan(row, files, roots):
    downloads, movies, shows = roots
    save = safe_parts(row['save_path'], absolute=True).relative_to('/data/downloads')
    videos = []
    for file in files:
        name = safe_parts(file['name'])
        if (name.suffix.lower() not in VIDEO or name.stem.casefold() in EXTRAS
                or any(part.casefold() in EXTRAS for part in name.parts[:-1])):
            continue
        if file.get('priority') == 0:
            continue
        size = file['size']
        if type(size) is not int or size <= 0 or file.get('progress') != 1:
            raise ValueError('A selected video is incomplete.')
        if re.search(r'[ ._-](?:sample|trailer)$', name.stem, re.I) and size < 150 * 1024 * 1024:
            continue
        videos.append((name, size))
    if not videos:
        raise ValueError('No video files found.')

    name = row['name']
    if not isinstance(name, str):
        raise ValueError('Invalid torrent name.')
    videos.sort(key=lambda video: (-video[1], video[0].as_posix()))
    primary = videos[0][0].name
    title, year = release_title(name)
    file_title, file_year = release_title(primary)
    title = title or file_title
    year = year or (file_year if file_title.casefold() == title.casefold() else None)
    if not title:
        raise ValueError('No title found.')
    serial = EPISODE.search(name) or SEASON.search(name) or any(episode_code(video.name) for video, _ in videos)
    if not serial:
        title = f'{title} ({year})' if year else title
        video, size = videos[0]
        return [(downloads.joinpath(*save.parts, *video.parts), movies / title / (title + video.suffix.lower()), size, None)]
    episodes = {}
    for video, size in videos:
        code = episode_code(video.name)
        if code is None:
            raise ValueError('An episode filename has no season and episode number.')
        season, number = code
        target = shows / title / f'Season {season:02d}' / f'{title} - S{season:02d}E{number:02d}{video.suffix.lower()}'
        episodes.setdefault(code, (downloads.joinpath(*save.parts, *video.parts), target, size, code))
    return list(episodes.values())


def source_info(source, size):
    try:
        resolved = source.resolve(strict=True)
    except RuntimeError as error:
        raise ValueError('A source path contains a symlink loop.') from error
    if resolved != source:
        raise ValueError('A source path contains a symlink.')
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != size:
        raise ValueError('A source file is missing or its size has changed.')
    return info


def place(source, target, info):
    # Preserve the seeding inode and its permissions. Copy files with other ownership or modes.
    if (os.name == 'nt' or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) ==
            (os.geteuid(), os.getegid(), 0o660)):
        try:
            os.link(source, target, follow_symlinks=os.name == 'nt')
            return
        except OSError as error:
            if error.errno not in {errno.EXDEV, errno.EPERM, errno.EACCES, errno.EMLINK, errno.EOPNOTSUPP}:
                raise
    if shutil.disk_usage(target.parent).free - info.st_size < FREE_RESERVE:
        raise ValueError('Insufficient free space to copy the video.')
    temporary = None
    try:
        with source.open('rb') as origin, NamedTemporaryFile(dir=target.parent, prefix='.familyhub-import-',
                                                             suffix='.part', delete=False) as copy:
            temporary = Path(copy.name)
            remaining = info.st_size
            while remaining:
                chunk = origin.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                copy.write(chunk)
                remaining -= len(chunk)
            if remaining or origin.read(1):
                raise ValueError('The source file size changed while copying.')
            copy.flush()
            if os.name != 'nt':
                if os.fstat(copy.fileno()).st_gid != os.getegid():
                    os.fchown(copy.fileno(), -1, os.getegid())
                os.fchmod(copy.fileno(), 0o660)
            os.fsync(copy.fileno())
        # Publish the complete copy atomically without replacing an existing library file.
        os.link(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def import_plan(entries, dry_run):
    ready = []
    for source, target, size, code in entries:
        info = source_info(source, size)
        folder = target.parent
        try:
            resolved = folder.resolve()
        except RuntimeError as error:
            raise ValueError('A library path contains a symlink loop.') from error
        if resolved != folder or target.is_symlink():
            raise ValueError('A library path contains a symlink.')
        ready.append((source, target, info, code))
    for source, target, info, code in ready:
        folder = target.parent
        if folder.is_dir() and any(path.is_file() and not path.is_symlink() and path.suffix.lower() in VIDEO
                                   and (code is None or episode_code(path.name) == code) for path in folder.iterdir()):
            if dry_run:
                log.info('Movie import already in library: %s', target)
            continue  # Covers earlier manual imports here and recovery after a partial import.
        if dry_run:
            log.info('Movie import plan: %s -> %s', source, target)
            continue
        folder.mkdir(mode=0o770, parents=True, exist_ok=True)
        place(source, target, info)


class MovieImport:
    def __init__(self, path, roots, torrents, files, refresh):
        self.path, self.roots = path, roots
        self.torrents, self.files, self.refresh = torrents, files, refresh

    def poll(self, dry_run=False):
        if self.path.is_symlink():
            raise ValueError('The movie import database path is linked.')
        if dry_run and not self.path.exists():
            connection = sqlite3.connect(':memory:')
        elif dry_run:
            connection = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=2)
        else:
            connection = sqlite3.connect(self.path, timeout=2)
        with closing(connection) as db:
            if not dry_run or not self.path.exists():
                db.execute('CREATE TABLE IF NOT EXISTS imported (hash TEXT PRIMARY KEY, refresh_pending INTEGER NOT NULL)')
            try:
                rows = self.torrents()
            except TORRENT_ERRORS as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                log.warning('Movie import could not read qBittorrent. The next poll will retry.')
                rows = []
            for row in rows:
                ident = row.get('hash') if isinstance(row, dict) else None
                if not isinstance(ident, str) or not re.fullmatch(r'[a-fA-F0-9]{40}|[a-fA-F0-9]{64}', ident):
                    continue
                state = row.get('state')
                if (row.get('category') != CATEGORY or row.get('progress') != 1 or row.get('amount_left') != 0 or
                        not isinstance(state, str) or state not in COMPLETE_STATES):
                    continue
                ident = ident.lower()
                try:
                    with db:
                        if not dry_run:
                            db.execute('BEGIN IMMEDIATE')
                        if db.execute('SELECT 1 FROM imported WHERE hash = ?', (ident,)).fetchone():
                            continue
                        entries = plan(row, self.files(ident), self.roots)
                        import_plan(entries, dry_run)
                        if not dry_run:
                            db.execute('INSERT INTO imported VALUES (?, 1)', (ident,))
                    if not dry_run:
                        log.info('Movie import recorded %s with %d library entries.', ident, len(entries))
                except TORRENT_ERRORS as error:
                    if isinstance(error, urllib.error.HTTPError):
                        error.close()
                    log.warning('Movie import %s will retry: %s', ident, error)
            if not dry_run:
                with db:
                    db.execute('BEGIN IMMEDIATE')
                    if db.execute('SELECT 1 FROM imported WHERE refresh_pending = 1 LIMIT 1').fetchone():
                        self.refresh()
                        db.execute('UPDATE imported SET refresh_pending = 0 WHERE refresh_pending = 1')


def start(config, qb_url, jellyfin_url):
    downloads = config.get('MOVIE_DOWNLOADS') or {}
    settings = downloads.get('import') or {}
    if settings.get('enabled') is not True:
        return
    dry_run = settings.get('dry_run') is True
    qb = downloads.get('qbittorrent') or {}
    key = config.get('JELLYFIN_API_KEY')
    valid_key = isinstance(key, str) and bool(key) and not any(c.isspace() for c in key)
    if not (qb_url and qb.get('user') and qb.get('password') and (dry_run or jellyfin_url and valid_key)):
        log.error('Movie import needs qBittorrent credentials and a Jellyfin URL and API key for live imports.')
        return
    data = Path('/srv/familyhub/data')
    try:
        roots = tuple(Path(settings.get(option, default)).resolve(strict=True)
                      for option, default in [('downloads_dir', data / 'downloads'), ('movies_dir', data / 'media/movies'),
                                              ('shows_dir', data / 'media/tv')])
    except (OSError, RuntimeError, TypeError, ValueError):
        log.error('Movie import could not open the configured media roots.')
        return
    if not all(root.is_dir() for root in roots) or any(left == right or left in right.parents or right in left.parents
                                                       for left, right in combinations(roots, 2)):
        log.error('Movie import needs three separate existing folders for downloads, movies and shows.')
        return
    database = state_path(config, DATABASE).absolute()

    def watch():
        lower_background_priority()
        while True:
            try:
                opener = None

                def read(path):
                    nonlocal opener
                    if opener is None:
                        opener = torrent_login(qb_url, qb, timeout=5)
                    return torrent_rows(opener, qb_url + '/api/v2/torrents/' + path, 5)

                def refresh():
                    request = urllib.request.Request(jellyfin_url + '/Library/Refresh', method='POST', data=b'',
                                                     headers={'X-Emby-Token': key})
                    with urllib.request.build_opener(NoRedirect).open(request, timeout=8):
                        pass

                importer = MovieImport(database, roots,
                    lambda: read('info?category=' + CATEGORY),
                    lambda ident: read('files?hash=' + ident),
                    refresh)
                importer.poll(dry_run)
            except urllib.error.HTTPError as error:
                error.close()
                log.warning('Movie import request failed. The next poll will retry.')
            except TORRENT_ERRORS + (sqlite3.Error,):
                log.exception('Movie import poll failed. The next poll will retry.')
            sleep(120)

    Thread(target=watch, name='movie-import', daemon=True).start()
