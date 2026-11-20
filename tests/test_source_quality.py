import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from music_web.source_quality import (SourceQuality, analyze, classify, spectrum, SIZE, RATE, ScanPaused,
                                      replace_saved, official_replacement, automatic_match)
from music_web.playlists import PlaylistStore
from music_web.listening_stats import ListeningStats
from test_music_web import Base
import test_native_music_api as native

FFMPEG = shutil.which('ffmpeg') or next(
    (str(path) for path in (Path(__file__).resolve().parents[1] / '.local/tools/ffmpeg').glob('*/bin/ffmpeg.exe')),
    None)


class SpectrumTests(unittest.TestCase):
    def test_fft_distinguishes_high_frequency_content_from_a_shelf(self):
        def energy(frequencies):
            return spectrum([sum(math.sin(2 * math.pi * frequency * i / RATE) for frequency in frequencies)
                             for i in range(SIZE)])
        self.assertEqual(classify([energy([3000, 14500])] * 3)['verdict'], 'suspect')
        self.assertEqual(classify([energy([3000, 14500, 19500])] * 3)['verdict'], 'clean')

    def test_silence_and_low_bandwidth_without_shelf_are_unknown(self):
        self.assertEqual(classify([[0] * 5] * 3)['verdict'], 'unknown')
        self.assertEqual(classify([[1, 1e-8, 1e-10, 1e-10, 1e-10]] * 3)['verdict'], 'unknown')

    def test_playback_yields_before_decoding(self):
        with patch('music_web.source_quality.subprocess.Popen') as process:
            with self.assertRaises(ScanPaused):
                analyze('unused', 180, idle=lambda: False)
            process.assert_not_called()

    def test_missing_decoder_is_unknown(self):
        with patch('music_web.source_quality.subprocess.Popen', side_effect=FileNotFoundError):
            self.assertEqual(analyze('unused', 180)['verdict'], 'unknown')

    @unittest.skipUnless(FFMPEG, 'ffmpeg is missing')
    def test_generated_opus_and_hard_shelves(self):
        with tempfile.TemporaryDirectory() as temporary:
            for cutoff, verdict in [(20000, 'clean'), (16000, 'suspect'), (17000, 'suspect')]:
                path = Path(temporary) / f'{cutoff}.opus'
                made = subprocess.run([FFMPEG, '-nostdin', '-v', 'error', '-f', 'lavfi',
                    '-i', 'anoisesrc=color=white:sample_rate=48000:duration=10:seed=42',
                    '-af', f'sinc=lp={cutoff}:lptaps=4095', '-c:a', 'libopus', '-b:a', '160k', str(path)],
                    capture_output=True, timeout=30)
                # Some ffmpeg builds lack libopus or the sinc filter; the analysis itself is not at fault.
                if made.returncode: self.skipTest('this ffmpeg cannot make the Opus test file')
                result = analyze(path, 10, ffmpeg=FFMPEG)
                self.assertEqual(result['verdict'], verdict, (cutoff, result))


