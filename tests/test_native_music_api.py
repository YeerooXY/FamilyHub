"""Authenticated download and playlist behavior with real files and manifests."""
import hashlib
import io
import json
import os
from pathlib import Path
import unittest
import wave
from unittest.mock import patch

from test_music_web import Base, ORIGIN, ROOT
import music_web
from music_web.playlists import PlaylistStore


FIRST = 'dQw4w9WgXcQ'
SECOND = 'abcdefghijk'


class FinishedAudioRequired(Base):
    extra = {'REQUIRE_FINISHED_AUDIO': True}

    def test_unfinished_audio_is_not_served_in_either_quality(self):
        NativeMusicApi.recording(self)
        client, _ = self.signed_in()
        self.assertEqual(self.go(client, 'GET', '/api/library').json['results'], [])
        for suffix in ('download', 'playback-info'):
            self.assertEqual(self.go(client, 'GET', f'/api/library/{FIRST}/{suffix}').status_code, 503)

    def test_explicit_stream_can_open_verified_source_while_purification_is_pending(self):
        NativeMusicApi.recording(self)
        client, _ = self.signed_in()
        info = self.go(client, 'GET', f'/api/library/{FIRST}/playback-info?stream=1&play_action=' + 'b' * 32)
        self.assertEqual(info.status_code, 200)
        self.assertIn('/playback-source/', info.json['download_url'])
        self.assertEqual(self.go(client, 'GET', info.json['download_url']).status_code, 404)
        stream = self.go(self.app.test_client(), 'GET', info.json['stream_url'], headers={'Range': 'bytes=0-255'})
        self.assertEqual(stream.status_code, 206)
        self.assertEqual(len(stream.data), 256)
        self.assertEqual(stream.headers['ETag'], f'"{info.json["download_sha256"]}"')
        events = self.go(client, 'GET', '/api/playback/diagnostics').json['actions'][0]['events']
        self.assertEqual({event['stage'] for event in events},
                         {'playback_info_started', 'playback_info_ready', 'stream_requested', 'stream_response_ready'})

    def test_persisted_saved_playlist_reports_unfinished_audio_as_preparing(self):
        NativeMusicApi.recording(self)
        PlaylistStore(self.ws).save('sample-a', {'id': 'p' * 22, 'name': 'Old playlist', 'revision': 1,
            'tracks': [{'title': 'First', 'artist': 'Artist', 'duration': .02, 'state': 'saved',
                        'source_id': FIRST, 'match': {'id': FIRST}}]})
        client, _ = self.signed_in()
        playlist = self.go(client, 'GET', '/api/playlists').json['playlists'][0]
        self.assertEqual(playlist['tracks'][0]['state'], 'preparing')
        self.assertEqual(self.go(client, 'GET', f'/api/library/{FIRST}/download').status_code, 503)


