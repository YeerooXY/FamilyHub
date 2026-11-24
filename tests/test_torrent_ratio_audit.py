from pathlib import Path
import runpy
import sqlite3
import tempfile
import unittest
from contextlib import closing


sample = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/torrent-ratio-audit.py'))['sample']


class TorrentRatioAuditTests(unittest.TestCase):
    def test_first_completed_milestone_survives_removal_and_readd(self):
        torrent = dict(hash='a' * 40, name='Sample torrent', category='familyhub', state='uploading',
                       ratio=2.01, uploaded=20100, downloaded=10000, progress=.9)
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'audit.sqlite3'
            sample(database, [torrent], '2026-11-24T10:00:00+00:00')
            with closing(sqlite3.connect(database)) as conn:
                self.assertIsNone(conn.execute('SELECT * FROM reached_goal').fetchone())
                sample(database, [dict(torrent, progress=1)], '2026-11-24T10:00:30+00:00')
                sample(database, [dict(torrent, progress=1, ratio=2.5, uploaded=25000)], '2026-11-24T10:01:00+00:00')
                sample(database, [], '2026-11-24T10:01:30+00:00')
                self.assertEqual(conn.execute('SELECT present, ratio FROM last_seen').fetchone(), (0, 2.5))
                self.assertEqual(conn.execute('SELECT ratio, uploaded, downloaded, observed_at FROM reached_goal').fetchone(),
                                 (2.01, 20100, 10000, '2026-11-24T10:00:30+00:00'))
                sample(database, [torrent], '2026-11-24T10:01:00+00:00')
                self.assertEqual(conn.execute('SELECT present FROM last_seen').fetchone(), (0,))
                sample(database, [dict(torrent, ratio=0.0, uploaded=0)], '2026-11-24T10:02:00+00:00')
                self.assertEqual(conn.execute('SELECT present, ratio FROM last_seen').fetchone(), (1, 0.0))
                self.assertEqual(conn.execute('SELECT ratio FROM reached_goal').fetchone(), (2.01,))
