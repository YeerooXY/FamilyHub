import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch, MagicMock

from test_music_web import Base
import test_native_music_api as native
from music_web.analysis import CAMELOT, KEY_PROFILES, detect_key, mean_chroma, analyze_library
from music_web.song_analysis import SongAnalysis, measure
from music_web.source_quality import ScanPaused


class CamelotTests(unittest.TestCase):
    def test_all_24_slots(self):
        self.assertEqual(CAMELOT, {
            'major': ('8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'),
            'minor': ('5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'),
        })
        self.assertEqual(set(CAMELOT['major'] + CAMELOT['minor']),
                         {str(number) + letter for number in range(1, 13) for letter in 'AB'})

    def test_busy_scanner_does_not_spawn(self):
        with patch('music_web.song_analysis.subprocess.Popen') as process:
            with self.assertRaises(ScanPaused):
                measure('unused', 180, lambda: False, 'ffmpeg')
            process.assert_not_called()

    def test_running_worker_is_reaped_when_playback_needs_it(self):
        child = MagicMock()
        child.poll.return_value = None
        child.communicate.side_effect = [subprocess.TimeoutExpired('analysis', .2), (b'', b'')]
        with patch('music_web.song_analysis.subprocess.Popen') as spawn, \
                patch('music_web.song_analysis.os.killpg', create=True) as kill_group, \
                patch('music_web.song_analysis.subprocess.run') as kill_tree:
            spawn.return_value.__enter__.return_value = child
            idle = iter([True, True, False])
            with self.assertRaises(ScanPaused):
                measure('unused', 180, lambda: next(idle), 'ffmpeg')
            self.assertEqual(child.communicate.call_count, 2)
            self.assertTrue(kill_group.called or kill_tree.called)
            self.assertEqual(spawn.call_args.kwargs['env']['OPENBLAS_NUM_THREADS'], '1')


class KeyDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import librosa
            import numpy as np
        except ImportError as error:
            raise unittest.SkipTest(f'librosa dependencies missing: {error}')
        cls.np = np

    def test_profiles_silence_and_ambiguous_chroma(self):
        np = self.np
        for mode, profile in KEY_PROFILES.items():
            for pitch in range(12):
                self.assertEqual(detect_key(np.roll(profile, pitch))['key'], CAMELOT[mode][pitch])
        for chroma in (np.zeros(12), np.ones(12), np.full(12, np.nan),
                       (np.array(KEY_PROFILES['major']) + np.roll(KEY_PROFILES['minor'], 9)) / 2):
            self.assertEqual(detect_key(chroma), {})
        self.assertEqual(detect_key(mean_chroma(np.zeros(22050 * 2), 22050)), {})

    def test_synthesised_chords_and_weighted_scales(self):
        np = self.np
        sr = 22050
        for mode, pitch in [('major', 0), ('minor', 9), ('minor', 6), ('major', 11)]:
            intervals = [0, 4, 7] if mode == 'major' else [0, 3, 7]
            time = np.arange(sr * 3) / sr
            chord = sum((1 if interval == 0 else .8) * np.sin(2 * np.pi *
                        (440 * 2 ** ((60 + pitch + interval - 69) / 12)) * time) for interval in intervals)
            self.assertEqual(detect_key(mean_chroma(chord, sr)).get('key'), CAMELOT[mode][pitch], (mode, pitch))
            intervals = [0, 2, 4, 5, 7, 9, 11] if mode == 'major' else [0, 2, 3, 5, 7, 8, 10]
            notes = []
            for interval in intervals:
                time = np.arange(int(sr * KEY_PROFILES[mode][interval] / 4)) / sr
                note = np.sin(2 * np.pi * (440 * 2 ** ((60 + pitch + interval - 69) / 12)) * time)
                notes.append(note)
            self.assertEqual(detect_key(mean_chroma(np.concatenate(notes), sr)).get('key'), CAMELOT[mode][pitch], (mode, pitch))

    def test_library_windows_are_bounded_and_bpm_needs_agreement(self):
        np = self.np
        decoded = MagicMock(stdout=np.zeros(22050 * 30, dtype='<f4').tobytes())
        with patch('subprocess.run', return_value=decoded) as decode, \
                patch('music_web.analysis.analyze', return_value={'reliable': True, 'bpm': 120.4}), \
                patch('music_web.analysis.mean_chroma', return_value=np.array(KEY_PROFILES['major'])):
            result = analyze_library('song.flac', 3600)
            self.assertEqual(result, {'bpm': 120, 'key': '8B', 'key_name': 'C major'})
            self.assertEqual(decode.call_count, 3)
            for call in decode.call_args_list:
                self.assertEqual(call.args[0][call.args[0].index('-t') + 1], '30')
                self.assertGreater(float(call.args[0][call.args[0].index('-ss') + 1]), 0)
        with patch('subprocess.run', return_value=decoded), \
                patch('music_web.analysis.analyze', side_effect=[{'reliable': True, 'bpm': 120},
                    {'reliable': True, 'bpm': 150}, {'reliable': False}]), \
                patch('music_web.analysis.mean_chroma', return_value=np.zeros(12)):
            self.assertEqual(analyze_library('song.flac', 180), {})
        with patch('subprocess.run', return_value=decoded), \
                patch('music_web.analysis.analyze', return_value={'reliable': False}), \
                patch('music_web.analysis.mean_chroma', return_value=np.array(KEY_PROFILES['minor'])):
            self.assertEqual(analyze_library('song.flac', 180), {'key': '5A', 'key_name': 'C minor'})
        with patch('subprocess.run', return_value=decoded), \
                patch('music_web.analysis.analyze', return_value={'reliable': False}), \
                patch('music_web.analysis.mean_chroma', side_effect=[
                    np.array(KEY_PROFILES['major']), np.roll(KEY_PROFILES['major'], 2),
                    np.array(KEY_PROFILES['major'])]):
            self.assertEqual(analyze_library('song.flac', 180), {})


