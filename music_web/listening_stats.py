"""Connected listening time, offline listening counters, royalties and subscription savings for the family server."""
import copy
import json
import math
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Reported industry average of $3.41 per 1000 qualified plays (Duetti 2024, https://report.duetti.co/).
ROYALTY_RATE_USD = 0.00341
ROYALTY_SOURCE = 'https://report.duetti.co/'
SPOTIFY_PRICE_HUF = 2190


def _boundary(year, month):
    """Midnight on the 1st of a month in Budapest."""
    try:
        zone = ZoneInfo('Europe/Budapest')
    except ZoneInfoNotFoundError:
        # shortcut: fixed offsets (summer time covers 1 Apr to 1 Oct), when tzdata is missing; install tzdata.
        zone = timezone(timedelta(hours=2 if 4 <= month <= 10 else 1))
    return datetime(year, month, 1, tzinfo=zone)


def longest_streak(daily):
    """Longest run of positive listening days; equal runs keep the earliest."""
    best, start, previous, length = None, None, None, 0
    for day, seconds in sorted(daily.items()):
        if seconds <= 0:
            continue
        current = date.fromisoformat(day)
        length = length + 1 if previous and current == previous + timedelta(days=1) else 1
        if length == 1:
            start = day
        if best is None or length > best['days']:
            best = dict(day=start, end_day=day, days=length)
        previous = current
    return best


def listening_records(daily, profiles, today):
    """Records from recorded daily totals only, restricted to existing profiles."""
    people = {p['id']: p['name'] for p in profiles}
    totals, personal = {}, []
    for user in sorted(people):
        for day, seconds in sorted(daily.get(user, {}).items()):
            if seconds > 0 and day <= today.isoformat():
                totals[day] = totals.get(day, 0) + seconds
                personal.append(dict(owner=user, user=people[user], day=day, seconds=seconds))
    if not personal:
        return []
    busiest = min(totals, key=lambda day: (-totals[day], day))
    solo = min(personal, key=lambda row: (-row['seconds'], row['day'], row['owner']))
    records = [dict(id='family-day', title='Busiest family day', day=busiest, seconds=totals[busiest]),
               dict(id='personal-day', title='Biggest solo day', **solo),
               dict(id='family-streak', title='Longest family streak', **longest_streak(totals))]
    for user in sorted(people):
        streak = longest_streak({row['day']: row['seconds'] for row in personal if row['owner'] == user})
        if streak:
            records.append(dict(id='streak-' + user, title='Longest listening streak', owner=user, user=people[user], **streak))
    first = min(totals)
    records.append(dict(id='first-day', title='First recorded listening day', day=first, seconds=totals[first]))
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    week = {user: sum(row['seconds'] for row in personal if row['owner'] == user and row['day'] >= week_start)
            for user in people}
    winner = min(week, key=lambda user: (-week[user], user))
    if week[winner] > 0:
        records.append(dict(id='week-listener', title='Top listener this week', owner=winner, user=people[winner],
                            day=week_start, end_day=today.isoformat(), seconds=week[winner]))
    return records


class ListeningStats:
    LEASE = 20
    DEVICE = re.compile(r'[0-9a-f]{32}')
    DAY = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
    MAX_ENTRIES = 400
    MAX_DEVICES = 32  # Durable counter devices per profile; never evict counters that could be replayed.

    def __init__(self, workspace, clock=time.monotonic, utc=lambda: datetime.now(timezone.utc)):
        self.path = Path(workspace) / '.listening-statistics.json'
        self.clock, self.utc = clock, utc
        self.lock = threading.RLock()
        self.devices, self.counted = {}, {}
        self.data = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {
            'since': utc().isoformat(), 'profiles': {}}
        # daily: user -> day -> seconds, plays: user -> qualified plays, savings: user -> month -> HUF credited,
        # counters: user -> device -> {at, days: day -> [seconds, plays]}. Old files simply gain empty sections.
        # shortcut: counters and daily seconds are bounded by the calendar since 2020, not pruned.
        for key in ('daily', 'plays', 'savings', 'counters'):
            self.data.setdefault(key, {})
        self.last_write = 0
        self.dirty = not self.path.exists()

    def _write(self, now):
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.data), encoding='utf-8')
        temporary.replace(self.path)
        self.last_write = now
        self.dirty = False

    def _expire(self, now):
        for key, device in list(self.devices.items()):
            if now - device['at'] >= self.LEASE:
                self.devices.pop(key)

    def _add_seconds(self, user, day, seconds):
        months = self.data['profiles'].setdefault(user, {})
        months[day[:7]] = months.get(day[:7], 0) + seconds
        daily = self.data['daily'].setdefault(user, {})
        daily[day] = daily.get(day, 0) + seconds

    def heartbeat(self, user, device_id, playing, count_time=True, track=None):
        """count_time=False keeps presence only, for clients that report their time through sync()."""
        with self.lock:
            now = self.clock()
            self._expire(now)
            key = (user, device_id)
            previous = self.devices.get(key)
            if count_time and previous and previous['playing']:
                # Count elapsed playback, merging overlapping devices of one profile.
                elapsed = max(0, now - max(previous['at'], self.counted.get(user, previous['at'])))
                if elapsed:
                    self._add_seconds(user, self.utc().strftime('%Y-%m-%d'), elapsed)
                    self.counted[user] = now
                    self.dirty = True
            if key not in self.devices and len(self.devices) >= 512:
                raise ValueError('Too many active players.')
            self.devices[key] = {'at': now, 'playing': playing, 'track': track if playing else None}
            if self.dirty and (now - self.last_write >= 30 or not playing):
                self._write(now)

    def sync(self, user, device_id, entries, *, after_day=''):
        """Credit the growth of a device's cumulative daily counters; returns the credited seconds and plays."""
        if not isinstance(user, str) or not user:
            raise ValueError('Choose a family profile.')
        if not isinstance(device_id, str) or not self.DEVICE.fullmatch(device_id):
            raise ValueError('Invalid device id.')
        if not isinstance(entries, list) or len(entries) > self.MAX_ENTRIES:
            raise ValueError(f'Send a list of up to {self.MAX_ENTRIES} daily counters.')
        if not entries: return dict(seconds=0, plays=0)
        newest = self.utc().date() + timedelta(days=1)
        parsed = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError('Each daily counter must be an object.')
            day, seconds, plays = entry.get('day'), entry.get('seconds'), entry.get('plays')
            try:
                if not isinstance(day, str) or not self.DAY.fullmatch(day):
                    raise ValueError
                when = date.fromisoformat(day)
            except ValueError:
                raise ValueError('Counter day must be a date like 2026-11-15.') from None
            if not date(2020, 1, 1) <= when <= newest:
                raise ValueError('Counter day is out of range.')
            if type(seconds) not in (int, float) or not math.isfinite(seconds) or not 0 <= seconds <= 86400:
                raise ValueError('Counter seconds must be between 0 and 86400.')
            if type(plays) is not int or not 0 <= plays <= 10000:
                raise ValueError('Counter plays must be a whole number between 0 and 10000.')
            parsed.append((day, float(seconds), plays))
        with self.lock:
            backup = copy.deepcopy(self.data)
            gained_seconds, gained_plays, changed = 0, 0, False
            try:
                known = self.data['counters'].setdefault(user, {})
                if device_id not in known and len(known) >= self.MAX_DEVICES:
                    raise ValueError('Too many listening devices for this profile.')
                device = known.setdefault(device_id, {'at': 0, 'days': {}})
                for day, seconds, plays in parsed:
                    if day <= after_day:
                        continue
                    old = device['days'].get(day, [0, 0])
                    new = [max(seconds, old[0]), max(plays, old[1])]
                    if new == old:
                        continue
                    changed = True
                    device['days'][day] = new
                    if new[0] > old[0]:
                        self._add_seconds(user, day, new[0] - old[0])
                        gained_seconds += new[0] - old[0]
                    if new[1] > old[1]:
                        self.data['plays'][user] = self.data['plays'].get(user, 0) + new[1] - old[1]
                        gained_plays += new[1] - old[1]
                if changed:
                    device['at'] = int(self.utc().timestamp())
                    self._write(self.clock())
            except Exception:
                self.data = backup  # keep memory equal to the file so a retry credits the same counters
                raise
            return dict(seconds=gained_seconds, plays=gained_plays)

    def playing(self):
        with self.lock:
            self._expire(self.clock())
            return any(d['playing'] for d in self.devices.values())

    def reset_presence(self, user):
        with self.lock:
            self.counted.pop(user, None)
            self.devices = {key: device for key, device in self.devices.items() if key[0] != user}

    def clear(self, user):
        with self.lock:
            self.reset_presence(user)
            for key in ('profiles', 'daily', 'plays', 'counters'):
                self.data[key].pop(user, None)
            self.dirty = True
            self._write(self.clock())

    def _reconcile(self, user, history, now):
        """Credit the first no-subscription month and subsequent eligible month boundaries once."""
        events = sorted(((e['at'], e['subscribed']) for e in history or []
                         if isinstance(e, dict) and type(e.get('at')) is int and type(e.get('subscribed')) is bool
                         and 0 <= e['at'] <= 4102444800000), key=lambda event: event[0])
        if not events:
            return None, False
        credits = self.data['savings'].setdefault(user, {})
        changed = False
        first = datetime.fromtimestamp(events[0][0] / 1000, timezone.utc)
        year, month = first.year, first.month
        while True:
            boundary = _boundary(year, month)
            if boundary > now:
                break
            key = f'{year:04d}-{month:02d}'
            if key not in credits:
                known = [subscribed for at, subscribed in events if at <= boundary.timestamp() * 1000]
                next_boundary = _boundary(year + 1, 1) if month == 12 else _boundary(year, month + 1)
                declared_without = any(not subscribed and boundary.timestamp() * 1000 <= at < next_boundary.timestamp() * 1000 and at <= now.timestamp() * 1000 for at, subscribed in events)
                if (known and known[-1] is False) or declared_without:
                    credits[key] = SPOTIFY_PRICE_HUF  # the month price stays as credited
                    changed = True
            year, month = (year + 1, 1) if month == 12 else (year, month + 1)
        return events[-1][1], changed

    def snapshot(self, profiles, subscription_history=None, *, hidden=()):
        with self.lock:
            self._expire(self.clock())
            now = self.utc()
            month = now.strftime('%Y-%m')
            rows, changed = [], False
            for profile in profiles:
                user = profile['id']
                months = self.data['profiles'].get(user, {}) if user not in hidden else {}
                devices = [d for (owner, _), d in self.devices.items() if owner == user and user not in hidden]
                current = max((d for d in devices if d["playing"] and d.get("track")), key=lambda d: d["at"], default=None)
                status = None
                if subscription_history is not None:
                    status, added = self._reconcile(user, subscription_history.get(user), now)
                    changed = changed or added
                plays = self.data['plays'].get(user, 0) if user not in hidden else 0
                rows.append(dict(id=user, name=profile['name'], current_track=current['track'] if current else None, online=bool(devices),
                                 listening=any(d['playing'] for d in devices), seconds=sum(months.values()),
                                 month_seconds=months.get(month, 0), active_months=sum(value > 0 for value in months.values()),
                                 qualified_plays=plays, royalty_usd=round(plays * ROYALTY_RATE_USD, 5),
                                 spotify_subscribed=status,
                                 daily=[dict(day=day, seconds=seconds) for day, seconds in sorted(self.data['daily'].get(user, {}).items())] if user not in hidden else [],
                                 saved_huf=sum(self.data['savings'].get(user, {}).values()),
                                 monthly_saved_huf=SPOTIFY_PRICE_HUF if status is False else 0))
            if changed:
                self.dirty = True
                try:
                    self._write(self.clock())
                except OSError:
                    pass  # stays dirty and is written with the next change
            today = now.date()
            daily = []
            visible = [p for p in profiles if p['id'] not in hidden]
            earliest = min([today.replace(day=1), today - timedelta(days=6),
                            *[date.fromisoformat(day) for p in visible for day in self.data['daily'].get(p['id'], {})]])
            earliest = max(date(2020, 1, 1), earliest)
            for back in range((today - earliest).days, -1, -1):
                day = (today - timedelta(days=back)).isoformat()
                daily.append(dict(day=day, seconds=sum(self.data['daily'].get(p['id'], {}).get(day, 0) for p in visible)))
            plays = sum(row['qualified_plays'] for row in rows)
            return dict(since=self.data['since'], profiles=rows,
                        total_seconds=sum(row['seconds'] for row in rows), total_qualified_plays=plays,
                        royalty_usd=round(plays * ROYALTY_RATE_USD, 5), royalty_rate_usd=ROYALTY_RATE_USD,
                        royalty_source=ROYALTY_SOURCE, saved_huf=sum(row['saved_huf'] for row in rows),
                        monthly_saved_huf=sum(row['monthly_saved_huf'] for row in rows), daily=daily,
                        records=listening_records(self.data['daily'], visible, today))
