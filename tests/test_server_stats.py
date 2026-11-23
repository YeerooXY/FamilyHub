from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from test_music_web import Base
from music_web.server_stats import DAY, History, LinuxSampler, MAX_POINTS, TIERS, counter_delta, encoded


class SamplingTests(unittest.TestCase):
    def test_counter_wrap_and_reset(self):
        self.assertEqual(counter_delta(90, 12, 100), 22)
        self.assertEqual(counter_delta(3, 12, 100), 9)
        self.assertEqual(counter_delta(12, 12, 100), 0)
        self.assertIsNone(counter_delta(90, 12))
        self.assertIsNone(counter_delta(901, 12, 100))

    def test_sample_linux_files_and_keep_missing_values_missing(self):
        with tempfile.TemporaryDirectory() as root:
            proc, sysfs = Path(root) / "proc", Path(root) / "sys"

            def write(path, content):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(str(content), encoding="ascii")

            def network(rx, tx):
                return f"enp1s0: {rx} 0 0 0 0 0 0 0 {tx} 0 0 0 0 0 0 0"

            package = sysfs / "class/powercap/rapl-package"
            glob = Path.glob

            def fixture_glob(path, pattern):
                if path == package.parent and pattern == "intel-rapl:[0-9]*":
                    return iter([package])
                return glob(path, pattern)

            mocked_paths = patch.object(Path, "glob", fixture_glob)
            mocked_paths.start()
            self.addCleanup(mocked_paths.stop)
            write(package / "name", "package-0")
            write(package / "max_energy_range_uj", 1_000_000_000)
            write(package / "energy_uj", 900_000_000)
            write(proc / "loadavg", "1.23 0.12 0.08 1/123 42")
            write(proc / "meminfo", "MemTotal: 1048576 kB\nMemAvailable: 524288 kB")
            write(proc / "net/dev", network(1024, 512))
            write(proc / "42/stat", "42 (VPN worker) " + " ".join(["S"] + ["0"] * 18 + ["12345"]))
            write(proc / "42/net/dev", network(2048, 100))
            write(sysfs / "class/thermal/thermal_zone0/type", "x86_pkg_temp")
            write(sysfs / "class/thermal/thermal_zone0/temp", 65000)
            sensor = LinuxSampler({"SERVER_NETWORK_INTERFACES": ["enp1s0"], "SERVER_VPN_PID": 42,
                                   "SERVER_VPN_INTERFACE": "enp1s0"}, proc=proc, sysfs=sysfs)
            first, _, _ = sensor.sample(100, 10)
            self.assertNotIn("power:cpu", first["values"])
            self.assertNotIn("power:machine", first["values"])
            self.assertNotIn("used", first["mounts"][1])
            write(package / "energy_uj", 200_000_000)
            write(proc / "net/dev", network(2560, 512))
            write(proc / "42/net/dev", network(3048, 400))
            second, totals, elapsed = sensor.sample(115, 25)
            self.assertEqual(elapsed, 15)
            self.assertEqual(second["values"]["cpu"], 1.23)
            self.assertEqual(second["values"]["memory:used"], 512 * 1024**2)
            self.assertEqual(second["values"]["temperature:cpu"], 65)
            self.assertEqual(second["values"]["power:cpu"], 20)
            self.assertEqual(second["values"]["network:enp1s0:download"], 102.4)
            self.assertEqual(second["values"]["network:enp1s0:upload"], 0)
            self.assertEqual(totals["network:enp1s0:download"], 1536)
            self.assertEqual(totals["network:VPN · enp1s0:download"], 1000)
            self.assertNotIn("power:cpu", sensor.sample(180, 90)[0]["values"])


class HistoryTests(unittest.TestCase):
    def setUp(self):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        self.history = History(db)

    def test_downsampling_weights_rates_and_keeps_totals(self):
        metric = "network:enp1s0:download"
        self.history.record(15, {"cpu": 1, metric: 10, "power:cpu": 20}, {metric: 150}, 15)
        self.history.record(30, {"cpu": 3, metric: 30, "power:cpu": 40}, {metric: 450}, 15)
        self.history.record(60, {metric: 20}, {metric: 600}, 30)
        minute = self.history.range(60, "24h")
        self.assertEqual(minute["series"]["cpu"], [[60, 2]])
        self.assertEqual(minute["series"][metric], [[60, 20]])
        self.assertEqual(minute["totals"][metric], 1200)
        self.assertEqual(len(self.history.range(60, "1h")["series"][metric]), 3)
        self.assertEqual(self.history.monthly(60), {"power:cpu": 21.6})

    def test_pruning_and_bounded_payload_at_each_resolution(self):
        now = 100 * DAY + 1
        for age in [91 * DAY, 30 * DAY, 3 * DAY, 7 * DAY, 3600]:
            self.history.record(now - age, {"disk:/": 10}, {}, 15)
        for stamp in range(now - 90 * DAY, now - DAY, 900):
            self.history.record(stamp, {"cpu": 1}, {}, 15)
        for stamp in range(now - DAY, now, 15):
            self.history.record(stamp, {"cpu": 1}, {}, 15)
        self.history.prune(now)
        for step, retention in TIERS.items():
            oldest = self.history.db.execute("SELECT min(at) FROM samples WHERE step=?", (step,)).fetchone()[0]
            self.assertGreaterEqual(oldest, (now - retention) // step * step)
        self.assertEqual(self.history.disk_baseline(now), {"disk:/": 10})
        for period in ("1h", "24h", "7d", "90d"):
            result = self.history.range(now, period)
            self.assertTrue(all(0 < len(points) <= MAX_POINTS for points in result["series"].values()))


class HealthPermissionTests(Base):
    extra = {"ADMIN_USERS": ["sample-a"]}

    def test_readings_require_admin_and_disable_caching(self):
        collector = self.app.extensions["server_health"]
        collector.now = encoded({"at": 10, "values": {"cpu": 0.5}})
        collector.ranges = {"1h": encoded({"at": 10, "series": {"cpu": [[10, 0.5]]}})}
        admin, _ = self.signed_in("sample-a")
        member, _ = self.signed_in("sample-b")
        for url in ("/api/server/stats/now", "/api/server/stats?range=1h"):
            for client, code in ((admin, 200), (member, 403), (self.app.test_client(), 401)):
                with self.subTest(url=url, code=code):
                    result = self.go(client, "GET", url)
                    self.assertEqual(result.status_code, code)
                    self.assertEqual(result.headers["Cache-Control"], "no-store")
                    if code == 200:
                        self.assertEqual(result.json["at"], 10)
        self.assertEqual(self.go(admin, "GET", "/api/server/stats?range=bad").status_code, 400)
        self.assertEqual(self.go(member, "GET", "/api/server/stats?range=bad").status_code, 403)
        self.assertEqual(self.go(member, "GET", "/api/server/stats?leaderboard=1").status_code, 403)
        self.assertEqual(self.go(member, "GET", "/api/server/stats").status_code, 403)
        leaderboard = self.go(member, "GET", "/api/activity/stats")
        self.assertEqual(leaderboard.status_code, 200)
        self.assertNotIn("workers", leaderboard.json)
