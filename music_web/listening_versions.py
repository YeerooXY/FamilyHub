"""Packet-preserving listening editions; source library files stay untouched."""
import hashlib
import json
import math
import os
import re
import secrets

from .state import state_path

SCHEMA = 1
MANIFEST = ".listening-versions.json"
FILE_RE = re.compile(r"\.listening-versions/[a-f0-9]{64}\.(opus|m4a|mp3|flac|ogg|wav)")


class ListeningVersions:
    def __init__(self, workspace, intake, *, state=None):
        self.workspace, self.intake, self.checked = workspace, intake, {}
        path = state_path(state or workspace, MANIFEST)
        self.versions = {}
        if not os.path.exists(path):
            return
        intake.regular_file(path, "listening edition manifest")
        with open(path, encoding="utf-8") as file:
            data = json.loads(file.read(2 << 20))
        if data.get("schema") != SCHEMA or not isinstance(data.get("versions"), dict):
            raise ValueError("Invalid listening edition manifest")
        for source_id, row in data["versions"].items():
            numbers = [row.get(k) for k in ("size", "duration", "start", "end", "original_duration")]
            if (not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", source_id)
                    or not FILE_RE.fullmatch(row.get("file", ""))
                    or any(not re.fullmatch(r"[a-f0-9]{64}", row.get(k, "")) for k in ("source_sha256", "sha256"))
                    or any(type(n) not in (int, float) or not math.isfinite(n) for n in numbers)
                    or not 0 < row["size"] <= 2 << 30
                    or row["duration"] <= 0
                    or not 0 <= row["start"] < row["end"] <= row["original_duration"]
                    or abs(row["duration"] - (row["end"]-row["start"])) > .12):
                raise ValueError("Invalid listening edition metadata")
            self.versions[source_id] = row

    def select(self, source_id, source_sha256):
        row = self.versions.get(source_id)
        if not row or row["source_sha256"] != source_sha256:
            return None
        directory = os.path.join(self.workspace, ".listening-versions")
        self.intake.real_dir(directory, "listening editions")
        path = os.path.join(self.workspace, *row["file"].split("/"))
        stat = self.intake.regular_file(path, "listening edition")
        stamp = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino)
        if stat.st_size != row["size"]:
            raise self.intake.IntakeError("Listening edition size changed")
        if self.checked.get(path) != stamp:
            if self.intake.sha256_file(path) != row["sha256"]:
                raise self.intake.IntakeError("Listening edition checksum changed")
            self.checked[path] = stamp
        return row, path


def packets(intake, path):
    rc, data, _ = intake.run([intake.tool("ffprobe"), "-v", "error", "-select_streams", "a:0",
        "-show_packets", "-show_entries", "packet=data_hash", "-show_data_hash", "sha256",
        "-of", "csv=p=0", path], 120, "listening packet check", True)
    hashes = re.findall(rb"SHA256:([a-f0-9]{64})", data)
    if rc or not hashes:
        raise ValueError("Could not verify compressed audio packets")
    return b"".join(bytes.fromhex(value.decode()) for value in hashes)


def prepare(intake, workspace, source, digest, start, end):
    info = intake.probe(source)
    duration = info["duration"]
    if (not all(type(v) in (int, float) and math.isfinite(v) for v in (start, end))
            or not 0 <= start < end <= duration + .01):
        raise ValueError("Invalid listening edition cues")
    end = min(duration, end)
    codec = info["codec"]
    extension = {"opus": ".opus", "aac": ".m4a", "mp3": ".mp3", "flac": ".flac", "vorbis": ".ogg"}.get(codec)
    if codec.startswith("pcm_"):
        extension = ".wav"
    if not extension:
        raise ValueError("This codec has no packet-preserving listening edition")
    key = hashlib.sha256(f"packet-trim-v1|{digest}|{start:.6f}|{end:.6f}".encode()).hexdigest()
    directory = os.path.join(workspace, ".listening-versions")
    if not os.path.exists(directory):
        os.mkdir(directory, 0o750)
    intake.real_dir(directory, "listening editions")
    path = os.path.join(directory, key + extension)
    if os.path.lexists(path):
        intake.regular_file(path, "listening edition")
    else:
        temporary = os.path.join(directory, "." + key + "." + secrets.token_hex(8) + extension)
        try:
            # Output-side seeking discards preceding packets; input seeking can retain an Ogg page.
            command = [intake.tool("ffmpeg"), "-nostdin", "-v", "error", *intake.SAFE_INPUT,
                "-i", source, "-ss", f"{start:.6f}", "-t", f"{end-start:.6f}",
                "-map", "0:a:0", "-vn", "-c:a", "copy", "-avoid_negative_ts", "make_zero"]
            if extension == ".m4a":
                command += ["-movflags", "+faststart"]
            rc, _, _ = intake.run(command + [temporary], 180, "listening edition trim")
            if rc:
                raise ValueError("Listening edition trim failed")
            decoded = intake.decode_check(temporary)
            if abs(decoded-(end-start)) > .12:
                raise ValueError("Listening edition duration does not match its cues")
            original_packets, kept_packets = packets(intake, source), packets(intake, temporary)
            position = original_packets.find(kept_packets)
            if position < 0 or position % 32:
                raise ValueError("Listening edition changed compressed audio packets")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    actual = intake.probe(path)["duration"]
    if abs(actual-(end-start)) > .12:
        raise ValueError("Listening edition container duration is incorrect")
    return {"source_sha256": digest, "sha256": intake.sha256_file(path),
        "file": ".listening-versions/" + key + extension, "size": os.path.getsize(path),
        "duration": actual, "start": start, "end": end, "original_duration": duration}
