"""Server-rendered listening audio: measured loudness, peak protection, lossless output."""
import hashlib
import json
import math
import os
import re
import secrets
import shutil
from .audio_profile import profile, measure_loudness as measurement
from . import mobile_audio
from .worker_activity import WorkerActivity
from .resources import observe, PriorityLane

VERSION = "loudness-flac-v1"
TARGET = -16
PEAK = -1.5
_encoding = PriorityLane()
activity = WorkerActivity('finished-audio', 'Finished audio')


def prepare_record(store, editions, library, item, manifest=None, background=lambda: False):
    if manifest is None:
        _, manifest, _ = store.intake.load_item(item)
    record = manifest["import"]
    source = os.path.join(library, *record["path"].split("/"))
    if not store.intake.inside(source, library):
        raise ValueError("Source audio is outside the library")
    digest = record["library_sha256"]
    edition = editions.select(manifest["source"].get("id", manifest["id"]), digest)
    if edition:
        version, source = edition
        finished = store.prepare(source, version["sha256"], title=record['title'], background=background)
    else:
        finished = store.select(digest)
        if not finished:
            # Reviewed cuts take priority. For new recordings only remove boundary silence;
            # speech, effects and ambiguous fades still need a reviewed edition.
            boundaries = profile(store.intake, item, manifest, measure=True)
            finished = store.prepare(source, digest, boundaries["start"], boundaries["end"],
                                     title=record['title'], background=background)
    row, path = finished
    mobile_audio.prepare(store.intake, item, path, row["sha256"], title=record['title'],
                         urgent=not background(), offline_only=background())
    return finished




class FinishedAudio:
    def __init__(self, workspace, intake):
        self.directory = os.path.join(workspace, ".finished-audio")
        self.intake = intake
        self.checked = {}

    def key(self, digest):
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid source checksum")
        return hashlib.sha256(f"{VERSION}|{digest}".encode()).hexdigest()

    def select(self, digest):
        key = self.key(digest)
        metadata = os.path.join(self.directory, key + ".json")
        if not os.path.lexists(metadata):
            return None
        self.intake.real_dir(self.directory, "finished audio")
        self.intake.regular_file(metadata, "finished audio metadata")
        with open(metadata, encoding="utf-8") as file:
            row = json.loads(file.read(8192))
        if (row.get("version") != VERSION or row.get("source_sha256") != digest
                or not re.fullmatch(r"[a-f0-9]{64}", row.get("sha256", ""))
                or any(type(row.get(k)) not in (int, float) or not math.isfinite(row[k])
                       for k in ("size", "duration", "lufs", "true_peak", "start", "end"))
                or not 0 < row["size"] <= 2 << 30
                or not 0 <= row["start"] < row["end"]
                or abs(row["duration"] - (row["end"] - row["start"])) > .12
                or abs(row["lufs"] - TARGET) > 1 or row["true_peak"] > -1):
            raise ValueError("Invalid finished audio metadata")
        path = os.path.join(self.directory, key + ".flac")
        stat = self.intake.regular_file(path, "finished audio")
        stamp = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, row["sha256"])
        if stat.st_size != row["size"]:
            raise ValueError("Finished audio size changed")
        if self.checked.get(path) != stamp:
            if self.intake.sha256_file(path) != row["sha256"]:
                raise ValueError("Finished audio checksum changed")
            self.checked[path] = stamp
        return row, path

    def prepare(self, source, digest, start=0, end=None, title='', background=lambda: False):
        with observe(getattr(self.intake, "RESOURCES", None), "finished", "render lock") as running, _encoding.turn(background=background), activity.track(title):
            running()
            existing = self.select(digest)
            if existing:
                return existing
            intake = self.intake
            intake.regular_file(source, "source audio")
            if intake.sha256_file(source) != digest:
                raise ValueError("Source audio checksum changed")
            info = intake.probe(source)
            end = info["duration"] if end is None else end
            if (not all(type(v) in (int, float) and math.isfinite(v) for v in (start, end))
                    or not 0 <= start < end <= info["duration"] + .01):
                raise ValueError("Invalid finished audio boundaries")
            os.makedirs(self.directory, mode=0o750, exist_ok=True)
            intake.real_dir(self.directory, "finished audio")
            # Reserve enough space for uncompressed 24-bit output plus filesystem headroom.
            needed = (end-start) * info["sample_rate"] * info["channels"] * 3 + (512 << 20)
            if shutil.disk_usage(self.directory).free < needed:
                raise ValueError("Not enough free space to prepare audio")
            trim = f"atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS"
            measured = measurement(intake, source, trim)
            normalize = (f"loudnorm=I={TARGET}:TP={PEAK}:LRA=50:linear=true"
                         f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
                         f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
                         f":offset={measured['target_offset']}")
            key = self.key(digest)
            path = os.path.join(self.directory, key + ".flac")
            temporary = path + "." + secrets.token_hex(8) + ".flac"
            metadata = os.path.join(self.directory, key + ".json")
            temporary_metadata = metadata + "." + secrets.token_hex(8)
            try:
                rc, _, _ = intake.run([intake.tool("ffmpeg"), "-nostdin", "-v", "error",
                    *intake.SAFE_INPUT, "-i", source, "-map", "0:a:0", "-vn",
                    "-af", trim + "," + normalize, "-ar", str(info["sample_rate"]),
                    "-c:a", "flac", "-sample_fmt", "s32", "-compression_level", "5",
                    "-fs", str(2 << 30), temporary], 600, "finished audio render")
                if rc or os.path.getsize(temporary) >= 2 << 30:
                    raise ValueError("Finished audio render failed")
                duration = intake.decode_check(temporary)
                if abs(duration - (end-start)) > .12:
                    raise ValueError("Finished audio duration changed")
                checked = measurement(intake, temporary)
                if abs(checked["input_i"] - TARGET) > 1 or checked["input_tp"] > -1:
                    raise ValueError("Finished audio failed loudness verification")
                row = {"version": VERSION, "source_sha256": digest,
                       "sha256": intake.sha256_file(temporary), "size": os.path.getsize(temporary),
                       "duration": intake.probe(temporary)["duration"], "start": start, "end": end,
                       "lufs": checked["input_i"], "true_peak": checked["input_tp"]}
                with open(temporary_metadata, "x", encoding="utf-8") as file:
                    json.dump(row, file)
                os.replace(temporary, path)
                os.replace(temporary_metadata, metadata)
            finally:
                for leftover in (temporary, temporary_metadata):
                    if os.path.exists(leftover):
                        os.unlink(leftover)
            return self.select(digest)
