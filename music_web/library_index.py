"""Rebuildable index of the shared music catalogue."""

from collections import defaultdict
from contextlib import closing, contextmanager
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from threading import Event, RLock
import unicodedata

from .genres import genre_key


SOURCE_ID = re.compile(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})")
SCHEMA = """
CREATE TABLE catalogue (identity TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, folders TEXT NOT NULL, dependencies TEXT NOT NULL,
                      stamp TEXT NOT NULL);
CREATE TABLE tracks (id TEXT NOT NULL UNIQUE, title TEXT, artist TEXT, album TEXT, genre TEXT,
                     artist_key TEXT, album_key TEXT, genre_key TEXT, duration REAL, added_at TEXT, library_sha256 TEXT,
                     source_kind TEXT, override_flags TEXT, response TEXT NOT NULL);
CREATE INDEX artist_index ON tracks(artist_key, id);
CREATE INDEX album_index ON tracks(album_key, id);
CREATE INDEX genre_index ON tracks(genre_key, id);
CREATE INDEX added_index ON tracks(added_at, id);
CREATE TABLE genre_counts (genre TEXT PRIMARY KEY, total INTEGER NOT NULL);
CREATE TRIGGER genre_insert AFTER INSERT ON tracks BEGIN
    INSERT INTO genre_counts VALUES(new.genre, 1) ON CONFLICT(genre) DO UPDATE SET total=total+1;
END;
CREATE TRIGGER genre_delete AFTER DELETE ON tracks BEGIN
    UPDATE genre_counts SET total=total-1 WHERE genre=old.genre;
    DELETE FROM genre_counts WHERE genre=old.genre AND total=0;
END;
CREATE TRIGGER genre_update AFTER UPDATE OF genre ON tracks WHEN old.genre IS NOT new.genre BEGIN
    UPDATE genre_counts SET total=total-1 WHERE genre=old.genre;
    DELETE FROM genre_counts WHERE genre=old.genre AND total=0;
    INSERT INTO genre_counts VALUES(new.genre, 1) ON CONFLICT(genre) DO UPDATE SET total=total+1;
END;
CREATE VIRTUAL TABLE titles USING fts5(title, artist, album, content='tracks', content_rowid='rowid',
                                    tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
CREATE TRIGGER track_insert AFTER INSERT ON tracks BEGIN
    INSERT INTO titles(rowid, title, artist, album) VALUES(new.rowid, new.title, new.artist, new.album);
END;
CREATE TRIGGER track_delete AFTER DELETE ON tracks BEGIN
    INSERT INTO titles(titles, rowid, title, artist, album)
        VALUES('delete', old.rowid, old.title, old.artist, old.album);
END;
CREATE TRIGGER track_update AFTER UPDATE OF title, artist, album ON tracks
WHEN (old.title, old.artist, old.album) IS NOT (new.title, new.artist, new.album) BEGIN
    INSERT INTO titles(titles, rowid, title, artist, album)
        VALUES('delete', old.rowid, old.title, old.artist, old.album);
    INSERT INTO titles(rowid, title, artist, album) VALUES(new.rowid, new.title, new.artist, new.album);
END;
PRAGMA user_version = 1;
"""

UPSERT_TRACK = """
INSERT INTO tracks(id, title, artist, album, genre, artist_key, album_key, genre_key, duration, added_at,
                   library_sha256, source_kind, override_flags, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
    genre=excluded.genre, artist_key=excluded.artist_key, album_key=excluded.album_key,
    genre_key=excluded.genre_key, duration=excluded.duration,
    added_at=excluded.added_at, library_sha256=excluded.library_sha256,
    source_kind=excluded.source_kind, override_flags=excluded.override_flags, response=excluded.response
"""


def file_stamp(path):
    try:
        st = os.stat(path, follow_symlinks=False)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return [st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def source_id(folder):
    return folder if folder.startswith("local-") else folder[3:14] if folder.startswith("yt-") else None


def library_folders(workspace, item_pattern, proceed=lambda: True):
    sources = defaultdict(list)
    with os.scandir(workspace) as entries:
        for entry in entries:
            if not proceed():
                return None
            identifier = source_id(entry.name)
            if identifier and item_pattern.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False):
                sources[identifier].append(entry.name)
    return sources


def search_words(value):
    value = ''.join(c for c in unicodedata.normalize('NFD', value) if not unicodedata.combining(c))
    return re.findall(r'[^\W_]+', value.lower())


