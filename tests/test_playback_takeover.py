"""Server-side playback snapshot, ownership and takeover tests."""
import unittest

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

    def test_paused_snapshot_keeps_track_position_and_queue(self):
        self.start(duration=100)
        self.clock.now = 3
        self.check_in(status='paused', track=None, position=None, queue_rev=1)
        self.clock.now = 8
        row = self.devices.list('me', PC)[0]
        self.assertEqual((row['status'], row['duration'], row['queue_rev'], row['track'], row['position'], row['age']),
                         ('paused', 100, 1, TRACK, 42.5, 5))
        self.takeover()
        command = self.check_in(PHONE, 'paused')[0]
        self.assertFalse(command['playing'])
        self.assertEqual(command['resume'], RESUME)

    def test_playing_position_advances_and_clamps_while_buffering_stays_put(self):
        for status, duration, expected in [('playing', 100, 52.5), ('playing', 50, 50), ('buffering', 100, 42.5)]:
            with self.subTest(status=status, duration=duration):
                self.setUp()
                self.start(status, duration=duration)
                self.clock.now = 10
                sent = self.takeover()
                command, _, epoch = self.check_in(PHONE, 'paused')
                self.assertEqual((command['id'], command['action'], epoch), (sent['id'], 'play', 2))
                self.assertEqual(command['resume'], dict(**QUEUE, position=expected))
                self.assertTrue(command['playing'])
                self.assertIsNone(self.check_in(PHONE, 'playing', acks=[sent['id']])[0])

    def test_takeover_play_retries_after_a_lost_response_until_target_acks(self):
        self.start()
        sent = self.takeover()
        first, _, epoch = self.check_in(PHONE, 'paused', sequence=1)
        self.assertEqual((first['id'], first['action'], first['epoch']), (sent['id'], 'play', epoch))
        pause, _, _ = self.check_in(acks=[sent['id']])
        self.assertEqual(pause['action'], 'pause')
        self.assertIsNone(self.check_in(status='paused', acks=[pause['id']])[0])
        self.assertEqual(self.check_in(PHONE, 'paused', sequence=2, acks=['unknown'])[0], first)
        self.assertIsNone(self.check_in(PHONE, 'playing', sequence=3, acks=[sent['id']])[0])
        self.assertIsNone(self.check_in(PHONE, 'playing', sequence=4)[0])

    def test_unacknowledged_play_expires_from_the_time_it_was_queued(self):
        self.start()
        sent = self.takeover()
        self.clock.now += 30
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['id'], sent['id'])
        self.clock.now += 1
        self.assertIsNone(self.check_in(PHONE, 'paused')[0])

    def test_new_owner_replaces_pending_pause_and_pauses_all_other_players(self):
        self.start()
        sent = self.takeover()
        old_pause, _, transfer_epoch = self.check_in()
        self.assertEqual(old_pause['device_id'], PHONE)
        self.assertEqual(self.check_in(PHONE)[0]['id'], sent['id'])

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
        self.takeover()
        pause, _, takeover_epoch = self.check_in(epoch=epoch, local_play=True)
        self.assertEqual((pause['action'], pause['device_id'], takeover_epoch), ('pause', PHONE, epoch + 1))
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['action'], 'play')
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
        self.assertIs(self.takeover()['source_paused'], False)
        self.assertEqual(self.check_in(PHONE, 'paused')[0]['resume'], RESUME)
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
        target = report(PHONE)
        self.assertEqual((target['epoch'], target['command']['id'], target['command']['resume']),
                         (2, response.json['id'], RESUME))
        self.assertEqual(report(PHONE)['command'], target['command'])
        self.assertIsNone(report(PHONE, epoch=2, acks=[response.json['id']])['command'])
        source = report(PC, epoch=1)
        self.assertEqual(source['command']['action'], 'pause')
        self.assertIsNone(report(PC, epoch=source['epoch'], acks=[source['command']['id']])['command'])

    def test_takeover_rejects_a_listen_together_host(self):
        client, token = self.select()
        for device in (PC, PHONE):
            self.assertEqual(self.post(client, token, '/api/playback/activity', json=dict(
                device_id=device, playing=False, device_info=dict(name=device, queue=QUEUE))).status_code, 200)
        room = self.post(client, token, '/api/listening/rooms', json=dict(
            queue=[TRACK], index=0, position=1, playing=True, auto_dj=False, crossfading=False))
        self.assertEqual(room.status_code, 201)
        response = self.post(client, token, '/api/playback/takeover', json={'from': PC, 'to': PHONE})
        self.assertEqual((response.status_code, response.json['error']), (409, 'Leave Listen Together first.'))
