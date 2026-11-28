"""Who is online and what they are doing, and the rules that turn Jellyfin playback reports into watch time."""
import logging
import re
import threading
import time

log = logging.getLogger(__name__)

TICKS = 10_000_000
MIN_SECONDS = 120  # A shorter clip is not counted as watching.
SEEK_SLACK = 3  # Seconds the position may run ahead of the clock between two reports.
MAX_GAP = 120  # A longer silence between reports counts nothing: the player was suspended or offline.
SESSION_LEASE = 300
WATCH_LEASE = 45  # A film shows as being watched this long after its last report.
WORDLE_LEASE = 120
SEEN_LEASE = 75  # Home refreshes every 30 s, so a visitor stays online across two missed refreshes.
MAX_SESSIONS = 256
ITEM = re.compile(r'[0-9a-f-]{32,36}')
TAG = re.compile(r'[A-Za-z0-9]{1,64}')
ACTIONS = ('start', 'progress', 'stopped')


def played_seconds(previous, position, now):
    """Seconds played since the previous report: only while that report was playing, never more than the clock allows.
    A jump (a seek) or a long silence counts nothing."""
    if previous is None or not previous['playing']:
        return 0
    elapsed, moved = now - previous['at'], position - previous['position']
    if elapsed > MAX_GAP or not 0 < moved <= elapsed + SEEK_SLACK:
        return 0
    return min(moved, elapsed)


def describe(item):
    """What the family sees about a Jellyfin film or episode."""
    if not isinstance(item, dict):
        return {}

    def text(value, limit=200):
        return value[:limit] if isinstance(value, str) and not any(ord(c) < 32 for c in value) else ''

    episode = item.get('Type') == 'Episode'
    owner, tag = (item.get('SeriesId'), item.get('SeriesPrimaryImageTag')) if episode else (
        item.get('Id'), (item.get('ImageTags') or {}).get('Primary'))
    season, number = item.get('ParentIndexNumber'), item.get('IndexNumber')
    line = ''
    if episode and type(season) is int and type(number) is int:
        line = f'Season {season}, episode {number}'
    ticks = item.get('RunTimeTicks')
    return dict(
        title=text(item.get('SeriesName') if episode else item.get('Name')),
        episode=line or (text(item.get('Name')) if episode else ''),
        poster=f'Items/{owner}/Images/Primary?tag={tag}&maxHeight=160'
        if isinstance(owner, str) and ITEM.fullmatch(owner) and isinstance(tag, str) and TAG.fullmatch(tag) else '',
        runtime=ticks / TICKS if type(ticks) in (int, float) and ticks > 0 else None)


def merge(profiles, presence, online, watching, wordle, paused):
    """One row per online profile. A profile with paused history shows as online with no details.
    presence maps a profile to the song it is playing (or None); watching maps a profile to describe() fields."""
    here = set(presence) | set(online) | set(watching) | set(wordle)
    members = []
    for profile in profiles:
        user = profile['id']
        if user not in here:
            continue
        row = dict(id=user, name=profile['name'], kind='online')
        if user not in paused:
            track, film = presence.get(user), watching.get(user)
            if track:
                row.update(kind='listening', title=track.get('title', ''), subtitle=track.get('channel', ''), cover=track.get('id', ''))
            elif film:
                runtime = film.get('runtime')
                row.update(kind='watching', title=film.get('title', ''), subtitle=film.get('episode', ''), poster=film.get('poster', ''),
                           progress=round(min(1, film['position'] / runtime), 3) if runtime else None)
            elif user in wordle:
                row['kind'] = 'wordle'
        members.append(row)
    rank = ('listening', 'watching', 'wordle', 'online')
    return sorted(members, key=lambda row: (rank.index(row['kind']), row['name'].casefold(), row['id']))


class Activity:
    """Short-lived, in-memory activity. Only watch time is kept, through `credit`."""

    def __init__(self, credit=lambda user, seconds: None, history_paused=lambda user: False, clock=time.monotonic):
        self.credit, self.history_paused, self.clock = credit, history_paused, clock
        self.lock = threading.Lock()
        self.sessions = {}  # (profile, item) -> last report
        self.watching = {}  # profile -> what is on screen
        self.wordle_until, self.seen_until = {}, {}

    def seen(self, user):
        with self.lock:
            self.seen_until[user] = self.clock() + SEEN_LEASE

    def wordle(self, user):
        with self.lock:
            self.wordle_until[user] = self.clock() + WORDLE_LEASE

    def _expire(self, now):
        for key in [key for key, state in self.sessions.items() if now - state['at'] > SESSION_LEASE]:
            del self.sessions[key]
        for user in [user for user, film in self.watching.items() if now - film['at'] > WATCH_LEASE]:
            del self.watching[user]
        for leases in (self.wordle_until, self.seen_until):
            for user in [user for user, until in leases.items() if until <= now]:
                del leases[user]
        while len(self.sessions) > MAX_SESSIONS:
            del self.sessions[min(self.sessions, key=lambda key: self.sessions[key]['at'])]

    def report(self, user, action, payload, lookup):
        """Apply one Jellyfin playback report from the Movies gateway. `lookup(item_id)` returns the Jellyfin item;
        it runs once per play, never for a stop. Failures are logged with their cause and never reach the player."""
        item, ticks, paused = (payload.get(key) for key in ('ItemId', 'PositionTicks', 'IsPaused')) if isinstance(payload, dict) else (None,) * 3
        if (action not in ACTIONS or not isinstance(item, str) or not ITEM.fullmatch(item)
                or type(ticks) not in (int, float) or not 0 <= ticks < 2 ** 53 or type(paused) is not bool):
            log.warning('watch activity ignored: profile=%s cause=invalid_report', user)
            return
        now, position, key = self.clock(), ticks / TICKS, (user, item)
        with self.lock:
            self._expire(now)
            state = self.sessions.get(key)
        info = state['info'] if state and action != 'start' else None
        if info is None and action != 'stopped':
            try:
                info = describe(lookup(item))
            except Exception as error:
                log.warning('watch activity lookup failed: profile=%s cause=%s', user, type(error).__name__)
                info = {}
        gained = 0 if action == 'start' else played_seconds(state, position, now)
        with self.lock:
            if action == 'stopped':
                self.sessions.pop(key, None)
                if self.watching.get(user, {}).get('item') == item:
                    del self.watching[user]
            else:
                self.sessions[key] = dict(info=info, position=position, at=now, playing=not paused)
                self.watching[user] = dict(info, item=item, position=position, at=now)
        runtime = (info or state and state['info'] or {}).get('runtime')
        try:
            if gained and not (runtime is not None and runtime < MIN_SECONDS) and not self.history_paused(user):
                self.credit(user, gained)
        except Exception as error:  # The player must never fail because its watch time could not be saved.
            log.warning('watch time not saved: profile=%s cause=%s', user, type(error).__name__)

    def members(self, profiles, presence, online, paused):
        now = self.clock()
        with self.lock:
            self._expire(now)
            watching, wordle, seen = dict(self.watching), set(self.wordle_until), set(self.seen_until)
        return merge(profiles, presence, set(online) | seen, watching, wordle, paused)
