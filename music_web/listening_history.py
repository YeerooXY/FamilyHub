"""Private listening events and durable yearly aggregates."""
import calendar
import copy
import hashlib
import json
import math
import re
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from .wrapped import add_event, compare, write_json, yearly_summary, first_artists
from .genres import genre_key, genre_label, most_common_genre

class ListeningHistory:
    MAX_BATCH = 100

    def __init__(self, workspace, utc=lambda: datetime.now(timezone.utc), track_metadata=lambda ids: {}):
        self.root = Path(workspace) / '.listening-history'
        self.utc = utc
        self.track_metadata = track_metadata
        self.lock = threading.RLock()
        self.cache = {}
        self.last_prune = None
        self.prune()

    def prune(self):
        with self.lock:
            now = self.utc()
            if self.last_prune and now - self.last_prune < timedelta(hours=24):
                return
            for path in self.root.glob('*.jsonl'):
                self._read_path(path)
            self.cache.clear()
            self.last_prune = now

    def path(self, profile):
        return self.root / (hashlib.sha256(profile.encode()).hexdigest() + '.jsonl')

    def cleared_at(self, profile):
        path = self.path(profile).with_suffix('.cleared')
        return path.read_text(encoding='utf-8') if path.exists() else None

    def cutoff(self):
        now = self.utc()
        return now.replace(year=now.year - 1, day=min(now.day, calendar.monthrange(now.year - 1, now.month)[1]))

    @staticmethod
    def timestamp(value):
        if not isinstance(value, str) or len(value) > 40:
            raise ValueError('started_at must be a UTC timestamp.')
        try:
            at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            raise ValueError('started_at must be a UTC timestamp.') from None
        if at.tzinfo is None or at.utcoffset() != timedelta(0):
            raise ValueError('started_at must be a UTC timestamp.')
        return at

    def validate(self, events):
        if not isinstance(events, list) or not 1 <= len(events) <= self.MAX_BATCH:
            raise ValueError('Send 1 to 100 listening events.')
        result = []
        fields = {'event_id', 'recording_id', 'started_at', 'listened_seconds', 'duration', 'outcome', 'position', 'source', 'device_kind'}
        for event in events:
            if not isinstance(event, dict) or not fields <= event.keys() <= fields | {'track'}:
                raise ValueError('Invalid listening event fields.')
            event = dict(event)
            try:
                if not isinstance(event['event_id'], str):
                    raise ValueError()
                event['event_id'] = str(UUID(event['event_id']))
            except (ValueError, AttributeError):
                raise ValueError('event_id must be a UUID.') from None
            if not isinstance(event['recording_id'], str) or not re.fullmatch(r'(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})', event['recording_id']):
                raise ValueError('Invalid recording id.')
            at = self.timestamp(event['started_at'])
            if at > self.utc() + timedelta(minutes=5):
                raise ValueError('started_at is in the future.')
            event['started_at'] = at.isoformat()
            for key in ('listened_seconds', 'duration', 'position'):
                value = event[key]
                if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 86400:
                    raise ValueError('Invalid listening seconds, duration or position.')
            if event['duration'] <= 0 or event['position'] > event['duration'] or event['listened_seconds'] > event['duration']:
                raise ValueError('Listening seconds and position must fit the duration.')
            if event['outcome'] not in ('completed', 'skipped', 'stopped'):
                raise ValueError('Invalid listening outcome.')
            if not isinstance(event['source'], str) or not re.fullmatch(r'(?:search|playlist:[A-Za-z0-9_-]{1,128}|radio|auto_dj|queue|library|other)', event['source']):
                raise ValueError('Invalid listening source.')
            if event['device_kind'] not in ('windows', 'android', 'iphone'):
                raise ValueError('Invalid device kind.')
            track = event.get('track', {})
            if (not isinstance(track, dict) or track.keys() - {'title', 'channel', 'library_album', 'genre'}
                    or any(not isinstance(value, str) or len(value) > 500 or any(ord(c) < 32 for c in value)
                           for value in track.values())):
                raise ValueError('Invalid song metadata.')
            result.append(event)
        return result

    def _write(self, path, events):
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(''.join(json.dumps(e, allow_nan=False) + '\n' for e in events), encoding='utf-8')
        temporary.replace(path)

    @staticmethod
    def _cleared(path):
        marker = path.with_suffix('.cleared')
        return marker.read_text(encoding='utf-8') if marker.exists() else None

    def _state(self, path, cleared):
        summary = path.with_suffix('.yearly.json')
        if summary.exists():
            saved = json.loads(summary.read_text(encoding='utf-8'))
            if saved['cleared_at'] == cleared:
                return saved
        return dict(cleared_at=cleared, cursor=0, years={})

    def _rollup(self, path, state, events):
        for event in events:
            add_event(state['years'], event, self.timestamp(event['started_at']))
            state['cursor'] = event['_sequence']
        write_json(path.with_suffix('.yearly.json'), state)

    def _prepare(self, events, cursor):
        metadata = self.track_metadata({event['recording_id'] for event in events})
        for index, event in enumerate(events, cursor + 1):
            event['_sequence'] = index
            known = {key: value for key, value in metadata.get(event['recording_id'], {}).items()
                     if value and value != 'Unsorted'}
            event['track'] = {**event.get('track', {}), **known}

    def _read_path(self, path):
        events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []
        cleared = self._cleared(path)
        state = self._state(path, cleared)
        cleared_at = self.timestamp(cleared) if cleared else None
        cutoff = self.cutoff()
        visible = [e for e in events if not cleared_at or self.timestamp(e['started_at']) > cleared_at]
        kept = [e for e in visible if self.timestamp(e['started_at']) >= cutoff]
        if visible and '_sequence' not in visible[0]:
            # Publish migration before rolling up, so an interrupted migration can replay the same sequence.
            self._prepare(visible, state['cursor'])
            self._write(path, visible)
        pending = [e for e in visible if e['_sequence'] > state['cursor']]
        if pending:
            self._rollup(path, state, pending)
        if len(kept) != len(events):
            self._write(path, kept)
            self.cache.clear()
        return kept, state

    def append(self, profile, events, paused=False, resumed_at=None):
        events = self.validate(events)  # Validate the entire batch before any mutation, even while paused.
        if paused:
            return {'acknowledged': [e['event_id'] for e in events], 'added': 0, 'paused': True}
        with self.lock:
            path = self.path(profile)
            saved, state = self._read_path(path)
            seen = {e['event_id'] for e in saved}
            additions = []
            cleared = state['cleared_at']
            cutoff = max([self.cutoff(), *(self.timestamp(value) for value in (cleared, resumed_at) if value)])
            for event in events:
                at = self.timestamp(event['started_at'])
                if event['event_id'] not in seen and at >= cutoff and (not cleared or at > self.timestamp(cleared)):
                    additions.append(event)
                    seen.add(event['event_id'])
            if additions:
                self._prepare(additions, state['cursor'])
                self._write(path, saved + additions)
                self.cache.pop(profile, None)
                self._rollup(path, state, additions)
        return {'acknowledged': [e['event_id'] for e in events], 'added': len(additions), 'paused': paused}

    def clear(self, profile):
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            path = self.path(profile).with_suffix('.cleared')
            temporary = path.with_suffix('.tmp')
            temporary.write_text(self.utc().isoformat(), encoding='utf-8')
            temporary.replace(path)
            self._write(self.path(profile), [])
            self.path(profile).with_suffix('.yearly.json').unlink(missing_ok=True)
            self.cache.pop(profile, None)

    def events(self, profile):
        with self.lock:
            events, _ = self._read_path(self.path(profile))
            return [{k: v for k, v in event.items() if k != '_sequence'}
                    for event in sorted(events, key=lambda e: (e['started_at'], e['event_id']))]

    def wrapped(self, profile, year, chart, *, full=False):
        with self.lock:
            path = self.path(profile)
            years = self._state(path, self._cleared(path))['years']
        result, artists, songs = yearly_summary(years, year, full=full)
        first = first_artists(years, year) if chart.get('day') else {}
        return {**result, **compare(chart, artists, songs, first)}

    def summary(self, profile, metadata):
        with self.lock:
            events = self.events(profile)
            metadata_key = tuple(sorted((key, track.get('channel', ''), track.get('genre', 'Unsorted')) for key, track in metadata.items()))
            key = (int(self.utc().timestamp() // 60), metadata_key)
            cached = self.cache.get(profile)
            if cached and cached[0] == key:
                return copy.deepcopy(cached[1])
            result = self._summary(events, metadata)
            result["cleared_at"] = self.cleared_at(profile)
            self.cache[profile] = (key, result)
            return copy.deepcopy(result)

    def _summary(self, events, metadata):
        recordings, artists, genres = {}, {}, {}
        genre_labels = defaultdict(Counter)
        hours, weekdays = [0] * 24, [0] * 7
        for event in events:
            at = self.timestamp(event['started_at'])
            complete, skip = event['outcome'] == 'completed', event['outcome'] == 'skipped'
            early = skip and (event['position'] < 30 or event['position'] / event['duration'] < .25)
            weight = .5 ** (max(0, (self.utc() - at).total_seconds()) / (30 * 86400))
            track = {**event.get('track', {}), **metadata.get(event['recording_id'], {})}
            genre = genre_label(track.get('genre'))
            key = genre_key(genre)
            genre_labels[key][genre] += 1
            for bucket, key in ((recordings, event['recording_id']), (artists, track.get('channel', '')), (genres, key)):
                if not key:
                    continue
                row = bucket.setdefault(key, dict(plays=0, completes=0, skips=0, early_skips=0, total_seconds=0, seconds=0, last_played=None, last_early_skip=None, score=0))
                row['plays'] += 1
                row['completes'] += int(complete)
                row['skips'] += int(skip)
                row['early_skips'] += int(early)
                row['total_seconds'] += event['listened_seconds']
                row['seconds'] += event['listened_seconds']
                row['last_played'] = event['started_at']
                if early:
                    row['last_early_skip'] = event['started_at']
                row['score'] += weight * (1 + 2 * complete - 2 * early)
            hours[at.hour] += event['listened_seconds']
            weekdays[at.weekday()] += event['listened_seconds']
        return dict(recordings=recordings, artists=artists,
                    genres={most_common_genre(genre_labels[key]): row for key, row in genres.items()},
                    hours=hours, weekdays=weekdays, timezone='UTC',
                    recent_history=[e['recording_id'] for e in events[-200:]])


def register(app, workspace, body, profiles, admins, metadata, profile_lock, *, track_metadata, chart, songs_added, clear_totals):
    from flask import g, jsonify, request, abort

    store = ListeningHistory(workspace, track_metadata=track_metadata)
    app.extensions['listening_history'] = store

    @app.before_request
    def prune_listening_history():
        store.prune()

    def reader():
        target = request.args.get('profile', g.user)
        if target != g.user and g.user not in admins:
            abort(403)
        if profiles:
            profiles.get(target)
        return target

    @app.post('/api/listening/events')
    def listening_events_post():
        data = body(512 * 1024)
        if set(data) != {'events'}:
            return jsonify(error='Send events only.'), 400
        try:
            with profile_lock:
                preferences = profiles.preferences(g.user) if profiles else {}
                return jsonify(store.append(g.user, data['events'], preferences.get('listening_history_paused', False),
                                            preferences.get('listening_history_resumed_at')))
        except ValueError as error:
            return jsonify(error=str(error)), 400

    @app.get('/api/listening/summary')
    def listening_summary():
        return jsonify(store.summary(reader(), metadata()))

    @app.get('/api/listening/wrapped')
    def listening_wrapped():
        try:
            year = int(request.args.get('year', store.utc().year))
            if not 1 <= year <= store.utc().year:
                raise ValueError
        except ValueError:
            return jsonify(error='Choose a past or current calendar year.'), 400
        snapshot = chart.snapshot()
        with profile_lock:
            if profiles and profiles.preferences(g.user)['listening_history_paused']:
                return jsonify(year=year, paused=True)
            return jsonify(paused=False, songs_added=songs_added(year).get(g.user, 0),
                           **store.wrapped(g.user, year, snapshot, full=True))

    @app.get('/api/listening/events')
    def listening_events_get():
        target = reader()
        if g.user not in admins:
            abort(403)
        return jsonify(events=store.events(target)[-200:])

    @app.delete('/api/listening/history')
    def listening_history_clear():
        with profile_lock:
            store.clear(g.user)
            clear_totals(g.user)
        return jsonify(cleared=True, cleared_at=store.cleared_at(g.user))

    return store
