"""Server-side playback snapshot, ownership and takeover tests."""
import unittest
from unittest.mock import Mock

from music_web.playback_devices import DeviceError, PlaybackDevices
import test_family_profiles as family
from test_music_web import Base
from test_playback_devices import Clock, OTHER, PC, PHONE, RESUME


QUEUE = {key: RESUME[key] for key in ('track_ids', 'index')}
TRACK = dict(id=QUEUE['track_ids'][QUEUE['index']], title='Song', channel='Artist')


class Takeover(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.devices = PlaybackDevices(self.clock)

    def check_in(self, device=PC, status='playing', position=42.5, track=TRACK, **fields):
        return self.devices.report('me', device, dict(name=device, status=status, **fields),
                                   status != 'paused', track, position)

    def start(self, status='playing', **fields):
        epoch = self.check_in(status=status, queue=QUEUE, queue_rev=1, epoch=0, local_play=True, **fields)[2]
        self.check_in(PHONE, status='paused', track=None)
        return epoch

    def takeover(self):
        return self.devices.takeover('me', PC, PHONE)

    def assert_owner(self, device, epoch):
        self.assertEqual(self.devices.active['me'], dict(id=device, epoch=epoch))
        self.assertEqual([d['id'] for d in self.devices.list('me') if d['active']], [device])

    def test_paused_snapshot_keeps_track_position_and_queue(self):
        self.start(duration=100)
        self.clock.now = 3
        self.check_in(status='paused', track=None, position=None, queue_rev=1)
        self.clock.now = 8
        row = self.devices.list('me', PC)[0]
        self.assertEqual((row['status'], row['duration'], row['queue_rev'], row['track'], row['position'], row['age']),
                         ('paused', 100, 1, TRACK, 42.5, 5))
        sent = self.takeover()
        command = self.check_in(PHONE, 'paused', epoch=1)[0]
        self.assertFalse(command['playing'])
        self.assertEqual(command['resume'], RESUME)
        self.assert_owner(PC, 1)
        self.assertIsNone(self.check_in(PHONE, 'playing', acks=[sent['id']])[0])
        self.assertIsNone(self.check_in(PHONE, 'paused', track=None, position=None)[0])
        self.assert_owner(PC, 1)
        self.assertIsNone(self.check_in(PHONE, 'paused')[0])
        self.assert_owner(PHONE, 2)
        self.assertFalse(self.check_in(status='paused')[0]['playing'])

    def test_playing_position_advances_and_clamps_while_buffering_stays_put(self):
        for status, duration, expected in [('playing', 100, 52.5), ('playing', 50, 50), ('buffering', 100, 42.5)]:
            with self.subTest(status=status, duration=duration):
                self.setUp()
                self.start(status, duration=duration)
                self.clock.now = 10
                sent = self.takeover()
                command, _, epoch = self.check_in(PHONE, 'paused')
                self.assertEqual((command['id'], command['action'], epoch), (sent['id'], 'play', 1))
                self.assertEqual(command['resume'], dict(**QUEUE, position=expected))
                self.assertTrue(command['playing'])
                self.assertIsNone(self.check_in(PHONE, 'playing', position=expected, acks=[sent['id']])[0])
                self.assert_owner(PHONE, 2)

    def test_takeover_play_retries_after_a_lost_response_until_target_acks(self):
        self.start()
        sent = self.takeover()
        first, _, epoch = self.check_in(PHONE, 'paused', sequence=1)
        self.assertEqual((first['id'], first['action'], first['epoch']), (sent['id'], 'play', epoch))
        self.assertIsNone(self.check_in(acks=[sent['id']])[0])
        self.assertEqual(self.check_in(PHONE, 'paused', sequence=2, acks=['unknown'])[0], first)
        self.assertEqual(self.check_in(PHONE, 'playing', sequence=3, epoch=epoch, local_play=True)[0], first)
        self.assert_owner(PC, epoch)
        self.assertIsNone(self.check_in(PHONE, 'playing', sequence=3, acks=[sent['id']])[0])
        self.assert_owner(PC, epoch)
        self.assertIsNone(self.check_in(PHONE, 'playing', sequence=4, acks=[sent['id']])[0])
        self.assertIsNone(self.check_in(PHONE, 'playing', sequence=5, acks=[sent['id']])[0])
        self.assert_owner(PHONE, epoch + 1)

    def test_timeout_keeps_source_ownership_and_playback_with_or_without_ack(self):
        for source_status in ('playing', 'paused'):
            for acked in (True, False):
                with self.subTest(source_status=source_status, acked=acked):
                    self.setUp()
                    epoch = self.start(source_status)
                    sent = self.takeover()
                    self.check_in(PHONE, 'paused', track=None, epoch=epoch)
                    self.clock.now += 14
                    command = self.check_in(PHONE, 'buffering', acks=[sent['id']] if acked else [])[0]
                    self.assertEqual(command is None, acked)
                    self.assertIsNone(self.check_in(status=source_status)[0])
                    self.assertEqual(self.devices.handoff_status('me', sent['id'])['state'], 'pending')
                    self.clock.now += 1
                    self.assertEqual(self.devices.handoff_status('me', sent['id'])['state'], 'failed')
                    self.assertIsNone(self.devices.handoffs['me', sent['id']]['command'])
                    self.assertIsNone(self.check_in(status=source_status)[0])
                    late = self.check_in(PHONE, source_status, acks=[sent['id']])[0]
                    self.assertTrue(late is None or late['action'] == 'pause')
                    self.assert_owner(PC, epoch)
                    self.assertEqual(self.devices.list('me', PC)[0]['status'], source_status)

    def test_transfer_and_takeover_create_the_same_handoff_and_play_command(self):
        expected = {'from': PC, 'to': PHONE, 'resume': RESUME, 'playing': False, 'state': 'pending', 'created': 0}
        commands = []
        for method in ('transfer', 'takeover'):
            self.setUp()
            self.start('paused')
            sent = (self.devices.transfer('me', PC, PHONE, RESUME, False)
                    if method == 'transfer' else self.takeover())
            record = self.devices.handoffs['me', sent['id']]
            self.assertEqual(record['id'], sent['id'])
            self.assertEqual({k: record[k] for k in expected}, expected)
            command = self.check_in(PHONE, 'paused')[0]
            self.assertEqual(command.pop('id'), sent['id'])
            commands.append(command)
        self.assertEqual(commands[0], commands[1])

    def test_replacement_handoff_rejects_the_superseded_ack(self):
        self.start()
        first = self.takeover()['id']
        self.check_in(PHONE, 'paused', epoch=1)
        second = self.devices.transfer('me', PC, PHONE, RESUME, True)['id']
        self.assertEqual(self.devices.handoff_status('me', first)['state'], 'failed')
        self.assertEqual(self.check_in(PHONE, acks=[first])[0]['id'], second)
        self.assertEqual(self.check_in(PHONE, acks=[first])[0]['id'], second)
        self.assert_owner(PC, 1)
        self.check_in(PHONE, acks=[second])
        self.assert_owner(PHONE, 2)

    def test_failed_return_handoff_preserves_the_outstanding_source_pause(self):
        self.start()
        first = self.takeover()['id']
        self.check_in(PHONE, 'paused')
        self.check_in(PHONE, acks=[first], queue=QUEUE)
        pause = self.check_in()[0]
        second = self.devices.takeover('me', PHONE, PC)['id']
        self.assertEqual(self.check_in()[0]['id'], second)
        self.clock.now += 15
        self.assertEqual(self.check_in(status='paused')[0], pause)
        self.assertEqual(self.devices.handoff_status('me', second)['state'], 'failed')
        self.assert_owner(PHONE, 2)

    def test_ack_waits_for_fresh_matching_playback_before_presence_or_pause(self):
        self.start()
        self.devices.presence = presence = Mock()
        sent = self.devices.transfer('me', PC, PHONE, RESUME, True)
        self.check_in(PHONE, 'playing', acks=[])
        self.check_in(PHONE, 'buffering', acks=[sent['id']])
        for fields in (dict(track=dict(id=QUEUE['track_ids'][0])), dict(position=55), dict(position=None)):
            self.assertIsNone(self.check_in(PHONE, 'playing', **fields)[0])
            self.assert_owner(PC, 1)
        presence.presence.assert_not_called()
        self.assertIsNone(self.check_in()[0])
        self.assertIsNone(self.check_in(PHONE, 'playing', position=45)[0])
        presence.presence.assert_called_with(('me', PHONE), 'listening', self.devices.ONLINE_SECONDS)
        self.assert_owner(PHONE, 2)

    def test_new_owner_replaces_pending_pause_and_pauses_all_other_players(self):
        self.start()
        sent = self.takeover()
        self.assertEqual(self.check_in(PHONE)[0]['id'], sent['id'])
        self.check_in(PHONE, acks=[sent['id']])
        old_pause, _, transfer_epoch = self.check_in()
        self.assertEqual(old_pause['device_id'], PHONE)

        _, _, epoch = self.check_in(OTHER, epoch=transfer_epoch, local_play=True)
        self.assertEqual(epoch, transfer_epoch + 1)
        for device in (PC, PHONE):
            with self.subTest(device=device):
                pause, _, reported_epoch = self.check_in(device, epoch=transfer_epoch, acks=[old_pause['id']])
                self.assertEqual((pause['action'], pause['device_id'], pause['epoch'], reported_epoch),
                                 ('pause', OTHER, epoch, epoch))
                self.assertNotEqual(pause['id'], old_pause['id'])
        self.assertIsNone(self.check_in(OTHER)[0])

    def test_retained_pause_retries_until_source_acknowledges_it(self):
        epoch = self.start()
        sent = self.takeover()
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['action'], 'play')
        self.check_in(PHONE, acks=[sent['id']])
        pause, _, takeover_epoch = self.check_in(epoch=epoch, local_play=True)
        self.assertEqual((pause['action'], pause['device_id'], takeover_epoch), ('pause', PHONE, epoch + 1))
        self.assertEqual(self.check_in(acks=['unknown'], status='paused')[0], pause)
        self.assertIsNone(self.check_in(status='paused', acks=[pause['id']])[0])
        self.assertIsNone(self.check_in(status='paused', acks=[pause['id']])[0])
        self.assertIsNone(self.check_in(epoch=takeover_epoch, local_play=True)[0])
        self.assertEqual(self.devices.active['me']['id'], PC)

    def test_retained_pause_expires_and_stale_device_does_not_extrapolate(self):
        self.start()
        self.clock.now = 16
        self.check_in(PHONE, 'paused')
        self.assertEqual([row['id'] for row in self.devices.list('me')], [PHONE])
        sent = self.takeover()
        self.assertIs(sent['source_paused'], False)
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['resume'], RESUME)
        self.check_in(PHONE, acks=[sent['id']])
        self.clock.now += 30
        self.assertEqual(self.check_in(status='paused')[0]['action'], 'pause')
        self.clock.now += 1
        self.assertIsNone(self.check_in(status='paused')[0])

    def test_queue_edits_and_unavailable_snapshots(self):
        self.start()
        self.check_in(queue_rev=2, queue=dict(QUEUE, index=0), track=None, position=1)
        self.check_in(queue_rev=2, track=None, position=2)
        self.takeover()
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['resume'], dict(QUEUE, index=0, position=2))

        for update in (dict(queue_rev=2), dict(queue_rev=2, queue=dict(track_ids=[], index=-1))):
            with self.subTest(update=update):
                self.setUp()
                self.start()
                self.check_in(**update)
                with self.assertRaises(DeviceError):
                    self.takeover()

    def test_index_only_update_preserves_queue_ids_and_revision_for_takeover(self):
        self.start(status='paused', sequence=1)
        self.check_in(status='paused', queue_rev=1, queue=dict(index=0), sequence=2, track=None, position=7)
        self.check_in(status='paused', queue_rev=1, sequence=3, track=None, position=None)

        self.assertEqual(self.devices.list('me', PC)[0]['queue_rev'], 1)
        self.takeover()
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['resume'], dict(QUEUE, index=0, position=7))

    def test_confirmed_queue_can_return_after_receiver_advances_without_controller(self):
        order = ['abcdefghijk', 'local-0123456789abcdef', 'ABCDEFGHIJK', '01234567890']
        queue = dict(track_ids=order, index=1, shuffle=True, repeat_mode='all', autoplay=True)
        next_track = dict(id=order[2], title='Next song', channel='Artist')
        self.check_in(queue=queue, queue_rev=1, sequence=1, epoch=0, local_play=True)
        self.check_in(PHONE, 'paused', queue=dict(track_ids=['01234567890'], index=0), queue_rev=1, sequence=1)

        sent = self.takeover()['id']
        command = self.check_in(PHONE, 'paused', queue_rev=1, sequence=2, epoch=1)[0]
        self.assertEqual(command['resume'], dict(queue, position=42.5))
        self.assert_owner(PC, 1)
        self.assertIsNone(self.check_in(PHONE, queue=queue, queue_rev=2, sequence=3, epoch=1, acks=[sent])[0])
        self.assertEqual(self.devices.handoff_status('me', sent)['state'], 'ready')
        self.assert_owner(PHONE, 2)

        command, controls, epoch = self.check_in(PHONE, position=1, track=next_track, queue=dict(index=2),
                                               queue_rev=3, sequence=4, epoch=2, background=True)
        self.assertEqual((command, controls, epoch), (None, [], 2))
        returned = self.devices.takeover('me', PHONE, PC)['id']
        command = self.check_in(status='paused', queue_rev=1, sequence=2, epoch=1)[0]
        self.assertEqual(command['resume'], dict(queue, index=2, position=1))
        self.assert_owner(PHONE, 2)
        self.check_in(position=1, track=next_track, queue=dict(queue, index=2), queue_rev=2,
                      sequence=3, epoch=2, acks=[returned])
        self.assert_owner(PC, 3)
        self.assertEqual(self.check_in(PHONE, queue_rev=3, sequence=5, epoch=2)[0]['action'], 'pause')

    def test_queue_modes_are_validated(self):
        self.start()
        for field, invalid in [('shuffle', 1), ('repeat_mode', 'twice'), ('autoplay', 'false')]:
            with self.subTest(field=field), self.assertRaisesRegex(DeviceError, 'Invalid playback queue'):
                self.check_in(queue={**QUEUE, field: invalid})

    def test_index_only_updates_require_an_integer_within_the_stored_queue(self):
        self.start()
        for queue in (dict(index=-1), dict(index=2), dict(index=True), dict(index=0.0), {}):
            with self.subTest(queue=queue), self.assertRaisesRegex(DeviceError, 'Invalid playback queue index'):
                self.check_in(queue_rev=1, queue=queue)
        self.assertEqual(self.devices.devices['me', PC]['queue'], QUEUE)

    def test_takeover_limits_devices_to_the_profile_and_excludes_followers(self):
        self.start()
        self.devices.report('other', OTHER, {}, False)
        for source, target in ((PC, OTHER), (OTHER, PHONE), (PC, PC), ([], PHONE)):
            with self.subTest(source=source, target=target), self.assertRaises(DeviceError):
                self.devices.takeover('me', source, target)
        self.check_in(PHONE, 'paused', following_host=True)
        with self.assertRaises(DeviceError):
            self.takeover()
        self.clock.now = 61
        self.check_in(PHONE, 'paused')
        with self.assertRaises(DeviceError):
            self.takeover()

    def test_invalid_snapshot_fields_are_rejected(self):
        for fields in (dict(queue=dict(QUEUE, index=2)), dict(queue=dict(track_ids=['bad'], index=0)),
                       dict(queue=dict(track_ids=['abcdefghijk'] * 1001, index=0)), dict(queue_rev=True),
                       dict(duration=float('nan')), dict(status='stopped'), dict(epoch=-1), dict(acks='id')):
            with self.subTest(fields=fields), self.assertRaises(DeviceError):
                self.check_in(**fields)


