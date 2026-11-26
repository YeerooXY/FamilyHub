"""Import completed FamilyHub torrents into the existing Jellyfin libraries."""
from contextlib import closing
from base64 import b32decode
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
from time import sleep, time
import urllib.parse
import urllib.request

from .catalog_search import NoRedirect
from . import audio_tracks, movie_subtitle_import, movie_subtitles
from .movie_search import plain_title
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
TORRENT_HASH = re.compile(r'[a-f0-9]{40}|[a-f0-9]{64}', re.I)


def release_hash(value, magnet):
    if isinstance(value, str) and TORRENT_HASH.fullmatch(value):
        return value.lower()
    if isinstance(magnet, str) and magnet.startswith('magnet:?') and len(magnet) <= 8192:
        try:
            query = urllib.parse.parse_qsl(urllib.parse.urlsplit(magnet).query, max_num_fields=64)
        except ValueError:
            return ''
        for key, target in query:
            if key != 'xt' or not target.lower().startswith('urn:btih:'):
                continue
            candidate = target[9:]
            if len(candidate) == 40 and TORRENT_HASH.fullmatch(candidate):
                return candidate.lower()
            if re.fullmatch(r'[A-Z2-7]{32}', candidate, re.I):
                return b32decode(candidate.upper()).hex()
    return ''


def job_key(title, ident):
    return ident or ('title:' + plain_title(title).casefold())


def record_options(cfg, title, ident, options):
    settings = (cfg.get('MOVIE_DOWNLOADS') or {}).get('import') or {}
    if settings.get('enabled') is not True or settings.get('dry_run') is True:
        return
    path = state_path(cfg, DATABASE)
    if path.is_symlink():
        raise ValueError('The movie import database path is linked.')
    key, expires = job_key(title, ident), time() + 30 * 86400
    with closing(sqlite3.connect(path, timeout=2)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS download_options (key TEXT PRIMARY KEY, audio INTEGER, subtitles INTEGER, expires INTEGER)')
        db.execute('DELETE FROM download_options WHERE expires <= ?', (time(),))
        db.execute('INSERT OR REPLACE INTO download_options VALUES (?, ?, ?, ?)',
                   (key, *options, expires))

    def forget():
        if path.is_symlink():
            return
        try:
            with closing(sqlite3.connect(path, timeout=2)) as db, db:
                db.execute('DELETE FROM download_options WHERE key = ? AND expires = ?', (key, expires))
        except sqlite3.Error:
            log.warning('Movie import could not clear download options for a rejected release.')

    return forget


def pending_tracks(cfg, rows):
    settings = (cfg.get('MOVIE_DOWNLOADS') or {}).get('import') or {}
    if settings.get('enabled') is not True or settings.get('dry_run') is True or not rows:
        return {}
    path = state_path(cfg, DATABASE)
    if path.is_symlink() or not path.is_file():
        return {}
    try:
        with closing(sqlite3.connect(path.absolute().as_uri() + '?mode=ro', uri=True, timeout=0.1)) as db:
            options = {key: (audio, subtitles) for key, audio, subtitles in
                       db.execute('SELECT key, audio, subtitles FROM download_options WHERE expires > ?', (time(),))}
        return {row['name']: [label for flag, label in zip(
                    options.get(job_key(row['name'], str(row.get('hash') or '').lower()),
                                options.get(job_key(row['name'], ''), (False, False))),
                    ('Hungarian audio', 'Hungarian subtitles')) if flag]
                for row in rows}
    except (OSError, sqlite3.Error):
        return {}


def import_path(roots, path):
    if isinstance(path, str) and len(path) <= 4096:
        video = Path(path)
        for root, mounted in zip(roots[1:], (Path('/data/movies'), Path('/data/tv'))):
            if video.is_relative_to(mounted):
                return str(root / video.relative_to(mounted))
            if video.is_relative_to(root):
                return str(video)
    return None


def subtitle_managed(database, roots, path):
    path = import_path(roots, path)
    if not path or database.is_symlink() or not database.is_file():
        return False
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=.1)) as db:
            return db.execute('SELECT 1 FROM subtitle_imports WHERE path = ? AND language = ?', (path, '')).fetchone() is not None
    except sqlite3.Error:
        return False


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
    show = shows / title
    if not show.is_dir():
        pattern = re.compile(re.escape(title) + r' \((\d{4})\)', re.I)
        matches = [folder for folder in shows.iterdir() if folder.is_dir()
                   and (match := pattern.fullmatch(folder.name)) and (not year or match[1] == year)]
        if len(matches) > 1:
            raise ValueError('Multiple library folders match the series.')
        if matches:
            show = matches[0]
    episodes = {}
    for video, size in videos:
        code = episode_code(video.name)
        if code is None:
            raise ValueError('An episode filename has no season and episode number.')
        season, number = code
        target = show / f'Season {season:02d}' / f'{show.name} - S{season:02d}E{number:02d}{video.suffix.lower()}'
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


