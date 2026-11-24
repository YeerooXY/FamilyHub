"""Locations, migration and persistence for the server's small state files."""
from collections.abc import Mapping
from concurrent.futures import Future, TimeoutError
from contextlib import closing
from datetime import date
import json
import logging
from pathlib import Path
from queue import Empty, Queue
import shutil
import sqlite3
from tempfile import NamedTemporaryFile, TemporaryDirectory
from threading import Lock, Thread
import time

from .resources import lower_background_priority


log = logging.getLogger(__name__)
STATE_NAMES = (
    '.word-puzzles.sqlite3', '.family-profiles.json', '.playback-state',
    '.listening-statistics.jsonl', '.listening-statistics.json', '.listening-history',
    '.catalogue-review.json', '.feedback.sqlite3', '.feedback-server.log', '.activity.log',
    '.artist-genres.json', '.verified-audio.sqlite3', '.familyhub-files.db', '.discovery',
    '.source-quality.json', '.song-analysis.json', '.replacements.json', '.library-additions.json',
    '.metadata-votes.json', '.deezer-chart.json', '.playlists', '.lyrics', '.listening-versions.json',
    '.movie-audio-jobs.json', '.profile-passwords.json',
    '.server-stats.sqlite3',
)


def state_path(cfg_or_workspace, name):
    if isinstance(cfg_or_workspace, Mapping):
        cfg = cfg_or_workspace
        root = cfg.get('STATE_DIR')
        if not root and name == '.familyhub-files.db':
            root = cfg.get('FILES_ROOT')
        root = root or cfg['WORKSPACE']
    else:
        root = cfg_or_workspace
    return Path(root) / name


def files_database_path(cfg):
    path = state_path(cfg, '.familyhub-files.db')
    if path.is_symlink():
        raise RuntimeError('The files database path is linked.')
    return path


def _state_entries(root):
    for name in STATE_NAMES:
        path = root / name
        if path.exists():
            yield path
        if name.endswith('.log'):
            yield from sorted(root.glob(name + '.*'))


def _copy_verified(source, target):
    if source.is_dir():
        target.mkdir(mode=0o700)
        for path in sorted(source.iterdir()):
            if path.is_symlink() or path.name.endswith(('.tmp', '-wal', '-shm', '-journal', '.moved-to-state')):
                continue
            try:
                _copy_verified(path, target / path.name)
            except FileNotFoundError:
                if path.exists():
                    raise
    elif target.suffix in ('.db', '.sqlite3'):
        with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as db, \
                closing(sqlite3.connect(target)) as snapshot:
            db.backup(snapshot, pages=128)
            if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError(f'SQLite integrity check failed for {source}')
    else:
        with source.open('rb') as original, target.open('wb') as copy:
            size = original.seek(0, 2)
            original.seek(0)
            remaining = size
            while remaining:
                chunk = original.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise OSError(f'Source changed while copying {source}')
                copy.write(chunk)
                remaining -= len(chunk)
        if target.stat().st_size != size:
            raise OSError(f'Copy size mismatch for {source}')
        if target.suffix == '.json':
            json.loads(target.read_bytes())
        elif target.suffix == '.jsonl':
            with target.open('rb') as stream:
                for line in stream:
                    if line.endswith(b'\n'):
                        json.loads(line)


def migrate_state(cfg):
    if not cfg.get('STATE_DIR'):
        return
    root = Path(cfg['STATE_DIR'])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    legacy = dict(cfg, STATE_DIR=None)
    workspace = Path(cfg['WORKSPACE'])
    sources = [state_path(legacy, name) for name in STATE_NAMES]
    for name in ('.activity.log', '.feedback-server.log'):
        sources.extend(sorted({p.with_name(p.name.removesuffix('.moved-to-state'))
                               for p in workspace.glob(name + '.*')
                               if p.name.removesuffix('.moved-to-state') != name}))
    pending_root = root / '.state-migration'
    for source in sources:
        target = state_path(cfg, source.name)
        if source.name == '.familyhub-files.db':
            target = files_database_path(cfg)
            if not target.exists():
                source = files_database_path(legacy)
        if target.exists() or source.resolve() == target.resolve():
            continue
        archived = source.with_name(source.name + '.moved-to-state')
        pending = pending_root / source.name
        if not source.exists() and not pending.exists():
            continue
        if source.exists() and archived.exists():
            raise FileExistsError(archived)
        sidecars = ()
        if source.suffix in ('.db', '.sqlite3'):
            sidecars = tuple((source.with_name(source.name + suffix), archived.with_name(archived.name + suffix))
                             for suffix in ('-wal', '-shm', '-journal'))
        if not pending.exists():
            log.info('Copying state %s to %s', source, target)
            pending_root.mkdir(mode=0o700, exist_ok=True)
            with TemporaryDirectory(prefix='.migrate-', dir=root) as temporary:
                staged = Path(temporary) / source.name
                _copy_verified(source, staged)
                staged.rename(pending)
            log.info('Verified state copy for %s', source)
        if source.exists():
            source.rename(archived)
            log.info('Archived workspace state at %s', archived)
        for old_sidecar, archived_sidecar in sidecars:
            if old_sidecar.exists():
                old_sidecar.rename(archived_sidecar)
        # A verified staged copy survives an interruption. Archives alone are never imported again.
        pending.rename(target)
        log.info('Published state at %s', target)


