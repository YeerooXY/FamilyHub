"""Short-lived, host-controlled listening sessions on the family server."""
import copy
import math
import re
import secrets
import threading
import time

from flask import g, jsonify, request, session


class RoomError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ListeningRooms:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.rooms = {}
        self.pokes = {}
        self.poke_sent = {}

    def poke(self, sender, name, target, room_id=None):
        if sender == target:
            raise RoomError("Choose another listener.")
        with self.lock:
            self.pending_pokes(target)
            now = self.clock()
            pair = (sender, target)
            self.poke_sent = {k: t for k, t in self.poke_sent.items() if now - t < 60}
            if pair in self.poke_sent:
                raise RoomError("Wait a minute before poking this listener again.", 429)
            if len(self.pokes) >= 512:
                raise RoomError("Too many listening requests. Try again shortly.", 429)
            key = secrets.token_urlsafe(12)
            self.pokes[key] = dict(id=key, sender=sender, name=name, target=target, at=now, room_id=room_id)
            self.poke_sent[pair] = now
            return key

    def pending_pokes(self, user):
        with self.lock:
            now = self.clock()
            self.pokes = {k: p for k, p in self.pokes.items() if now - p['at'] < 120}
            return [{**dict(id=p['id'], sender=p['sender'], name=p['name']), **({'room_id':p['room_id'], 'kind':'invite'} if p.get('room_id') else {})} for p in self.pokes.values() if p['target'] == user]

    def dismiss_poke(self, user, key):
        with self.lock:
            poke = self.pokes.get(key)
            if poke is not None and poke['target'] != user:
                raise RoomError("This request belongs to another listener.", 403)
            self.pokes.pop(key, None)

    def prune(self):
        now = self.clock()
        for key, room in list(self.rooms.items()):
            if now - room['updated'] > 30:
                del self.rooms[key]
            else:
                room['members'] = {k: v for k, v in room['members'].items() if now - v < 30}

    @staticmethod
    def validate(data, previous=None):
        if not isinstance(data, dict):
            raise RoomError('Send a playback state.')
        rows = data.get('queue', previous)
        if not isinstance(rows, list) or len(rows) > 2000:
            raise RoomError('Choose up to 2000 songs.')
        queue = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not re.fullmatch(r'(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})', row['id']):
                raise RoomError('Choose songs with a recording.')
            if any(not isinstance(row.get(k), str) or len(row[k]) > 500 for k in ('title', 'channel')):
                raise RoomError('Invalid song details.')
            queue.append(dict(id=row['id'], title=row['title'], channel=row['channel'], url='' if row['id'].startswith('local-') else 'https://www.youtube.com/watch?v=' + row['id']))
        index, position = data.get('index'), data.get('position')
        if type(index) is not int or (not 0 <= index < len(queue) if queue else index != -1):
            raise RoomError('Invalid queue position.')
        if type(position) not in (int, float) or not math.isfinite(position) or not 0 <= position <= 86400:
            raise RoomError('Invalid playback position.')
        if any(type(data.get(k)) is not bool for k in ('playing', 'auto_dj', 'crossfading')):
            raise RoomError('Invalid playback controls.')
        if not queue and (position != 0 or data['playing'] or data['crossfading']):
            raise RoomError('An empty session must be stopped.')
        control_revision = data.get('control_revision', 0)
        if type(control_revision) is not int or not 0 <= control_revision <= 9007199254740991:
            raise RoomError('Invalid playback control revision.')
        fade = {k: data.get(k, default) for k, default in [('fade_position', 0), ('fade_elapsed', 0), ('fade_duration', 6)]}
        if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 60 for v in fade.values()):
            raise RoomError('Invalid crossfade position.')
        return dict(queue=queue, index=index, position=position, playing=data['playing'], auto_dj=data['auto_dj'], crossfading=data['crossfading'], control_revision=control_revision, **fade)

    def snapshot(self, room, identity, known_queue=0):
        state = copy.deepcopy(room['state'])
        if state['playing']:
            elapsed = max(0, self.clock() - room['updated'])
            state['position'] += elapsed
            if state['crossfading']:
                state['fade_position'] += elapsed
                state['fade_elapsed'] += elapsed
        if known_queue == room['queue_revision']:
            state.pop('queue')
        return dict(id=room['id'], host_name=room['name'], host_user=room['host'][0] if isinstance(room['host'], tuple) else room['host'], is_host=room['host'] == identity,
                    listeners=1 + len(room['members']), revision=room['revision'], queue_revision=room['queue_revision'], **state)

    def list(self):
        with self.lock:
            self.prune()
            return [dict(id=r['id'], host_name=r['name'], host_user=r['host'][0] if isinstance(r['host'], tuple) else r['host'], listeners=1 + len(r['members']),
                         title=r['state']['queue'][r['state']['index']]['title'] if r['state']['queue'] else 'Waiting for a song') for r in self.rooms.values()]

    @staticmethod
    def profile(identity):
        return identity[0] if isinstance(identity, tuple) else identity

    def create(self, identity, name, data):
        state = self.validate(data)
        with self.lock:
            self.prune()
            existing = next((r for r in self.rooms.values() if self.profile(r['host']) == self.profile(identity)), None)
            if existing and existing['host'] != identity:
                current = self.snapshot(existing, identity)
                for field in ('position', 'fade_position', 'fade_elapsed'):
                    if field in current: existing['state'][field] = current[field]
                existing.update(host=identity, name=name, updated=self.clock(), revision=existing['revision'] + 1)
                existing['members'] = {member: at for member, at in existing['members'].items() if self.profile(member) != self.profile(identity)}
                return {**self.snapshot(existing, identity), 'resumed': True}
            if existing:
                # A request can succeed after its client times out. Retrying must recover that room.
                self.update(existing['id'], identity, data)
                return self.snapshot(existing, identity)
            if len(self.rooms) >= 16:
                raise RoomError('All listening sessions are in use. Try again shortly.', 429)
            key = secrets.token_urlsafe(16)
            room = dict(id=key, host=identity, name=name, state=state, updated=self.clock(), members={}, revision=1, queue_revision=1)
            self.rooms[key] = room
            return self.snapshot(room, identity)

    def access(self, key):
        self.prune()
        if key not in self.rooms:
            raise RoomError('This listening session has ended.', 404)
        return self.rooms[key]

    def join(self, key, identity):
        with self.lock:
            room = self.access(key)
            if self.profile(room['host']) == self.profile(identity):
                raise RoomError('This is your session. Resume hosting instead.', 403)
            if room['host'] != identity:
                if identity not in room['members'] and len(room['members']) >= 32:
                    raise RoomError('This listening session is full.', 429)
                room['members'][identity] = self.clock()
            return self.snapshot(room, identity)

    def read(self, key, identity, known_queue=0):
        with self.lock:
            room = self.access(key)
            if room['host'] != identity:
                if identity not in room['members']:
                    raise RoomError('Join this listening session first.', 403)
                room['members'][identity] = self.clock()
            return self.snapshot(room, identity, known_queue)

    def update(self, key, identity, data):
        with self.lock:
            room = self.access(key)
            if room['host'] != identity:
                raise RoomError('Only the host can control playback.', 403)
            state = self.validate(data, room['state']['queue'])
            if state['queue'] != room['state']['queue']:
                room['queue_revision'] += 1
            room.update(state=state, updated=self.clock(), revision=room['revision'] + 1)
            return self.snapshot(room, identity, room['queue_revision'])

    def leave(self, key, identity):
        with self.lock:
            room = self.access(key)
            if room['host'] == identity:
                del self.rooms[key]
            else:
                room['members'].pop(identity, None)


