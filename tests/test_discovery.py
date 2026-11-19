"""Offline provider fixtures, cache guarantees and authenticated endpoint coverage."""
import copy
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch, Mock
from datetime import date
import urllib.error

from test_music_web import Base, URL
from music_web.discovery import Discovery, recent_release
from music_web.playlists import PlaylistStore


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.fixture = json.loads((Path(__file__).parent / 'fixtures/discovery_deezer.json').read_text(encoding='utf-8-sig'))
        self.calls = []
        self.store = Discovery(temporary.name, self.provider)
        self.tracks = [dict(id='abcdefghijk', title='Known song', channel='Artist')]
        self.store.select('a', dict(artists={'Artist': dict(completes=2, score=3)}), self.tracks)
        self.sleep = patch('music_web.discovery.time.sleep').start()
        self.addCleanup(self.sleep.stop)

    def provider(self, path):
        self.calls.append(path)
        key = 'identity' if path.startswith('search/') else 'albums' if '/albums?' in path else 'tracks' if '/tracks?' in path else 'album'
        return copy.deepcopy(self.fixture[key])

    def refresh(self):
        with patch('music_web.discovery.date') as clock:
            clock.today.return_value = date(2026, 11, 18)
            clock.fromisoformat.side_effect = date.fromisoformat
            return self.store.refresh_one()

    def items(self, profile='a', selected=('artist',)):
        with patch('music_web.discovery.date') as clock:
            clock.today.return_value = date(2026, 11, 18)
            clock.fromisoformat.side_effect = date.fromisoformat
            return self.store.items(profile, selected, set(), self.tracks)

    def test_shelf_spreads_artists_and_caps_albums_and_cover_art(self):
        for name, identifier in [('Artist', 42), ('Second Artist', 43), ('Third Artist', 44)]:
            self.store.put_artist(dict(name=name, deezer_id=identifier))
        rows = []

        def add(artist, album, track, title, day, cover=None, album_title=None):
            row = dict(id=f'{album}:{track}', artist_id=artist, album=album_title or f'Release {album}',
                       title=title, release_date=f'2026-11-{day:02}', cover_hash=cover,
                       source_ids=dict(artist=artist, album=album, track=track))
            rows.append((row['id'], artist, json.dumps(row)))

        shared_cover = 'a' * 32
        for index in range(13):
            add(42, 1, 100 + index, f'Song {index}', 18, shared_cover if index == 0 else None)
        add(42, 2, 200, 'Another song', 17, shared_cover)
        add(42, 3, 300, 'Song 0 (Guest Remix)', 16)
        add(42, 4, 400, 'Song 0 - VIP Remix', 15)
        add(42, 5, 500, 'Different title', 14, album_title='Release 1 [Remixes]')
        add(42, 6, 600, 'Second release', 13)
        add(42, 7, 700, 'Third release', 12)
        add(43, 8, 800, 'Shared artwork', 17, shared_cover)
        add(43, 9, 900, 'Second artist song', 11)
        add(44, 10, 1000, 'Third artist song', 10)
        with self.store.db() as db:
            db.executemany('INSERT INTO releases VALUES (?,?,?)', rows)
        items = self.items(selected=('artist', 'second artist', 'third artist'))
        self.assertEqual([row['id'] for row in items], ['1:100', '9:900', '10:1000', '6:600'])

    def test_song_identity_daily_cache_known_recordings_and_private_states(self):
        self.assertTrue(self.refresh())
        self.assertEqual(self.store.artists()[0]['confidence'], 'song_verified')
        items = self.items()
        self.assertEqual([r['title'] for r in items], ['New song'])
        self.assertEqual(len(self.calls), 4)
        self.assertFalse(self.refresh())
        self.assertEqual(len(self.calls), 4)
        with self.store.db() as db:
            db.execute('INSERT INTO states VALUES (?,?,?)', ('a', items[0]['id'], 'dismissed'))
        self.assertEqual(self.items(), [])
        self.assertEqual(len(self.items('b')), 1)
        row = self.store.artists()[0]
        row.update(next_refresh=0, updated_at=time.time() - 90000)
        self.store.put_artist(row)
        self.store.get = Mock(side_effect=OSError('offline'))
        self.refresh()
        self.assertTrue(self.items('b')[0]['stale'])

    def test_ambiguous_names_are_quarantined(self):
        self.fixture['identity']['data'].append(dict(title='Known song', artist=dict(id=43, name='Artist')))
        self.refresh()
        row = self.store.artists()[0]
        self.assertIsNone(row['deezer_id'])
        self.assertEqual(row['candidates'], [42, 43])
        self.assertTrue(all(c.startswith('search/') for c in self.calls))
        self.assertEqual(self.items(), [])

    def test_invalid_dates_reissues_and_types(self):
        for row in [None, {}, dict(id=1, record_type='single', release_date='2026'),
                    dict(id=True, record_type='single', release_date='2026-11-01'),
                    dict(id=1, record_type='compile', release_date='2026-11-01'),
                    dict(id=1, record_type='single', release_date='2026-12-01'),
                    dict(id=1, record_type='single', release_date='2026-01-01')]:
            self.assertFalse(recent_release(row, date(2026, 11, 18)))
        self.fixture['album']['artist'] = []
        self.refresh()
        self.assertGreater(self.store.artists()[0]['next_refresh'], time.time())
        self.assertEqual(self.items(), [])

    def test_admin_correction_wins_during_provider_request(self):
        original = self.provider
        def provider(path):
            row = self.store.artists()[0]
            row.update(deezer_id=99, confidence='admin_confirmed', revision=1)
            self.store.put_artist(row)
            return original(path)
        self.store.get = provider
        self.refresh()
        self.assertEqual(self.store.artists()[0]['deezer_id'], 99)

    def test_backoff_honors_retry_after(self):
        self.store.get = Mock(side_effect=urllib.error.HTTPError('https://api.deezer.com', 429, 'busy', {'Retry-After': '200000'}, None))
        now = time.time()
        self.store.refresh_one(now)
        self.assertGreaterEqual(self.store.artists()[0]['next_refresh'], now + 200000)
        self.store.put_artist(dict(name='other', aliases=['other'], deezer_id=99, next_refresh=0))
        self.assertFalse(self.store.refresh_one(now + 60))
        self.assertEqual(self.store.get.call_count, 1)

    def test_follows_priority_cap_and_shared_artist_refresh(self):
        with self.store.db() as db:
            db.execute('INSERT INTO follows VALUES (?,?)', ('a', 'followed'))
        selected, follows = self.store.select('a', dict(artists={str(i): dict(completes=2, score=i) for i in range(40)}), [])
        self.assertEqual(selected[0], 'followed')
        self.assertEqual(len(selected), 30)
        self.assertEqual(follows, {'followed'})
        # Two aliases for one confirmed catalogue identity share the daily result.
        row = self.store.artists()[0]
        self.store.put_artist(dict(name='alias', aliases=['alias'], deezer_id=42, confidence='admin_confirmed', next_refresh=0, updated_at=time.time()))
        self.store.put_artist(dict(name='artist', aliases=['artist'], deezer_id=42, confidence='admin_confirmed', next_refresh=-1, updated_at=None))
        self.refresh()
        self.assertEqual(self.calls, [])


