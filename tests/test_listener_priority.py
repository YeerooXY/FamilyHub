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
            with mock.patch.object(mobile_audio, "measure_loudness", return_value={"input_i": -16, "input_tp": -2}):
                with mobile_audio._encoding:  # a background playlist encode is running
                    worker = threading.Thread(target=lambda: (mobile_audio.prepare(intake, item, source, "a" * 64, urgent=True), done.set()))
                    worker.start()
                    self.assertTrue(done.wait(2), "the listener's encode waited for background work")
                worker.join(2)
            self.assertTrue(os.path.exists(os.path.join(item, f".{mobile_audio.VERSION}-{'a' * 64}.opus")))


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