def matches(track, words, artist, album, genre, after, identifier):
    if (after and track['id'] <= after or identifier and track['id'] != identifier
            or artist and track['channel'].casefold() != artist.casefold()
            or album and track['library_album'].casefold() != album.casefold()
            or genre and genre_key(track.get('genre')) != genre):
        return False
    if not words:
        return True
    tokens = search_words(' '.join(track[key] for key in ('title', 'channel', 'library_album')))
    return all(any(token.startswith(word) for token in tokens) for word in words)


class LibraryIndex:
    def __init__(self, path, workspace, item_pattern, identity, dependencies, dependency_stamp, project):
        self.path, self.workspace, self.item_pattern = Path(path), Path(workspace), item_pattern
        self.identity = json.dumps(identity)
        self.dependencies, self.dependency_stamp, self.project = dependencies, dependency_stamp, project
        self.lock = RLock()
        self.wake = Event()
        self.ready = self.initialized = self.reset = False
        self.generation = 0
        try:
            with self.connect() as db:
                self.initialized = self.ready = self.valid(db)
                self.reset = not self.ready
        except FileNotFoundError:
            pass
        except (sqlite3.Error, OSError) as error:
            self.failed(error)

    @contextmanager
    def connect(self):
        for suffix in ('', '-wal', '-shm'):
            if Path(str(self.path) + suffix).is_symlink():
                raise OSError('Library index path is linked')
        if not self.path.is_file():
            raise FileNotFoundError(self.path)
        with closing(sqlite3.connect(self.path.resolve().as_uri() + '?mode=rw', uri=True, timeout=2)) as db:
            with db:
                yield db

    def valid(self, db):
        if db.execute('PRAGMA user_version').fetchone() != (1,):
            return False
        return db.execute('SELECT identity FROM catalogue').fetchone() == (self.identity,)

    def failed(self, error):
        self.ready = self.initialized = False
        code = getattr(error, 'sqlite_errorcode', 0) & 255
        if code in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB, sqlite3.SQLITE_ERROR) or isinstance(error, ValueError):
            self.reset = True
        if not isinstance(error, FileNotFoundError):
            logging.getLogger(__name__).warning('Library index unavailable: %s', type(error).__name__)

    def initialize(self):
        if self.initialized:
            return
        if not self.reset and self.path.is_file():
            with self.connect() as db:
                if self.valid(db):
                    self.initialized = True
                    return
        if self.reset or self.path.is_file():
            for suffix in ('-wal', '-shm', ''):
                Path(str(self.path) + suffix).unlink(missing_ok=True)
        self.path.touch(mode=0o600, exist_ok=False)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript(SCHEMA)
        self.reset = False
        self.initialized = True

    def read(self, sql, values=(), decode=lambda row: row):
        if not self.ready:
            return None
        with self.lock:
            if self.ready:
                try:
                    with self.connect() as db:
                        return [decode(row) for row in db.execute(sql, values)]
                except (sqlite3.Error, OSError, ValueError) as error:
                    self.failed(error)
                    self.wake.set()

    def candidates(self, identifier):
        rows = self.read('SELECT folders FROM sources WHERE id=?', (identifier,), lambda row: json.loads(row[0]))
        if rows is not None:
            return rows[0] if rows else []

    def get(self, identifier):
        rows = self.query(identifier=identifier)
        return rows[0] if rows else None

    def query(self, *, words=(), artist='', album='', genre='', after='', identifier='', limit=None):
        clauses, values = [], []
        for clause, value in (('t.artist_key=?', artist.casefold()), ('t.album_key=?', album.casefold()),
                              ('t.genre_key=?', genre), ('t.id>?', after), ('t.id=?', identifier)):
            if value:
                clauses.append(clause)
                values.append(value)
        filters = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
        decode = lambda row: json.loads(row[0])
        sql = 'SELECT t.response FROM tracks t'
        if words:
            expression = ' AND '.join('"' + word.replace('"', '""') + '"*' for word in words)
            if limit is not None and not identifier:
                # Common prefixes can fill a page from this bounded ID range without sorting all matches.
                window = ('SELECT rowid, id, response FROM tracks t' + filters + ' ORDER BY t.id LIMIT ?')
                leading = self.read(f'SELECT t.response FROM ({window}) t CROSS JOIN titles ON titles.rowid=t.rowid '
                                    'WHERE titles MATCH ? ORDER BY t.id LIMIT ?',
                                    (*values, max(64, 2 * limit), expression, limit), decode)
                if leading is None or len(leading) == limit:
                    return leading
            sql += ' JOIN titles ON titles.rowid=t.rowid'
            filters += (' AND ' if filters else ' WHERE ') + 'titles MATCH ?'
            values.append(expression)
        sql += filters
        sql += ' ORDER BY t.id'
        if limit is not None:
            sql += ' LIMIT ?'
            values.append(limit)
        return self.read(sql, values, decode)

    def genres(self):
        return self.read('SELECT genre, total FROM genre_counts')

    def history_metadata(self, identifiers):
        # Room for every parameter on SQLite builds with the original 999-variable limit.
        ids = sorted(identifiers)
        rows = {}
        for start in range(0, len(ids), 900):
            batch = ids[start:start + 900]
            placeholders = ','.join('?' for _ in batch)
            found = self.read(f'SELECT id, artist, genre FROM tracks WHERE id IN ({placeholders})', batch)
            if found is None:
                return None
            rows.update((identifier, {'channel': artist, 'genre': genre}) for identifier, artist, genre in found)
        return rows

    def manifest_stamps(self, folders):
        return {folder: stamp for folder in sorted(folders)
                if (stamp := file_stamp(self.workspace / folder / 'manifest.json')) is not None}

    def stamp(self, identifier, manifests, dependencies):
        return json.dumps([manifests, self.dependency_stamp(identifier, dependencies)], sort_keys=True)

    def collect(self, identifier, manifests, previous=None, changed=lambda: True):
        folders = list(manifests)
        dependencies = previous[0] if previous else []
        stamp = self.stamp(identifier, manifests, dependencies)
        if (previous and stamp == previous[1]) or (not previous and not folders):
            return None
        if not changed():
            return None
        if not previous or manifests != json.loads(previous[1])[0]:
            dependencies = self.dependencies(folders)
            stamp = self.stamp(identifier, manifests, dependencies)
        result = self.project(identifier, folders) if folders else None
        return identifier, folders, dependencies, stamp, result

    @staticmethod
    def store(db, change):
        identifier, folders, dependencies, stamp, result = change
        if folders:
            db.execute('INSERT OR REPLACE INTO sources VALUES (?, ?, ?, ?)',
                       (identifier, json.dumps(folders), json.dumps(dependencies), stamp))
        else:
            db.execute('DELETE FROM sources WHERE id=?', (identifier,))
        if result is None:
            db.execute('DELETE FROM tracks WHERE id=?', (identifier,))
        else:
            track, added_at, digest, kind, overrides = result
            db.execute(UPSERT_TRACK, (identifier, track['title'], track['channel'], track['library_album'],
                                     track['genre'], track['channel'].casefold(), track['library_album'].casefold(),
                                     genre_key(track['genre']), track['duration'], added_at,
                                     digest, kind, json.dumps(sorted(overrides)), json.dumps(track)))

    def update(self, updates):
        """Write through known changes. Each value lists any newly published folders."""
        with self.lock:
            self.generation += 1
            if not self.ready:
                self.wake.set()
                return
            try:
                with self.connect() as db:
                    for identifier, added in updates.items():
                        saved = db.execute('SELECT folders, dependencies, stamp FROM sources WHERE id=?',
                                           (identifier,)).fetchone()
                        folders = set(json.loads(saved[0]) if saved else ()) | set(added)
                        previous = (json.loads(saved[1]), saved[2]) if saved else None
                        change = self.collect(identifier, self.manifest_stamps(folders), previous)
                        if change is not None:
                            self.store(db, change)
            except (sqlite3.Error, OSError, ValueError) as error:
                self.failed(error)
                self.wake.set()

    def reconcile(self, proceed=lambda: True):
        try:
            with self.lock:
                self.initialize()
                generation = self.generation
            with self.connect() as db:
                old = {key: (json.loads(dependencies), stamp) for key, dependencies, stamp in
                       db.execute('SELECT id, dependencies, stamp FROM sources')}

            def changed():
                with self.lock:
                    if generation != self.generation:
                        return False
                    self.ready = False
                    return True

            sources = library_folders(self.workspace, self.item_pattern, proceed)
            if sources is None:
                return False
            changes = []
            for identifier in sorted(sources.keys() | old.keys()):
                if not proceed():
                    return False
                manifests = self.manifest_stamps(sources.get(identifier, ()))
                change = self.collect(identifier, manifests, old.get(identifier), changed)
                if change is not None:
                    changes.append(change)
            with self.lock:
                if generation != self.generation:
                    return False
                with self.connect() as db:
                    for change in changes:
                        self.store(db, change)
                    if not db.execute('SELECT 1 FROM catalogue').fetchone():
                        db.execute('INSERT INTO catalogue VALUES (?)', (self.identity,))
                self.ready = True
            return True
        except (sqlite3.Error, OSError, ValueError) as error:
            with self.lock:
                self.failed(error)
            return False