class SongScannerTests(Base):
    def setUp(self):
        super().setUp()
        tool = patch.object(self.intake, 'tool', return_value='ffmpeg')
        tool.start()
        self.addCleanup(tool.stop)

    def test_idle_persistence_and_library_hash_invalidation(self):
        native.NativeMusicApi.recording(self)
        scanner = self.state.song_analysis
        scanner.idle = lambda: False
        with patch('music_web.song_analysis.measure') as worker:
            scanner.scan_once()
            worker.assert_not_called()
        scanner.idle = lambda: True
        item = next(Path(self.ws).glob('yt-*'))
        manifest = json.loads((item / 'manifest.json').read_text())
        with patch('music_web.song_analysis.measure', return_value={'bpm': 120, 'key': '8A', 'key_name': 'A minor'}) as worker:
            scanner.scan_once()
            scanner.scan_once()
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(worker.call_args.args[0], Path(self.lib) / manifest['import']['path'])
        digest = manifest['import']['library_sha256']
        restored = SongAnalysis(self.ws, self.lib, self.intake)
        self.assertEqual(restored.metadata(native.FIRST, digest), {'bpm': 120, 'key': '8A', 'key_name': 'A minor'})
        self.assertIn(native.FIRST + ':' + digest, json.loads(restored.path.read_text()))
        # The library digest can change independently of the original staged audio.
        replacement = Path(self.lib) / manifest['import']['path']
        replacement.write_bytes(replacement.read_bytes() + b'replaced')
        new_digest = self.intake.sha256_file(str(replacement))
        manifest['import']['library_sha256'] = new_digest
        (item / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.assertEqual(restored.metadata(native.FIRST, new_digest), {})
        with patch('music_web.song_analysis.measure', return_value={'key': '8B'}) as worker:
            restored.scan_once()
            worker.assert_called_once()
        self.assertEqual(restored.metadata(native.FIRST, new_digest), {'key': '8B', 'key_name': 'C major'})

    def test_library_json_exposes_only_the_current_hash(self):
        native.NativeMusicApi.recording(self)
        scanner = self.state.song_analysis
        with patch('music_web.song_analysis.measure', return_value={'bpm': 128, 'key': '11A'}):
            scanner.scan_once()
        client, _ = self.signed_in()
        track = self.go(client, 'GET', '/api/library').json['results'][0]
        self.assertEqual((track['bpm'], track['key'], track['key_name']), (128, '11A', 'F# minor'))
        scanner.rows = {native.FIRST + ':old': {'bpm': 100, 'key': '8A'}}
        track = self.go(client, 'GET', '/api/library').json['results'][0]
        self.assertNotIn('bpm', track)
        self.assertNotIn('key', track)

    def test_unknown_is_cached_and_pause_is_not(self):
        native.NativeMusicApi.recording(self)
        scanner = self.state.song_analysis
        with patch('music_web.song_analysis.measure', side_effect=ScanPaused):
            scanner.scan_once()
        self.assertFalse(scanner.rows)
        with patch('music_web.song_analysis.measure', return_value={}) as worker:
            scanner.scan_once()
            scanner.scan_once()
            worker.assert_called_once()

    def test_failed_persistence_is_retried(self):
        native.NativeMusicApi.recording(self)
        scanner = self.state.song_analysis
        with patch('music_web.song_analysis.measure', return_value={'bpm': 120}) as worker:
            with patch.object(Path, 'replace', side_effect=OSError('Disk unavailable')):
                scanner.scan_once()
            self.assertFalse(scanner.rows)
            self.assertFalse(scanner.path.exists())
            scanner.scan_once()
            self.assertEqual(worker.call_count, 2)
        self.assertEqual(json.loads(scanner.path.read_text()), scanner.rows)


class LibraryBpmTests(unittest.TestCase):
    def test_agreeing_windows_give_a_tempo(self):
        from music_web.analysis import library_bpm
        w = lambda bpm, c: dict(bpm=bpm, confidence=c, reliable=False)
        self.assertEqual(library_bpm([w(120.2, .45), w(120.2, .59), w(120.1, .36)]), 120)
        self.assertEqual(library_bpm([w(174, .4), w(87.1, .3)]), 174)            # half time agrees
        self.assertIsNone(library_bpm([w(114.8, .02), w(172.3, .29), w(117.5, .15)]))  # conflict
        self.assertIsNone(library_bpm([w(120, .5), w(120, .05)]))               # one supported window

