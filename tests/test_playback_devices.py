"""Connect to a device: online devices per profile and handing playback over."""
import unittest
from music_web.playback_devices import DeviceError, PlaybackDevices
import test_family_profiles as family
from test_music_web import Base

PC, PHONE, OTHER = 'a' * 32, 'b' * 32, 'c' * 32
RESUME = dict(track_ids=['abcdefghijk', 'local-0123456789abcdef'], index=1, position=42.5)


class Clock:
    def __init__(self): self.now = 0.0
    def __call__(self): return self.now


class Devices(PlaybackDevices):
    def report_command(self, *args): return self.report(*args)[0]


class Registry(unittest.TestCase):
    def setUp(self):
        self.clock = Clock(); self.devices = Devices(self.clock)

    def test_lists_a_profiles_online_devices_with_this_one_first(self):
        self.devices.report('me', PC, dict(name='Desk PC', kind='windows'), True, dict(id='abcdefghijk', title='Song', channel='A'), 10)
        self.devices.report('me', PHONE, dict(name=' Pixel\n', kind='toaster'), False)
        self.devices.report('someone', OTHER, dict(name='Their phone', kind='android'), True)
        self.devices.report('me', OTHER, None, True)
        rows = self.devices.list('me', PHONE)
        self.assertEqual([(r['name'], r['kind'], r['this']) for r in rows], [('Pixel', 'other', True), ('Desk PC', 'windows', False)])
        self.assertEqual(rows[1]['track']['title'], 'Song')
        self.clock.now = 16
        self.assertEqual(self.devices.list('me'), [], 'devices that stop checking in go offline')

    def test_transfer_waits_for_the_targets_next_check_in_once(self):
        self.devices.report('me', PC, dict(name='Desk PC', kind='windows'), True)
        self.devices.report('me', PHONE, dict(name='Pixel', kind='android'), False)
        sent = self.devices.transfer('me', PHONE, PC, RESUME, True)
        self.assertEqual(sent['target'], 'Desk PC')
        self.assertIsNone(self.devices.report_command('me', PHONE, dict(name='Pixel'), False), 'only the target receives it')
        command, _, _ = self.devices.report('me', PC, dict(name='Desk PC', kind='windows'), True)
        self.assertEqual((command['action'], command['from_name'], command['resume'], command['playing']), ('play', 'Pixel', RESUME, True))
        self.assertIsNone(self.devices.report_command('me', PC, dict(name='Desk PC'), True), 'a command is delivered once')
        self.devices.transfer('me', PHONE, PC, RESUME, True); self.clock.now = 31
        self.devices.report('me', PHONE, dict(name='Pixel'), False)
        self.assertIsNone(self.devices.report_command('me', PC, dict(name='Desk PC'), True), 'an uncollected command expires')

    def test_remote_controls_reach_the_target_in_order(self):
        self.devices.report('me', PC, dict(name='Desk PC'), True, dict(id='abcdefghijk', title='Song', channel='A'), 30)
        self.devices.control('me', PHONE, PC, 'pause')
        self.assertEqual(self.devices.list('me')[0]['status'], 'playing', 'the last check-in remains authoritative')
        self.devices.control('me', PHONE, PC, 'seek', 95.5)
        _, controls, _ = self.devices.report('me', PC, dict(name='Desk PC'), False)
        self.assertEqual([(c['action'], c['position']) for c in controls], [('pause', None), ('seek', 95.5)])
        self.assertEqual(self.devices.report('me', PC, dict(name='Desk PC'), False)[1], [])
        self.assertEqual(self.devices.list('me')[0]['status'], 'paused')
        for args in ((PHONE, PC, 'shuffle'), (PHONE, PC, 'seek', -1), (PC, PC, 'play'), (PHONE, OTHER, 'play')):
            with self.assertRaises(DeviceError): self.devices.control('me', *args)

    def test_transfer_validation(self):
        self.devices.report('me', PC, dict(name='Desk PC'), False)
        self.devices.report('other', OTHER, dict(name='Their phone'), False)
        for args in ((PC, PC, RESUME, True), ('x', PC, RESUME, True), (PHONE, PC, None, True), (PHONE, PC, RESUME, 'yes'),
                     (PHONE, PC, {**RESUME, 'index': 2}, True), (PHONE, PC, {**RESUME, 'track_ids': ['bad id']}, True),
                     (PHONE, PC, {**RESUME, 'position': float('nan')}, True)):
            with self.assertRaises(DeviceError): self.devices.transfer('me', *args)
        with self.assertRaises(DeviceError) as offline: self.devices.transfer('me', PHONE, OTHER, RESUME, True)
        self.assertEqual(offline.exception.status, 409, "another profile's device is not reachable")

    def test_local_play_pauses_other_devices_and_takeback_does_not_ping_pong(self):
        pc = dict(name='Desk PC', activation=10, sequence=1)
        phone = dict(name='Pixel', activation=20, sequence=1)
        self.devices.report('me', PC, pc, True)
        self.assertIsNone(self.devices.report('me', PHONE, phone, True, position=42)[0])
        command, controls, _ = self.devices.report('me', PC, {**pc, 'sequence': 2}, True)
        self.assertEqual((command['action'], command['device_id'], command['from_name'], command['position']), ('pause', PHONE, 'Pixel', 42))
        self.assertEqual(controls, [])
        self.assertIsNone(self.devices.report('me', PHONE, {**phone, 'sequence': 2}, True)[0])
        self.assertIsNone(self.devices.report('me', PC, {**pc, 'sequence': 3}, False)[0])
        self.assertIsNone(self.devices.report('me', PC, {**pc, 'activation': 30, 'sequence': 4}, True)[0])
        command, _, _ = self.devices.report('me', PHONE, {**phone, 'sequence': 3}, True)
        self.assertEqual((command['action'], command['device_id']), ('pause', PC))
        self.assertIsNone(self.devices.report('me', PC, {**pc, 'activation': 30, 'sequence': 5}, True)[0])

    def test_delayed_epoch_cannot_replace_a_newer_local_action(self):
        _, _, epoch = self.devices.report('me', PC, dict(name='Desk PC', epoch=0, local_play=True, sequence=2), True, position=50)
        command, _, _ = self.devices.report('me', PHONE, dict(name='Pixel', epoch=0, local_play=True, sequence=1), True)
        self.assertEqual(command['device_id'], PC)
        self.assertEqual(self.devices.report('me', PC, dict(name='Old PC', activation=40, sequence=1), False), (None, [], epoch))
        self.assertEqual(self.devices.list('me', PC)[0]['name'], 'Desk PC')
        self.assertEqual(self.devices.list('me', PC)[0]['position'], 50)
        self.assertTrue(self.devices.list('me', PC)[0]['playing'])
        self.devices.control('me', PHONE, PC, 'next')
        self.assertEqual(self.devices.report('me', PC, dict(name='Old PC', activation=100, sequence=2), False), (None, [], epoch))
        _, controls, _ = self.devices.report('me', PC, dict(name='Desk PC', epoch=epoch, sequence=3), True)
        self.assertEqual([c['action'] for c in controls], ['next'], 'stale reports must not consume commands')

    def test_local_play_supersedes_queued_controls_for_that_device_only(self):
        self.devices.report('me', PC, dict(name='Desk PC', activation=10, sequence=1), True)
        self.devices.report('me', PHONE, dict(name='Pixel'), False)
        self.devices.report('other', OTHER, dict(name='Other'), True)
        self.devices.control('me', PHONE, PC, 'pause')
        self.devices.control('other', PHONE, OTHER, 'pause')
        self.assertEqual(self.devices.report('me', PC, dict(name='Desk PC', activation=20, sequence=2), True), (None, [], 2))
        self.assertTrue(self.devices.list('me', PC)[0]['playing'])
        _, controls, _ = self.devices.report('other', OTHER, dict(name='Other'), True)
        self.assertEqual([c['action'] for c in controls], ['pause'], 'another profile keeps its queued controls')
        self.devices.control('me', PHONE, PC, 'pause')
        _, controls, _ = self.devices.report('me', PC, dict(name='Desk PC', activation=20, sequence=3), True)
        self.assertEqual([c['action'] for c in controls], ['pause'], 'normal heartbeats preserve remote controls')

    def test_automatic_play_followers_and_other_profiles_do_not_activate(self):
        self.devices.report('me', PC, dict(name='Desk PC'), True)
        self.assertIsNone(self.devices.report('me', PHONE, dict(name='Pixel'), True)[0], 'startup playback is not a local action')
        self.devices.report('other', OTHER, dict(name='Other', activation=100), True)
        self.devices.report('me', OTHER, dict(name='Guest', activation=100, following_host=True), True)
        self.assertIsNone(self.devices.report('me', PC, dict(name='Desk PC', activation=10), True)[0])
        self.assertIsNone(self.devices.report('me', OTHER, dict(name='Guest', activation=100, following_host=True), True)[0])
        self.assertIsNone(self.devices.report('other', OTHER, dict(name='Other', activation=100), True)[0])
        command, _, epoch = self.devices.report('me', PHONE, dict(name='Pixel'), True)
        self.assertEqual(command['device_id'], PC)
        self.assertEqual(self.devices.report('me', PHONE, None, True), (None, [], epoch), 'old clients keep checking in')
        with self.assertRaises(DeviceError): self.devices.transfer('me', PC, OTHER, RESUME, True)

    def test_stale_transfer_is_superseded_and_remote_devices_follow_the_new_winner(self):
        self.devices.report('me', PC, dict(name='Desk PC', activation=10), True)
        self.devices.report('me', PHONE, dict(name='Pixel'), False)
        self.devices.transfer('me', PC, PHONE, RESUME, True)
        transferred = self.devices.active['me']['epoch']
        self.devices.report('me', PC, dict(name='Desk PC', epoch=transferred, local_play=True), True)
        command, _, _ = self.devices.report('me', PHONE, dict(name='Pixel'), True)
        self.assertEqual((command['action'], command['device_id']), ('pause', PC), 'queued play must not override takeback')
        self.devices.report('me', OTHER, dict(name='Tablet', epoch=transferred + 1, local_play=True), True)
        command, _, _ = self.devices.report('me', PHONE, dict(name='Pixel', remote_device=PC), False)
        self.assertEqual(command['device_id'], OTHER, 'a paused controller follows the active device')

    def test_offline_active_device_does_not_pause_another_player(self):
        self.devices.report('me', PC, dict(name='Desk PC', activation=10), True)
        self.clock.now = 16
        self.assertIsNone(self.devices.report('me', PHONE, dict(name='Pixel'), True)[0])

    def test_expired_legacy_device_does_not_claim_playback_with_unchanged_activation(self):
        self.devices.report('me', PC, dict(activation=10, sequence=1), True)
        self.devices.report('me', PHONE, dict(activation=20), True)
        self.clock.now = 61
        self.assertEqual(self.devices.list('me'), [])
        self.assertEqual(self.devices.report('me', PHONE, dict(activation=20), False)[2], 2)
        self.assertEqual(self.devices.report('me', PC, dict(activation=10, sequence=2), False), (None, [], 2))
        self.assertEqual([row['id'] for row in self.devices.list('me') if row['active']], [PHONE])
        self.assertEqual(self.devices.report('other', PC, dict(activation=10), True)[2], 1)
        self.assertEqual(self.devices.report('me', PC, dict(activation=30, sequence=3), True)[2], 3)

    def test_expired_legacy_activation_cache_is_bounded(self):
        self.devices.MAX_EXPIRED_ACTIVATIONS = 1
        self.devices.report('me', PC, dict(activation=10), True)
        self.devices.report('me', PHONE, dict(activation=20), True)
        self.clock.now = 61
        self.devices.list('me')
        self.assertEqual(self.devices.expired_activations, {('me', PHONE): 20})

    def test_invalid_ordering_and_follower_fields_are_rejected(self):
        for info in (dict(activation=True), dict(activation=-1), dict(activation=1.5), dict(sequence='1'),
                     dict(sequence=2 ** 63), dict(following_host='yes'), dict(remote_device='../other')):
            with self.subTest(info=info), self.assertRaises(DeviceError): self.devices.report('me', PC, info, True)


