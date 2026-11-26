"""Record torrent activity and enforce FamilyHub's seeding limits."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import http.client
import http.cookiejar
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request


GOAL = 2.0
SEEDING_MINUTES = 14 * 24 * 60
MOVIE_CATEGORIES = {'familyhub', 'movies', 'tv'}
STOPPED_STATES = {'stoppedUP', 'stoppedDL', 'pausedUP'}
REMOVAL_LIMIT = 20
DATABASE = '.torrent-ratio.sqlite3'
FIELDS = ('hash', 'name', 'category', 'state', 'ratio', 'uploaded', 'downloaded')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS last_seen (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL,
    ratio REAL NOT NULL, uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL,
    observed_at TEXT NOT NULL, complete INTEGER NOT NULL, present INTEGER NOT NULL,
    progress REAL, size INTEGER, dl_speed INTEGER, up_speed INTEGER, seeding_time INTEGER
);
CREATE TABLE IF NOT EXISTS reached_goal (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL,
    ratio REAL NOT NULL, uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finished_torrents (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, finished_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('goal', 'no_demand')),
    ratio REAL NOT NULL, uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL, size INTEGER,
    removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))
);
CREATE TABLE IF NOT EXISTS last_sample (id INTEGER PRIMARY KEY CHECK (id = 1), observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS global_ratio (
    id INTEGER PRIMARY KEY CHECK (id = 1), uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS global_goal (
    id INTEGER PRIMARY KEY CHECK (id = 1), uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_limits_backfill (id INTEGER PRIMARY KEY CHECK (id = 1));
'''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def record(config, database):
    base = config['url'].rstrip('/')
    url = urllib.parse.urlsplit(base)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username is not None
            or url.query or url.fragment or any(char.isspace() for char in base)):
        raise ValueError('The qBittorrent URL is invalid.')
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    login = urllib.request.Request(base + '/api/v2/auth/login', headers={'Referer': base + '/'},
        data=urllib.parse.urlencode({'username': config['user'], 'password': config['password']}).encode())
    with opener.open(login, timeout=8) as response:
        answer = response.read(64).strip()
        if answer != b'Ok.' and (response.status != 204 or answer):
            raise ValueError('qBittorrent rejected the audit login.')
    with opener.open(base + '/api/v2/sync/maindata?rid=0', timeout=8) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('The torrent snapshot is too large.')
    data = json.loads(raw)
    if data.get('full_update') is not True:
        raise ValueError('qBittorrent did not return a complete snapshot.')
    rows = [dict(row, hash=ident) for ident, row in data.get('torrents', {}).items()]
    totals = data['server_state']
    observed_at = datetime.now(timezone.utc).isoformat(timespec='microseconds')
    sample(database, rows, observed_at, (totals['alltime_ul'], totals['alltime_dl']))
    removed = remove_finished(database, observed_at, opener, base)
    apply_share_limits(database, [row for row in rows if row['hash'] not in removed], opener, base)


def remove_finished(database, observed_at, opener, base):
    with closing(sqlite3.connect(database, timeout=2)) as conn:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            finished = conn.execute('''SELECT hash, name, observed_at,
                       CASE WHEN ratio >= ? THEN 'goal' ELSE 'no_demand' END,
                       ratio, uploaded, downloaded, size
                FROM last_seen WHERE present=1 AND complete=1 AND observed_at=?
                    AND category IN (?, ?, ?) AND state IN (?, ?, ?)
                    AND (ratio >= ? OR seeding_time >= ?)
                ORDER BY hash LIMIT ?''',
                (GOAL, observed_at, *MOVIE_CATEGORIES, *STOPPED_STATES, GOAL,
                 SEEDING_MINUTES * 60, REMOVAL_LIMIT)).fetchall()
            if not finished:
                return set()
            conn.executemany('''INSERT OR IGNORE INTO finished_torrents
                (hash, name, finished_at, outcome, ratio, uploaded, downloaded, size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)''', finished)

        with conn:
            # The journal must be committed before the request. Recheck after reacquiring the write lock.
            conn.execute('BEGIN IMMEDIATE')
            if conn.execute('SELECT observed_at FROM last_sample WHERE id=1').fetchone() != (observed_at,):
                return set()
            hashes = [row[0] for row in finished if conn.execute(
                'SELECT present FROM last_seen WHERE hash=?', (row[0],)).fetchone() == (1,)]
            if not hashes:
                return set()
            request = urllib.request.Request(base + '/api/v2/torrents/delete', headers={'Referer': base + '/'},
                data=urllib.parse.urlencode(dict(hashes='|'.join(hashes), deleteFiles='false')).encode())
            try:
                with opener.open(request, timeout=3):
                    pass
            except (OSError, http.client.HTTPException) as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                print('Could not remove finished torrents. The next sample will retry.', file=sys.stderr)
                return set()
            conn.executemany('UPDATE last_seen SET present=0 WHERE hash=?', ((ident,) for ident in hashes))
            conn.executemany('UPDATE finished_torrents SET removed=1 WHERE hash=?', ((ident,) for ident in hashes))
            return set(hashes)


def apply_share_limits(database, rows, opener, base):
    with closing(sqlite3.connect(database, timeout=2)) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        backfill = conn.execute('SELECT 1 FROM share_limits_backfill WHERE id=1').fetchone() is None
        hashes = []
        for row in rows:
            if (backfill or row['category'] in MOVIE_CATEGORIES) and (
                row.get('ratio_limit'), row.get('seeding_time_limit'), row.get('inactive_seeding_time_limit'),
                row.get('share_limit_action'), row.get('share_limits_mode', 'MatchAny')
            ) != (GOAL, SEEDING_MINUTES, -2, 'Stop', 'MatchAny'):
                hashes.append(row['hash'])
        if hashes:
            with opener.open(base + '/api/v2/app/version', timeout=3) as reply:
                version = re.fullmatch(rb'v?(\d+)\.(\d+)\.\d+(?:[-+][\w.+-]+)?', reply.read(64).strip())
            # Earlier versions can apply the limits with an inherited action that removes data.
            if not version or tuple(map(int, version.groups())) < (5, 2):
                raise ValueError('qBittorrent does not support an explicit per-torrent Stop action.')
            request = urllib.request.Request(base + '/api/v2/torrents/setShareLimits',
                headers={'Referer': base + '/'}, data=urllib.parse.urlencode(dict(
                    hashes='|'.join(hashes), ratioLimit=GOAL, seedingTimeLimit=SEEDING_MINUTES,
                    inactiveSeedingTimeLimit=-2, shareLimitAction='Stop', shareLimitsMode='MatchAny')).encode())
            with opener.open(request, timeout=3):
                pass
        if backfill:
            conn.execute('INSERT INTO share_limits_backfill VALUES (1)')


def sample(database, rows, observed_at, totals=None):
    if not isinstance(rows, list):
        raise ValueError('qBittorrent returned an invalid torrent list.')
    if totals is not None and any(type(value) is not int or not 0 <= value < 2**63 for value in totals):
        raise ValueError('qBittorrent returned invalid lifetime counters.')
    observations = []
    for row in rows:
        ident, name, category, state, ratio, uploaded, downloaded = values = tuple(row[key] for key in FIELDS)
        progress = row['progress']
        if (not isinstance(ident, str) or not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', ident)
                or not all(isinstance(value, str) for value in (name, category, state))
                or type(ratio) not in (int, float) or not math.isfinite(ratio)
                or type(progress) not in (int, float) or not 0 <= progress <= 1
                or any(type(count) is not int or not 0 <= count < 2**63 for count in (uploaded, downloaded))):
            raise ValueError('qBittorrent returned invalid torrent counters.')
        counters = tuple(row.get(key) for key in ('size', 'dlspeed', 'upspeed', 'seeding_time'))
        counters = tuple(value if type(value) is int and 0 <= value < 2**63 else None for value in counters)
        observations.append((*values, observed_at, int(progress == 1), progress, *counters))

    with closing(sqlite3.connect(database, timeout=5)) as conn:
        conn.executescript(SCHEMA)
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            previous = conn.execute('SELECT observed_at FROM last_sample WHERE id=1').fetchone()
            if previous and previous[0] >= observed_at:
                return
            columns = {row[1] for row in conn.execute('PRAGMA table_info(last_seen)')}
            for column, kind in (('progress', 'REAL'), ('size', 'INTEGER'), ('dl_speed', 'INTEGER'),
                                 ('up_speed', 'INTEGER'), ('seeding_time', 'INTEGER')):
                if column not in columns:
                    conn.execute(f'ALTER TABLE last_seen ADD COLUMN {column} {kind}')
            conn.executemany('''INSERT INTO last_seen
                (hash, name, category, state, ratio, uploaded, downloaded, observed_at, complete,
                 progress, size, dl_speed, up_speed, seeding_time, present) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(hash) DO UPDATE SET name=excluded.name, category=excluded.category, state=excluded.state,
                ratio=excluded.ratio, uploaded=excluded.uploaded, downloaded=excluded.downloaded,
                observed_at=excluded.observed_at, complete=excluded.complete, progress=excluded.progress,
                size=excluded.size, dl_speed=excluded.dl_speed, up_speed=excluded.up_speed,
                seeding_time=excluded.seeding_time, present=1''', observations)
            conn.execute('UPDATE last_seen SET present=0 WHERE present=1 AND observed_at<>?', (observed_at,))
            conn.execute('''UPDATE finished_torrents SET removed=1 WHERE removed=0
                            AND hash IN (SELECT hash FROM last_seen WHERE present=0)''')
            conn.executemany('INSERT OR IGNORE INTO reached_goal VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                             (row[:8] for row in observations if row[8] and row[4] >= GOAL and row[6] > 0))
            conn.execute('INSERT OR REPLACE INTO last_sample VALUES (1, ?)', (observed_at,))
            if totals is not None:
                uploaded, downloaded = totals
                conn.execute('INSERT OR REPLACE INTO global_ratio VALUES (1, ?, ?, ?)', (*totals, observed_at))
                if downloaded and uploaded >= GOAL * downloaded:
                    conn.execute('INSERT OR IGNORE INTO global_goal VALUES (1, ?, ?, ?)', (*totals, observed_at))


def show(database, query):
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        latest = conn.execute('SELECT observed_at FROM last_sample WHERE id=1').fetchone()
        result = {'last_sample_at': latest[0], 'torrents': []}
        has_totals = conn.execute("SELECT 1 FROM sqlite_master WHERE name='global_ratio'").fetchone()
        totals = conn.execute('SELECT uploaded, downloaded, observed_at FROM global_ratio WHERE id=1').fetchone() if has_totals else None
        if totals:
            proof = conn.execute('SELECT uploaded, downloaded, observed_at FROM global_goal WHERE id=1').fetchone()
            uploaded, downloaded, _ = totals
            result['global_ratio'] = dict(totals) | {
                'ratio': uploaded / downloaded if downloaded else None,
                'goal': GOAL, 'remaining_upload': max(0, 2 * downloaded - uploaded),
                'reached_2x': dict(proof) if proof else None,
            }
        for row in conn.execute('''SELECT * FROM last_seen WHERE instr(lower(name), lower(?)) > 0 OR hash = ?
                                   ORDER BY present DESC, observed_at DESC, name''', (query, query.lower())):
            proof = conn.execute('SELECT * FROM reached_goal WHERE hash=?', (row['hash'],)).fetchone()
            result['torrents'].append(dict(row) | {'reached_2x': dict(proof) if proof else None})
        print(json.dumps(result, indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/familyhub-music-web/config.json'))
    parser.add_argument('--show', nargs='?', const='', metavar='TITLE_OR_HASH', help='Show the stored proof and last observation.')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    database = Path(config.get('STATE_DIR') or config['WORKSPACE']) / DATABASE
    if database.is_symlink():
        raise RuntimeError('The torrent ratio database path is linked.')
    if args.show is not None:
        show(database, args.show)
    else:
        try:
            record(config['MOVIE_DOWNLOADS']['qbittorrent'], database)
        except (OSError, http.client.HTTPException, KeyError, ValueError, TypeError, AttributeError, sqlite3.Error) as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            sys.exit('Could not record torrent activity or apply seeding limits. The next sample will retry.')


if __name__ == '__main__':
    main()
