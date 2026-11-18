import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from music_web import catalog_search, link_playlists, load_intake, radio
from music_web.playlist_preparation import PlaylistPreparation
from music_web.resources import (PriorityLane, ProviderGate, ResourceGovernor, TransferResources,
                                 audio_command, background_command, background_request, transfer_limit, waiting)


class SummaryTests(unittest.TestCase):
    def test_active_summary_and_no_idle_timer(self):
        clock = Mock(return_value=100)
        governor = ResourceGovernor(lambda: [("fetch", "same source", 80)], clock=clock)
        with patch("music_web.resources.threading.Timer") as timer:
            with governor.track("preview"):
                with waiting("transfer"), self.assertLogs("music_web.resources", "INFO") as logs:
                    clock.return_value = 130
                    governor.report()
                self.assertIn("fetch=0r/1q[same source:1,oldest=50s", logs.output[0])
                self.assertIn("preview=0r/1q[transfer:1,oldest=30s", logs.output[0])
                self.assertIn("presence=offline reserved_cpu=0 reserved_transfers=0", logs.output[0])
                self.assertEqual(len(logs.output), 1)
                self.assertEqual([call.args[0] for call in timer.call_args_list], [30, 30])
            governor.queued = lambda: ()
            with self.assertNoLogs("music_web.resources", "INFO"):
                governor.report()
            self.assertEqual(timer.call_count, 2)


