"""Devices a profile is listening on, and handing playback from one to another.

Each open app reports itself with its playback check-in (/api/playback/activity).
Both handoff routes keep the source in its current state until the destination confirms
playback. Only then does the source receive its retained pause command.
"""
import re
import secrets
import threading
import time

DEVICE = re.compile(r'[a-f0-9]{32}')
RECORDING = re.compile(r'(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})')
KINDS = ('windows', 'mac', 'android', 'iphone', 'ipad', 'other')
# Remote control from the device that sent its playback away.
ACTIONS = ('play', 'pause', 'next', 'previous', 'seek')
STATUSES = ('playing', 'paused', 'buffering')


class DeviceError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def clean_name(value):
    if not isinstance(value, str): return ''
    return re.sub(r'[\x00-\x1f\x7f]+', ' ', value).strip()[:60]


def valid_device(value):
    return isinstance(value, str) and bool(DEVICE.fullmatch(value))


def valid_seconds(value):
    return type(value) in (int, float) and 0 <= value <= 86400


def playback_queue(value):
    if isinstance(value, dict):
        ids, index = value.get('track_ids'), value.get('index')
        modes = {key: value[key] for key in ('shuffle', 'repeat_mode', 'autoplay') if key in value}
        if (isinstance(ids, list) and len(ids) <= 1000
                and all(isinstance(item, str) and RECORDING.fullmatch(item) for item in ids)
                and type(index) is int and (0 <= index < len(ids) if ids else index == -1)
                and type(modes.get('shuffle', False)) is bool
                and modes.get('repeat_mode', 'off') in ('off', 'all', 'one')
                and type(modes.get('autoplay', True)) is bool):
            return dict(track_ids=list(ids), index=index, **modes)
    raise DeviceError('Invalid playback queue.')


def current_recording(queue):
    return queue['track_ids'][queue['index']] if queue and queue['track_ids'] else None