def backup_state(cfg, day=None):
    root = Path(cfg['STATE_BACKUP_DIR'])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_root = state_path(cfg, '.family-profiles.json').parent
    if root.resolve() == state_root.resolve():
        raise ValueError('STATE_BACKUP_DIR must differ from the state directory')
    destination = root / f'state-{day or date.today()}'
    if not destination.exists():
        with TemporaryDirectory(prefix='.backup-', dir=root) as temporary:
            staged = Path(temporary) / 'state'
            staged.mkdir(mode=0o700)
            sources = list(_state_entries(state_root))
            if not cfg.get('STATE_DIR') and cfg.get('FILES_ROOT'):
                sources = [p for p in sources if p.name != '.familyhub-files.db']
                sources.append(state_path(cfg, '.familyhub-files.db'))
            for source in sources:
                if source.is_symlink() or source.name.endswith('.moved-to-state'):
                    continue
                try:
                    _copy_verified(source, staged / source.name)
                except FileNotFoundError:
                    if source.exists():
                        raise
            staged.rename(destination)
            log.info('Backed up state to %s', destination)
    copies = []
    for path in sorted(root.glob('state-????-??-??')):
        if path.is_dir() and not path.is_symlink():
            try:
                date.fromisoformat(path.name.removeprefix('state-'))
            except ValueError:
                continue
            copies.append(path)
    for old in copies[:-14]:
        shutil.rmtree(old)


def start_backups(cfg):
    def nightly():
        lower_background_priority()
        last_day = None
        while True:
            today = date.today()
            if today != last_day:
                try:
                    backup_state(cfg, today)
                except (OSError, ValueError, sqlite3.Error):
                    log.exception('State backup failed')
                else:
                    last_day = today
            time.sleep(60)

    if cfg.get('STATE_BACKUP_DIR'):
        Thread(target=nightly, name='state-backup', daemon=True).start()


class StateWriter:
    """Commit writes in order and keep retries off the request threads."""

    def __init__(self):
        self.queue = Queue()
        self.lock = Lock()
        self.thread = None
        self.watchers = []
        self.closed = False

    def _start(self):
        if self.thread is None:
            self.thread = Thread(target=self._run, name='state-writer', daemon=True)
            self.thread.start()

    def watch(self, callback):
        with self.lock:
            self.watchers.append(callback)
            self._start()

    def submit(self, name, write):
        done = Future()
        with self.lock:
            if self.closed:
                raise RuntimeError('State writer is closed')
            self.queue.put((name, write, done))
            self._start()
        return done

    def _run(self):
        next_poll = time.monotonic() + 1
        while True:
            try:
                task = self.queue.get(timeout=max(0, next_poll - time.monotonic()))
            except Empty:
                with self.lock:
                    if not self.watchers and self.queue.empty():
                        self.thread = None
                        return
            else:
                if task is None:
                    self.queue.task_done()
                    return
                name, write, done = task
                delay = 0.25
                while True:
                    try:
                        write()
                    except (OSError, sqlite3.Error):
                        log.warning('Could not commit %s. Retrying in %g seconds', name, delay, exc_info=True)
                        time.sleep(delay)
                        delay = min(delay * 2, 30)
                    except Exception as error:
                        log.exception('State write failed for %s', name)
                        done.set_exception(error)
                        break
                    else:
                        done.set_result(None)
                        break
                self.queue.task_done()
            if time.monotonic() >= next_poll:
                for callback in self.watchers:
                    try:
                        callback()
                    except (OSError, ValueError, sqlite3.Error):
                        log.exception('Could not refresh cached state')
                next_poll = time.monotonic() + 1

    def flush(self):
        self.queue.join()

    def close(self):
        with self.lock:
            if not self.closed:
                self.closed = True
                if self.thread is not None:
                    self.queue.put(None)
            thread = self.thread
        if thread is not None and thread.is_alive():
            thread.join()


def wait_for_write(done):
    if done is not None:
        try:
            done.result(timeout=2)
        except TimeoutError:
            log.warning('State write is pending and will complete in the background')


def read_version(path):
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    return info.st_mtime_ns, info.st_size, info.st_ino


def write_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, suffix='.tmp', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream)
            stream.close()
            version = read_version(temporary)
            temporary.replace(path)
            return version
        except BaseException:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise


class CachedJSON:
    def __init__(self, writer):
        self.writer = writer
        self.entries = {}
        self.lock = Lock()

    def read(self, path):
        with self.lock:
            entry = self.entries.get(path)
            if entry is not None and entry[2] is not None:
                return entry[0]  # A queued write is newer than anything on disk.
        # One stat call (inode metadata, kept in the kernel cache) notices a change made by another process at once.
        version = read_version(path)
        with self.lock:
            entry = self.entries.get(path)
            if entry is not None and (entry[2] is not None or entry[1] == version):
                return entry[0]
        value = json.loads(path.read_bytes()) if version else None
        with self.lock:
            entry = self.entries.get(path)
            if entry is not None and entry[2] is not None:
                return entry[0]
            self.entries[path] = (value, version, None)
            return value

    def write(self, path, value):
        with self.lock:
            def persist():
                version = write_json(path, value)
                with self.lock:
                    if self.entries[path][2] is done:
                        self.entries[path] = (value, version, None)

            done = self.writer.submit(path.name, persist)
            self.entries[path] = (value, None, done)
            return done

    def refresh(self):
        with self.lock:
            entries = list(self.entries.items())
        for path, entry in entries:
            _, previous, pending = entry
            if pending is not None:
                continue
            version = read_version(path)
            if version == previous:
                continue
            value = json.loads(path.read_bytes()) if version else None
            with self.lock:
                if self.entries[path] is entry:
                    self.entries[path] = (value, version, None)
