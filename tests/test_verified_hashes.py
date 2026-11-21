import hashlib
from pathlib import Path
import re
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from music_web.verified_hashes import install


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
