"""Linux host measurements. The worker owns all sensor and SQLite access."""
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time


INTERVAL = 15
DAY = 86400
TIERS = {15: 6 * 3600, 60: 7 * DAY, 900: 90 * DAY}
RANGES = {"1h": (3600, 15), "24h": (DAY, 60), "7d": (7 * DAY, 60), "90d": (90 * DAY, 900)}
MAX_POINTS = 400
MAX_DEVICES = 8
LOG = logging.getLogger(__name__)


def read(path):
    try:
        return path.read_text(encoding="ascii", errors="replace").strip()
    except OSError:
        return ""


def integer(path):
    try:
        return int(read(path))
    except ValueError:
        return None


def counter_delta(before, after, modulus=None):
    if modulus is not None and (modulus <= 0 or not 0 <= before <= modulus or not 0 <= after <= modulus):
        return None
    if after >= before:
        return after - before
    return None if modulus is None else modulus - before + after


def net_counters(path):
    for line in read(path).splitlines():
        name, sep, data = line.partition(":")
        fields = data.split()
        if sep and len(fields) >= 16 and fields[0].isdigit() and fields[8].isdigit():
            yield name.strip(), int(fields[0]), int(fields[8])


def block_disks(device):
    if not device.exists():
        return
    device = device.resolve()
    if (device / "partition").exists():
        device = device.parent
    slaves = sorted((device / "slaves").glob("*"))
    if slaves:
        for slave in slaves:
            yield from block_disks(slave)
    else:
        yield device


