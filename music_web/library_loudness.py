"""Content-addressed EBU R128 measurements of library recordings."""

import json
import math
import re

from .library_index import file_stamp
from .state import write_json


def parse_measurement(log):
    # Intake flattens ffmpeg stderr, so use section headings rather than line breaks.
    summary = log.rpartition("Summary:")[2] if "Summary:" in log else ""
    integrated = re.search(r"Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?)\s+LUFS", summary)
    peak = re.search(r"True peak:\s*Peak:\s*([+-]?\d+(?:\.\d+)?|-inf)\s+dBFS", summary)
    if not integrated or not peak:
        raise ValueError("Missing EBU R128 measurement")
    if peak[1] == "-inf":
        return {"lufs": None, "true_peak": None}
    loudness, true_peak = float(integrated[1]), float(peak[1])
    if not math.isfinite(loudness) or not math.isfinite(true_peak):
        raise ValueError("Invalid EBU R128 measurement")
    return {"lufs": loudness, "true_peak": true_peak}


def measurement_path(directory, digest):
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid recording checksum")
    return directory / (digest + ".json")


def read_measurement(intake, path):
    try:
        intake.real_dir(path.parent, "library loudness directory")
        intake.regular_file(path, "library loudness measurements")
        with path.open(encoding="utf-8") as stream:
            row = json.loads(stream.read(1024))
        if isinstance(row, dict) and set(row) == {"lufs", "true_peak"}:
            values = row.values()
            if all(value is None for value in values) or all(
                type(value) in (int, float) and math.isfinite(value) for value in values
            ):
                return row
    except (OSError, ValueError, OverflowError, intake.IntakeError):
        pass
    return None


def measure(intake, source, path):
    """Publish only a complete measurement of the verified file."""
    if (existing := read_measurement(intake, path)) is not None:
        return existing
    stamp = file_stamp(source)
    intake.regular_file(source, "library audio")
    if intake.sha256_file(source) != path.stem or file_stamp(source) != stamp:
        raise ValueError("Recording changed before loudness measurement")
    rc, _, log = intake.run([intake.tool("ffmpeg"), "-nostdin", "-hide_banner", "-nostats",
        "-loglevel", "info", "-xerror", *intake.SAFE_INPUT, "-i", source, "-map", "0:a:0",
        "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
        300, "library loudness measurement", stderr_limit=8192)
    if rc or file_stamp(source) != stamp:
        raise ValueError("Could not measure library audio")
    row = parse_measurement(log)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    intake.real_dir(path.parent, "library loudness directory")
    write_json(path, row)
    return row