class TakeoverRoutes(Base):
    extra = {'FAMILY_PROFILES': True}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def test_index_only_update_requests_a_full_queue_when_the_base_is_unavailable(self):
        client, token = self.select()

        def report(queue, sequence, **fields):
            return self.post(client, token, '/api/playback/activity', json=dict(
                device_id=PC, playing=False, device_info=dict(name=PC, sequence=sequence, queue=queue, **fields)))

        compact = dict(index=0)
        needs_full_queue = (400, 'Send the full playback queue.')
        response = report(compact, 1, queue_rev=2)
        self.assertEqual((response.status_code, response.json['error']), needs_full_queue)
        self.assertEqual(report(QUEUE, 1, queue_rev=2).status_code, 200)

        for fields in (dict(queue_rev=1), {}):
            with self.subTest(fields=fields):
                response = report(compact, 2, **fields)
                self.assertEqual((response.status_code, response.json['error']), needs_full_queue)

        self.assertEqual(report(dict(QUEUE, index=0), 2, queue_rev=3).status_code, 200)
        self.assertEqual(report(dict(index=1), 3, queue_rev=3).status_code, 200)

    def test_activity_and_takeover_with_server_epoch_and_command_acks(self):
        client, token = self.select()

        def report(device, playing=False, **fields):
            response = self.post(client, token, '/api/playback/activity',
                                 json=dict(device_id=device, playing=playing, device_info=dict(name=device), **fields))
            self.assertEqual(response.status_code, 200)
            return response.json

        first = report(PC, epoch=0, local_play=True, status='paused', duration=95,
                       queue=QUEUE, queue_rev=1, track=TRACK, position=42.5)
        self.assertEqual(first['epoch'], 1)
        self.assertIsNone(report(PHONE)['command'])
        rows = self.go(client, 'GET', '/api/playback/devices?device_id=' + PC).json['devices']
        self.assertEqual((rows[0]['status'], rows[0]['duration'], rows[0]['queue_rev'], rows[0]['track']),
                         ('paused', 95, 1, TRACK))
        response = self.post(client, token, '/api/playback/takeover', json={'from': PC, 'to': PHONE})
        self.assertEqual(response.status_code, 202)
        path = '/api/playback/handoff/' + response.json['id']
        self.assertEqual(self.go(client, 'GET', path).json, dict(state='pending', target=PHONE))
        other, _ = self.select('sample-b')
        self.assertEqual(self.go(other, 'GET', path).status_code, 404)
        target = report(PHONE)
        self.assertEqual((target['epoch'], target['command']['id'], target['command']['resume']),
                         (1, response.json['id'], RESUME))
        self.assertEqual(report(PHONE)['command'], target['command'])
        self.assertIsNone(report(PHONE, epoch=1, acks=[response.json['id']])['command'])
        self.assertEqual(self.go(client, 'GET', path).json['state'], 'pending')
        self.assertIsNone(report(PC)['command'])
        self.assertEqual(report(PHONE, epoch=1, track=TRACK, position=42.5)['epoch'], 2)
        self.assertEqual(self.go(client, 'GET', path).json, dict(state='ready', target=PHONE))
        source = report(PC, epoch=1)
        self.assertEqual(source['command']['action'], 'pause')
        self.assertIsNone(report(PC, epoch=source['epoch'], acks=[source['command']['id']])['command'])

    def test_both_handoff_routes_reject_a_listen_together_host(self):
        client, token = self.select()
        for device in (PC, PHONE):
            self.assertEqual(self.post(client, token, '/api/playback/activity', json=dict(
                device_id=device, playing=False, device_info=dict(name=device, queue=QUEUE))).status_code, 200)
        room = self.post(client, token, '/api/listening/rooms', json=dict(
            queue=[TRACK], index=0, position=1, playing=True, auto_dj=False, crossfading=False))
        self.assertEqual(room.status_code, 201)
        for route, fields in (('takeover', {}), ('transfer', dict(resume=RESUME, playing=True))):
            with self.subTest(route=route):
                response = self.post(client, token, '/api/playback/' + route, json={'from': PC, 'to': PHONE, **fields})
                self.assertEqual((response.status_code, response.json['error']), (409, 'Leave Listen Together first.'))