class AdmissionTests(unittest.TestCase):
    def run_thread(self, fn, *args):
        worker = threading.Thread(target=fn, args=args, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 2)
        return worker

    def test_transfer_and_scratch_prioritize_foreground_and_release_on_error(self):
        for size, lane in [(0, "transfer"), (60, "scratch")]:
            with self.subTest(lane=lane):
                resources = TransferResources(1, lambda: 100)
                cancelled = threading.Event()
                order = []

                def lease(background, cancel=lambda: False):
                    return resources.lease(size=size, background=lambda: background,
                                           cancelled=cancel, error=ValueError)

                def enter(name, background, cancel):
                    try:
                        with lease(background, cancel):
                            order.append(name)
                            raise ValueError("failed")
                    except ValueError as error:
                        if str(error) != "failed":
                            order.append("cancelled")

                with lease(False):
                    workers = []
                    for name, background, cancel in [("background", True, lambda: False),
                                                      ("cancel", True, cancelled.is_set),
                                                      ("foreground", False, lambda: False)]:
                        workers.append(self.run_thread(enter, name, background, cancel))
                        with resources.condition:
                            self.assertTrue(resources.condition.wait_for(
                                lambda: len(resources.waiters[lane]) == len(workers), 2))
                    cancelled.set()
                    resources.wake()
                    workers[1].join(2)
                    self.assertEqual(order, ["cancelled"])
                for worker in workers:
                    worker.join(2)
                self.assertEqual(order, ["cancelled", "foreground", "background"])
                self.assertEqual((resources.active, resources.reserved), (0, 0))
                self.assertTrue(all(not queue for queue in resources.waiters.values()))

    def test_full_disk_fails_without_taking_a_transfer(self):
        resources = TransferResources(4, lambda: 59)
        with self.assertRaisesRegex(ValueError, "scratch capacity exceeded"):
            with resources.lease(size=60, background=lambda: False, cancelled=lambda: False, error=ValueError):
                self.fail("admitted an oversized reservation")
        self.assertEqual((resources.active, resources.reserved), (0, 0))

    def test_transfer_environment_limit(self):
        for value, expected in [("", 4), ("2", 2), ("40", 8), ("0", 1)]:
            with patch.dict(os.environ, FAMILYHUB_TRANSFERS=value):
                self.assertEqual(transfer_limit(), expected)

    def test_presence_leases_and_gradual_handback(self):
        clock = Mock(return_value=100)
        governor = ResourceGovernor(clock=clock)
        with patch.object(governor, "wake"):
            device = ("ana", "phone")
            governor.presence(device)
            self.assertEqual(governor.reservations(), ("online-idle", 1, 1))
            governor.presence(("ana", "tab"), "browsing", 10)
            self.assertEqual(governor.reservations(), ("browsing", 2, 1))
            clock.return_value = 110
            self.assertEqual(governor.reservations(), ("online-idle", 1, 1))
            governor.presence(device, "listening")
            clock.return_value = 111
            governor.presence(device)
            governor.pause(device)
            clock.return_value = 114
            governor.presence(device)
            governor.pause(device)
            self.assertEqual(governor.reservations(), ("listening", 2, 2))
            clock.return_value = 116
            self.assertEqual(governor.reservations(), ("online-idle", 1, 1))
            clock.return_value = 129
            self.assertEqual(governor.reservations(), ("offline", 0, 0))
            self.assertEqual(governor.background_slots(12), 0)
            self.assertEqual(governor.background_delay(1), 1)
            clock.return_value = 131
            self.assertEqual(governor.background_slots(12), 2)
            clock.return_value = 141
            self.assertEqual(governor.background_slots(12), 12)

    def test_search_supersession_grace_and_room_exit_recompute_shared_reservations(self):
        clock = Mock(return_value=100)
        governor = ResourceGovernor(clock=clock)
        with patch.object(governor, "wake"):
            first = governor.begin_search("ana")
            current = governor.begin_search("ana")
            other = governor.begin_search("ben")
            self.assertTrue(first.is_set())
            governor.end_search("ana", first)
            clock.return_value = 120
            self.assertEqual(governor.reservations(), ("searching", 2, 1))
            governor.end_search("ana", current)
            governor.end_search("ben", other)
            clock.return_value = 122
            self.assertEqual(governor.reservations(), ("searching", 2, 1))
            clock.return_value = 123
            self.assertEqual(governor.reservations(), ("offline", 0, 0))
            governor.presence(("ana", "phone"), "listening")
            governor.room("one", 153)
            governor.room("two", 153)
            self.assertEqual(governor.reservations(), ("listen-together", 2, 2))
            governor.room("one", None)
            self.assertEqual(governor.reservations(), ("listen-together", 2, 2))
            governor.room("two", None)
            self.assertEqual(governor.reservations(), ("listening", 2, 2))

    def test_idle_transfers_expand_then_wait_without_interrupting_active_transfer(self):
        governor = ResourceGovernor()
        entered = [threading.Event() for _ in range(7)]
        release = threading.Event()
        with patch.dict(os.environ, FAMILYHUB_IDLE_TRANSFERS="1", FAMILYHUB_TRANSFERS_IDLE="6"):
            transfers = TransferResources(4, lambda: 100, governor)
        self.addCleanup(release.set)

        def transfer(index):
            with transfers.lease(background=lambda: True, cancelled=lambda: False, error=ValueError):
                entered[index].set()
                release.wait(2)

        for index in range(6):
            self.run_thread(transfer, index)
            self.assertTrue(entered[index].wait(1))
        with patch.object(governor, "wake"):
            governor.presence("ana")
            self.run_thread(transfer, 6)
            self.assertFalse(entered[6].wait(.05))
            self.assertEqual(transfers.active, 6)
            governor.close("ana")
            governor.handback -= 6
            release.set()
            self.assertTrue(entered[6].wait(1))
        with patch.dict(os.environ, FAMILYHUB_IDLE_TRANSFERS="0", FAMILYHUB_TRANSFERS_IDLE="8"):
            self.assertEqual(TransferResources(4, lambda: 100, governor).idle_capacity, 4)

    def test_compute_keeps_core_free_and_a_slot_for_waiting_playback(self):
        with patch("music_web.resources.compute_capacity", return_value=4):
            governor = ResourceGovernor()
        admitted, release = threading.Event(), threading.Event()

        def listen():
            with governor.compute(False) as granted:
                self.assertTrue(granted)
                admitted.set()
                release.wait(1)

        with governor.compute(True) as first, governor.compute(True) as second:
            self.assertTrue(first and second)
            worker = self.run_thread(listen)
            self.assertTrue(admitted.wait(.25))
            with governor.compute(False) as second_listener:
                self.assertTrue(second_listener)
                self.assertEqual(governor.cpu_active, 4)
                with governor.compute(True, start_offline=True) as scanner:
                    self.assertFalse(scanner)
            release.set()
            worker.join(1)
        self.assertEqual(governor.cpu_active, 0)

    def test_background_commands_keep_process_priority_and_bound_ffmpeg_threads(self):
        with patch("music_web.resources.os.name", "posix"), patch("music_web.resources.shutil.which", return_value=True):
            command = background_command(["ffmpeg", "input"])
        self.assertEqual(command, ["ionice", "-c", "3", "-t", "nice", "-n", "10", "ffmpeg", "input"])
        with patch("music_web.resources.shutil.which", return_value=None):
            command = audio_command(["ffmpeg", "-i", "in.flac", "out.opus"])
        self.assertEqual(command.count("-threads"), 2)
        self.assertEqual(command[-3:], ["-threads", "1", "out.opus"])

    def test_playlist_capacity_and_releasing_a_callback_before_acquisition_finishes(self):
        governor = ResourceGovernor()
        operation = SimpleNamespace(stop=threading.Event())
        with patch.dict(os.environ, FAMILYHUB_IDLE_PLAYLISTS="0"):
            fixed = PlaylistPreparation(None, threading.RLock(), None, resources=governor)
        self.assertEqual(fixed.capacity, 3)
        with patch.dict(os.environ, FAMILYHUB_IDLE_PLAYLISTS="1"):
            coordinator = PlaylistPreparation(None, threading.RLock(), None, resources=governor)
        entered = threading.Semaphore(0)
        release_slot, complete = threading.Event(), threading.Event()

        def callback(release):
            entered.release()
            if release_slot.wait(2):
                release()
            complete.wait(2)

        try:
            for index in range(7):
                self.run_thread(coordinator._execute, ("ana", index), operation, callback)
            self.assertTrue(all(entered.acquire(timeout=1) for _ in range(6)))
            self.assertFalse(entered.acquire(timeout=.05))
            release_slot.set()
            self.assertTrue(entered.acquire(timeout=1))
        finally:
            complete.set()

    def test_shared_deezer_transport_and_other_provider_independence(self):
        deezer, itunes = ProviderGate(.01), ProviderGate(0)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"data":[]}'
        starts = []

        def open_request(request, **kw):
            starts.append((request.host, time.monotonic()))
            return response

        with patch.dict(catalog_search.PROVIDERS, deezer=deezer, itunes=itunes), patch(
                "urllib.request.build_opener", return_value=SimpleNamespace(open=open_request)):
            catalog_search._get("deezer", "https://api.deezer.com/artist/1")
            radio._deezer("artist/1/radio")
            link_playlists._deezer("playlist/1")
            catalog_search._get("itunes", "https://itunes.apple.com/search")
        self.assertEqual([host for host, _ in starts], ["api.deezer.com"] * 3 + ["itunes.apple.com"])
        self.assertTrue(all(later[1] - earlier[1] >= .009 for earlier, later in zip(starts, starts[1:3])))

    def test_provider_priority_after_refusal(self):
        gate = ProviderGate(0)
        with self.assertRaises(HTTPError):
            with gate.request():
                raise HTTPError("https://api.deezer.com", 429, "slow", {"Retry-After": "60"}, None)
        self.assertGreater(gate.next_start, time.monotonic() + 55)
        order = []

        def enter(background):
            token = background_request.set(background)
            try:
                with gate.request():
                    order.append(background)
            finally:
                background_request.reset(token)

        workers = []
        for background in (True, False):
            workers.append(self.run_thread(enter, background))
            with gate.condition:
                self.assertTrue(gate.condition.wait_for(lambda: len(gate.queue) == len(workers), 2))
        with ProviderGate(0).request():
            self.assertEqual(order, [])
        with gate.condition:
            gate.next_start = 0
            gate.condition.notify_all()
        for worker in workers:
            worker.join(2)
        self.assertEqual(order, [False, True])


