import hashlib
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from music_web.verified_hashes import SAMPLE_BYTES, install


class VerifiedHashes(unittest.TestCase):
    def test_restart_reuses_digest_and_replacement_invalidates(self):
        with tempfile.TemporaryDirectory() as tmp, patch('music_web.verified_hashes.sys.platform', 'linux'):
            ws, lib = Path(tmp), Path(tmp) / 'library'
            lib.mkdir()
            audio = lib / 'song.wav'
            audio.write_bytes(b'aaa')
            hash_file = Mock(side_effect=lambda p: hashlib.sha256(p.read_bytes()).hexdigest())
            def restart():
                intake = SimpleNamespace(sha256_file=hash_file, ID_RE=re.compile('unused'))
                install(intake, str(ws), str(lib))
                return intake.sha256_file
            first = restart()(audio)
            verify = restart()
            self.assertEqual(verify(audio), first)
            replacement = lib / 'replacement'
            replacement.write_bytes(b'bbb')
            replacement.replace(audio)
            self.assertNotEqual(verify(audio), first)
            self.assertEqual(hash_file.call_count, 2)

    def test_legacy_row_survives_copy_then_sampled_edits_invalidate(self):
        with tempfile.TemporaryDirectory() as tmp, patch('music_web.verified_hashes.sys.platform', 'linux'):
            ws, lib = Path(tmp), Path(tmp) / 'library'
            lib.mkdir()
            state = ws / 'state'
            state.mkdir()
            audio = lib / 'song.wav'
            audio.write_bytes(b'a' * (7 * SAMPLE_BYTES))
            original = audio.stat()
            stamp = f'{original.st_dev}:{original.st_ino}:{original.st_size}:{original.st_mtime_ns}:{original.st_ctime_ns}'
            digest = hashlib.sha256(audio.read_bytes()).hexdigest()
            database = state / '.verified-audio.sqlite3'
            db = sqlite3.connect(database)
            try:
                db.execute('CREATE TABLE hashes (path TEXT PRIMARY KEY, stamp TEXT, digest TEXT)')
                db.execute('INSERT INTO hashes VALUES (?, ?, ?)', (str(audio), stamp, digest))
                db.commit()
                for _ in range(2):
                    copy = lib / 'copy.wav'
                    shutil.copy2(audio, copy)
                    copy.replace(audio)
                    hash_file = Mock(side_effect=lambda path: hashlib.sha256(path.read_bytes()).hexdigest())
                    intake = SimpleNamespace(sha256_file=hash_file, ID_RE=re.compile('unused'))
                    install(intake, ws, lib, state={'WORKSPACE': ws, 'STATE_DIR': state})
                    self.assertEqual(intake.sha256_file(audio), digest)
                    hash_file.assert_not_called()
                stamp = db.execute('SELECT stamp FROM hashes').fetchone()[0]
                self.assertTrue(stamp.startswith(f'v2:{original.st_size}:{original.st_mtime_ns}:'))
                for offset in (0, original.st_size // 2, original.st_size - 1):
                    with audio.open('r+b') as stream:
                        stream.seek(offset)
                        stream.write(b'b')
                    os.utime(audio, ns=(original.st_atime_ns, original.st_mtime_ns))
                    updated = intake.sha256_file(audio)
                    self.assertNotEqual(updated, digest)
                    digest = updated
                self.assertEqual(hash_file.call_count, 3)
            finally:
                db.close()
