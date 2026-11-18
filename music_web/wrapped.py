"""Calendar-year listening aggregates and a public Deezer chart snapshot."""
import json
import re
import threading
import unicodedata
from datetime import timedelta
from pathlib import Path

from .link_playlists import _deezer
from .listening_stats import longest_streak


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data), encoding='utf-8')
    temporary.replace(path)


def chart_key(value):
    value = re.sub(r'\s+-\s+topic$', '', value, flags=re.I)
    return ' '.join(re.findall(r'\w+', unicodedata.normalize('NFKC', value).casefold()))


def count(row, seconds, completed):
    row['seconds'] = row.get('seconds', 0) + seconds
    row['plays'] = row.get('plays', 0) + completed


def add_event(years, event, at):
    year = years.setdefault(str(at.year), {})
    day = at.date().isoformat()
    seconds = event['listened_seconds']
    completed = int(event['outcome'] == 'completed')
    recording = year.setdefault('songs', {}).setdefault(event['recording_id'], {})
    for key, value in event.get('track', {}).items():
        if value and value not in ('Unsorted', 'Selected recordings'):
            recording[key] = value
    count(recording, seconds, completed)
    if seconds > 0 or completed:
        recording['starts'] = recording.get('starts', 0) + 1
        artist = recording.get('channel', '')
        key = chart_key(artist)
        if key:
            first = year.setdefault('first_artists', {})
            if key not in first or day < first[key][1]:
                first[key] = [artist, day]
    if event['outcome'] == 'skipped':
        recording['skips'] = recording.get('skips', 0) + 1
    daily = year.setdefault('daily', {})
    daily[day] = daily.get(day, 0) + seconds
    year.setdefault('hours', [0] * 24)[at.hour] += seconds
    year.setdefault('hourly_plays', [0] * 24)[at.hour] += completed
    device = 'pc' if event['device_kind'] == 'windows' else 'phone'
    count(year.setdefault('devices', {}).setdefault(device, {}), seconds, completed)


def top(rows):
    return sorted(rows, key=lambda row: (-row['seconds'], -row['plays'], row['name'].casefold()))


def yearly_summary(years, year, *, full=False):
    data = years.get(str(year), {})
    songs, artists, albums, genres = [], {}, {}, {}
    skipped, replayed = [], []
    for identifier, row in data.get('songs', {}).items():
        artist, album, genre = (row.get(key, '') for key in ('channel', 'library_album', 'genre'))
        song = dict(id=identifier, title=row.get('title'), artist=artist, album=album, genre=genre,
                    name=row.get('title', identifier), plays=row['plays'], seconds=row['seconds'],
                    skips=row.get('skips', 0), replays=max(0, row.get('starts', 0) - 1))
        if row['seconds'] or row['plays']:
            songs.append(song)
            for rows, name, key in ((artists, artist, artist.casefold()),
                                    (albums, album, (artist.casefold(), album.casefold())),
                                    (genres, genre, genre.casefold())):
                if name:
                    group = rows.setdefault(key, dict(name=name))
                    count(group, row['seconds'], row['plays'])
                    if rows is albums:
                        group['artist'] = artist
        if song['skips']:
            skipped.append(song)
        if song['replays']:
            replayed.append(song)

    daily = data.get('daily', {})
    hours, plays = data.get('hours', [0] * 24), data.get('hourly_plays', [0] * 24)
    streak = longest_streak(daily)
    seconds = sum(hours)
    songs, artists, genres = top(songs), top(artists.values()), top(genres.values())
    replay = most(replayed, 'replays')
    if replay and not full:
        replay = {key: replay[key] for key in ('title', 'artist', 'replays')}
    result = dict(year=year, timezone='UTC', total_minutes=seconds / 60,
                  favourite_artist=artists[0]['name'] if artists else None,
                  favourite_genre=genres[0]['name'] if genres else None,
                  longest_streak_days=streak['days'] if streak else 0,
                  night_owl_share=sum(plays[:6]) / sum(plays) if sum(plays) else None,
                  most_replayed_song=replay)
    if full:
        first = first_artists(years, year)
        monthly = [0] * 12
        for day, listened in daily.items():
            monthly[int(day[5:7]) - 1] += listened / 60
        result.update(top_songs=minutes(songs), top_artists=minutes(artists),
                      top_albums=minutes(top(albums.values())), top_genres=minutes(genres),
                      distinct_artists=len(artists), first_listened_per_artist={name: when for name, when in first.values()},
                      monthly_minutes=monthly, top_hour=max(range(24), key=hours.__getitem__) if seconds else None,
                      longest_streak=streak, most_skipped_song=most(skipped, 'skips'),
                      devices={name: dict(plays=row['plays'], minutes=row['seconds'] / 60)
                               for name, row in data.get('devices', {}).items()})
    return result, artists[:10], songs[:10]


def minutes(rows):
    return [dict(row, minutes=row['seconds'] / 60) for row in rows]


def most(rows, field):
    return min(rows, key=lambda row: (-row[field], -row['seconds'], row['id']), default=None)


def first_artists(years, through_year):
    active = years.get(str(through_year), {}).get('first_artists', {})
    first = {}
    for year, data in years.items():
        if int(year) <= through_year:
            for key, (artist, day) in data.get('first_artists', {}).items():
                if key in active and (key not in first or day < first[key][1]):
                    first[key] = (artist, day)
    return first


class DeezerChart:
    def __init__(self, workspace, utc, read=None):
        self.path = Path(workspace) / '.deezer-chart.json'
        self.utc, self.read = utc, read or (lambda path: _deezer(path, timeout=4, max_wait=1))
        self.lock = threading.Lock()
        self.data = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {}

    def snapshot(self):
        if not self.lock.acquire(blocking=False):
            return self.data
        try:
            now = self.utc()
            if now.timestamp() - self.data.get('attempted', 0) < timedelta(days=1).total_seconds():
                return self.data
            attempted = dict(self.data, attempted=now.timestamp())
            write_json(self.path, attempted)
            self.data = attempted
            try:
                chart = self.read('chart?limit=50')
                artists = {chart_key(row['name']) for row in chart['artists']['data']}
                songs = {(chart_key(row['artist']['name']), chart_key(row['title'])) for row in chart['tracks']['data']}
                artists.discard('')
                songs = [list(pair) for pair in sorted(songs) if all(pair)]
                if not artists or not songs:
                    return self.data
            except (OSError, ValueError, KeyError, TypeError):
                return self.data
            day = now.date().isoformat()
            first = self.data.get('first', {}).copy()
            for artist in artists:
                first.setdefault(artist, self.data.get('day'))
            snapshot = dict(attempted, day=day, artists=sorted(artists), songs=songs, first=first)
            write_json(self.path, snapshot)
            self.data = snapshot
            return snapshot
        finally:
            self.lock.release()


def compare(chart, artists, songs, first):
    chart_artists, chart_songs = set(chart.get('artists', [])), set(map(tuple, chart.get('songs', [])))
    artist_keys = {chart_key(row['name']) for row in artists} - {''}
    song_keys = {(chart_key(row['artist']), chart_key(row['title'])) for row in songs if row['title'] and row['artist']}
    song_keys = {pair for pair in song_keys if all(pair)}
    count = len(artist_keys) + len(song_keys)
    score = (len(artist_keys & chart_artists) + len(song_keys & chart_songs)) / count if chart_artists and count else None
    early = [name for key, (name, day) in first.items() if chart['first'].get(key) and day < chart['first'][key]] if chart_artists else []
    return dict(mainstream_score=score, early_listeners=sorted(early, key=str.casefold), chart_date=chart.get('day'))
