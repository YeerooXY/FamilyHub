import unittest

from music_web.listening_rooms import ListeningRooms, RoomError
from test_music_web import Base


def playback(**changes):
    return dict(queue=[dict(id='abcdefghijk', title='Song', channel='Artist')], index=0,
                position=12, playing=True, auto_dj=True, crossfading=False, **changes)


class RoomStateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.rooms = ListeningRooms(lambda: self.now)

    def test_pokes_are_private_bounded_and_expire(self):
        key = self.rooms.poke('alex', 'Alex', 'sam')
        self.assertEqual(self.rooms.pending_pokes('alex'), [])
        self.assertEqual(self.rooms.pending_pokes('sam'), [dict(id=key, sender='alex', name='Alex')])
        with self.assertRaises(RoomError): self.rooms.dismiss_poke('alex', key)
        with self.assertRaises(RoomError): self.rooms.poke('alex', 'Alex', 'sam')
        with self.assertRaises(RoomError): self.rooms.poke('alex', 'Alex', 'alex')
        self.rooms.dismiss_poke('sam', key)
        self.assertEqual(self.rooms.pending_pokes('sam'), [])
        self.now += 60
        self.rooms.poke('alex', 'Alex', 'sam')
        self.now += 120
        self.assertEqual(self.rooms.pending_pokes('sam'), [])

    def test_same_profile_cannot_join_itself_and_restart_reclaims_host(self):
        old, restarted, guest = ('a','old'), ('a','new'), ('b','other')
        room = self.rooms.create(old,'Alex',playback()); key=room['id']
        self.rooms.join(key, guest)
        with self.assertRaises(RoomError): self.rooms.join(key, restarted)
        self.now += 4
        resumed=self.rooms.create(restarted,'Alex',dict(queue=[],index=-1,position=0,playing=False,auto_dj=True,crossfading=False))
        self.assertEqual(resumed['id'],key)
        self.assertTrue(resumed['resumed'] and resumed['is_host'])
        self.assertEqual((resumed['position'],resumed['listeners'],len(resumed['queue'])),(16,2,1))
        with self.assertRaises(RoomError): self.rooms.update(key, old, playback())
        self.assertTrue(self.rooms.read(key, guest)['playing'])
        self.assertEqual(len(self.rooms.list()),1)

    def test_host_authority_clock_and_incremental_queue(self):
        host, guest = ('a', 'device1'), ('b', 'device2')
        room = self.rooms.create(host, 'Alex', playback())
        key = room['id']
        self.assertEqual(room['host_user'], 'a')
        self.assertEqual(self.rooms.list()[0]['host_user'], 'a')
        self.assertEqual(self.rooms.create(host, 'Alex', playback())['id'], key)
        with self.assertRaises(RoomError): self.rooms.read(key, guest)
        self.rooms.join(key, guest)
        self.now += 3
        state = self.rooms.read(key, guest, 1)
        self.assertEqual(state['position'], 15)
        self.assertNotIn('queue', state)
        self.assertEqual(state['listeners'], 2)
        with self.assertRaises(RoomError): self.rooms.update(key, guest, playback())
        paused = dict(position=15, playing=False, index=0, auto_dj=False, crossfading=False)
        self.rooms.update(key, host, paused)
        self.now += 2
        self.assertEqual(self.rooms.read(key, guest)['position'], 15)
        changed = playback()
        changed['queue'].append(dict(id='12345678901', title='Next', channel='Other'))
        self.rooms.update(key, host, changed)
        fresh = self.rooms.read(key, guest, 1)
        self.assertEqual(len(fresh['queue']), 2)
        self.assertEqual(fresh['queue_revision'], 2)
        self.rooms.leave(key, guest)
        self.assertEqual(self.rooms.read(key, host)['listeners'], 1)
        self.rooms.leave(key, host)
        self.assertEqual(self.rooms.list(), [])

    def test_guest_polling_cannot_keep_absent_host_alive(self):
        room = self.rooms.create('host', 'Host', playback())
        self.rooms.join(room['id'], 'guest')
        self.now += 29
        self.rooms.read(room['id'], 'guest')
        self.now += 2
        with self.assertRaises(RoomError): self.rooms.read(room['id'], 'guest')
        self.assertEqual(self.rooms.list(), [])

    def test_empty_session_join_heartbeat_play_and_clear(self):
        waiting = dict(queue=[], index=-1, position=0, playing=False, auto_dj=True, crossfading=False)
        room = self.rooms.create('host', 'Host', waiting)
        key = room['id']
        self.assertEqual(self.rooms.list()[0]['title'], 'Waiting for a song')
        self.assertEqual(self.rooms.join(key, 'guest')['queue'], [])
        self.now += 20
        self.rooms.read(key, 'guest')
        heartbeat = {k: v for k, v in waiting.items() if k != 'queue'}
        self.rooms.update(key, 'host', heartbeat)
        self.now += 20
        self.assertFalse(self.rooms.read(key, 'guest')['playing'])
        self.rooms.update(key, 'host', playback())
        started = self.rooms.read(key, 'guest', room['queue_revision'])
        self.assertTrue(started['playing'])
        self.assertEqual(started['queue'][0]['title'], 'Song')
        self.rooms.update(key, 'host', waiting)
        stopped = self.rooms.read(key, 'guest', started['queue_revision'])
        self.assertEqual(stopped['queue'], [])
        self.assertEqual(stopped['index'], -1)
        for field, value in [('index', 0), ('playing', True), ('crossfading', True), ('position', 1)]:
            with self.subTest(field=field), self.assertRaises(RoomError):
                self.rooms.update(key, 'host', dict(waiting, **{field: value}))

    def test_fade_clock_advances_only_while_playing(self):
        data = playback(); data.update(crossfading=True, fade_elapsed=2, fade_position=2.1, fade_duration=6)
        room = self.rooms.create('host', 'Host', data)
        self.now += 1
        state = self.rooms.read(room['id'], 'host')
        self.assertEqual(state['fade_elapsed'], 3)
        self.assertEqual(state['fade_position'], 3.1)
        data['playing'] = False
        self.rooms.update(room['id'], 'host', data)
        self.now += 1
        self.assertEqual(self.rooms.read(room['id'], 'host')['fade_elapsed'], 2)

    def test_validation_and_external_urls_are_not_trusted(self):
        for field, value in [('position', float('nan')), ('position', -1), ('playing', 1), ('index', True), ('queue', []), ('auto_dj', 'yes'), ('control_revision', -1), ('control_revision', True)]:
            data = playback(); data[field] = value
            with self.subTest(field=field), self.assertRaises(RoomError): self.rooms.create('h', 'H', data)
        data = playback(); data['queue'][0]['url'] = 'https://attacker.invalid/secret'
        room = self.rooms.create('h', 'H', data)
        self.assertEqual(room['queue'][0]['url'], 'https://www.youtube.com/watch?v=abcdefghijk')
        data['control_revision'] = 3
        self.rooms.update(room['id'], 'h', data)
        self.assertEqual(self.rooms.read(room['id'], 'h')['control_revision'], 3)