class DiscoveryApiTests(Base):
    extra = {'ADMIN_USERS': ['sample-a']}

    def test_metadata_endpoints_never_search_and_profile_states_are_private(self):
        a, token = self.signed_in()
        b, btoken = self.signed_in('sample-b')
        with patch.object(self.intake, 'cmd_search', side_effect=AssertionError('YouTube request')), patch('music_web.catalog_search._get', side_effect=AssertionError('Provider request')):
            self.assertEqual(self.go(a, 'GET', '/api/discovery').json, {'items': []})
            self.assertEqual(self.post(a, token, '/api/discovery/follow', json=dict(artist='Artist')).status_code, 200)
            self.go(a, 'GET', '/api/discovery')
            self.assertEqual(self.go(b, 'GET', '/api/discovery').json['items'], [])
            self.assertEqual(self.post(b, btoken, '/api/admin/discovery', json=dict(name='Artist', deezer_id=42)).status_code, 403)
            self.assertEqual(self.post(a, token, '/api/admin/discovery', json=dict(name='Artist', deezer_id=42)).status_code, 200)
            store = self.app.extensions['discovery']
            item = dict(id='1:2', artist_id=42, artist='Artist', title='New song', album='New single',
                        release_date=date.today().isoformat(), source_ids=dict(artist=42, album=1, track=2))
            with store.db() as db:
                db.execute('INSERT INTO releases VALUES (?,?,?)', ('1:2', 42, json.dumps(item)))
            self.assertEqual(len(self.go(a, 'GET', '/api/discovery').json['items']), 1)
            play = self.post(a, token, '/api/discovery/1:2/play', json={})
            self.assertEqual(play.json['query'], 'artist New song')
            self.assertTrue(self.go(a, 'GET', '/api/discovery').json['items'][0]['seen'])
            self.post(b, btoken, '/api/discovery/follow', json=dict(artist='Artist'))
            self.assertFalse(self.go(b, 'GET', '/api/discovery').json['items'][0]['seen'])
            self.assertEqual(self.post(a, token, '/api/discovery/1:2/state', json={'state': 'dismissed'}).status_code, 200)
            self.assertEqual(self.go(a, 'GET', '/api/discovery').json['items'], [])
            self.assertEqual(len(self.go(b, 'GET', '/api/discovery').json['items']), 1)
            self.assertEqual(self.post(a, token, '/api/discovery/missing/play', json={}).status_code, 404)
            self.assertEqual(self.go(a, 'POST', '/api/discovery/follow', json=dict(artist='Artist')).status_code, 400)