def import_plan(entries, dry_run, known=(), remember=None):
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
    imported = []
    for source, target, info, code in ready:
        folder = target.parent
        if folder.is_dir() and any(path.is_file() and not path.is_symlink() and path.suffix.lower() in VIDEO
                                   and (code is None or episode_code(path.name) == code) for path in folder.iterdir()):
            if dry_run:
                log.info('Movie import already in library: %s', target)
            elif target.is_file() and (str(target) in known or source.samefile(target)):
                if remember:
                    remember(target)
                imported.append((source, target, code))
            continue  # Covers earlier manual imports here and recovery after a partial import.
        if dry_run:
            log.info('Movie import plan: %s -> %s', source, target)
            continue
        folder.mkdir(mode=0o770, parents=True, exist_ok=True)
        place(source, target, info)
        if remember:
            remember(target)
        imported.append((source, target, code))
    return imported


def release_files(row, files, root):
    save = safe_parts(row['save_path'], absolute=True).relative_to('/data/downloads')
    return {root.joinpath(*save.parts, *safe_parts(file['name']).parts):
            file.get('progress') == 1 and file.get('priority') != 0 for file in files}


def related_files(source, code, listed, release_folder):
    words = movie_subtitle_import.words
    stem = words(source.stem)
    title, year = release_title(source.name)
    title = words(title)
    labels = set().union(*movie_subtitle_import.LANGUAGES.values(), movie_subtitle_import.VARIANTS)
    single = not code and sum(complete and path.suffix.lower() in VIDEO
                              and not any(part.casefold() in EXTRAS for part in path.parts)
                              for path, complete in listed.items()) == 1

    def matches(path, listed_file):
        if path == source or any(part.casefold() in EXTRAS for part in path.parts):
            return False
        if code:
            return next((number for part in (path.stem, *reversed(path.parent.parts))
                         if (number := episode_code(part)) is not None), None) == code
        if episode_code(path.stem):
            return False
        name = words(path.stem)
        if name[:len(stem)] == stem:
            return True
        if title and name[:len(title)] == title:
            rest = name[len(title):]
            if rest and YEAR.fullmatch(rest[0]):
                return year is None or rest[0] == year
            return bool(rest and (movie_subtitle_import.language(rest) or path.suffix.lower() in VIDEO))
        if not listed_file and (release_folder is None or not path.is_relative_to(release_folder)):
            return False
        if single and path.suffix.lower() in movie_subtitle_import.FORMATS_SUBTITLE:
            return True
        return all(token.isdecimal() or token in labels for token in name)

    paths = {path for path, complete in listed.items() if complete and matches(path, True)}
    folders = [(source.parent, 0)]
    if release_folder is not None and release_folder != source.parent:
        folders.append((release_folder, 0))
    remaining = 512
    while folders and remaining:
        folder, depth = folders.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    remaining -= 1
                    if not remaining:
                        break
                    path = Path(entry.path)
                    if (depth < 3 and (depth or entry.name.casefold() in {'subs', 'subtitles'})
                            and entry.is_dir(follow_symlinks=False)):
                        folders.append((path, depth + 1))
                    elif (path not in listed and path.suffix.lower() in movie_subtitle_import.FORMATS_SUBTITLE
                          and entry.is_file(follow_symlinks=False) and matches(path, False)):
                        paths.add(path)
        except OSError:
            continue
    return paths