class RoomApiTests(Base):
    extra = {'FAMILY_PROFILES': True}

    def select(self, profile):
        client = self.app.test_client()
        token = self.go(client, 'GET', '/api/connect').json['csrf_token']
        token = self.post(client, token, '/api/profile/select', json={'profile_id': profile}).json['csrf_token']
        return client, token

    def test_poke_delivery_authorization_and_no_automatic_session(self):
        sender, st = self.select('sample-a'); target, tt = self.select('sample-b')
        path = '/api/listening/pokes'
        self.assertEqual(self.go(sender, 'POST', path, json={'target':'sample-b'}).status_code, 400)
        response = self.post(sender, st, path, json={'target':'sample-b'})
        self.assertEqual(response.status_code, 201)
        key = response.json['id']
        self.assertEqual(self.go(sender, 'GET', path).json['requests'], [])
        self.assertEqual(self.go(target, 'GET', path).json['requests'][0]['sender'], 'sample-a')
        self.assertEqual(self.go(target, 'GET', '/api/listening/rooms').json['rooms'], [])
        self.assertEqual(self.post(sender, st, path, json={'target':'sample-b'}).status_code, 429)
        self.assertEqual(self.go(sender, 'DELETE', path+'/'+key, headers={'X-CSRFToken':st}).status_code, 403)
        self.assertEqual(self.go(target, 'DELETE', path+'/'+key, headers={'X-CSRFToken':tt}).status_code, 200)
        self.assertEqual(self.go(target, 'GET', path).json['requests'], [])
        self.assertEqual(self.post(sender, st, path, json={'target':'unknown'}).status_code, 400)

    def test_invitation_is_private_host_only_and_requires_acceptance(self):
        host, ht = self.select('sample-a'); guest, gt = self.select('sample-b')
        room = self.post(host, ht, '/api/listening/rooms', json=playback()).json['room']
        data = dict(target='sample-b',room_id=room['id'])
        self.assertEqual(self.post(guest, gt, '/api/listening/invites', json=data).status_code,403)
        self.assertEqual(self.post(host, ht, '/api/listening/invites', json=dict(data,target='sample-a')).status_code,400)
        self.assertEqual(self.post(host, ht, '/api/listening/invites', json=data).status_code,201)
        requests = self.go(guest,'GET','/api/listening/pokes').json['requests']
        self.assertEqual((requests[0]['kind'],requests[0]['room_id']),('invite',room['id']))
        self.assertEqual(self.go(host,'GET','/api/listening/pokes').json['requests'],[])
        path='/api/listening/rooms/'+room['id']
        self.assertEqual(self.go(guest,'GET',path).status_code,403)
        self.assertEqual(self.post(guest,gt,path+'/join',json={}).status_code,200)

    def test_auth_csrf_join_and_other_device_cannot_drive(self):
        host, ht = self.select('sample-a'); guest, gt = self.select('sample-b')
        self.assertEqual(self.go(self.app.test_client(), 'GET', '/api/listening/rooms').status_code, 401)
        self.assertEqual(self.go(host, 'POST', '/api/listening/rooms', json=playback()).status_code, 400)
        created = self.post(host, ht, '/api/listening/rooms', json=playback())
        self.assertEqual(created.status_code, 201, created.json)
        path = '/api/listening/rooms/' + created.json['room']['id']
        self.assertEqual(self.go(guest, 'GET', path).status_code, 403)
        self.assertEqual(self.post(guest, gt, path + '/join', json={}).status_code, 200)
        response = self.go(guest, 'PUT', path, json=playback(), headers={'X-CSRFToken': gt})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.go(guest, 'GET', path).json['room']['listeners'], 2)
        self.assertEqual(self.go(host, 'DELETE', path, headers={'X-CSRFToken': ht}).status_code, 200)
        self.assertEqual(self.go(guest, 'GET', path).status_code, 404)
