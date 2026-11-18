import importlib.util
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from music_web import mobile_audio


class ListenerLaneTests(unittest.TestCase):
    def test_listener_encode_does_not_wait_behind_background_encodes(self):
        with tempfile.TemporaryDirectory() as item:
            source = os.path.join(item, "song.flac"); Path(source).write_bytes(b"x")
            intake = mock.Mock()
            intake.tool.return_value = "ffmpeg"
            intake.probe.return_value = {"duration": 10.0}
            intake.SAFE_INPUT = []
            def run(args, *rest, **kw):
                Path(args[-1]).write_bytes(b"opus"); return 0, b"", ""
            intake.run.side_effect = run
            done = threading.Event()
            with mock.patch.object(mobile_audio, "measure_loudness", return_value={"input_i": -14, "input_tp": -2}):
                with mobile_audio._encoding:  # a background playlist encode is running
                    worker = threading.Thread(target=lambda: (mobile_audio.prepare(intake, item, source, "a" * 64, urgent=True), done.set()))
                    worker.start()
                    self.assertTrue(done.wait(2), "the listener's encode waited for background work")
                worker.join(2)
            self.assertTrue(os.path.exists(os.path.join(item, f".{mobile_audio.TIERS['normal'][1]}-{'a' * 64}.opus")))


    def test_song_needed_soonest_encodes_first(self):
        gate, order, started = mobile_audio._Gate(), [], []
        def wait(lead, name):
            with gate.turn(lead): order.append(name)
        with gate.turn(0):  # a listener's song is encoding
            for lead, name in ((200, "later"), (30, "soon"), (0, "skipped")):
                t = threading.Thread(target=wait, args=(lead, name)); t.start(); started.append(t)
            while len(gate.waiting) < 3: threading.Event().wait(.01)
        for t in started: t.join(2)
        self.assertEqual(order, ["skipped", "soon", "later"])

    def test_same_copy_is_encoded_once(self):
        with tempfile.TemporaryDirectory() as item:
            source = os.path.join(item, "song.flac"); Path(source).write_bytes(b"x")
            intake = mock.Mock(); intake.tool.return_value = "ffmpeg"; intake.SAFE_INPUT = []
            intake.probe.return_value = {"duration": 10.0}
            release, calls = threading.Event(), []
            def run(args, *rest, **kw):
                calls.append(1); release.wait(2); Path(args[-1]).write_bytes(b"opus"); return 0, b"", ""
            intake.run.side_effect = run
            with mock.patch.object(mobile_audio, "measure_loudness", return_value={"input_i": -14, "input_tp": -2}):
                workers = [threading.Thread(target=mobile_audio.prepare, args=(intake, item, source, "b" * 64), kwargs=dict(urgent=urgent)) for urgent in (False, True)]
                for w in workers: w.start()
                threading.Event().wait(.2); release.set()
                for w in workers: w.join(3)
            self.assertEqual(len(calls), 1)


    def test_song_playing_anywhere_gets_its_phone_copy_once(self):
        with tempfile.TemporaryDirectory() as item:
            source = os.path.join(item, "song.flac"); Path(source).write_bytes(b"x")
            intake = mock.Mock(spec=["tool", "probe", "run", "SAFE_INPUT", "regular_file"]); intake.tool.return_value = "ffmpeg"; intake.SAFE_INPUT = []
            intake.probe.return_value = {"duration": 10.0}
            made = threading.Event(); calls = []
            def run(args, *rest, **kw):
                calls.append(args[-1]); Path(args[-1]).write_bytes(b"opus"); made.set(); return 0, b"", ""
            intake.run.side_effect = run
            with mock.patch.object(mobile_audio, "measure_loudness", return_value={"input_i": -14, "input_tp": -2}),                     mock.patch.dict(mobile_audio._wanted, {"high": __import__("time").time()}, clear=True):
                warmer = mobile_audio.Warmer(intake, lambda s: (item, source, "c" * 64, "Song"), lambda: [], lambda: True, backfill=False, start_delay=0)
                try:
                    warmer.now_playing("dQw4w9WgXcQ")
                    self.assertTrue(made.wait(3))
                    warmer.now_playing("dQw4w9WgXcQ")
                    threading.Event().wait(.3)
                finally:
                    warmer.stop.set()
                    with warmer.cv: warmer.cv.notify_all()
            self.assertEqual(len(calls), 1)
            self.assertTrue(os.path.exists(mobile_audio.copy_path(item, "c" * 64, "high")))

def load_intake():
    path = Path(__file__).resolve().parents[1] / "scripts" / "music-intake.py"
    spec = importlib.util.spec_from_file_location("music_intake_priority", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


@unittest.skipIf(os.name == "nt", "niceness applies on the Linux server")
class BackgroundNiceTests(unittest.TestCase):
    def test_background_processes_run_niced_and_listener_ones_do_not(self):
        intake = load_intake()
        with mock.patch.object(intake.subprocess, "Popen") as popen:
            intake.CONTROL.background = True
            intake.spawn(["ffmpeg", "-version"])
            intake.CONTROL.background = False
            intake.spawn(["ffmpeg", "-version"])
        self.assertEqual(popen.call_args_list[0][0][0][:3], ["nice", "-n", "10"])
        self.assertEqual(popen.call_args_list[1][0][0], ["ffmpeg", "-version"])


if __name__ == "__main__":
    unittest.main()