class LibraryAdditionTests(Base):
    def test_pending_addition_resumes_with_same_job_id_after_restart(self):
        import music_web
        from test_native_music_api import NativeMusicApi

        client, token = self.signed_in()
        playlist = self.post(client, token, '/api/playlists', json={'name': 'Additions'}).json['playlist']
        target = dict(id=playlist['id'], owner_id='sample-a')
        self.state.resources.room('fixture', time.monotonic() + 30)
        added = self.post(client, token, '/api/library/additions', json={'urls': [URL], 'playlist': target}).json['jobs'][0]
        self.assertEqual(added['state'], 'queued')
        self.stop_worker()
        NativeMusicApi.recording(self)
        with patch('music_web.load_intake', return_value=self.intake), \
                patch.object(self.intake, 'cmd_preview', side_effect=self.intake.IntakeError('fixture')):
            restarted = music_web.create_app(self.settings)
            self.app = restarted
            self.state = restarted.extensions['music']
            client, token = self.signed_in()
            self.assertEqual(self.wait(client, added['id'])['state'], 'done')
        self.assertEqual([row['source_id'] for row in PlaylistStore(self.ws).read('sample-a', playlist['id'])['tracks']],
                         [added['source_id']])
        self.assertEqual(json.loads(Path(self.ws, '.library-additions.json').read_text(encoding='utf-8')), [])

    def test_existing_recording_adds_once_and_respects_playlist_access(self):
        from test_native_music_api import NativeMusicApi

        NativeMusicApi.recording(self)
        client, token = self.signed_in()
        playlist = self.post(client, token, '/api/playlists', json={'name': 'Additions'}).json['playlist']
        target = dict(id=playlist['id'], owner_id='sample-a')
        other, other_token = self.signed_in('sample-b')
        data = dict(urls=[URL], playlist=target)
        self.assertEqual(self.post(other, other_token, '/api/library/additions', json=data).status_code, 403)
        for _ in range(2):
            result = self.post(client, token, '/api/library/additions', json=data)
            self.assertTrue(result.json['jobs'][0]['saved'])
        entries = PlaylistStore(self.ws).read('sample-a', playlist['id'])['tracks']
        self.assertEqual([(row['title'], row['added_by']) for row in entries], [('First', 'sample-a')])

    def test_upload_and_job_status_stream_use_the_selected_playlist(self):
        from test_native_music_api import NativeMusicApi

        item, _, manifest, audio = NativeMusicApi.recording(self)
        local_id = 'local-' + manifest['audio']['sha256'][:16]
        local = item.with_name(local_id)
        item.rename(local)
        manifest.update(id=local_id, source=dict(kind='local', original_name='Song.wav', lossy=None))
        self.intake.write_manifest(str(local), manifest)
        client, token = self.signed_in()
        playlist = self.post(client, token, '/api/playlists', json={'name': 'Uploads'}).json['playlist']
        with patch.object(self.intake, 'cmd_stage', return_value=dict(item=str(local), manifest=manifest)):
            result = self.post(client, token, '/api/uploads',
                               data=dict(file=(io.BytesIO(audio), 'Song.wav'), read_tags='true', show_in_additions='true',
                                         playlist_id=playlist['id'], playlist_owner='sample-a'))
            self.assertEqual(result.status_code, 202, result.json)
            identifier = result.json['job']['id']
            with self.go(client, 'GET', f'/api/jobs/{identifier}?watch=1', buffered=True) as status:
                updates = [json.loads(line)['job'] for line in status.data.splitlines() if line]
                self.assertEqual(status.mimetype, 'application/x-ndjson')
                self.assertEqual((updates[-1]['state'], updates[-1]['source_id']), ('done', local_id))
        self.assertEqual(self.go(client, 'GET', '/api/library/additions').json['jobs'][0]['id'], identifier)
        self.assertEqual(PlaylistStore(self.ws).read('sample-a', playlist['id'])['tracks'][0]['source_id'], local_id)
        other, _ = self.signed_in('sample-b')
        self.assertEqual(self.go(other, 'GET', f'/api/jobs/{identifier}?watch=1').status_code, 404)

    def test_validates_entire_batch_and_deduplicates_while_background(self):
        c, token = self.signed_in()
        with patch.object(self.intake, 'cmd_fetch') as fetch:
            result = self.post(c, token, '/api/library/additions', json={'urls': [URL, 'not a url']})
            self.assertEqual(result.status_code, 400)
            fetch.assert_not_called()
        # An existing room reserves capacity; library additions still keep their base background slots.
        self.state.resources.room('fixture', time.monotonic() + 30)
        result = self.post(c, token, '/api/library/additions', json={'urls': [URL, 'https://youtu.be/dQw4w9WgXcQ']})
        self.assertEqual(result.status_code, 202)
        self.assertEqual(len(result.json['jobs']), 1)
        jid = result.json['jobs'][0]['id']
        again = self.post(c, token, '/api/library/additions', json={'urls': [URL]})
        self.assertEqual(again.json['jobs'][0]['id'], jid)
        self.assertEqual(self.state.jobs[jid]['priority'], 20)
        self.assertTrue(self.state.jobs[jid]['playlist_import'])
        self.assertIn(self.state.jobs[jid]['state'], ('queued', 'running'))
        other, _ = self.signed_in('sample-b')
        self.assertEqual(self.go(other, 'GET', '/api/library/additions').json['jobs'], [])
        self.state.jobs[jid]['cancel'].set()
        self.state.jobs[jid]['state'] = 'cancelled'

    def test_retry_saved_reuse_and_gate_background_priority(self):
        from test_native_music_api import NativeMusicApi
        c, token = self.signed_in()
        with patch.object(self.intake, 'cmd_fetch', side_effect=self.intake.IntakeError('offline')):
            first = self.post(c, token, '/api/library/additions', json={'urls': [URL]}).json['jobs'][0]
            self.assertEqual(self.wait(c, first['id'])['state'], 'error')
        flags = []
        def fetched(args):
            flags.append(self.intake.CONTROL.background)
            item, _, manifest, _ = NativeMusicApi.recording(self)
            return dict(item=str(item), manifest=manifest)
        with patch.object(self.intake, 'cmd_fetch', side_effect=fetched) as fetch, patch.object(self.intake, 'cmd_preview', side_effect=self.intake.IntakeError('fixture')):
            second = self.post(c, token, '/api/library/additions', json={'urls': [URL]}).json['jobs'][0]
            self.assertNotEqual(first['id'], second['id'])
            self.assertEqual(self.wait(c, second['id'])['state'], 'done')
            self.assertEqual(flags, [True])
            other, other_token = self.signed_in('sample-b')
            saved = self.post(other, other_token, '/api/library/additions', json={'urls': [URL]}).json['jobs'][0]
            self.assertTrue(saved['saved'])
            self.assertEqual(fetch.call_count, 1)

    def test_200_pending_limit_allows_existing_requests(self):
        c, token = self.signed_in()
        self.state.resources.room('fixture', time.monotonic() + 30)
        try:
            urls = ['https://youtu.be/%011d' % i for i in range(200)]
            result = self.post(c, token, '/api/library/additions', json={'urls': urls})
            self.assertEqual(result.status_code, 202)
            self.assertEqual(len(result.json['jobs']), 200)
            self.assertEqual(self.post(c, token, '/api/library/additions', json={'urls': [URL]}).status_code, 429)
            self.assertEqual(self.post(c, token, '/api/library/additions', json={'urls': [urls[0]]}).status_code, 202)
        finally:
            for job in self.state.jobs.values():
                job['cancel'].set()

    def test_queue_bound_and_auth(self):
        c, token = self.signed_in()
        self.assertEqual(self.post(c, token, '/api/library/additions', json={'urls': [URL] * 201}).status_code, 400)
        self.assertEqual(self.go(c, 'POST', '/api/library/additions', json={'urls': [URL]}).status_code, 400)
        self.assertEqual(self.go(self.app.test_client(), 'GET', '/api/library/additions').status_code, 401)
