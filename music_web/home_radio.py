"""Build bounded Home shortcuts from a profile's plays and the current library."""

from collections import Counter, defaultdict
from datetime import timedelta
import hashlib

from flask import g, jsonify, request

from .genres import genre_key, genre_label, most_common_genre
from .playlists import library_match_key
from .radio import _key, first_artist


def shortcuts(library, events, added_ids, now, timestamp, offset=0):
    tracks = {track['id']: track for track in library}
    events = [(tracks[event['recording_id']], timestamp(event['started_at']))
              for event in reversed(events[-200:]) if event['recording_id'] in tracks]
    genres, labels, artists = defaultdict(list), defaultdict(Counter), defaultdict(list)
    for track in tracks.values():
        label = genre_label(track.get('genre'))
        key = genre_key(label)
        genres[key].append(track)
        labels[key][label] += 1
    for track, _ in events:
        if artist := first_artist(track['channel']):
            artists[_key(artist)].append(track)
    plays = Counter(genre_key(track.get('genre')) for track, _ in events)
    local_now = now + timedelta(minutes=offset)
    day = local_now.date().isoformat()

    def daily_key(track):
        return hashlib.sha256(f"{day}:{track['id']}".encode()).digest()

    result, seen = [], set()

    def add(key, label, candidates, artist=False):
        unique = {}
        for track in candidates:
            song = library_match_key(track['title'], track['channel'])
            unique.setdefault(song, track['id'])
            if len(unique) == 16:
                break
        signature = frozenset(unique)
        if signature and (artist or signature not in seen) and len(result) < 7:
            result.append(dict(key=key, label=label, track_ids=list(unique.values())))
            if not artist:
                seen.add(signature)

    daily = sorted(tracks.values(), key=lambda t: (genre_key(t.get('genre')) not in plays, daily_key(t)))
    add('daily', 'Daily mix', daily)
    add('recent', 'Recently added mix', (tracks[i] for i in added_ids[:8] if i in tracks))
    periods = [('morning', 'Morning mix', 5, 12), ('evening', 'Evening mix', 17, 24)]
    periods.sort(key=lambda period: not period[2] <= local_now.hour < period[3])
    for key, label, start, end in periods:
        add(key, label, (t for t, at in events if start <= (at + timedelta(minutes=offset)).hour < end))
    plays.pop('unsorted', None)
    for key, _ in plays.most_common(2):
        add('genre:' + key, most_common_genre(labels[key]) + ' mix', sorted(genres[key], key=daily_key))
    for key in sorted(artists, key=lambda key: -len(artists[key]))[:3]:
        track = artists[key][0]
        add('artist:' + key, first_artist(track['channel']) + ' Radio', [track], artist=True)
    return result


def register(app, allow, library_tracks, get_index, history, profiles):
    @app.get('/api/home/radio')
    def home_radio_shortcuts():
        offset = request.args.get('offset', 0, type=int)
        if not -840 <= offset <= 840:
            return jsonify(error='Invalid time zone offset.'), 400
        if not allow('home-radio:' + g.user, 30, 60):
            return jsonify(error='Wait a minute before reloading radio shortcuts.'), 429
        library = library_tracks()
        index = get_index()
        added = index.read("SELECT id FROM tracks WHERE added_at IS NOT NULL AND added_at != '' "
                           "ORDER BY added_at DESC, id DESC LIMIT 8", (), lambda row: row[0]) if index else None
        if added is None:
            dated = sorted((track for track in library if track.get('added_at')),
                           key=lambda track: (track['added_at'], track['id']), reverse=True)
            added = [track['id'] for track in dated[:8]]
        paused = profiles and profiles.preferences(g.user).get('listening_history_paused')
        events = [] if paused else history.events(g.user)
        return jsonify(shortcuts=shortcuts(library, events, added, history.utc(), history.timestamp, offset))