def import_hungarian_audio(video, source, files, ffmpeg, ffprobe):
    if not ffmpeg or not ffprobe or video.suffix.lower() not in audio_tracks.FORMATS:
        return

    def hungarian(stream):
        return movie_subtitle_import.language(movie_subtitle_import.words(stream['language'])) == 'hu'

    def named_hungarian(path):
        return movie_subtitle_import.subtitle_label(path, source)[0] == 'hu'

    if os.path.lexists(video.with_suffix('.hu.mka')):
        return
    with audio_tracks.opened(video) as fd:
        video_stamp = audio_tracks.fingerprint(os.fstat(fd))
    target = audio_tracks.probe_audio(ffprobe, video, video_stamp)
    if any(hungarian(stream) for stream in target):
        return
    target_index = audio_tracks.english(target)
    if target_index is None and len(target) == 1 and target[0]['language'] == 'und':
        target_index = target[0]['index']
    if target_index is None:
        return
    candidates = (path for path in sorted(files) if path.suffix.lower() in audio_tracks.FORMATS
                  and (named_hungarian(path) or
                       path.suffix.lower() in VIDEO and release_title(path.name)[0] == release_title(source.name)[0]))
    for path in candidates:
        try:
            with audio_tracks.opened(path) as fd:
                stamp = audio_tracks.fingerprint(os.fstat(fd))
            if stamp[:2] == video_stamp[:2]:
                continue
            streams = audio_tracks.probe_audio(ffprobe, path, stamp)
        except movie_subtitle_import.MEDIA_ERRORS:
            continue
        track = next((stream for stream in streams if hungarian(stream)), None)
        if (not track and len(streams) == 1 and streams[0]['language'] == 'und'
                and named_hungarian(path)):
            track = streams[0]
        if not track or max(track['duration'] or 0, *(stream['duration'] or 0 for stream in target)) > audio_tracks.MAX_SECONDS:
            continue
        report = audio_tracks.match_track(ffmpeg, video, path, target_index, audio_tracks.english(streams),
                                          track['index'], stamp, video_stamp)
        audio_tracks.write_sidecar(ffmpeg, ffprobe, path, video, track, 'hu', 'Hungarian', report, stamp, video_stamp)
        return


