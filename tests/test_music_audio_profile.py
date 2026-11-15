import json
import threading
import time
import unittest
from types import SimpleNamespace
from unittest import mock

from music_web.audio_profile import parse_measurement, profile
from music_web.mixing import transition
from music_web import preview_victims
from tests.test_music_intake import Base, HAVE_FFMPEG, mi


class Measurements(unittest.TestCase):
    def test_only_boundary_silence_is_removed_and_peak_limits_gain(self):
        log = 'silence_start: 0 silence_end: 1.45 silence_start: 5 silence_end: 6 silence_start: 19 silence_end: 20 '
        log += json.dumps({'input_i': '-22', 'input_tp': '-3'})
        result = parse_measurement(log, 20)
        self.assertAlmostEqual(result['start'], 1.37)
        self.assertAlmostEqual(result['end'], 19.08)
        self.assertEqual(result['gain_db'], 1.5)
        plan = transition({}, {}, 20, 4, left_audio=result, right_audio=result)
        self.assertAlmostEqual(plan['out'], 15.08)
        self.assertAlmostEqual(plan['in'], 1.37)

    def test_next_and_recently_requested_audio_survive_cache_pressure(self):
        jobs = [dict(priority=i, created=i, preview_state='ready', cancel=threading.Event()) for i in range(10)]
        jobs[0]['current'] = True
        jobs[5]['accessed'] = time.time()
        victims = preview_victims(jobs)
        self.assertEqual([j['priority'] for j in victims], [9, 8, 7, 6, 4, 3, 2])
        jobs[1]['cancel'].set()
        self.assertIn(jobs[1], preview_victims(jobs))


@unittest.skipUnless(HAVE_FFMPEG, 'FFmpeg required')
class MeasuredAudio(Base):
    def test_real_measurement_is_cached_without_changing_audio(self):
        original = self.tmp / 'silence-tone.flac'
        rc, _, _ = mi.run([mi.tool('ffmpeg'), '-v', 'error', '-f', 'lavfi', '-i',
            'sine=frequency=440:duration=8', '-af', 'adelay=1500,apad=pad_dur=2', str(original)], 30, 'fixture')
        self.assertEqual(rc, 0)
        item = mi.cmd_stage(SimpleNamespace(file=str(original), workspace=str(self.ws)))
        _, manifest, audio = mi.load_item(item['item'])
        before = mi.sha256_file(audio)
        result = profile(mi, item['item'], manifest, measure=True)
        self.assertAlmostEqual(result['start'], 1.42, delta=.04)
        self.assertAlmostEqual(result['end'], 9.58, delta=.04)
        self.assertTrue(-60 < result['gain_db'] <= 12)
        with mock.patch.object(mi, 'run', side_effect=AssertionError('cached measurements must not decode again')):
            self.assertEqual(profile(mi, item['item'], manifest, measure=True), result)
        self.assertEqual(mi.sha256_file(audio), before)
