from contextlib import closing
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

from music_web import torrent_seeding


audit = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/torrent-ratio-audit.py'))
sample = audit['sample']


class TorrentRatioAuditTests(unittest.TestCase):
    def test_backfill_retries_and_future_movies_receive_stop_limits(self):
        torrent = dict(name='Sample torrent', category='familyhub', state='downloading',
                       ratio=0.0, uploaded=0, downloaded=10000, progress=.5)
        config = dict(url='http://qbittorrent.test', user='fixture-user', password='fixture-password')
        configured = dict(ratio_limit=2.0, seeding_time_limit=20160, inactive_seeding_time_limit=-2,
                          share_limit_action='Stop', share_limits_mode='MatchAny')
        first, existing, new, unrelated = (letter * 40 for letter in 'abcd')
        rows = {first: torrent.copy(), existing: dict(torrent, category='other')}
        writes = []
        version = b'v5.1.0'

        def upstream(request, timeout):
            self.assertLessEqual(timeout, 8)
            url = request if isinstance(request, str) else request.full_url
            if url.endswith('/auth/login'):
                self.assertEqual(parse_qs(request.data.decode()),
                                 {'username': ['fixture-user'], 'password': ['fixture-password']})
                return io.BytesIO(b'Ok.')
            if url.endswith('/sync/maindata?rid=0'):
                return io.BytesIO(json.dumps(dict(full_update=True, torrents=rows,
                    server_state=dict(alltime_ul=0, alltime_dl=10000))).encode())
            if url.endswith('/app/version'):
                return io.BytesIO(version)
            self.assertEqual(url, config['url'] + '/api/v2/torrents/setShareLimits')
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(request.get_header('Referer'), config['url'] + '/')
            payload = parse_qs(request.data.decode())
            hashes, = payload.pop('hashes')
            self.assertEqual(payload, dict(ratioLimit=['2.0'], seedingTimeLimit=['20160'],
                inactiveSeedingTimeLimit=['-2'], shareLimitAction=['Stop'], shareLimitsMode=['MatchAny']))
            writes.append(hashes)
            if len(writes) == 1:
                raise TimeoutError('fixture failure')
            for ident in hashes.split('|'):
                rows[ident].update(configured)
            return io.BytesIO()

        with tempfile.TemporaryDirectory() as folder, patch('urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect = upstream
            database = Path(folder) / torrent_seeding.DATABASE
            record = audit['record']
            with self.assertRaisesRegex(ValueError, 'explicit per-torrent Stop'):
                record(config, database)
            self.assertEqual(writes, [])
            version = b'v5.3.0'
            with self.assertRaises(TimeoutError):
                record(config, database)
            record(config, database)
            rows[new] = dict(torrent, category='tv')
            rows[unrelated] = dict(torrent, category='other')
            rows[existing] = dict(torrent, category='other')
            record(config, database)
            record(config, database)
            rows[first] = torrent.copy()
            record(config, database)
            self.assertEqual(writes, [first + '|' + existing, first + '|' + existing, new, first])

    def test_snapshot_classifies_current_ratio_and_completed_seeding_time(self):
        torrent = dict(name='Sample torrent', category='familyhub', ratio=.4, uploaded=400,
                       downloaded=1000, progress=1)
        cap = 14 * 24 * 60 * 60
        cases = [
            ('stoppedUP', 2.0, cap, 'Goal reached'),
            ('pausedUP', .4, cap, 'Stopped, no demand'),
            ('stoppedUP', .4, cap - 1, 'Stopped'),
            ('stoppedUP', .4, None, 'Stopped'),
            ('queuedUP', .4, 0, 'Waiting'),
            ('uploading', .4, 0, 'Seeding'),
            ('stalledUP', .4, 0, 'Seeding'),
        ]
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / torrent_seeding.DATABASE
            rows = [dict(torrent, hash=f'{index:040x}', state=state, ratio=ratio, seeding_time=seconds)
                    for index, (state, ratio, seconds, _) in enumerate(cases)]
            sample(database, rows, datetime.now(timezone.utc).isoformat())
            snapshot = torrent_seeding.snapshot({'WORKSPACE': folder})
            self.assertEqual([item['state'] for item in snapshot['items']], [case[3] for case in cases])

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
