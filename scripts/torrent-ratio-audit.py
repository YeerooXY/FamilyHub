"""Keep qBittorrent's last observation and first recorded 2.0 share ratio."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import http.cookiejar
import json
import math
from pathlib import Path
import re
import sqlite3
import urllib.parse
import urllib.request


GOAL = 2.0
DATABASE = '.torrent-ratio.sqlite3'
FIELDS = ('hash', 'name', 'category', 'state', 'ratio', 'uploaded', 'downloaded')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS last_seen (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL,
    ratio REAL NOT NULL, uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL,
    observed_at TEXT NOT NULL, complete INTEGER NOT NULL, present INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reached_goal (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL,
    ratio REAL NOT NULL, uploaded INTEGER NOT NULL, downloaded INTEGER NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS last_sample (id INTEGER PRIMARY KEY CHECK (id = 1), observed_at TEXT NOT NULL);
'''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def torrent_snapshot(config):
    base = config['url'].rstrip('/')
    url = urllib.parse.urlsplit(base)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username is not None or url.query or url.fragment:
        raise ValueError('The qBittorrent URL is invalid.')
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    login = urllib.request.Request(base + '/api/v2/auth/login', headers={'Referer': base + '/'},
        data=urllib.parse.urlencode({'username': config['user'], 'password': config['password']}).encode())
    with opener.open(login, timeout=8) as response:
        answer = response.read(64).strip()
        if answer != b'Ok.' and (response.status != 204 or answer):
            raise RuntimeError('qBittorrent rejected the audit login.')
    with opener.open(base + '/api/v2/torrents/info', timeout=8) as response:
        return json.loads(response.read(8 * 1024 * 1024))


def sample(database, rows, observed_at):
    if not isinstance(rows, list):
        raise ValueError('qBittorrent returned an invalid torrent list.')
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
        observations.append((*values, observed_at, int(progress == 1)))

    with closing(sqlite3.connect(database, timeout=5)) as conn:
        conn.executescript(SCHEMA)
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            previous = conn.execute('SELECT observed_at FROM last_sample WHERE id=1').fetchone()
            if previous and previous[0] >= observed_at:
                return
            conn.executemany('''INSERT INTO last_seen VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(hash) DO UPDATE SET name=excluded.name, category=excluded.category, state=excluded.state,
                ratio=excluded.ratio, uploaded=excluded.uploaded, downloaded=excluded.downloaded,
                observed_at=excluded.observed_at, complete=excluded.complete, present=1''', observations)
            conn.execute('UPDATE last_seen SET present=0 WHERE present=1 AND observed_at<>?', (observed_at,))
            conn.executemany('INSERT OR IGNORE INTO reached_goal VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                             (row[:-1] for row in observations if row[-1] and row[4] >= GOAL and row[6] > 0))
            conn.execute('INSERT OR REPLACE INTO last_sample VALUES (1, ?)', (observed_at,))


def show(database, query):
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        latest = conn.execute('SELECT observed_at FROM last_sample WHERE id=1').fetchone()
        result = {'last_sample_at': latest[0], 'torrents': []}
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
        rows = torrent_snapshot(config['MOVIE_DOWNLOADS']['qbittorrent'])
        sample(database, rows, datetime.now(timezone.utc).isoformat(timespec='microseconds'))


if __name__ == '__main__':
    main()
