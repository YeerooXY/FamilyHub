import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from music_web import load_intake
from music_web.finished_audio import FinishedAudio, measurement


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class FinishedAudioTests(unittest.TestCase):
    def test_quiet_and_loud_sources_converge_preserve_original_and_reuse_output(self):
        intake = load_intake(str(Path(__file__).resolve().parents[1] / "scripts/music-intake.py"))
        with tempfile.TemporaryDirectory() as directory:
            store = FinishedAudio(directory, intake)
            for level in ("0.2", "3"):
                source = Path(directory) / (level + ".wav")
                subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=8", "-af", "volume=" + level, str(source)],
                    check=True, capture_output=True)
                digest = intake.sha256_file(str(source))
                row, output = store.prepare(str(source), digest, 1, 7)
                self.assertAlmostEqual(row["duration"], 6, delta=.12)
                self.assertAlmostEqual(row["lufs"], -16, delta=1)
                self.assertLessEqual(row["true_peak"], -1)
                self.assertEqual(intake.sha256_file(str(source)), digest)
                with patch.object(intake, "run", side_effect=AssertionError("Cache must not re-encode")):
                    self.assertEqual(store.prepare(str(source), digest, 1, 7), (row, output))
                audio = Path(output)
                data = bytearray(audio.read_bytes())
                data[-1] ^= 1
                audio.write_bytes(data)
                with self.assertRaises(ValueError):
                    store.select(digest)

    def test_silence_never_publishes_finished_audio(self):
        intake = load_intake(str(Path(__file__).resolve().parents[1] / "scripts/music-intake.py"))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silence.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc",
                            "-t", "5", str(source)], check=True, capture_output=True)
            store = FinishedAudio(directory, intake)
            digest = intake.sha256_file(str(source))
            with self.assertRaises(ValueError):
                store.prepare(str(source), digest)
            self.assertIsNone(store.select(digest))