class LinuxSampler:
    def __init__(self, config, proc=Path("/proc"), sysfs=Path("/sys")):
        self.proc, self.sysfs = proc, sysfs
        self.mounts = tuple(dict.fromkeys(("/", "/srv/familyhub", *(config.get("SERVER_BACKUP_MOUNTS") or []))))[:MAX_DEVICES]
        self.interfaces = tuple(config.get("SERVER_NETWORK_INTERFACES") or ())[:MAX_DEVICES]
        self.vpn_pid = config.get("SERVER_VPN_PID")
        self.vpn_interface = config.get("SERVER_VPN_INTERFACE")
        source = config.get("SERVER_POWER_SOURCE")
        self.power_source = Path(source) if source and Path(source).is_relative_to("/sys") and ".." not in Path(source).parts else None
        self.previous = {}
        self.previous_at = None

    def storage(self):
        mounted = {}
        for line in read(self.proc / "self/mountinfo").splitlines():
            fields = line.split()
            if len(fields) >= 6:
                path = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
                mounted[path] = fields[2]
        disks = {}
        rows = []
        for path in self.mounts:
            row = {"mount": path, "disks": []}
            rows.append(row)
            if path not in mounted:
                continue
            try:
                usage = os.statvfs(path)
            except OSError:
                continue
            row.update(used=(usage.f_blocks - usage.f_bfree) * usage.f_frsize,
                       free=usage.f_bavail * usage.f_frsize, total=usage.f_blocks * usage.f_frsize)
            for disk in dict.fromkeys(block_disks(self.sysfs / "dev/block" / mounted[path])):
                if disk.name not in disks and len(disks) >= MAX_DEVICES:
                    continue
                disks[disk.name] = disk
                health = read(disk / "device/smart_health") or read(disk / "smart_health")
                row["disks"].append({"name": disk.name, "smart": health[:80] or None})
        return rows, disks

    def temperatures(self, disks):
        readings = {}
        for hwmon in sorted((self.sysfs / "class/hwmon").glob("hwmon*")):
            driver = read(hwmon / "name")
            device = (hwmon / "device").resolve()
            for sensor in sorted(hwmon.glob("temp*_input")):
                label = read(hwmon / sensor.name.replace("_input", "_label"))
                value = integer(sensor)
                if value is None or not -50000 <= value <= 200000:
                    continue
                if (driver == "coretemp" and label.startswith("Package id")
                        or driver == "k10temp" and label in ("Tdie", "Tctl")):
                    readings["cpu"] = max(readings.get("cpu", -50), value / 1000)
                for name, disk in disks.items():
                    if ((driver == "drivetemp" and device == (disk / "device").resolve())
                            or (driver == "nvme" and device in disk.parents and label in ("", "Composite"))):
                        readings[name] = max(readings.get(name, -50), value / 1000)
        if "cpu" not in readings:
            for zone in sorted((self.sysfs / "class/thermal").glob("thermal_zone*")):
                if read(zone / "type") in {"x86_pkg_temp", "cpu-thermal", "cpu_thermal"}:
                    value = integer(zone / "temp")
                    if value is not None and -50000 <= value <= 200000:
                        readings["cpu"] = max(readings.get("cpu", -50), value / 1000)
        return readings

    def sample(self, at, monotonic):
        elapsed = monotonic - self.previous_at if self.previous_at is not None else 0
        # A long pause can hide multiple RAPL wraps. Gaps stay unmeasured.
        previous = self.previous if 0 < elapsed <= 2 * INTERVAL else {}
        counters = {}
        values = {}
        totals = {}

        load = read(self.proc / "loadavg").split()
        if load and re.fullmatch(r"\d+(\.\d+)?", load[0]):
            values["cpu"] = float(load[0])
        memory = {}
        for line in read(self.proc / "meminfo").splitlines():
            key, _, content = line.partition(":")
            fields = content.split()
            if key in ("MemTotal", "MemAvailable") and fields and fields[0].isdigit():
                memory[key] = int(fields[0]) * 1024
        if 0 <= memory.get("MemAvailable", -1) <= memory.get("MemTotal", -2):
            values["memory:available"] = memory["MemAvailable"]
            values["memory:used"] = memory["MemTotal"] - memory["MemAvailable"]

        mounts, disks = self.storage()
        for row in mounts:
            if "used" in row:
                values["disk:" + row["mount"]] = row["used"]
        for name, value in self.temperatures(disks).items():
            values["temperature:" + name] = value

        powercap = self.sysfs / "class/powercap"
        packages = {}
        package_paths = list(powercap.glob("intel-rapl:[0-9]*")) + list(powercap.glob("intel-rapl/intel-rapl:[0-9]*"))
        for package in sorted({path.resolve() for path in package_paths}):
            if not read(package / "name").startswith("package-"):
                continue
            energy = integer(package / "energy_uj")
            modulus = integer(package / "max_energy_range_uj")
            packages[package.name] = None
            if energy is not None and modulus:
                key = ("rapl", package)
                before, old_modulus = previous.get(key, (None, None))
                counters[key] = energy, modulus
                if before is not None and old_modulus == modulus:
                    packages[package.name] = counter_delta(before, energy, modulus)
        if packages and all(delta is not None for delta in packages.values()):
            values["power:cpu"] = sum(packages.values()) / (elapsed * 1_000_000)
        if self.power_source:
            power = integer(self.power_source)
            if power is not None and power >= 0:
                values["power:machine"] = power / 1_000_000

        networks = []
        for name, rx, tx in net_counters(self.proc / "net/dev"):
            device = self.sysfs / "class/net" / name
            if name in self.interfaces or (not self.interfaces and (device / "device").exists()
                    and read(device / "type") == "1" and not any((device / link).exists() for link in ("wireless", "phy80211"))):
                networks.append((name, read(device / "ifindex"), rx, tx))
        networks = networks[:MAX_DEVICES]
        if type(self.vpn_pid) is int and self.vpn_pid > 1 and self.vpn_interface:
            process = self.proc / str(self.vpn_pid)
            # Use the process start time to avoid comparing counters after PID reuse.
            fields = read(process / "stat").rpartition(")")[2].split()
            if len(fields) >= 20:
                for name, rx, tx in net_counters(process / "net/dev"):
                    if name == self.vpn_interface:
                        networks.append(("VPN · " + name, fields[19], rx, tx))
                        break
        for name, identity, rx, tx in networks:
            for direction, count in (("download", rx), ("upload", tx)):
                metric = f"network:{name}:{direction}"
                key = (metric, identity)
                counters[key] = count
                if key in previous and (delta := counter_delta(previous[key], count)) is not None:
                    totals[metric] = delta
                    values[metric] = delta / elapsed

        self.previous, self.previous_at = counters, monotonic
        return {"at": at, "mounts": mounts, "networks": [row[0] for row in networks], "values": values}, totals, elapsed


def merge_metrics(target, source):
    for key, (amount, weight, total) in source.items():
        item = target.setdefault(key, [0, 0, 0])
        item[0] += amount
        item[1] += weight
        item[2] += total


