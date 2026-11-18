"""Private, retained listening events. No history is exposed through family totals."""
import calendar
import copy
import hashlib
import json
import math
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID



class ListeningHistory:
    MAX_BATCH = 100

    def __init__(self, workspace, utc=lambda: datetime.now(timezone.utc)):
        self.root = Path(workspace) / '.listening-history'
        self.utc = utc
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
                events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
                cleared_path = path.with_suffix('.cleared')
                cleared = self.timestamp(cleared_path.read_text(encoding='utf-8')) if cleared_path.exists() else None
                kept = [e for e in events if self.timestamp(e['started_at']) >= self.cutoff()
                        and (not cleared or self.timestamp(e['started_at']) > cleared)]
                if len(events) != len(kept):
                    temporary = path.with_suffix('.tmp')
                    temporary.write_text(''.join(json.dumps(e) + '\n' for e in kept), encoding='utf-8')
                    temporary.replace(path)
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
            if not isinstance(event, dict) or set(event) != fields:
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
            result.append(event)
        return result

    def _write(self, profile, events):
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.path(profile)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(''.join(json.dumps(e, allow_nan=False) + '\n' for e in events), encoding='utf-8')
        temporary.replace(path)
        self.cache.pop(profile, None)

    def _read(self, profile):
        path = self.path(profile)
        events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []
        cleared = self.cleared_at(profile)
        kept = [e for e in events if self.timestamp(e['started_at']) >= self.cutoff()
                and (not cleared or self.timestamp(e['started_at']) > self.timestamp(cleared))]
        if len(kept) != len(events):
            self._write(profile, kept)
        return kept

    def append(self, profile, events, paused=False):
        events = self.validate(events)  # Validate the entire batch before any mutation, even while paused.
        with self.lock:
            saved = self._read(profile)
            seen = {e['event_id'] for e in saved}
            additions = []
            cleared = self.cleared_at(profile)
            cutoff = max(self.cutoff(), self.timestamp(cleared)) if cleared else self.cutoff()
            for event in events:
                at = self.timestamp(event['started_at'])
                if not paused and event['event_id'] not in seen and at >= cutoff and (not cleared or at > self.timestamp(cleared)):
                    additions.append(event)
                    seen.add(event['event_id'])
            if additions:
                self._write(profile, saved + additions)
        return {'acknowledged': [e['event_id'] for e in events], 'added': len(additions), 'paused': paused}

    def clear(self, profile):
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            path = self.path(profile).with_suffix('.cleared')
            temporary = path.with_suffix('.tmp')
            temporary.write_text(self.utc().isoformat(), encoding='utf-8')
            temporary.replace(path)
            self._write(profile, [])

    def events(self, profile):
        with self.lock:
            return sorted(self._read(profile), key=lambda e: (e['started_at'], e['event_id']))

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
        hours, weekdays = [0] * 24, [0] * 7
        for event in events:
            at = self.timestamp(event['started_at'])
            complete, skip = event['outcome'] == 'completed', event['outcome'] == 'skipped'
            early = skip and (event['position'] < 30 or event['position'] / event['duration'] < .25)
            weight = .5 ** (max(0, (self.utc() - at).total_seconds()) / (30 * 86400))
            track = metadata.get(event['recording_id'], {})
            for bucket, key in ((recordings, event['recording_id']), (artists, track.get('channel', '')), (genres, track.get('genre', 'Unsorted'))):
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
        return dict(recordings=recordings, artists=artists, genres=genres, hours=hours, weekdays=weekdays, timezone='UTC',
                    recent_history=[e['recording_id'] for e in events[-200:]])


def register(app, workspace, body, profiles, admins, metadata, profile_lock):
    from flask import g, jsonify, request, abort

    store = ListeningHistory(workspace)
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
        data = body(128 * 1024)
        if set(data) != {'events'}:
            return jsonify(error='Send events only.'), 400
        try:
            with profile_lock:
                paused = profiles.preferences(g.user).get('listening_history_paused', False) if profiles else False
                return jsonify(store.append(g.user, data['events'], paused))
        except ValueError as error:
            return jsonify(error=str(error)), 400

    @app.get('/api/listening/summary')
    def listening_summary():
        return jsonify(store.summary(reader(), metadata()))

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
        return jsonify(cleared=True, cleared_at=store.cleared_at(g.user))
