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
        command, _ = self.devices.report('me', PC, dict(name='Desk PC', kind='windows'), True)
        self.assertEqual((command['action'], command['from_name'], command['resume'], command['playing']), ('play', 'Pixel', RESUME, True))
        self.assertIsNone(self.devices.report_command('me', PC, dict(name='Desk PC'), True), 'a command is delivered once')
        self.devices.transfer('me', PHONE, PC, RESUME, True); self.clock.now = 31
        self.devices.report('me', PHONE, dict(name='Pixel'), False)
        self.assertIsNone(self.devices.report_command('me', PC, dict(name='Desk PC'), True), 'an uncollected command expires')

    def test_remote_controls_reach_the_target_in_order(self):
        self.devices.report('me', PC, dict(name='Desk PC'), True, dict(id='abcdefghijk', title='Song', channel='A'), 30)
        self.devices.control('me', PHONE, PC, 'pause')
        self.assertFalse(self.devices.list('me')[0]['playing'], 'the controller sees the pause at once')
        self.devices.control('me', PHONE, PC, 'seek', 95.5)
        _, controls = self.devices.report('me', PC, dict(name='Desk PC'), False)
        self.assertEqual([(c['action'], c['position']) for c in controls], [('pause', None), ('seek', 95.5)])
        self.assertEqual(self.devices.report('me', PC, dict(name='Desk PC'), False)[1], [])
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