class History:
    def __init__(self, db):
        self.db = db
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.execute("PRAGMA journal_size_limit=1048576")
        db.execute("PRAGMA max_page_count=16384")
        db.execute("""CREATE TABLE IF NOT EXISTS samples
            (step INTEGER, at INTEGER, metrics TEXT, PRIMARY KEY (step, at)) WITHOUT ROWID""")

    def record(self, at, values, totals, elapsed):
        metrics = {}
        for key, value in values.items():
            weight = elapsed if key in totals or key == "power:cpu" else INTERVAL
            metrics[key] = [round(value * weight, 4), round(weight, 4), totals.get(key, 0)]
        if not metrics:
            return
        with self.db:
            for step in TIERS:
                start = (at - 1) // step * step
                old = self.db.execute("SELECT metrics FROM samples WHERE step=? AND at=?", (step, start)).fetchone()
                bucket = json.loads(old[0]) if old else {}
                merge_metrics(bucket, metrics)
                self.db.execute("INSERT OR REPLACE INTO samples VALUES (?, ?, ?)",
                                (step, start, json.dumps(bucket, separators=(",", ":"))))

    def prune(self, now):
        with self.db:
            for step, retention in TIERS.items():
                self.db.execute("DELETE FROM samples WHERE step=? AND at<?", (step, (now - retention) // step * step))

    def rows(self, since, step, until):
        return self.db.execute("SELECT at, metrics FROM samples WHERE step=? AND at>=? AND at<? ORDER BY at",
                               (step, since // step * step, until))

    def range(self, now, name):
        duration, step = RANGES[name]
        since = now - duration
        width = math.ceil(duration / (MAX_POINTS - 1) / step) * step
        buckets = {}
        totals = {}
        newest = {}
        for at, encoded in self.rows(since, step, now):
            metrics = json.loads(encoded)
            merge_metrics(buckets.setdefault(at // width * width, {}), metrics)
            for key, (_, _, total) in metrics.items():
                group = key.rsplit(":", 1)[0] if key.startswith("network:") else key
                newest[group] = at
                if key.startswith("network:"):
                    totals[key] = totals.get(key, 0) + total
        recent = sorted(newest, key=newest.get, reverse=True)
        networks = [group for group in recent if group.startswith("network:")][:MAX_DEVICES + 1]
        sensors = [group for group in recent if group.startswith("temperature:")][:MAX_DEVICES + 1]
        allowed = {key for key in recent if not key.startswith(("network:", "temperature:"))}
        allowed.update(sensors)
        allowed.update(group + ":" + direction for group in networks for direction in ("download", "upload"))
        series = {}
        for at, metrics in buckets.items():
            for key, (amount, weight, _) in metrics.items():
                if weight and key in allowed:
                    series.setdefault(key, []).append([min(now, max(since, at + width // 2)), round(amount / weight, 3)])
        return {"at": now, "since": since, "step": width, "series": series,
                "totals": {key: value for key, value in totals.items() if key in allowed}}

    def disk_baseline(self, now):
        at = now - 7 * DAY
        row = next(self.rows(at, 60, at + 60), None)
        return {key: round(amount / weight) for key, (amount, weight, _) in json.loads(row[1]).items()
                if key.startswith("disk:") and weight} if row else {}

    def monthly(self, now):
        combined = {}
        for _, encoded in self.rows(now - DAY, 60, now):
            metrics = json.loads(encoded)
            merge_metrics(combined, {key: value for key, value in metrics.items() if key.startswith("power:")})
        return {key: round(amount / weight * 24 * 30 / 1000, 2)
                for key, (amount, weight, _) in combined.items() if weight}


def encoded(data):
    return json.dumps(data, separators=(",", ":"), allow_nan=False).encode()


class Collector:
    def __init__(self):
        self.now = None
        self.ranges = {}

    def run(self, workspace, config):
        sampler = LinuxSampler(config)
        db = None
        monthly = {}
        while True:
            started = time.monotonic()
            try:
                at = int(time.time())
                current, totals, elapsed = sampler.sample(at, started)
            except (OSError, ValueError):
                LOG.exception("Could not read server measurements")
                time.sleep(INTERVAL)
                continue
            try:
                if db is None:
                    db = sqlite3.connect(workspace / ".server-stats.sqlite3", timeout=0.1)
                    history = History(db)
                    refreshed = float("-inf")
                refresh_history = started - refreshed >= 55
                if refresh_history:
                    history.prune(at)
                history.record(at, current["values"], totals, elapsed)
                if refresh_history:
                    self.ranges = {name: encoded(history.range(at, name)) for name in RANGES}
                    monthly = history.monthly(at)
                    refreshed = started
                baseline = history.disk_baseline(at)
                for row in current["mounts"]:
                    old = baseline.get("disk:" + row["mount"])
                    if old is not None and "used" in row:
                        row["growth"] = row["used"] - old
            except (OSError, sqlite3.Error, ValueError):
                LOG.exception("Could not save server measurement history")
                monthly = {}
                if db is not None:
                    db.close()
                    db = None
            current["monthly"] = monthly
            self.now = encoded(current)
            time.sleep(max(0, INTERVAL - (time.monotonic() - started)))


_lock = threading.Lock()
_collector = None


def start(workspace, config):
    global _collector
    if not sys.platform.startswith("linux"):
        return Collector()
    with _lock:
        if _collector is None:
            _collector = Collector()
            threading.Thread(target=_collector.run, args=(Path(workspace), config),
                             name="server-health", daemon=True).start()
        return _collector
