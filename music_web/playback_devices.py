"""Devices a profile is listening on, and handing playback from one to another.

Each open app reports itself with its playback check-in (/api/playback/activity). A transfer
leaves a command for the target device, which receives it in the reply to its next check-in.
Nothing is kept on disk: a device drops off the list when it stops checking in.
"""
import math
import re
import secrets
import threading
import time

DEVICE = re.compile(r'[a-f0-9]{32}')
RECORDING = re.compile(r'(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})')
KINDS = ('windows', 'mac', 'android', 'iphone', 'ipad', 'other')


class DeviceError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def clean_name(value):
    if not isinstance(value, str): return ''
    return re.sub(r'[\x00-\x1f\x7f]+', ' ', value).strip()[:60]


class PlaybackDevices:
    # A device that has not checked in for this long is offline; a command it never collects expires.
    ONLINE_SECONDS = 15
    COMMAND_SECONDS = 30
    MAX_DEVICES = 512

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.devices = {}
        self.commands = {}

    def _expire(self, now):
        for key in [k for k, d in self.devices.items() if now - d['at'] > self.ONLINE_SECONDS * 4]: del self.devices[key]
        for key in [k for k, c in self.commands.items() if now - c['at'] > self.COMMAND_SECONDS]: del self.commands[key]

    def report(self, user, device_id, info, playing, track=None, position=None):
        """Record a check-in; returns a waiting transfer command for this device, or None."""
        if not DEVICE.fullmatch(device_id or ''): raise DeviceError('Invalid device id.')
        # Apps older than "Connect to a device" send no device_info and cannot take playback over.
        if not isinstance(info, dict): return None
        kind = info.get('kind') if info.get('kind') in KINDS else 'other'
        position = position if type(position) in (int, float) and math.isfinite(position) and 0 <= position <= 86400 else None
        with self.lock:
            now = self.clock()
            self._expire(now)
            key = (user, device_id)
            if key not in self.devices and len(self.devices) >= self.MAX_DEVICES: raise DeviceError('Too many active players.', 429)
            self.devices[key] = dict(id=device_id, name=clean_name(info.get('name')) or 'Unnamed device', kind=kind,
                                     playing=bool(playing), track=track if playing else None, position=position, at=now)
            command = self.commands.pop(key, None)
            return {k: v for k, v in command.items() if k != 'at'} if command else None

    def list(self, user, device_id=''):
        """Online devices of one profile, the asking device first."""
        with self.lock:
            now = self.clock()
            self._expire(now)
            rows = [dict(id=d['id'], name=d['name'], kind=d['kind'], playing=d['playing'], track=d['track'], this=d['id'] == device_id)
                    for (owner, _), d in self.devices.items() if owner == user and now - d['at'] <= self.ONLINE_SECONDS]
        return sorted(rows, key=lambda d: (not d['this'], not d['playing'], d['name'].casefold()))

    def transfer(self, user, source, target, resume, playing):
        """Leave a play command for the target device with the source's queue and position."""
        if not DEVICE.fullmatch(source or '') or not DEVICE.fullmatch(target or ''): raise DeviceError('Choose a device.')
        if source == target: raise DeviceError('Already playing on this device.')
        if type(playing) is not bool: raise DeviceError('Invalid playback state.')
        if not isinstance(resume, dict): raise DeviceError('Play a song first.')
        ids, index, position = resume.get('track_ids'), resume.get('index'), resume.get('position')
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 1000 or any(not isinstance(i, str) or not RECORDING.fullmatch(i) for i in ids)
                or type(index) is not int or not 0 <= index < len(ids)
                or type(position) not in (int, float) or not math.isfinite(position) or not 0 <= position <= 86400):
            raise DeviceError('Play a song first.')
        with self.lock:
            now = self.clock()
            self._expire(now)
            device = self.devices.get((user, target))
            if not device or now - device['at'] > self.ONLINE_SECONDS: raise DeviceError('That device is offline. Open FamilyHub on it and try again.', 409)
            sender = self.devices.get((user, source))
            command = dict(id=secrets.token_hex(8), action='play', from_name=sender['name'] if sender else '',
                           resume=dict(track_ids=list(ids), index=index, position=float(position)), playing=playing, at=now)
            self.commands[(user, target)] = command
            return dict(id=command['id'], target=device['name'])


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
        return jsonify(devices.transfer(g.user, data.get('from'), data.get('to'), data.get('resume'), data.get('playing', True))), 202