class NativeMusicApi(Base):
    def test_large_library_refresh_reuses_verified_recordings(self):
        for index in range(300):
            self.recording(source_id=f'{index:011d}')
        client, _ = self.signed_in()
        self.assertEqual(len(self.go(client, 'GET', '/api/library').json['results']), 300)
        with patch.object(self.intake, 'sha256_file', wraps=self.intake.sha256_file) as hashing:
            self.assertEqual(len(self.go(client, 'GET', '/api/library').json['results']), 300)
            self.assertEqual(hashing.call_count, 0, 'Refreshing a large library rehashed unchanged audio')

    def recording(self, source_id=FIRST, title='First', imported=True, samples=b'\x01\x02' * 160):
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(samples)
        data = stream.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        item_id = 'yt-' + source_id + '-' + digest[:12]
        item = Path(self.ws) / item_id
        item.mkdir()
        (item / 'audio.wav').write_bytes(data)
        relative = f'Local Imports/Artist/Album/{source_id}.wav'
        target = Path(self.lib) / relative
        if imported:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        manifest = {
            'schema': 1, 'id': item_id,
            'audio': {'file': 'audio.wav', 'sha256': digest, 'duration': 0.02,
                      'sample_rate': 8000, 'channels': 1, 'size': len(data),
                      'codec': 'pcm_s16le', 'bit_rate': 128000},
            'source': {'kind': 'youtube', 'id': source_id,
                       'url': 'https://www.youtube.com/watch?v=' + source_id},
            'edit': None,
            'import': {'path': relative, 'sha256': digest, 'library_sha256': digest,
                       'artist': 'Artist', 'album': 'Album', 'title': title} if imported else None,
        }
        self.intake.write_manifest(str(item), manifest)
        self.intake.load_item(str(item))
        return item, target, manifest, data

    def test_local_recording_catalogue_download_and_playlist(self):
        item,target,manifest,audio = self.recording()
        local_id = 'local-' + manifest['audio']['sha256'][:16]
        destination = item.parent / local_id
        item.rename(destination)
        manifest['id'] = local_id
        manifest['source'] = dict(kind='local',original_name='Song.wav',lossy=None)
        self.intake.write_manifest(str(destination),manifest)
        client,token = self.signed_in()
        rows = self.go(client,'GET','/api/library').json['results']
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['id'],rows[0]['url']),(local_id,''))
        with self.go(client,'GET',f'/api/library/{local_id}/download') as result:
            self.assertEqual((result.status_code,result.data),(200,audio))
        created=self.post(client,token,'/api/playlists',json=dict(name='Local songs')).json['playlist']
        result=self.go(client,'PATCH','/api/playlists/'+created['id'],json=dict(revision=created['revision'],add_source_id=local_id),headers={'X-CSRFToken':token})
        self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(result.json['playlist']['tracks'][0]['source_id'],local_id)

    def test_library_includes_original_measurements_and_legacy_gain(self):
        item, _, manifest, _ = self.recording()
        measurement = {'duration': .02, 'start': 0, 'end': .02, 'lufs': -8.76, 'true_peak': 2.12, 'gain_db': -7.24}
        client, _ = self.signed_in()
        with patch('music_web.profile', return_value=measurement):
            response = self.go(client, 'GET', '/api/library')
        self.assertEqual(response.status_code, 200)
        track = response.json['results'][0]
        self.assertEqual(track['playback_gain_db'], -7.24)
        self.assertEqual(track['lufs'], -8.76)
        self.assertEqual(track['true_peak'], 2.12)

    def test_scratch_quota_counts_pending_audio_but_not_published_assets(self):
        item, target, _, _ = self.recording()
        for folder in ('.app-updates', '.finished-audio', '.listening-versions'):
            directory = Path(self.ws)/folder
            directory.mkdir()
            (directory/'asset').write_bytes(b'x'*100)
        scratch = Path(self.ws)/'.tmp-test'
        scratch.mkdir()
        (scratch/'partial').write_bytes(b'x'*31)
        before = music_web.scratch_size(self.ws, self.lib, self.intake)
        # Published intake copies and installers do not consume scratch quota.
        self.assertEqual(before, 31)
        target.unlink()
        self.assertGreater(music_web.scratch_size(self.ws, self.lib, self.intake), before)

    def test_finished_file_is_served_with_its_hash_and_no_extra_gain(self):
        from music_web.finished_audio import FinishedAudio, VERSION
        item, original, manifest, original_data = self.recording()
        store = FinishedAudio(self.ws, self.intake)
        digest = manifest['import']['library_sha256']
        folder = Path(store.directory)
        folder.mkdir()
        data = b'finished-audio-fixture'
        row = dict(version=VERSION, source_sha256=digest, sha256=hashlib.sha256(data).hexdigest(),
                   size=len(data), duration=.02, start=0, end=.02, lufs=-16, true_peak=-1.5)
        (folder/(store.key(digest)+'.flac')).write_bytes(data)
        (folder/(store.key(digest)+'.json')).write_text(json.dumps(row))
        client, _ = self.signed_in()
        track = self.go(client, 'GET', '/api/library').json['results'][0]
        self.assertEqual(track['listening_version'], 'finished')
        self.assertEqual(track['download_extension'], '.flac')
        self.assertEqual(track['download_sha256'], row['sha256'])
        self.assertEqual(track['playback_gain_db'], 0)
        self.assertEqual(track['lufs'], row['lufs'])
        self.assertEqual(track['true_peak'], row['true_peak'])
        with self.go(client, 'GET', track['download_url'], headers={'Range':'bytes=0-7'}) as response:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.data, data[:8])
        self.assertEqual(original.read_bytes(), original_data)

    def mutate(self, client, token, playlist, change=None, method='PATCH'):
        return self.go(client, method, '/api/playlists/' + playlist['id'],
                       json={'revision': playlist['revision'], **(change or {})},
                       headers={'X-CSRFToken': token})

    def create(self, client, token, name='Driving'):
        response = self.post(client, token, '/api/playlists', json={'name': name})
        self.assertEqual(response.status_code, 201, response.json)
        return response.json['playlist']

    def test_download_metadata_full_head_range_and_if_range(self):
        _, _, manifest, data = self.recording()
        client, _ = self.signed_in()
        track = self.go(client, 'GET', '/api/library').json['results'][0]
        url = '/api/library/' + FIRST + '/download'
        self.assertEqual(track['download_url'], url)
        self.assertEqual(track['download_size'], len(data))
        self.assertEqual(track['download_sha256'], manifest['import']['library_sha256'])
        self.assertEqual(track['download_extension'], '.wav')
        self.assertEqual((track['title'], track['channel'], track['saved']), ('First', 'Artist', True))
        with self.go(client, 'GET', url) as full:
            self.assertEqual(full.status_code, 200)
            self.assertEqual(full.data, data)
            etag = full.headers['ETag']
            self.assertEqual(etag, '"' + track['download_sha256'] + '"')
        with self.go(client, 'HEAD', url) as head:
            self.assertEqual(head.status_code, 200)
            self.assertEqual(head.data, b'')
            self.assertEqual(int(head.headers['Content-Length']), len(data))
        with self.go(client, 'GET', url, headers={'Range': 'bytes=12-23', 'If-Range': etag}) as partial:
            self.assertEqual(partial.status_code, 206)
            self.assertEqual(partial.data, data[12:24])
            self.assertEqual(partial.headers['Content-Range'], f'bytes 12-23/{len(data)}')
        with self.go(client, 'GET', url, headers={'Range': 'bytes=12-', 'If-Range': '"outdated"'}) as changed:
            self.assertEqual(changed.status_code, 200)
            self.assertEqual(changed.data, data)
        with self.go(client, 'GET', url, headers={'Range': 'bytes=9999-'}) as outside:
            self.assertEqual(outside.status_code, 416)

    def test_stream_link_plays_without_cookie_only_with_its_ticket(self):
        self.recording()
        client, _ = self.signed_in()
        info = self.go(client, 'GET', '/api/library/' + FIRST + '/playback-info?quality=max').json
        stream = info['stream_url']
        self.assertTrue(stream.startswith('/api/library/' + FIRST + '/download?'))
        anonymous = self.app.test_client()
        self.assertEqual(self.go(anonymous, 'GET', stream).status_code, 200)
        self.assertEqual(self.go(anonymous, 'GET', stream, headers={'Range': 'bytes=0-3'}).status_code, 206)
        forged = stream[:-1] + ('0' if stream[-1] != '0' else '1')
        self.assertEqual(self.go(anonymous, 'GET', forged).status_code, 401)
        other = stream.replace(FIRST, 'local-' + '0' * 16, 1)
        self.assertEqual(self.go(anonymous, 'GET', other).status_code, 401)
        self.assertEqual(self.go(client, 'GET', '/api/library/' + FIRST + '/playback-info?quality=max&lead=x').status_code, 400)

    def test_download_requires_session_and_refuses_unsaved_or_missing_recordings(self):
        self.recording(imported=False)
        url = '/api/library/' + FIRST + '/download'
        anonymous = self.app.test_client()
        for method in ('GET', 'HEAD'):
            self.assertEqual(self.go(anonymous, method, url).status_code, 401)
        client, _ = self.signed_in()
        self.assertEqual(self.go(client, 'GET', url).status_code, 404)
        self.assertEqual(self.go(client, 'GET', '/api/library').json['results'], [])
        self.assertEqual(self.go(client, 'GET', '/api/library/invalid/download').status_code, 404)

    def test_modified_and_missing_files_invalidate_cached_download(self):
        _, target, _, data = self.recording()
        client, _ = self.signed_in()
        url = '/api/library/' + FIRST + '/download'
        with self.go(client, 'GET', url) as first:
            self.assertEqual(first.status_code, 200)
        target.write_bytes(data + b'changed')
        self.assertEqual(self.go(client, 'GET', url).status_code, 404)
        self.assertEqual(self.go(client, 'GET', '/api/library').json['results'], [])
        target.unlink()
        self.assertEqual(self.go(client, 'GET', url).status_code, 404)

    def test_manifest_cannot_escape_library(self):
        item, _, manifest, _ = self.recording()
        manifest['import']['path'] = '../outside/private.wav'
        self.intake.write_manifest(str(item), manifest)
        client, _ = self.signed_in()
        self.assertEqual(self.go(client, 'GET', '/api/library/' + FIRST + '/download').status_code, 404)
        self.assertEqual(self.go(client, 'GET', '/api/library').json['results'], [])

    def test_download_rejects_symlink(self):
        item, target, _, _ = self.recording()
        target.unlink()
        try:
            os.symlink(item / 'audio.wav', target)
        except OSError:
            self.skipTest('This host does not permit creating symlinks.')
        client, _ = self.signed_in()
        self.assertEqual(self.go(client, 'GET', '/api/library/' + FIRST + '/download').status_code, 404)

    def test_library_does_not_stop_after_200_recordings(self):
        for index in range(205):
            self.recording(f'{index:011d}')
        client, _ = self.signed_in()
        tracks = self.go(client, 'GET', '/api/library').json['results']
        self.assertEqual(len(tracks), 205)
        self.assertEqual(len({track['id'] for track in tracks}), 205)

    def test_playlist_rejects_duplicates_reorder_rename_remove_and_delete(self):
        self.recording()
        self.recording(SECOND, 'Second')
        client, token = self.signed_in()
        playlist = self.create(client, token)
        for source_id in (FIRST, SECOND):
            response = self.mutate(client, token, playlist, {'add_source_id': source_id})
            self.assertEqual(response.status_code, 200, response.json)
            playlist = response.json['playlist']
        repeated = self.mutate(client, token, playlist, {'add_source_id': FIRST})
        self.assertEqual(repeated.status_code, 409)
        self.assertEqual([track['source_id'] for track in playlist['tracks']], [FIRST, SECOND])
        playlist = self.mutate(client, token, playlist, {'move_from': 1, 'move_to': 0}).json['playlist']
        self.assertEqual([track['title'] for track in playlist['tracks']], ['Second', 'First'])
        playlist = self.mutate(client, token, playlist, {'name': ' Night drive '}).json['playlist']
        self.assertEqual(playlist['name'], 'Night drive')
        playlist = self.mutate(client, token, playlist, {'remove_index': 1}).json['playlist']
        self.assertEqual([track['source_id'] for track in playlist['tracks']], [SECOND])
        listed = self.go(client, 'GET', '/api/playlists').json['playlists'][0]
        self.assertEqual(listed, playlist)
        self.assertEqual(self.mutate(client, token, playlist, method='DELETE').status_code, 200)
        self.assertEqual(self.go(client, 'GET', '/api/playlists').json['playlists'], [])

    def test_playlist_stale_revision_and_invalid_mutations_leave_state_unchanged(self):
        self.recording()
        client, token = self.signed_in()
        original = self.create(client, token)
        playlist = self.mutate(client, token, original, {'add_source_id': FIRST}).json['playlist']
        self.assertEqual(self.mutate(client, token, original, {'name': 'Stale'}).status_code, 409)
        self.assertEqual(self.mutate(client, token, original, method='DELETE').status_code, 409)
        for change in ({'remove_index': True}, {'remove_index': -1}, {'remove_index': 1},
                       {'move_from': 0, 'move_to': True}, {'move_from': 0},
                       {'name': 'Rename', 'remove_index': 0}, {'name': ''}, {'add_source_id': 'bad'}):
            with self.subTest(change=change):
                self.assertEqual(self.mutate(client, token, playlist, change).status_code, 400)
        self.assertEqual(self.go(client, 'GET', '/api/playlists').json['playlists'][0], playlist)
        self.assertEqual(self.mutate(client, token, {**playlist, 'revision': True}, {'name': 'Bad'}).status_code, 409)

    def test_playlist_isolation_and_csrf(self):
        client, token = self.signed_in()
        other, other_token = self.signed_in('sample-b')
        playlist = self.create(client, token)
        self.assertEqual(self.go(other, 'GET', '/api/playlists').json['playlists'], [])
        self.assertEqual(self.mutate(other, other_token, playlist, {'name': 'Other'}).status_code, 400)
        self.assertEqual(self.mutate(other, other_token, playlist, method='DELETE').status_code, 400)
        path = '/api/playlists/' + playlist['id']
        self.assertEqual(self.go(client, 'PATCH', path, json={'revision': playlist['revision'], 'name': 'No token'}).status_code, 400)
        self.assertEqual(self.go(client, 'DELETE', path, json={'revision': playlist['revision']}).status_code, 400)
        self.assertEqual(self.go(client, 'POST', '/api/playlists', json={'name': 'No token'}).status_code, 400)
        self.assertEqual(self.go(client, 'GET', '/api/playlists').json['playlists'][0], playlist)

    def test_matching_rejects_reorder_or_removal_during_search(self):
        self.recording()
        self.recording(SECOND, 'Second')
        client, token = self.signed_in()
        for change in ({'move_from': 0, 'move_to': 1}, {'remove_index': 0}):
            with self.subTest(change=change):
                playlist = self.create(client, token)
                for source_id in (FIRST, SECOND):
                    playlist = self.mutate(client, token, playlist, {'add_source_id': source_id}).json['playlist']
                edited = {}

                def search(_):
                    response = self.mutate(client, token, playlist, change)
                    self.assertEqual(response.status_code, 200)
                    edited.update(response.json['playlist'])
                    return {'results': [{'id': FIRST, 'url': 'https://www.youtube.com/watch?v=' + FIRST,
                                         'title': 'First search result', 'channel': 'Artist', 'duration': 0.02}]}

                with patch.object(self.intake, 'cmd_search', side_effect=search):
                    response = self.post(client, token, '/api/playlists/' + playlist['id'] + '/match',
                                         json={'index': 0})
                self.assertEqual(response.status_code, 409, response.json)
                saved = next(row for row in self.go(client, 'GET', '/api/playlists').json['playlists']
                             if row['id'] == playlist['id'])
                self.assertEqual(saved, edited)

    def test_saved_purified_recording_links_using_original_duration(self):
        item, target, manifest, audio = self.recording()
        client, token = self.signed_in()
        playlist = self.create(client, token)
        playlist['tracks'] = [{'title': 'First', 'artist': 'Artist', 'duration': 196,
                               'state': 'review', 'candidates': [], 'spotify_uri': 'spotify:track:test'}]
        PlaylistStore(self.ws).save('sample-a', playlist)
        edition = {'duration': 179.77, 'original_duration': 195.73, 'size': target.stat().st_size,
                   'sha256': manifest['import']['library_sha256'], 'start': 0, 'end': 179.77}
        with patch('music_web.ListeningVersions.select', return_value=(edition, str(target))):
            result = self.go(client, 'GET', '/api/playlists').json['playlists'][0]['tracks'][0]
        self.assertEqual((result['source_id'], result['state']), (FIRST, 'saved'))

    def test_saved_recording_is_reused_across_playlists_without_search(self):
        self.recording(title='Artist - First (Official Audio)')
        client, token = self.signed_in()
        store = PlaylistStore(self.ws)
        source = {'title': 'First', 'artist': 'Artist', 'duration': .02, 'state': 'unmatched'}
        for pid in ('a'*22, 'b'*22):
            store.save('sample-a', dict(id=pid, name=pid, tracks=[
                dict(source), dict(source, title='First (Live)'), dict(source, artist='Artist & Guest')]))
        with patch.object(self.intake, 'cmd_search', side_effect=AssertionError('Expected a saved recording')):
            response = self.go(client, 'GET', '/api/playlists')
        self.assertEqual(response.status_code, 200)
        for playlist in response.json['playlists']:
            self.assertEqual([track.get('source_id') for track in playlist['tracks']], [FIRST, None, None])

    def test_playlist_survives_app_restart(self):
        self.recording()
        client, token = self.signed_in()
        playlist = self.create(client, token)
        playlist = self.mutate(client, token, playlist, {'add_source_id': FIRST}).json['playlist']
        self.app = music_web.create_app({
            'SECRET_KEY': 'k' * 40, 'CLI_PATH': str(ROOT / 'scripts' / 'music-intake.py'),
            'WORKSPACE': self.ws, 'LIBRARY': self.lib, 'PUBLIC_ORIGIN': ORIGIN,
            'PLAYER_URL': 'https://player.test/', 'ALLOWED_USERS': ['sample-a', 'sample-b'],
            # This restart uses the same transport-only fixture policy as Base.setUp.
            'REQUIRE_FINISHED_AUDIO': False,
        })
        self.state = self.app.extensions['music']
        client, _ = self.signed_in()
        self.assertEqual(self.go(client, 'GET', '/api/playlists').json['playlists'][0], playlist)

    def test_legacy_spotify_playlist_remains_editable_and_retains_matching_state(self):
        legacy = {'id': '6CCDIMytDCox2aDcNi1ztu', 'name': 'DnB', 'tracks': [
            {'title': 'Local entry', 'artist': '', 'duration': 123, 'spotify_uri': 'spotify:local:::local:123',
             'candidates': [], 'state': 'unmatched', 'job_id': 'existing-job'},
        ], 'notice': 'Imported'}
        PlaylistStore(self.ws).save('sample-a', legacy)
        client, token = self.signed_in()
        listed = self.go(client, 'GET', '/api/playlists').json['playlists'][0]
        self.assertEqual(listed['revision'], 0)
        renamed = self.mutate(client, token, listed, {'name': 'Renamed'}).json['playlist']
        self.assertEqual(renamed['tracks'], legacy['tracks'])
        self.assertEqual(renamed['revision'], 1)


if __name__ == '__main__':
    unittest.main()