class MovieImport:
    def __init__(self, path, roots, torrents, files, refresh, subtitles=None, ffmpeg=None, ffprobe=None):
        self.path, self.roots = path, roots
        self.torrents, self.files, self.refresh = torrents, files, refresh
        self.subtitles, self.ffmpeg, self.ffprobe = subtitles, ffmpeg, ffprobe

    def import_tracks(self, db, row, files, entries, options, ident):
        if not hasattr(os, 'O_PATH') or not hasattr(os, 'O_NOFOLLOW'):
            return
        listed = release_files(row, files, self.roots[0])
        save = safe_parts(row['save_path'], absolute=True).relative_to('/data/downloads')
        save = self.roots[0].joinpath(*save.parts)
        title, year = release_title(row['name'])
        audio, hungarian = options or (False, False)
        for source, video, episode in entries:
            relative = source.relative_to(save)
            release_folder = save / relative.parts[0] if len(relative.parts) > 1 else None
            paths = related_files(source, episode, listed, release_folder)

            def mark_tried(code):
                with db:
                    return db.execute('INSERT OR IGNORE INTO subtitle_imports VALUES (?, ?, ?)',
                                      (str(video), code, ident)).rowcount == 1

            def fallback(language):
                return movie_subtitles.fetch_for_import(*self.subtitles, mark_tried, title, year,
                                                        episode, source, language) if self.subtitles else None

            try:
                movie_subtitle_import.import_subtitles(video, source, paths, ['en', 'hu'] if hungarian else ['en'],
                                                       fallback, self.ffmpeg, self.ffprobe)
            except movie_subtitle_import.MEDIA_ERRORS + (movie_subtitles.SubtitleError,):
                log.warning('Movie import could not save a subtitle sidecar.')
            if audio:
                try:
                    import_hungarian_audio(video, source, paths, self.ffmpeg, self.ffprobe)
                except movie_subtitle_import.MEDIA_ERRORS:
                    log.warning('Movie import could not add the Hungarian audio track.')

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
            if not dry_run:
                db.execute('CREATE TABLE IF NOT EXISTS download_options (key TEXT PRIMARY KEY, audio INTEGER, subtitles INTEGER, expires INTEGER)')
                db.execute('CREATE TABLE IF NOT EXISTS subtitle_imports (path TEXT, language TEXT, torrent TEXT, '
                           'PRIMARY KEY (path, language))')
            try:
                rows = self.torrents()
            except TORRENT_ERRORS as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                log.warning('Movie import could not read qBittorrent. The next poll will retry.')
                rows = []
            for row in rows:
                ident = row.get('hash') if isinstance(row, dict) else None
                if not isinstance(ident, str) or not TORRENT_HASH.fullmatch(ident):
                    continue
                state = row.get('state')
                if (row.get('category') != CATEGORY or row.get('progress') != 1 or row.get('amount_left') != 0 or
                        not isinstance(state, str) or state not in COMPLETE_STATES):
                    continue
                ident = ident.lower()
                try:
                    if db.execute('SELECT 1 FROM imported WHERE hash = ?', (ident,)).fetchone():
                        continue
                    files = self.files(ident)
                    entries = plan(row, files, self.roots)
                    if dry_run:
                        import_plan(entries, True)
                        continue
                    keys = (ident, job_key(row['name'], ''))
                    known = {str(video) for _, video, _, _ in entries if db.execute(
                        'SELECT 1 FROM subtitle_imports WHERE path = ? AND language = ? AND torrent = ?',
                        (str(video), '', ident)).fetchone()}

                    def remember(video):
                        with db:
                            db.execute('INSERT OR IGNORE INTO subtitle_imports VALUES (?, ?, ?)', (str(video), '', ident))

                    placed = import_plan(entries, False, known, remember)
                    options = db.execute('SELECT key, expires, audio, subtitles FROM download_options '
                                         'WHERE key IN (?, ?) AND expires > ? ORDER BY key = ? DESC LIMIT 1',
                                         (*keys, time(), ident)).fetchone()
                    self.import_tracks(db, row, files, placed, options[2:] if options else None, ident)
                    with db:
                        db.execute('INSERT OR IGNORE INTO imported VALUES (?, ?)', (ident, int(self.refresh is not None)))
                        if options:
                            db.execute('DELETE FROM download_options WHERE key = ? AND expires = ?', options[:2])
                    log.info('Movie import recorded %s with %d library entries.', ident, len(entries))
                except TORRENT_ERRORS as error:
                    if isinstance(error, urllib.error.HTTPError):
                        error.close()
                    log.warning('Movie import %s will retry: %s', ident, error)
            if not dry_run and self.refresh is not None:
                pending = db.execute('SELECT hash FROM imported WHERE refresh_pending = 1').fetchall()
                if pending:
                    self.refresh()
                    with db:
                        db.executemany('UPDATE imported SET refresh_pending = 0 WHERE hash = ?', pending)


def start(config, qb_url, jellyfin_url, subtitles=None):
    downloads = config.get('MOVIE_DOWNLOADS') or {}
    settings = downloads.get('import') or {}
    if settings.get('enabled') is not True:
        return
    dry_run = settings.get('dry_run') is True
    qb = downloads.get('qbittorrent') or {}
    key = config.get('JELLYFIN_API_KEY')
    valid_key = isinstance(key, str) and bool(key) and not any(c.isspace() for c in key)
    if not (qb_url and qb.get('user') and qb.get('password') and (dry_run or jellyfin_url)):
        log.error('Movie import needs qBittorrent credentials and a Jellyfin URL for live imports.')
        return
    if not dry_run and key and not valid_key:
        log.error('Movie import has an invalid Jellyfin refresh key.')
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
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not dry_run and not valid_key:
        log.info('Movie import uses Jellyfin real-time monitoring for library updates.')

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
                                                     headers={'Authorization': 'MediaBrowser Token="' + key + '"'})
                    with urllib.request.build_opener(NoRedirect).open(request, timeout=8):
                        pass

                importer = MovieImport(database, roots,
                    lambda: read('info?category=' + CATEGORY),
                    lambda ident: read('files?hash=' + ident),
                    refresh if valid_key else None, subtitles, ffmpeg, ffprobe)
                importer.poll(dry_run)
            except urllib.error.HTTPError as error:
                error.close()
                log.warning('Movie import request failed. The next poll will retry.')
            except TORRENT_ERRORS + (sqlite3.Error,):
                log.exception('Movie import poll failed. The next poll will retry.')
            sleep(120)

    Thread(target=watch, name='movie-import', daemon=True).start()
    return lambda path: subtitle_managed(database, roots, path)