class QualityScanTests(Base):
    extra = {'ADMIN_USERS': ['sample-a']}

    def proposal(self):
        item, target, manifest, audio = native.NativeMusicApi.recording(self)
        candidate = dict(id=native.SECOND, url='https://www.youtube.com/watch?v=' + native.SECOND,
                         title='First', channel='Artist - Topic', duration=.02, source_tier=1)
        row = dict(id=native.FIRST, sha256=manifest['audio']['sha256'], title='First', artist='Artist',
                   duration=.02, verdict='suspect', source_tier=3, proposed_replacement=candidate)
        self.state.source_quality.save(native.FIRST + ':' + row['sha256'], row)
        return item, target, manifest, candidate

    def wait_replaced(self):
        for _ in range(300):
            if not any(row.get('replacing') for row in self.state.source_quality.rows.values()): break
            time.sleep(.02)
        self.assertFalse(any(row.get('replacing') for row in self.state.source_quality.rows.values()))
        self.assertFalse(self.state.source_quality.replace_lock.locked())

    def test_replace_all_queues_only_the_chosen_group(self):
        _, _, _, candidate = self.proposal()
        admin, token = self.signed_in()
        response = self.post(admin, token, '/api/catalogue/source-quality/replace-all', json=dict(group='unofficial'))
        self.assertEqual((response.status_code, response.json['queued']), (202, 0))
        self.assertEqual(self.post(admin, token, '/api/catalogue/source-quality/replace-all', json=dict(group='x')).status_code, 400)
        self.state.jobs['busy'] = dict(source_id=native.SECOND, state='running')
        response = self.post(admin, token, '/api/catalogue/source-quality/replace-all', json=dict(group='damaged'))
        self.assertEqual((response.status_code, response.json['queued']), (202, 1))
        row = self.state.source_quality.snapshot()['songs'][0]
        self.assertTrue(row['replacing'] and row['queued'])
        self.assertEqual(self.post(admin, token, f'/api/catalogue/source-quality/{native.FIRST}/replace', json=dict(candidate_id=native.SECOND)).status_code, 409)

    def test_replacement_uses_acquisition_and_repoints_all_profiles(self):
        item, target, manifest, candidate = self.proposal()
        store = PlaylistStore(self.ws)
        for user in ('sample-a', 'sample-b'):
            store.save(user, dict(id='p' * 22, tracks=[dict(source_id=native.FIRST, match=dict(id=native.FIRST))]))
        review = self.state.catalogue_review
        values = dict(artist='Reviewed artist', album='Reviewed album', genre='Pop')
        review.data['overrides'][native.FIRST] = dict(sha256=manifest['import']['library_sha256'], values=values)
        review.dirty = True
        review.flush()
        lyrics = Path(self.ws) / '.lyrics'
        lyrics.mkdir()
        (lyrics / (native.FIRST + '.json')).write_text('{"state":"plain","text":"words"}')

        def fetch(args):
            new_item, _, new_manifest, _ = native.NativeMusicApi.recording(self, source_id=native.SECOND, samples=b'\x03\x04' * 160)
            return dict(item=str(new_item), manifest=new_manifest)

        admin, token = self.signed_in()
        with patch.object(self.intake, 'cmd_fetch', side_effect=fetch) as acquisition, patch.object(self.intake, 'cmd_preview', side_effect=ValueError):
            response = self.post(admin, token, f'/api/catalogue/source-quality/{native.FIRST}/replace', json=dict(candidate_id=native.SECOND))
            self.assertEqual(response.status_code, 202, response.json)
            self.wait_replaced()
            acquisition.assert_called_once()
        self.assertEqual(self.state.source_quality.snapshot()['songs'], [])
        for user in ('sample-a', 'sample-b'):
            row = store.read(user, 'p' * 22)['tracks'][0]
            self.assertEqual((row['source_id'], row['match']['id']), (native.SECOND, native.SECOND))
        new_item = next(Path(self.ws).glob('yt-' + native.SECOND + '-*'))
        _, new_manifest, _ = self.intake.load_item(str(new_item))
        self.assertNotEqual(new_manifest['import']['library_sha256'], manifest['import']['library_sha256'])
        self.assertEqual(review.overrides(native.SECOND, new_manifest['import']['library_sha256']), values)
        self.assertEqual(review.overrides(native.SECOND, manifest['import']['library_sha256']), {})
        archive = Path(self.ws) / '.replaced' / native.FIRST
        self.assertFalse(item.exists())
        self.assertFalse(target.exists())
        self.assertTrue((archive / item.name / 'audio.wav').exists())
        self.assertTrue((archive / 'library' / target.name).exists())
        self.assertTrue((lyrics / (native.SECOND + '.json')).exists())
        journal = json.loads((Path(self.ws) / '.replacements.json').read_text())
        self.assertEqual(journal[native.FIRST]['state'], 'done')
        # An in-flight playlist preparation must not write the archived ID back later.
        store.save('sample-a', dict(id='q' * 22, tracks=[dict(source_id=native.FIRST, match=dict(id=native.FIRST))]))
        self.assertEqual(store.read('sample-a', 'q' * 22)['tracks'][0]['source_id'], native.SECOND)

    def test_lengths_are_compared_after_trimming(self):
        item, _, manifest, candidate = self.proposal()
        new_item, _, new_manifest, _ = native.NativeMusicApi.recording(
            self, source_id=native.SECOND, samples=b'' * 160)
        new_manifest = dict(new_manifest, audio=dict(new_manifest['audio'], duration=manifest['audio']['duration'] + 9))
        saved = {native.FIRST: dict(item=str(item), manifest=manifest), native.SECOND: dict(item=str(new_item), manifest=new_manifest)}
        args = (self.ws, self.lib, native.FIRST, candidate, saved.get, PlaylistStore(self.ws),
                self.state.catalogue_review, ListeningStats(self.ws), self.intake)
        with self.assertRaisesRegex(ValueError, 'After trimming silence'):
            replace_saved(*args)
        with patch('music_web.source_quality.shutil.move', side_effect=OSError('Archive unavailable')):
            with self.assertRaises(OSError):
                replace_saved(*args, length=lambda saved: 100.0)

    def test_undo_automatic_replacement_preserves_later_playlist_edits_and_restores_audio(self):
        item, target, _, candidate = self.proposal()
        native.NativeMusicApi.recording(self, source_id=native.SECOND, samples=b'\x03\x04' * 160)
        original_audio = target.read_bytes()
        store = PlaylistStore(self.ws)
        pid = 'p' * 22
        original = dict(source_id=native.FIRST, match=dict(id=native.FIRST), state='saved')
        store.save('sample-a', dict(id=pid, name='Before replacement', tracks=[dict(original), dict(original)]))
        saved = {}
        for path in Path(self.ws).glob('yt-*'):
            _, manifest, _ = self.intake.load_item(str(path))
            saved[manifest['source']['id']] = dict(item=str(path), manifest=manifest)
        review = self.state.catalogue_review
        old_digest = saved[native.FIRST]['manifest']['import']['library_sha256']
        new_digest = saved[native.SECOND]['manifest']['import']['library_sha256']
        review.observe(dict(id=native.SECOND, title='First', channel='Artist'), {}, new_digest)
        review.data['overrides'][native.FIRST] = dict(sha256=old_digest, values={'artist': 'Family artist', 'genre': 'Rock'})
        review.data['overrides'][native.SECOND] = dict(sha256=new_digest, values={'album': 'Family album'})
        review.dirty = True
        replace_saved(self.ws, self.lib, native.FIRST, candidate, saved.get, store,
                      review, ListeningStats(self.ws), self.intake,
                      automatic=dict(title='First', artist='Artist', damaged=True))
        self.assertEqual(review.overrides(native.SECOND, new_digest),
                         {'album': 'Family album', 'artist': 'Family artist', 'genre': 'Rock'})
        row = review.data['metadata'][native.SECOND]
        review.edit_metadata(native.SECOND, row['revision'], {'genre': 'Rock'})
        self.assertFalse(item.exists())
        self.assertFalse(target.exists())
        self.assertEqual(self.state.source_quality.snapshot()['fixed'][0]['id'], native.FIRST)
        playlist = store.read('sample-a', pid)
        playlist['name'] = 'Changed after replacement'
        playlist['tracks'][1].update(source_id='other000000', match=dict(id='other000000'))
        playlist['tracks'].append(dict(source_id=native.SECOND, match=candidate, state='saved'))
        store.save('sample-a', playlist)
        # A delayed playlist save can still refer to the original after its initial replacement.
        late = 'q' * 22
        store.save('sample-a', dict(id=late, tracks=[dict(original)]))
        self.assertEqual(store.read('sample-a', late)['tracks'][0]['source_id'], native.SECOND)

        admin, token = self.signed_in()
        url = f'/api/catalogue/source-quality/{native.FIRST}/undo'
        self.assertEqual(self.post(admin, token, url, json={}).status_code, 200)
        self.assertEqual(self.post(admin, token, url, json={}).status_code, 200)
        self.assertTrue(item.exists())
        self.assertEqual(target.read_bytes(), original_audio)
        restored = store.read('sample-a', pid)
        self.assertEqual(restored['name'], 'Changed after replacement')
        self.assertEqual([row['source_id'] for row in restored['tracks']], [native.FIRST, 'other000000', native.SECOND])
        self.assertEqual(store.read('sample-a', late)['tracks'][0]['source_id'], native.FIRST)
        self.assertEqual(review.overrides(native.FIRST, old_digest), {'artist': 'Family artist', 'genre': 'Rock'})
        self.assertEqual(review.overrides(native.SECOND, new_digest), {'album': 'Family album', 'genre': 'Rock'})
        snapshot = self.state.source_quality.snapshot()
        self.assertEqual(snapshot['fixed'], [])
        self.assertTrue(snapshot['songs'][0]['automatic_skipped'])

    def test_failed_archive_restores_review_in_memory_and_on_disk(self):
        item, target, manifest, candidate = self.proposal()
        new_item, _, new_manifest, _ = native.NativeMusicApi.recording(
            self, source_id=native.SECOND, samples=b'\x03\x04' * 160)
        review = self.state.catalogue_review
        values = dict(artist='Reviewed artist')
        review.data['overrides'][native.FIRST] = dict(sha256=manifest['import']['library_sha256'], values=values)
        review.dirty = True
        review.flush()
        before = json.loads(review.path.read_text(encoding='utf-8'))
        saved = {
            native.FIRST: dict(item=str(item), manifest=manifest),
            native.SECOND: dict(item=str(new_item), manifest=new_manifest),
        }
        with patch('music_web.source_quality.shutil.move', side_effect=OSError('Archive unavailable')):
            with self.assertRaises(OSError):
                replace_saved(self.ws, self.lib, native.FIRST, candidate, saved.get,
                              PlaylistStore(self.ws), review, ListeningStats(self.ws), self.intake)
        self.assertEqual(review.data, before)
        self.assertEqual(json.loads(review.path.read_text(encoding='utf-8')), before)
        self.assertFalse(review.dirty)
        self.assertTrue(item.exists())
        self.assertTrue(target.exists())

    def test_dismiss_and_non_admin_mutations(self):
        self.proposal()
        member, token = self.signed_in('sample-b')
        for action in ('dismiss', 'replace'):
            self.assertEqual(self.post(member, token, f'/api/catalogue/source-quality/{native.FIRST}/{action}', json={}).status_code, 403)
        admin, token = self.signed_in()
        response = self.post(admin, token, f'/api/catalogue/source-quality/{native.FIRST}/dismiss', json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SourceQuality(self.ws, self.intake).snapshot()['songs'], [])
        self.assertEqual(next(iter(self.state.source_quality.rows.values()))['verdict'], 'suspect')
        snapshot = self.go(admin, 'GET', '/api/catalogue/source-quality').json
        self.assertEqual(snapshot['songs'], [])
        self.assertEqual((snapshot['counts']['damaged'], snapshot['counts']['unofficial']), (0, 0))
        self.assertEqual((snapshot['counts']['suspect'], snapshot['counts']['total']), (1, 1))

    def test_cached_mismatched_proposal_is_hidden_and_cannot_replace(self):
        _, _, _, candidate = self.proposal()
        candidate.update(title='Other Animusic Songs', channel='Other Animusic Songs', recommended=True)
        snapshot = self.state.source_quality.snapshot()
        self.assertIsNone(snapshot['songs'][0]['proposed_replacement'])
        self.assertEqual(snapshot['counts']['damaged'], 1)
        admin, token = self.signed_in()
        response = self.post(admin, token, f'/api/catalogue/source-quality/{native.FIRST}/replace', json=dict(candidate_id=native.SECOND))
        self.assertEqual(response.status_code, 400)
        self.assertFalse(self.state.source_quality.replace_lock.locked())

    def test_duration_and_running_download_are_refused(self):
        _, _, _, candidate = self.proposal()
        admin, token = self.signed_in()
        candidate['duration'] = 30
        response = self.post(admin, token, f'/api/catalogue/source-quality/{native.FIRST}/replace', json=dict(candidate_id=native.SECOND))
        self.assertEqual(response.status_code, 400)
        candidate['duration'] = .02
        # A running download of the candidate queues the replacement until it finishes.
        self.state.jobs['busy'] = dict(source_id=native.SECOND, state='running')
        response = self.post(admin, token, f'/api/catalogue/source-quality/{native.FIRST}/replace', json=dict(candidate_id=native.SECOND))
        self.assertEqual(response.status_code, 202)
        time.sleep(.1)
        self.assertTrue(self.state.source_quality.snapshot()['songs'][0]['queued'])
        self.assertFalse(self.state.source_quality.replace_lock.locked())

    def test_idle_cache_and_replacement_never_change_audio(self):
        native.NativeMusicApi.recording(self, title='Artist - First')
        scanner = self.state.source_quality
        scanner.idle = lambda: False
        with patch('music_web.source_quality.analyze') as measurement:
            scanner.scan_once()
            measurement.assert_not_called()
        scanner.idle = lambda: True
        candidate = dict(id='abcdefghijk', title='First', channel='Artist - Topic', duration=.02)
        item = next(Path(self.ws).glob('yt-*'))
        before = (item / 'audio.wav').read_bytes()
        with patch('music_web.source_quality.analyze', return_value=dict(verdict='suspect', bands_db=[])) as measurement:
            with patch.object(self.intake, 'cmd_search', return_value=dict(results=[candidate])) as search:
                scanner.scan_once()
                scanner.scan_once()
                self.assertEqual(measurement.call_count, 1)
                self.assertEqual(search.call_count, 1)
        self.assertEqual((item / 'audio.wav').read_bytes(), before)
        row = scanner.snapshot()['songs'][0]
        self.assertEqual(row['proposed_replacement']['id'], candidate['id'])
        self.assertEqual(row['source_tier'], 3)
        restored = SourceQuality(self.ws, self.intake)
        self.assertEqual(restored.snapshot(), scanner.snapshot())
        data = json.loads((Path(self.ws) / '.source-quality.json').read_text())
        self.assertIn(native.FIRST + ':' + self.intake.sha256_file(str(item / 'audio.wav')), data)

    def test_admin_endpoint(self):
        admin, _ = self.signed_in('sample-a')
        member, _ = self.signed_in('sample-b')
        self.assertEqual(self.go(member, 'GET', '/api/catalogue/source-quality').status_code, 403)
        result = self.go(admin, 'GET', '/api/catalogue/source-quality')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['counts']['total'], 0)
        self.assertEqual(result.json['songs'], [])

    def test_failed_source_search_exposes_retry_and_does_not_search_again_early(self):
        native.NativeMusicApi.recording(self)
        scanner = self.state.source_quality
        with patch('music_web.source_quality.analyze', return_value={'verdict': 'suspect', 'bands_db': []}), \
                patch.object(self.intake, 'cmd_search', side_effect=OSError) as search:
            self.assertTrue(scanner.scan_once())
            row = scanner.snapshot()['songs'][0]
            self.assertEqual(row['retry_reason'], 'Source search unavailable')
            self.assertGreater(row['retry_at'], time.time())
            self.assertTrue(scanner.scan_once())
            search.assert_called_once()

    def test_idle_scan_limits_audio_measurement_per_pass(self):
        for source in (native.FIRST, native.SECOND):
            native.NativeMusicApi.recording(self, source_id=source)
        scanner = self.state.source_quality
        scanner.limit_search = True
        with patch('music_web.source_quality.SCAN_BATCH', 1), \
                patch('music_web.source_quality.analyze', return_value={'verdict': 'clean', 'bands_db': []}) as measure, \
                patch.object(self.intake, 'cmd_search', return_value={'results': []}):
            self.assertTrue(scanner.scan_once())
            self.assertEqual(measure.call_count, 1)
            scanner.scan_once()
            scanner.scan_once()
            self.assertEqual(measure.call_count, 2)


class QualitySnapshotTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.scanner = SourceQuality(temporary.name, None)
        self.candidate = dict(id='official', title='Pipe Dream', channel='Animusic - Topic',
                              duration=180, source_tier=1)

    def row(self, identifier, verdict='clean', tier=3, candidate=None, **flags):
        row = dict(id=identifier, title='Pipe Dream', artist='Animusic', duration=180,
                   verdict=verdict, source_tier=tier, proposed_replacement=candidate, **flags)
        self.scanner.save(identifier, row)
        return row

    def test_problem_categories_counts_and_retained_measurements(self):
        self.row('damage-official', verdict='suspect', tier=1)
        self.row('damage-fan', verdict='suspect', candidate=self.candidate, replacing=True)
        self.row('fan-clean', candidate=self.candidate)
        self.row('fan-unknown', verdict='unknown', candidate=self.candidate)
        self.row('fan-no-match')
        self.row('unknown-no-match', verdict='unknown')
        self.row('official-clean', tier=1, candidate=self.candidate)
        self.row('dismissed', verdict='suspect', candidate=self.candidate, dismissed=True)
        self.row('replaced', verdict='suspect', candidate=self.candidate, replaced_by='official')
        snapshot = self.scanner.snapshot()
        self.assertEqual([r['id'] for r in snapshot['songs']],
                         ['damage-official', 'damage-fan', 'fan-clean', 'fan-unknown'])
        self.assertEqual(snapshot['counts']['damaged'], 2)
        self.assertEqual(snapshot['counts']['unofficial'], 2)
        self.assertEqual(snapshot['counts']['damaged'] + snapshot['counts']['unofficial'], len(snapshot['songs']))
        self.assertTrue(snapshot['songs'][1]['replacing'])
        self.assertEqual(snapshot['counts']['total'], 9)
        self.assertEqual(snapshot['counts']['tier_3'], 7)
        self.assertIn('fan-no-match', self.scanner.rows)
        self.assertEqual(self.scanner.rows['dismissed']['verdict'], 'suspect')
        self.scanner.active_keys = {'damage-official', 'fan-clean', 'fan-no-match'}
        snapshot = self.scanner.snapshot()
        self.assertEqual((snapshot['counts']['damaged'], snapshot['counts']['unofficial']), (1, 1))
        self.assertEqual(snapshot['counts']['total'], 3)

    def test_official_matching_rechecks_title_artist_version_and_source(self):
        track = self.row('original')
        for changes in (dict(title='Other Animusic Songs'), dict(title='Pipe Dream (Live)'),
                        dict(channel='Animusic fan'), dict(channel='Another Artist - Topic')):
            with self.subTest(changes=changes):
                candidate = {**self.candidate, **changes, 'recommended': True}
                self.assertIsNone(official_replacement(track, [candidate]))
                track['proposed_replacement'] = candidate
                self.assertEqual(self.scanner.snapshot()['songs'], [])
        candidate = {**self.candidate, 'title': 'Animusic - Pipe Dream (Official Audio)'}
        self.assertEqual(official_replacement(track, [candidate])['id'], 'official')

    def test_invalid_cached_proposal_is_researched_after_restart(self):
        self.row('original', verdict='suspect', candidate={**self.candidate, 'title': 'Other Animusic Songs'},
                 replacement_checked=True)
        restored = SourceQuality(self.scanner.workspace, None)
        self.assertIsNone(restored.rows['original']['proposed_replacement'])
        self.assertFalse(restored.rows['original']['replacement_checked'])
        self.assertIsNone(restored.snapshot()['songs'][0]['proposed_replacement'])