class PlaybackDevices:
    # A device that has not checked in for this long is offline; a command it never collects expires.
    # Native clients check in every five seconds; allow two missed heartbeats.
    ONLINE_SECONDS = 15
    RESUME_TOLERANCE_SECONDS = 5
    HANDOFF_HISTORY_SECONDS = 300
    COMMAND_SECONDS = 30
    MAX_DEVICES = 512
    MAX_EXPIRED_ACTIVATIONS = 512

    def __init__(self, clock=time.monotonic, presence=None):
        self.clock = clock
        self.presence = presence
        self.lock = threading.Lock()
        self.devices = {}
        self.expired_activations = {}
        self.pauses = {}
        self.controls = {}
        self.active = {}
        self.handoffs = {}
        self.pending = {}

    def _expire(self, now):
        for user, handoff in list(self.pending.items()):
            if now - handoff['created'] >= self.ONLINE_SECONDS:
                self._finish_handoff(user, 'failed')
        for key in [k for k, h in self.handoffs.items() if now - h['created'] >= self.HANDOFF_HISTORY_SECONDS]:
            del self.handoffs[key]
        for key in [k for k, d in self.devices.items() if now - d['at'] > self.ONLINE_SECONDS * 4]:
            activation = self.devices.pop(key)['activation']
            if activation:
                self.expired_activations[key] = activation
                if len(self.expired_activations) > self.MAX_EXPIRED_ACTIVATIONS:
                    del self.expired_activations[next(iter(self.expired_activations))]
        for key in [k for k, c in self.pauses.items() if now - c['at'] > self.COMMAND_SECONDS]: del self.pauses[key]
        for key in list(self.controls):
            self.controls[key] = [c for c in self.controls[key] if now - c['at'] <= self.COMMAND_SECONDS]
            if not self.controls[key]: del self.controls[key]

    def _presence(self, user, device, playing, session=None, background=False, room_heartbeat=None):
        if self.presence:
            key = (user, device)
            if playing or not background:
                self.presence.presence(key, 'listening' if playing else 'online-idle', self.ONLINE_SECONDS)
            if not playing:
                self.presence.pause(key, session)
            elif room_heartbeat is not None:
                room_heartbeat(session)

    def report(self, user, device_id, info, playing, track=None, position=None, session=None,
               background=False, room_heartbeat=None):
        """Record a check-in and return its handover command, controls and ownership epoch."""
        if not valid_device(device_id): raise DeviceError('Invalid device id.')
        # Apps older than "Connect to a device" send no device_info and cannot take playback over.
        if not isinstance(info, dict):
            with self.lock:
                self._presence(user, device_id, playing, session, background, room_heartbeat)
                return None, [], self.active.get(user, {}).get('epoch', 0)
        activation, sequence = info.get('activation', 0), info.get('sequence', 0)
        epoch, queue_rev = info.get('epoch'), info.get('queue_rev')
        if any(type(value) is not int or not 0 <= value < 2 ** 63
               for value in (activation, sequence, info.get('epoch', 0), info.get('queue_rev', 0))):
            raise DeviceError('Invalid playback activity ordering.')
        following = info.get('following_host', False)
        remote = info.get('remote_device', '')
        local_play = info.get('local_play')
        if type(following) is not bool or type(info.get('local_play', False)) is not bool or not isinstance(remote, str) or remote and not valid_device(remote):
            raise DeviceError('Invalid playback device state.')
        status = info.get('status', 'playing' if playing else 'paused')
        duration = info.get('duration')
        if status not in STATUSES or duration is not None and not valid_seconds(duration):
            raise DeviceError('Invalid playback status or duration.')
        raw_queue = info.get('queue')
        index_only = isinstance(raw_queue, dict) and 'track_ids' not in raw_queue
        queue = playback_queue(raw_queue) if 'queue' in info and not index_only else None
        acks = info.get('acks', [])
        if (not isinstance(acks, list) or len(acks) > 100
                or any(not isinstance(ack, str) or len(ack) > 64 for ack in acks)):
            raise DeviceError('Invalid playback command acknowledgements.')
        kind = info.get('kind') if info.get('kind') in KINDS else 'other'
        position = position if valid_seconds(position) else None
        with self.lock:
            now = self.clock()
            self._expire(now)
            key = (user, device_id)
            if key not in self.devices and len(self.devices) >= self.MAX_DEVICES: raise DeviceError('Too many active players.', 429)
            previous = self.devices.get(key, {})
            active = self.active.get(user)
            current_epoch = active['epoch'] if active else 0
            previous_queue = previous.get('queue')
            previous_rev = previous.get('queue_rev', 0)
            if index_only:
                if previous_queue is None or queue_rev is None or queue_rev < previous_rev:
                    raise DeviceError('Send the full playback queue.')
                index = raw_queue.get('index')
                if type(index) is not int or not 0 <= index < len(previous_queue['track_ids']):
                    raise DeviceError('Invalid playback queue index.')
                queue = dict(previous_queue, index=index)
            if previous.get('sequence', 0) and sequence <= previous['sequence']:
                return None, [], current_epoch
            previous_activation = previous.get('activation', 0) or self.expired_activations.pop(key, 0)
            if queue_rev is None:
                queue_rev = previous_rev + (queue is not None and queue != previous_queue)
            if queue_rev < previous_rev or queue is None and queue_rev == previous_rev:
                queue, queue_rev = previous_queue, previous_rev
            reported_track, reported_position = track, position
            old_track = previous.get('track')
            same_track = (current_recording(queue) == current_recording(previous_queue)
                          and (track is None or old_track is not None and track['id'] == old_track['id']))
            if status == 'paused' and same_track:
                if track is None:
                    track = old_track
                if position is None:
                    position = previous.get('position')
            # Epoch-aware clients omit empty ack lists. Remember their protocol across heartbeats.
            supports_acks = previous.get('supports_acks', False) or epoch is not None or local_play is not None or 'acks' in info
            device = self.devices[key] = dict(
                id=device_id, name=clean_name(info.get('name')) or 'Unnamed device', kind=kind,
                playing=bool(playing), status=status, track=track, position=position, at=now,
                duration=duration if duration is not None or not same_track else previous.get('duration'),
                queue=queue, queue_rev=queue_rev, session=session, following=following,
                sequence=sequence, activation=activation or previous_activation, supports_acks=supports_acks)
            handoff = self.pending.get(user)
            receiving = handoff is not None and handoff['to'] == device_id
            # Legacy clients use activation as a per-device action token.
            if local_play is None:
                local_play = bool(activation and activation != previous_activation)
            epoch_matches = epoch == current_epoch or (epoch is None and 'local_play' not in info)
            if receiving:
                receiving = not self._confirm_handoff(user, handoff, device, reported_track, reported_position, acks, now)
            elif not following and not remote and local_play and epoch_matches:
                self._activate(user, device, now)
                self.controls.pop(key, None)
            active = self.active.get(user)
            current_epoch = active['epoch'] if active else 0
            command = self.pauses.get(key)
            if command and command['id'] in acks:
                self.pauses.pop(key)
                command = None
            if receiving:
                command = handoff['command']
            controls = [{k: v for k, v in c.items() if k != 'at'} for c in self.controls.pop(key, [])]
            target = self.devices.get((user, active['id'])) if active else None
            if (not command and not receiving and not following and target and not target['following'] and active['id'] != device_id
                    and now - target['at'] <= self.ONLINE_SECONDS and (playing or remote and remote != active['id'])):
                command = self._pause_command('active-' + str(current_epoch), target, current_epoch)
            if command and command['action'] == 'pause':
                controls = []
            if not receiving:
                listening = playing and (background or not following) and not (command and command['action'] == 'pause')
                self._presence(user, device_id, listening, session, background, room_heartbeat)
            return ({k: v for k, v in command.items() if k != 'at'} if command else None), controls, current_epoch

    def _finish_handoff(self, user, state):
        handoff = self.pending.pop(user)
        handoff['state'] = state
        handoff['command'] = None

    def _confirm_handoff(self, user, handoff, device, track, position, acks, now):
        # The collecting check-in describes playback BEFORE delivery, even if it already matches.
        if not handoff['delivered']:
            handoff['delivered'] = True
            return False
        if handoff['id'] in acks:
            handoff['command'] = None
        legacy = not device['supports_acks']
        resume = handoff['resume']
        if (device['following'] or (handoff['command'] is not None and not legacy)
                or not track or track['id'] != current_recording(resume)
                or device['playing'] != handoff['playing']
                or device['status'] != ('playing' if handoff['playing'] else 'paused')):
            return False
        if position is None:
            # Early players can identify the loaded track without reporting a playhead.
            if not legacy:
                return False
        elif abs(position - resume['position']) > self.RESUME_TOLERANCE_SECONDS:
            return False
        self._finish_handoff(user, 'ready')
        epoch = self._activate(user, device, now)['epoch']
        source_key = (user, handoff['from'])
        self.controls.pop(source_key, None)
        self.pauses[source_key] = dict(self._pause_command(secrets.token_hex(8), device, epoch), at=now)
        return True

    def _activate(self, user, target, now):
        if user in self.pending:
            self._finish_handoff(user, 'failed')
        epoch = self.active.get(user, {}).get('epoch', 0) + 1
        active = self.active[user] = dict(id=target['id'], epoch=epoch)
        for key in [key for key in self.pauses if key[0] == user]:
            if key[1] == target['id']:
                del self.pauses[key]
            else:
                self.pauses[key] = dict(self._pause_command(secrets.token_hex(8), target, epoch), at=now)
        return active

    @staticmethod
    def _pause_command(command_id, target, epoch):
        return dict(id=command_id, action='pause', device_id=target['id'], from_name=target['name'],
                    playing=target['playing'], position=target['position'], track=target['track'],
                    status=target['status'], duration=target['duration'], epoch=epoch, activation=epoch)

    def list(self, user, device_id=''):
        """Online devices of one profile, the asking device first."""
        with self.lock:
            now = self.clock()
            self._expire(now)
            rows = [dict(id=d['id'], name=d['name'], kind=d['kind'], playing=d['playing'], track=d['track'], position=d['position'],
                         status=d['status'], duration=d['duration'], queue_rev=d['queue_rev'],
                         age=round(now - d['at'], 1), this=d['id'] == device_id,
                         active=self.active.get(user, {}).get('id') == d['id'])
                    for (owner, _), d in self.devices.items() if owner == user and now - d['at'] <= self.ONLINE_SECONDS]
        return sorted(rows, key=lambda d: (not d['this'], not d['playing'], d['name'].casefold()))

    def transfer(self, user, source, target, resume, playing, rooms=None):
        if type(playing) is not bool: raise DeviceError('Invalid playback state.')
        if not isinstance(resume, dict): raise DeviceError('Play a song first.')
        queue = playback_queue(resume)
        position = resume.get('position')
        if not queue['track_ids'] or not valid_seconds(position):
            raise DeviceError('Play a song first.')
        return self._start_handoff(user, source, target, dict(**queue, position=position), playing, rooms)

    def takeover(self, user, source, target, rooms=None):
        return self._start_handoff(user, source, target, None, None, rooms)

    def _start_handoff(self, user, source, target, resume, playing, rooms):
        if not valid_device(source) or not valid_device(target) or source == target:
            raise DeviceError('Choose two different devices.')
        with self.lock:
            now = self.clock()
            self._expire(now)
            sender = self.devices.get((user, source))
            device = self.devices.get((user, target))
            if not device or now - device['at'] > self.ONLINE_SECONDS:
                raise DeviceError('That device is offline.', 409)
            active = self.active.get(user)
            if active and active['id'] != source and (user, active['id']) in self.devices:
                raise DeviceError('Playback has moved to another device.', 409)
            if device['following'] or sender and sender['following']:
                raise DeviceError('Leave Listen Together first.', 409)
            if rooms:
                sessions = (sender['session'] if sender else None, device['session'])
                with rooms.lock:
                    rooms.prune()
                    if any(identity == room['host'] or identity in room['members']
                           for identity in sessions for room in rooms.rooms.values()):
                        raise DeviceError('Leave Listen Together first.', 409)
            if resume is None:
                if not sender or not sender['queue'] or not sender['queue']['track_ids']:
                    raise DeviceError('The source device has no playback queue.', 409)
                position = sender['position'] or 0
                age = now - sender['at']
                if sender['status'] == 'playing' and sender['position'] is not None and age <= self.ONLINE_SECONDS:
                    position += age
                position = min(position, sender['duration'] if sender['duration'] is not None else 86400)
                resume = dict(**sender['queue'], position=position)
                playing = sender['status'] != 'paused'
            if user in self.pending:
                self._finish_handoff(user, 'failed')
            command_id = secrets.token_hex(8)
            epoch = active['epoch'] if active else 0
            command = dict(id=command_id, action='play', from_name=sender['name'] if sender else '',
                           resume=resume, playing=playing, epoch=epoch, activation=epoch)
            handoff = {'id': command_id, 'from': source, 'to': target, 'resume': resume, 'playing': playing,
                       'state': 'pending', 'created': now, 'delivered': False, 'command': command}
            self.handoffs[user, command_id] = self.pending[user] = handoff
            self.controls.pop((user, target), None)
            result = dict(id=command_id, target=device['name'])
            if sender and now - sender['at'] > self.ONLINE_SECONDS:
                result['source_paused'] = False
            return result

    def handoff_status(self, user, command_id):
        with self.lock:
            self._expire(self.clock())
            handoff = self.handoffs.get((user, command_id))
            if handoff is None:
                raise DeviceError('Handoff not found.', 404)
            return dict(state=handoff['state'], target=handoff['to'])

    def control(self, user, source, target, action, position=None):
        """Queue a play/pause/next/previous/seek for the device this profile's music plays on."""
        if not valid_device(source) or not valid_device(target) or source == target: raise DeviceError('Choose a device.')
        if action not in ACTIONS: raise DeviceError('Unknown playback action.')
        if action == 'seek' and not valid_seconds(position):
            raise DeviceError('Choose a position in the song.')
        with self.lock:
            now = self.clock()
            self._expire(now)
            device = self.devices.get((user, target))
            if not device or now - device['at'] > self.ONLINE_SECONDS: raise DeviceError('That device is offline.', 409)
            queue = self.controls.setdefault((user, target), [])
            if len(queue) >= 8: queue.pop(0)
            queue.append(dict(id=secrets.token_hex(6), action=action, position=float(position) if action == 'seek' else None, at=now))
            if action in ('play', 'pause') and self.pending.get(user, {}).get('to') != target:
                self._presence(user, target, action == 'play')
            return dict(ok=True)


def register_playback_devices(app, body, devices):
    from flask import g, jsonify, request

    @app.errorhandler(DeviceError)
    def device_error(error): return jsonify(error=str(error)), error.status

    @app.get('/api/playback/devices')
    def playback_devices():
        return jsonify(devices=devices.list(g.user, request.args.get('device_id', '')))

    @app.post('/api/playback/transfer')
    def transfer_playback():
        data = body(65536)
        return jsonify(devices.transfer(g.user, data.get('from'), data.get('to'), data.get('resume'),
                                        data.get('playing', True), app.extensions.get('listening_rooms'))), 202

    @app.get('/api/playback/handoff/<command_id>')
    def playback_handoff(command_id):
        return jsonify(devices.handoff_status(g.user, command_id))

    @app.post('/api/playback/takeover')
    def takeover_playback():
        data = body(4096)
        return jsonify(devices.takeover(g.user, data.get('from'), data.get('to'), app.extensions.get('listening_rooms'))), 202

    @app.post('/api/playback/control')
    def control_playback():
        data = body(4096)
        return jsonify(devices.control(g.user, data.get('from'), data.get('to'), data.get('action'), data.get('position'))), 202
