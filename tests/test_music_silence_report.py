import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("silence_report", Path(__file__).resolve().parents[1] / "scripts/analyze-music-silence.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class SilenceReport(unittest.TestCase):
    def levels(self, values):
        return [{"time": i*.1, "seconds": .1, "rms_dbfs": rms, "peak_dbfs": peak}
                for i, (rms, peak) in enumerate(values)]

    def test_quiet_tail_with_brief_peaks_is_detected(self):
        values = [(-16, -4)]*300 + [(-55, -40)]*150
        values[325:328] = [(-25, -10)]*3
        values[410:414] = [(-27, -13)]*4
        result = report.propose_edge(self.levels(values), ending=True)
        self.assertAlmostEqual(result["proposed_skip_seconds"], 14.85)
        self.assertEqual(result["kind"], "quiet with brief peaks")

    def test_middle_quiet_section_does_not_cut_edges(self):
        values = [(-16, -4)]*100 + [(-60, -50)]*200 + [(-16, -4)]*150
        self.assertEqual(report.propose_edge(self.levels(values))["proposed_skip_seconds"], 0)
        self.assertEqual(report.propose_edge(self.levels(values), ending=True)["proposed_skip_seconds"], 0)

    def test_sustained_return_of_sound_is_preserved(self):
        values = [(-16, -4)]*300 + [(-55, -40)]*70 + [(-20, -4)]*10 + [(-55, -40)]*70
        self.assertAlmostEqual(report.propose_edge(self.levels(values), ending=True)["proposed_skip_seconds"], 6.85)

    def test_uniform_quiet_music_is_not_treated_as_silence(self):
        result = report.propose_edge(self.levels([(-40, -25)]*450), ending=True)
        self.assertEqual(result["proposed_skip_seconds"], 0)

    def test_unmeasured_long_silence_is_flagged(self):
        result = report.propose_edge(self.levels([(-120, -100)]*450), ending=True)
        self.assertTrue(result["window_limited"])

    def test_internal_quiet_is_excluded_and_eof_is_closed(self):
        result = report.edge_intervals("silence_start: 0\nsilence_end: 1.2\n"
            "silence_start: 30\nsilence_end: 35\nsilence_start: 95", 100)
        self.assertEqual(result["beginning"], [{"start": 0, "end": 1.2, "seconds": 1.2}])
        self.assertEqual(result["ending"], [{"start": 95, "end": 100, "seconds": 5}])

    def test_tiny_boundary_gaps_are_excluded(self):
        self.assertEqual(report.edge_intervals("silence_start: 0\nsilence_end: .02", 100),
                         {"beginning": [], "ending": []})

    def test_decoder_delay_and_probe_rounding_are_clamped(self):
        result = report.edge_intervals("silence_start: -0.005\nsilence_end: 1\n"
            "silence_start: 98\nsilence_end: 100.007", 100)
        self.assertEqual(result["beginning"][0]["start"], 0)
        self.assertEqual(result["ending"][0]["end"], 100)
