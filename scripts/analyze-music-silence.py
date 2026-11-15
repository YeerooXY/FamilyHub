"""Report quiet audio at track boundaries without modifying recordings (FFmpeg required)."""
import argparse
import array
import json
import math
from pathlib import Path
import re
import subprocess
import statistics
import sys

DETECTOR_VERSION = "edge-rms-v1"
STEP = .1


def audio_info(path):
    probe = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-select_streams", "a:0", "-show_entries", "format=duration:stream=codec_name,channels",
        "-of", "json", str(path)], capture_output=True, text=True, timeout=30, check=True)
    info = json.loads(probe.stdout)
    duration = float(info["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Audio has no usable duration")
    return duration, info["streams"][0]


def read_levels(path, start, length):
    # Two channels preserve stereo energy; 45 seconds cap the decoded buffer at about 18 MB.
    decoded = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-ss", str(start), "-i", str(path), "-map", "0:a:0", "-t", str(length),
        "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"],
        capture_output=True, timeout=120, check=True)
    samples = array.array("f")
    samples.frombytes(decoded.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    result, size = [], 9600
    for i in range(0, len(samples), size):
        frame = samples[i:i+size]
        mean_square = sum(x*x for x in frame) / len(frame)
        peak = max(abs(x) for x in frame)
        result.append({"time": round(start+i/96000, 3), "seconds": len(frame)/96000,
            "rms_dbfs": round(10*math.log10(max(mean_square, 1e-24)), 2),
            "peak_dbfs": round(20*math.log10(max(peak, 1e-12)), 2)})
    return result


def propose_edge(levels, ending=False):
    if not levels:
        raise ValueError("No decoded audio at boundary")
    reference = statistics.median(sorted(w["rms_dbfs"] for w in levels)[-max(1, len(levels)//4):])
    cutoff = min(-30, reference-12)
    ordered = list(reversed(levels)) if ending else levels
    strict = quiet = 0
    for w in ordered:
        if w["peak_dbfs"] > -50:
            break
        strict += w["seconds"]
    for w in ordered:
        if w["rms_dbfs"] > cutoff:
            break
        quiet += w["seconds"]
    # A boundary may contain brief clicks/effects: tolerate <=10% louder windows,
    # with no louder run over 0.5 seconds. These remain manual-review candidates.
    elapsed = bad = run = longest = tolerant = 0
    for i, w in enumerate(ordered):
        elapsed += w["seconds"]
        if w["rms_dbfs"] > cutoff:
            bad += w["seconds"]
            run += w["seconds"]
            longest = max(longest, run)
        else:
            run = 0
        settled = i >= 2 and all(v["rms_dbfs"] <= cutoff for v in ordered[i-2:i+1])
        if elapsed >= 3 and bad <= elapsed*.1+1e-6 and longest <= .500001 and settled:
            tolerant = elapsed
    strict = strict if strict >= .25 else 0
    quiet = quiet if quiet >= .5 else 0
    raw = max(strict, quiet, tolerant)
    kind = ("quiet with brief peaks" if tolerant > max(strict, quiet)+.2 else
            "quiet fade" if quiet > strict+.2 else "near-silence" if raw else "none")
    window_limited = raw > 0 and raw >= sum(w["seconds"] for w in ordered)-.11
    return {"proposed_skip_seconds": round(max(0, raw-.15), 3),
        "kind": kind, "near_silent_seconds": round(strict, 3),
        "quiet_contiguous_seconds": round(quiet, 3), "quiet_threshold_dbfs": round(cutoff, 2),
        "reference_dbfs": round(reference, 2), "window_limited": window_limited,
        "review": "required" if raw else "no candidate"}


def review_edges(path, window=45):
    path = Path(path).resolve(strict=True)
    duration, audio = audio_info(path)
    length = min(window, duration)
    start_levels = read_levels(path, 0, length)
    end_levels = read_levels(path, max(0, duration-length), length)
    beginning, ending = propose_edge(start_levels), propose_edge(end_levels, ending=True)
    start = beginning["proposed_skip_seconds"]
    end = round(duration-ending["proposed_skip_seconds"], 3)
    if start >= end:
        start, end = 0, duration
        beginning["review"] = ending["review"] = "conflicting cues; keep original"
    return {"path": str(path), "duration": duration, "audio": audio, "detector": DETECTOR_VERSION,
        "window_seconds": window, "proposed_start": start, "proposed_end": end,
        "beginning": beginning, "ending": ending,
        "levels": {"beginning": start_levels, "ending": end_levels}}


def edge_intervals(log, duration, minimum=.25):
    intervals, start = [], None
    for kind, value in re.findall(r"silence_(start|end):\s*(-?[\d.]+)", log):
        value = min(duration, max(0, float(value)))
        if kind == "start":
            start = value
        elif start is not None:
            intervals.append((start, value))
            start = None
    if start is not None:
        intervals.append((start, duration))
    result = {"beginning": [], "ending": []}
    for start, end in intervals:
        if end - start + .001 < minimum:
            continue
        entry = {"start": round(start, 3), "end": round(end, 3), "seconds": round(end-start, 3)}
        if start <= .1:
            result["beginning"].append(entry)
        if end >= duration - .1:
            result["ending"].append(entry)
    return result


def analyze(path, thresholds=(-50, -40, -30), minimum=.25):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("Choose an audio file")
    duration, audio = audio_info(path)
    output = {"path": str(path), "duration": duration, "audio": audio,
              "minimum_seconds": minimum, "boundaries": []}
    for threshold in thresholds:
        detected = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats",
            "-protocol_whitelist", "file,pipe", "-i", str(path), "-map", "0:a:0", "-vn",
            "-af", f"silencedetect=noise={threshold}dB:d={minimum}", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120, check=True)
        output["boundaries"].append({"threshold_dbfs": threshold,
            **edge_intervals(detected.stderr, duration, minimum)})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+")
    parser.add_argument("--threshold", action="append", type=float,
                        help="Quiet threshold in dBFS; repeat for comparisons (default: -50, -40, -30)")
    parser.add_argument("--minimum", type=float, default=.25)
    parser.add_argument("--review-edges", action="store_true", help="Propose RMS-based cues, allowing brief peaks; manual review required")
    args = parser.parse_args()
    thresholds = args.threshold or [-50, -40, -30]
    if not math.isfinite(args.minimum) or args.minimum <= 0 or any(not math.isfinite(t) or t >= 0 for t in thresholds):
        parser.error("Use a positive minimum duration and negative dBFS thresholds")
    print(json.dumps([review_edges(path) if args.review_edges else analyze(path, thresholds, args.minimum)
                      for path in args.files], indent=2))


if __name__ == "__main__":
    main()
