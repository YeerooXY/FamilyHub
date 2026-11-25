import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from music_web.library_loudness import measure, measurement_path, parse_measurement, read_measurement
from tests.test_music_intake import mi


HOT_MASTER = """[Parsed_ebur128_0 @ 0x123] t: 0.1 M: -120.7 S: -120.7 I: -70.0 LUFS
[Parsed_ebur128_0 @ 0x123] Summary:

  Integrated loudness:
    I:          -7.6 LUFS
    Threshold: -17.8 LUFS

  Loudness range:
    LRA:         5.8 LU

  True peak:
    Peak:       +4.0 dBFS
"""


class LibraryLoudnessTests(unittest.TestCase):
    def test_final_summary_and_positive_true_peak(self):
        self.assertEqual(parse_measurement(HOT_MASTER), {"lufs": -7.6, "true_peak": 4.0})
        self.assertEqual(parse_measurement(" ".join(HOT_MASTER.split())), parse_measurement(HOT_MASTER))
        self.assertEqual(parse_measurement(HOT_MASTER.replace("+4.0", "-1.1"))["true_peak"], -1.1)

    def test_silence_and_missing_summary(self):
        silent = HOT_MASTER.replace("-7.6", "-70.0").replace("+4.0", "-inf")
        self.assertEqual(parse_measurement(silent), {"lufs": None, "true_peak": None})
        self.assertEqual(parse_measurement(silent + HOT_MASTER), parse_measurement(HOT_MASTER))
        with self.assertRaises(ValueError):
            parse_measurement(HOT_MASTER.replace("True peak:", "Sample peak:"))
        with self.assertRaises(ValueError):
            parse_measurement("I: -7.6 LUFS")

    def test_measurement_is_cached_by_checksum_and_preserves_source(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "recording.opus"
            original = b"unmodified recording"
            source.write_bytes(original)
            digest = hashlib.sha256(original).hexdigest()
            destination = measurement_path(Path(tmp) / "loudness", digest)
            with patch.object(mi, "tool", return_value="ffmpeg"), patch.object(
                mi, "run", return_value=(0, b"", HOT_MASTER)
            ) as run:
                expected = measure(mi, source, destination)
                self.assertEqual(read_measurement(mi, destination), expected)
                self.assertEqual(measure(mi, source, destination), expected)
                self.assertEqual(run.call_count, 1)
                self.assertIn("ebur128=peak=true:framelog=verbose", run.call_args.args[0])
            self.assertEqual(source.read_bytes(), original)

    def test_replaced_file_does_not_publish_a_measurement(self):
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / "recording.opus"
            source.write_bytes(b"original bytes")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            destination = measurement_path(Path(tmp) / "loudness", digest)

            def change_audio(*args, **kwargs):
                source.write_bytes(b"audio changed while reading")
                return 0, b"", HOT_MASTER

            with patch.object(mi, "tool", return_value="ffmpeg"), patch.object(mi, "run", side_effect=change_audio):
                with self.assertRaises(ValueError):
                    measure(mi, source, destination)
            self.assertFalse(destination.exists())
