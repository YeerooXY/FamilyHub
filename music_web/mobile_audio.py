"""Reusable Opus playback copies; imported originals are never modified."""
import os
import secrets
import threading
from .audio_profile import measure_loudness

_encoding = threading.Lock()
# A listener waiting for a song encodes in its own lane, never behind background playlist work.
_listening = threading.Lock()
VERSION = "opus96-v1"


def prepare(intake, item, source, digest, urgent=False):
    path = os.path.join(item, f".{VERSION}-{digest}.opus")
    # Published copies are immutable and appear through atomic replacement.
    # Playback of an existing copy must not wait behind another song's encoder.
    if os.path.lexists(path):
        intake.regular_file(path, "mobile audio")
        return path
    # Serialize encodes so simultaneous listeners cannot exhaust the server.
    with (_listening if urgent else _encoding):
        if os.path.lexists(path):
            intake.regular_file(path, "mobile audio")
        else:
            temporary = path + "." + secrets.token_hex(8) + ".opus"
            try:
                # Lossy encoding can create intersample peaks above its input.
                # Limit transient peaks, then verify the decoded delivery file itself.
                ceiling_db = -4
                requested_lufs = -16
                for attempt in range(4):
                    filters = [] if attempt == 0 else ["-af", f"loudnorm=I={requested_lufs:.2f}:TP={ceiling_db:.2f}:LRA=50"]
                    rc, _, _ = intake.run([intake.tool("ffmpeg"), "-nostdin", "-v", "error", "-y",
                        *intake.SAFE_INPUT, "-i", source, "-map", "0:a:0", "-vn",
                        *filters, "-ar", "48000", "-c:a", "libopus", "-b:a", "96k", "-ac", "2", "-vbr", "constrained", "-application", "audio",
                        "-fs", str(64 << 20), temporary], 180, "mobile audio")
                    if rc or not os.path.getsize(temporary):
                        raise ValueError("Mobile audio preparation failed")
                    measured = measure_loudness(intake, temporary)
                    if abs(measured["input_i"] + 16) <= 1.5 and measured["input_tp"] <= -1:
                        break
                    if attempt > 0:
                        requested_lufs += -16 - measured["input_i"]
                        if measured["input_tp"] > -1:
                            ceiling_db -= measured["input_tp"] + 1.5
                    if ceiling_db < -9 or not -18 <= requested_lufs <= -12:
                        raise ValueError("Mobile audio requires excessive peak limiting")
                else:
                    raise ValueError("Mobile audio failed loudness or peak verification")
                # Refuse an output truncated by the size limit.
                if os.path.getsize(temporary) >= (64 << 20):
                    raise ValueError("Recording exceeds the mobile audio limit")
                if abs(intake.probe(temporary)["duration"] - intake.probe(source)["duration"]) > .2:
                    raise ValueError("Mobile audio duration does not match the original")
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    return path
