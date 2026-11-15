"""Non-destructive, content-addressed loudness and boundary-silence measurements."""
import json
import math
import os
import re
import secrets


def measure_loudness(intake, source, filters="", target=-16, peak=-1.5):
    prefix = filters + "," if filters else ""
    rc, _, log = intake.run([intake.tool("ffmpeg"), "-nostdin", "-hide_banner", "-nostats",
        *intake.SAFE_INPUT, "-i", source, "-map", "0:a:0", "-af",
        prefix + f"loudnorm=I={target}:TP={peak}:LRA=50:print_format=json",
        "-f", "null", "-"], 300, "finished audio measurement", stderr_limit=8192)
    match = re.search(r'\{\s*"input_i"[\s\S]*?\}', log)
    if rc or not match:
        raise ValueError("Could not measure recording loudness")
    data = json.loads(match.group())
    values = {key: float(data[key]) for key in
              ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    if not all(math.isfinite(value) for value in values.values()):
        raise ValueError("Recording has no measurable loudness")
    return values



def parse_measurement(log, duration):
    match = re.search(r'\{\s*"input_i"[\s\S]*?\}', log)
    measured = json.loads(match.group()) if match else {}
    loudness, peak = float(measured.get("input_i", "nan")), float(measured.get("input_tp", "nan"))
    if not all(math.isfinite(v) for v in (loudness, peak, duration)):
        raise ValueError("Audio has no measurable loudness")
    start, end, silence = 0, duration, None
    for kind, value in re.findall(r'silence_(start|end):\s*([\d.]+)', log):
        value = float(value)
        if kind == "start":
            silence = value
        elif silence is not None:
            if silence <= .03:
                start = max(0, value - .08)
            if value >= duration - .06:
                end = min(duration, silence + .08)
            silence = None
    if end <= start:
        start, end = 0, duration
    # Fixed track gain preserves dynamics. Peak headroom wins over the loudness target.
    return {"duration": duration, "start": start, "end": end,
            "lufs": loudness, "true_peak": peak, "gain_db": min(12, -16 - loudness, -1.5 - peak)}


def profile(intake, item, manifest, measure=False):
    path = os.path.join(os.path.dirname(item), ".playback-" + manifest["audio"]["sha256"] + ".json")
    try:
        intake.regular_file(path, "playback measurements")
        with open(path, encoding="utf-8") as f:
            data = json.loads(f.read(8192))
        if (set(data) == {"duration", "start", "end", "lufs", "true_peak", "gain_db"}
                and all(type(v) in (int, float) and math.isfinite(v) for v in data.values())
                and 0 <= data["start"] < data["end"] <= data["duration"]
                and -60 <= data["gain_db"] <= 12):
            return data
    except (OSError, ValueError, TypeError, KeyError, intake.IntakeError):
        pass
    if not measure:
        return {"duration": manifest["audio"]["duration"]}
    audio = os.path.join(item, manifest["audio"]["file"])
    rc, _, log = intake.run([intake.tool("ffmpeg"), "-nostdin", "-hide_banner", "-nostats",
        *intake.SAFE_INPUT, "-i", audio, "-af",
        "silencedetect=noise=-50dB:d=0.08,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
        "-f", "null", "-"], 90, "playback measurement", stderr_limit=2 << 20)
    if rc:
        raise ValueError("Playback measurement failed")
    data = parse_measurement(log, manifest["audio"]["duration"])
    tmp = path + "." + secrets.token_hex(8)
    try:
        with open(tmp, "x", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return data