class YouTubeTests(unittest.TestCase):
    def setUp(self):
        self.intake = load_intake(str(Path(__file__).resolve().parents[1] / "scripts/music-intake.py"))
        self.intake.YOUTUBE.spacing = 0
        self.url = self.intake.WATCH + "abcdefghijk"
        self.data = dict(id="abcdefghijk", title="Recording", duration=30, filesize=128,
                         vcodec="none", acodec="opus", format_id="251", protocol="https",
                         url="https://media.example/audio?signature=private", webpage_url=self.url)

    def test_ordinary_download_uses_one_extraction_and_private_descriptor(self):
        for search_first, expired in [(False, False), (True, False), (True, True)]:
            with self.subTest(search_first=search_first, expired=expired), tempfile.TemporaryDirectory() as workspace:
                self.intake.SEARCH_CACHE.clear()
                resources = TransferResources(1, lambda: 128 << 20)

                def lease(size=0):
                    return resources.lease(size=size, background=lambda: False,
                                           cancelled=lambda: False, error=self.intake.IntakeError)

                commands = []
                transfers = 0

                def run(command, *args):
                    nonlocal transfers
                    commands.append(command)
                    if "--load-info-json" not in command:
                        self.assertEqual((resources.active, resources.reserved), (0, 0))
                        return 0, json.dumps(self.data).encode(), ""
                    transfers += 1
                    self.assertEqual(resources.active, 1)
                    self.assertGreater(resources.reserved, self.data["filesize"] * 2)
                    self.assertNotIn(self.url, command)
                    path = Path(command[command.index("--load-info-json") + 1])
                    descriptor = json.loads(path.read_bytes())
                    self.assertEqual(descriptor["url"], self.data["url"])
                    self.assertNotIn("webpage_url", descriptor)
                    if expired and transfers == 1:
                        return 1, b"", "HTTP Error 410"
                    dl = Path(command[command.index("--paths") + 1])
                    (dl / "source.opus").write_bytes(b"audio")
                    return 0, b"", ""

                self.intake.CONTROL.reserve = self.intake.CONTROL.transfer = lease
                with patch.object(self.intake, "tool", side_effect=lambda name: name), patch.object(
                        self.intake, "run", side_effect=run), patch.object(self.intake, "finish", return_value="saved"):
                    if search_first:
                        self.intake.cmd_search(SimpleNamespace(query=self.url, limit=1))
                    self.assertEqual(self.intake.cmd_fetch(SimpleNamespace(url=self.url, workspace=workspace)), "saved")
                self.assertEqual(len(commands), 4 if expired else 2)
                self.assertEqual((resources.active, resources.reserved), (0, 0))
                self.assertEqual(list(Path(workspace).iterdir()), [])

    def test_in_flight_media_success_cannot_cancel_cooldown(self):
        gate = self.intake.YOUTUBE
        started, finish = threading.Event(), threading.Event()

        def download():
            with gate.request("fetch", True, media=True):
                started.set()
                finish.wait(2)
                gate.result("fetch", 0, "", media=True)

        with patch.object(self.intake.time, "monotonic", return_value=100):
            worker = threading.Thread(target=download, daemon=True)
            worker.start()
            try:
                self.assertTrue(started.wait(2))
                gate.result("search", 1, "HTTP 429")
            finally:
                finish.set()
                worker.join(2)
            self.assertEqual((gate.until, gate.backoff), (400, 300))
            gate.result("search", 0, "")
            self.assertEqual((gate.until, gate.backoff), (0, 0))
