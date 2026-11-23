"""Reuse hashes of published Linux audio files across service restarts."""
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import stat
import sys
from threading import Lock

from .state import state_path


SAMPLE_BYTES = 64 * 1024


def signature(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        return None
    size = info.st_size
    sample = hashlib.sha256()
    with path.open('rb') as audio:
        for offset in (0, max(0, (size - SAMPLE_BYTES) // 2), max(0, size - SAMPLE_BYTES)):
            audio.seek(offset)
            sample.update(audio.read(SAMPLE_BYTES))
    return f'v2:{size}:{info.st_mtime_ns}:{sample.hexdigest()}'


def install(intake, workspace, library, *, state=None):
    if not sys.platform.startswith('linux'):
        return
    database = state_path(state or workspace, '.verified-audio.sqlite3')
    original = intake.sha256_file
    locks = [Lock() for _ in range(64)]
    workspace, library = Path(workspace), Path(library)

    def checked(path):
        path = Path(path)
        if not (path.is_relative_to(library) or path.parent.parent == workspace and (
                path.parent.name in ('.finished-audio', '.listening-versions') or
                path.name.startswith('audio.') and intake.ID_RE.fullmatch(path.parent.name))):
            return original(path)
        with locks[hash(path) % len(locks)]:
            before = signature(path)
            if before is None:
                return original(path)
            digest = None
            try:
                with closing(sqlite3.connect(database)) as db:
                    db.execute('CREATE TABLE IF NOT EXISTS hashes (path TEXT PRIMARY KEY, stamp TEXT, digest TEXT)')
                    row = db.execute('SELECT stamp, digest FROM hashes WHERE path=?', (str(path),)).fetchone()
                    if row:
                        old, cached = row
                        if old == before:
                            return cached
                        old_fields = old.split(':') if isinstance(old, str) else []
                        if (len(old_fields) == 5 and all(field.lstrip('-').isdigit() for field in old_fields)
                                and old_fields[2:4] == before.split(':')[1:3]):
                            db.execute('UPDATE hashes SET stamp=? WHERE path=? AND stamp=?', (before, str(path), old))
                            db.commit()
                            return cached
                    digest = original(path)
                    if signature(path) == before:
                        db.execute('INSERT OR REPLACE INTO hashes VALUES (?, ?, ?)', (str(path), before, digest))
                        db.commit()
                    return digest
            except sqlite3.Error:
                return digest if digest is not None else original(path)

    intake.sha256_file = checked
