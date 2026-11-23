"""Offline migration and backup tests using temporary directories and real SQLite."""
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from music_web.state import backup_state, migrate_state, state_path


class StateDirectoryTests(TestCase):
    def setUp(self):
        root = Path(self.enterContext(TemporaryDirectory()))
        self.workspace = root / 'workspace'
        self.files = root / 'files'
        self.workspace.mkdir()
        self.files.mkdir()
        self.cfg = {'WORKSPACE': self.workspace, 'FILES_ROOT': self.files,
                    'STATE_DIR': root / 'state', 'STATE_BACKUP_DIR': root / 'backups'}

    def create_database(self, path):
        db = self.enterContext(closing(sqlite3.connect(path)))
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE sample (value TEXT)')
        db.execute("INSERT INTO sample VALUES ('committed')")
        db.commit()
        return db

    def assert_database(self, path):
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(db.execute('SELECT value FROM sample').fetchall(), [('committed',)])

    def test_migration_archives_originals_and_keeps_existing_state(self):
        profiles = self.workspace / '.family-profiles.json'
        profiles.write_text('{"profiles": []}', encoding='utf-8')
        audio = self.workspace / '.finished-audio'
        audio.mkdir()
        files_db = self.files / '.familyhub-files.db'
        self.create_database(files_db).close()
        activity = self.workspace / '.activity.log.2026-11-22'
        activity.write_text('entry\n', encoding='utf-8')
        genres = self.workspace / '.artist-genres.json'
        genres.write_text('{}', encoding='utf-8')
        legacy = dict(self.cfg, STATE_DIR=None)
        self.assertEqual(state_path(legacy, profiles.name), profiles)
        self.assertEqual(state_path(legacy, files_db.name), files_db)
        migrate_state(legacy)
        self.assertTrue(profiles.exists())

        rename = Path.rename

        def interrupted_publish(path, target):
            if target == state_path(self.cfg, genres.name):
                raise OSError('Interrupted before publication')
            return rename(path, target)

        with patch.object(Path, 'rename', interrupted_publish), self.assertRaises(OSError):
            migrate_state(self.cfg)
        self.assertFalse(genres.exists())
        migrate_state(self.cfg)

        for source in (profiles, files_db, activity):
            self.assertFalse(source.exists())
            self.assertTrue(source.with_name(source.name + '.moved-to-state').exists())
        self.assertEqual(state_path(self.cfg, profiles.name).read_bytes(), b'{"profiles": []}')
        self.assertEqual(state_path(self.cfg, '.artist-genres.json').read_bytes(), b'{}')
        self.assert_database(state_path(self.cfg, files_db.name))
        self.assertTrue(audio.is_dir())
        profiles.write_text('{"profiles": ["old"]}', encoding='utf-8')
        migrate_state(self.cfg)
        self.assertEqual(state_path(self.cfg, profiles.name).read_bytes(), b'{"profiles": []}')
        state_path(self.cfg, genres.name).unlink()
        migrate_state(self.cfg)
        self.assertFalse(state_path(self.cfg, genres.name).exists())

    def test_invalid_json_keeps_workspace_source(self):
        source = self.workspace / '.family-profiles.json'
        source.write_text('{', encoding='utf-8')
        with self.assertRaises(ValueError):
            migrate_state(self.cfg)
        self.assertTrue(source.exists())
        self.assertFalse(state_path(self.cfg, source.name).exists())

    def test_backup_copies_committed_wal_and_retains_fourteen_days(self):
        root = self.cfg['STATE_DIR']
        root.mkdir()
        db_path = root / '.word-puzzles.sqlite3'
        db = self.create_database(db_path)
        self.assertTrue(db_path.with_name(db_path.name + '-wal').exists())
        db.execute("INSERT INTO sample VALUES ('uncommitted')")
        (root / '.family-profiles.json').write_text('{}', encoding='utf-8')
        first = date(2026, 11, 1)
        for offset in range(16):
            backup_state(self.cfg, first + timedelta(days=offset))
        backups = sorted(self.cfg['STATE_BACKUP_DIR'].iterdir())
        self.assertEqual(len(backups), 14)
        self.assertEqual(backups[0].name, 'state-2026-11-03')
        self.assert_database(backups[-1] / db_path.name)
        self.assertEqual((backups[-1] / '.family-profiles.json').read_bytes(), b'{}')