class AutomaticMatchTests(unittest.TestCase):
    def test_requires_same_title_credit_edition_and_duration(self):
        track = dict(id=native.FIRST, title='First', artist='Artist', duration=180)
        candidate = dict(id=native.SECOND, title='Artist - First (Official Audio)', channel='Artist - Topic', duration=183)
        for channel in ('Artist - Topic', 'Artist Official', 'ArtistVEVO'):
            with self.subTest(channel=channel):
                self.assertEqual(automatic_match(track, dict(candidate, channel=channel))['id'], native.SECOND)
        for changes in (dict(id=native.FIRST), dict(title='First (Live)'), dict(title='Another - First'),
                        dict(track_title='First (Radio Edit)'), dict(artist='Artist & Guest'),
                        dict(channel='Different - Topic', kind='topic'), dict(channel='Artist Fan'),
                        dict(channel='Artist'), dict(duration=183.01), dict(duration=None), dict(duration=float('nan'))):
            with self.subTest(changes=changes):
                self.assertIsNone(automatic_match(track, dict(candidate, **changes)))


class AutomaticReplacementTests(Base):
    extra = {'ADMIN_USERS': ['sample-a'], 'SOURCE_QUALITY_SCAN': True}

    def test_background_scan_replaces_with_verified_better_audio(self):
        scanner = self.state.source_quality
        self.addCleanup(scanner.stop.set)
        item, target, _, _ = native.NativeMusicApi.recording(self)
        official, _, manifest, _ = native.NativeMusicApi.recording(self, source_id=native.SECOND, samples=b'\x03\x04' * 160)
        manifest['source'].update(title='First', channel='Artist - Topic')
        self.intake.write_manifest(str(official), manifest)
        candidate = dict(id=native.SECOND, title='First', channel='Artist - Topic', url=manifest['source']['url'], duration=.02)

        def measurement(path, *args, **kwargs):
            return dict(verdict='suspect' if native.FIRST in str(path) else 'clean', bands_db=[])

        with patch('music_web.source_quality.analyze', side_effect=measurement), patch.object(
                self.intake, 'cmd_search', return_value=dict(results=[candidate])) as search:
            scanner.scan_once()
            for _ in range(100):
                if scanner.snapshot()['fixed'] and not scanner.replace_lock.locked():
                    break
                time.sleep(.02)
            search.assert_called_once()
            self.assertTrue(search.call_args.args[0].youtube_background)
        self.assertFalse(item.exists())
        self.assertFalse(target.exists())
        self.assertEqual(scanner.snapshot()['fixed'][0]['replaced_by'], native.SECOND)
        self.assertEqual([kind for _, kind in self.state.catalogue_review.data['automatic_attempts']],
                         ['source search', 'source replacement'])
