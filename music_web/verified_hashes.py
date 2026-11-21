"""Reuse hashes of published Linux audio files across service restarts."""
from contextlib import closing
from pathlib import Path
import sqlite3
import stat
import sys
from threading import Lock


def install(intake, workspace, library):
    # Linux ctime changes even when an edit restores a file's modification time.
    if not sys.platform.startswith('linux'):
        return
    database = Path(workspace) / '.verified-audio.sqlite3'
    original = intake.sha256_file
    locks = [Lock() for _ in range(64)]
    workspace, library = Path(workspace), Path(library)

    def signature(path):
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            return f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}'

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
            try:
                with closing(sqlite3.connect(database)) as db:
                    db.execute('CREATE TABLE IF NOT EXISTS hashes (path TEXT PRIMARY KEY, stamp TEXT, digest TEXT)')
                    row = db.execute('SELECT digest FROM hashes WHERE path=? AND stamp=?', (str(path), before)).fetchone()
                    if row:
                        return row[0]
                    digest = original(path)
                    if signature(path) == before:
                        db.execute('INSERT OR REPLACE INTO hashes VALUES (?, ?, ?)', (str(path), before, digest))
                        db.commit()
                    return digest
            except sqlite3.Error:
                return original(path)

    intake.sha256_file = checked