def register_listening_rooms(app, body, profile_store):
    rooms = ListeningRooms()
    app.extensions['listening_rooms'] = rooms

    @app.errorhandler(RoomError)
    def room_error(error):
        return jsonify(error=str(error)), error.status

    def identity():
        return (g.user, session['sid'])

    @app.route('/api/listening/pokes', methods=['GET', 'POST'])
    def listening_pokes():
        if request.method == 'GET':
            return jsonify(requests=rooms.pending_pokes(g.user))
        target = body(1024).get('target')
        if profile_store is None:
            raise RoomError("Choose a family profile first.")
        profile_store.get(target)
        name = profile_store.get(g.user)['name']
        return jsonify(id=rooms.poke(g.user, name, target)), 201

    @app.post('/api/listening/invites')
    def invite_listener():
        data = body(1024)
        if profile_store is None: raise RoomError("Choose a family profile first.")
        target = data.get('target'); profile_store.get(target)
        key = data.get('room_id')
        if not isinstance(key, str): raise RoomError("Choose a session to invite someone to.")
        with rooms.lock:
            room = rooms.access(key)
            if room['host'] != identity(): raise RoomError("Only the host can invite listeners.", 403)
            name = profile_store.get(g.user)['name']
            request_id = rooms.poke(g.user, name, target, key)
        return jsonify(id=request_id), 201

    @app.delete('/api/listening/pokes/<key>')
    def dismiss_listening_poke(key):
        rooms.dismiss_poke(g.user, key)
        return jsonify(ok=True)

    @app.route('/api/listening/rooms', methods=['GET', 'POST'])
    def listening_rooms():
        if request.method == 'GET':
            return jsonify(rooms=rooms.list())
        name = profile_store.get(g.user)['name'] if profile_store is not None else g.user
        return jsonify(room=rooms.create(identity(), name, body(1048576))), 201

    @app.post('/api/listening/rooms/<key>/join')
    def join_listening_room(key):
        return jsonify(room=rooms.join(key, identity()))

    @app.route('/api/listening/rooms/<key>', methods=['GET', 'PUT', 'DELETE'])
    def listening_room(key):
        if request.method == 'DELETE':
            rooms.leave(key, identity())
            return jsonify(left=True)
        known = request.args.get('queue_revision', type=int, default=0)
        result = rooms.update(key, identity(), body(1048576)) if request.method == 'PUT' else rooms.read(key, identity(), known)
        return jsonify(room=result)
