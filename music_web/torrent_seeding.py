"""Read the torrent sampler's current observations and durable milestones."""
from contextlib import closing
from datetime import datetime, timezone
import math
import sqlite3

from .state import state_path


GOAL = 2.0
SEEDING_SECONDS = 14 * 24 * 60 * 60
DATABASE = '.torrent-ratio.sqlite3'
STATES = {
    'uploading': 'Seeding', 'forcedUP': 'Seeding', 'stalledUP': 'Stalled seeding', 'queuedUP': 'Queued to seed',
    'pausedUP': 'Paused', 'stoppedUP': 'Stopped', 'checkingUP': 'Checking', 'checkingDL': 'Checking',
    'checkingResumeData': 'Checking', 'moving': 'Moving', 'allocating': 'Preparing',
    'downloading': 'Downloading', 'forcedDL': 'Downloading', 'metaDL': 'Fetching metadata',
    'stalledDL': 'Stalled download', 'queuedDL': 'Queued to download', 'pausedDL': 'Paused', 'stoppedDL': 'Stopped',
    'error': 'Problem', 'missingFiles': 'Missing files', 'unknown': 'Unknown',
}


def ratio(value):
    return max(0.0, float(value)) if type(value) in (int, float) and math.isfinite(value) else 0.0


def seeding_state(state, share_ratio, seeding_time, complete):
    if complete:
        if state in {'pausedUP', 'stoppedUP', 'stoppedDL'}:
            return 'Stopped, no demand' if share_ratio < GOAL and (seeding_time or 0) >= SEEDING_SECONDS else 'Stopped'
        if state == 'queuedUP':
            return 'Waiting'
        if state in {'uploading', 'forcedUP', 'stalledUP'}:
            return 'Seeding'
    return STATES.get(state, 'Unknown')


def snapshot(config):
    path = state_path(config, DATABASE).absolute()
    unavailable = dict(available=False, reason='Seeding records are unavailable.')
    if path.is_symlink() or not path.is_file():
        return unavailable
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            db.row_factory = sqlite3.Row
            db.execute('BEGIN')
            latest = db.execute('SELECT observed_at FROM last_sample WHERE id=1').fetchone()
            if latest is None:
                return unavailable
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            totals = db.execute('SELECT uploaded, downloaded FROM global_ratio WHERE id=1').fetchone() if 'global_ratio' in tables else None
            finished = {'goal': 0, 'no_demand': 0}
            if 'finished_torrents' in tables:
                finished.update(db.execute('SELECT outcome, COUNT(*) FROM finished_torrents WHERE removed=1 GROUP BY outcome'))
            columns = {row[1] for row in db.execute('PRAGMA table_info(last_seen)')}
            rows = db.execute(f'''
                SELECT s.hash, s.name, s.state, s.ratio, s.uploaded, s.downloaded, s.complete,
                       {', '.join(column if column in columns else f'NULL AS {column}'
                                  for column in ('progress', 'size', 'dl_speed', 'up_speed', 'seeding_time'))},
                       r.observed_at AS reached_goal_at
                FROM last_seen s LEFT JOIN reached_goal r ON s.hash = r.hash
                WHERE s.present = 1 ORDER BY s.name COLLATE NOCASE, s.hash
            ''').fetchall()
        sampled_at = datetime.fromisoformat(latest['observed_at'])
        stale = (datetime.now(timezone.utc) - sampled_at).total_seconds() > 120
    except (sqlite3.Error, ValueError, TypeError):
        return unavailable
    items = []
    for row in rows:
        item = dict(row)
        item['ratio'] = ratio(item['ratio'])
        item['state'] = seeding_state(item['state'], item['ratio'], item.pop('seeding_time'), item['complete'])
        items.append(item)
    uploaded, downloaded = totals if totals else (0, 0)
    return dict(available=True, goal=GOAL, last_sample_at=sampled_at.isoformat(), stale=stale, items=items,
                finished=finished,
                total_uploaded=uploaded, total_downloaded=downloaded,
                global_ratio=round(uploaded / downloaded, 4) if downloaded else 0.0)