class Routes(Base):
    extra = {'FAMILY_PROFILES': True}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def test_check_ins_list_devices_and_carry_a_transfer(self):
        client, token = self.select()
        check_in = lambda device, name: self.post(client, token, '/api/playback/activity', json=dict(device_id=device, playing=False, device_info=dict(name=name, kind='windows')))
        self.assertIsNone(check_in(PC, 'Desk PC').json['command'])
        check_in(PHONE, 'Pixel')
        listed = self.go(client, 'GET', '/api/playback/devices?device_id=' + PHONE).json['devices']
        self.assertEqual([d['name'] for d in listed], ['Pixel', 'Desk PC'])
        sent = self.post(client, token, '/api/playback/transfer', json={'from': PHONE, 'to': PC, 'resume': RESUME, 'playing': True})
        self.assertEqual((sent.status_code, sent.json['target']), (202, 'Desk PC'))
        self.assertEqual(check_in(PC, 'Desk PC').json['command']['resume'], RESUME)
        self.assertEqual(self.post(client, token, '/api/playback/control', json={'from': PHONE, 'to': PC, 'action': 'next'}).status_code, 202)
        self.assertEqual([c['action'] for c in check_in(PC, 'Desk PC').json['controls']], ['next'])
        self.assertEqual(self.post(client, token, '/api/playback/transfer', json={'from': PHONE, 'to': OTHER, 'resume': RESUME}).status_code, 409)

    def test_activity_route_delivers_automatic_pause(self):
        client, token = self.select()
        def report(device, activation, sequence):
            return self.post(client, token, '/api/playback/activity', json=dict(device_id=device, playing=True,
                device_info=dict(name=device, activation=activation, sequence=sequence)))
        self.assertIsNone(report(PC, 10, 1).json['command'])
        self.assertIsNone(report(PHONE, 20, 1).json['command'])
        command = report(PC, 10, 2).json['command']
        self.assertEqual((command['action'], command['device_id'], command['epoch']), ('pause', PHONE, 2))
        self.assertIsNone(report(PC, 30, 3).json['command'])
        self.assertEqual(report(PHONE, 20, 2).json['command']['device_id'], PC)
