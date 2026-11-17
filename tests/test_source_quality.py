import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from music_web.source_quality import SourceQuality, analyze, classify, spectrum, SIZE, RATE, ScanPaused
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
