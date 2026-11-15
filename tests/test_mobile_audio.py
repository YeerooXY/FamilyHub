"""Real Opus encoding and authenticated playback-copy delivery."""
import os
import threading
import hashlib
import io
import math
import struct
import shutil
import wave
from unittest import mock
import unittest

import test_native_music_api as native
from test_music_web import Base
from music_web import mobile_audio


class CachedMobileAudio(Base):
    def test_cached_copy_does_not_wait_for_unrelated_encoder(self):
        digest = "a" * 64
        path = os.path.join(self.ws, f".{mobile_audio.VERSION}-{digest}.opus")
        with open(path, "wb") as file:
            file.write(b"published fixture")
        result = []
        finished = threading.Event()
        def read():
            result.append(mobile_audio.prepare(self.intake, self.ws, "unused", digest))
            finished.set()
        worker = threading.Thread(target=read)
        try:
            with mobile_audio._encoding:
                worker.start()
                self.assertTrue(finished.wait(1), "Cached playback waited for unrelated encoder")
        finally:
            worker.join(2)
        self.assertEqual(result, [path])


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
class MobileAudio(Base):
    recording = native.NativeMusicApi.recording

    def test_compressed_copy_is_reused_original_preserved_and_range_supported(self):
        item, target, manifest, _ = self.recording()
        # A longer PCM recording exercises actual savings rather than container overhead.
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(b''.join(struct.pack('<h', int(.225 * 32767 * math.sin(2*math.pi*440*n/48000)))
                                      for n in range(4*48000)))
        data = stream.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        (item / 'audio.wav').write_bytes(data)
        target.write_bytes(data)
        manifest['audio'].update(sha256=digest, duration=4, sample_rate=48000, size=len(data), bit_rate=768000)
        manifest['import'].update(sha256=digest, library_sha256=digest)
        self.intake.write_manifest(str(item), manifest)
        client, _ = self.signed_in()
        with self.go(client, "GET", f"/api/library/{native.FIRST}/download") as response:
            original = response.data
        with mock.patch.object(self.intake, "run", wraps=self.intake.run) as encode:
            info = self.go(client, "GET", f"/api/library/{native.FIRST}/playback-info")
            self.assertEqual(info.status_code, 200, info.data)
            track = info.json
            self.assertLess(track["download_size"], len(original))
            self.assertEqual(track["playback_source_sha256"], hashlib.sha256(original).hexdigest())
            audio = self.go(client, "GET", track["download_url"])
            self.addCleanup(audio.close)
            self.assertEqual(audio.status_code, 200)
            self.assertEqual(hashlib.sha256(audio.data).hexdigest(), track["download_sha256"])
            self.assertEqual(len(audio.data), track["download_size"])
            with self.go(client, "GET", track["download_url"], headers={"Range":"bytes=12-"}) as part:
                self.assertEqual(part.status_code, 206)
                self.assertEqual(part.data, audio.data[12:])
            commands = [c.args[0] for c in encode.call_args_list]
            self.assertEqual(sum("96k" in c for c in commands), 1)
        with self.go(client, "GET", f"/api/library/{native.FIRST}/download") as response:
            self.assertEqual(response.data, original)
        self.assertEqual(self.go(self.app.test_client(), "GET", track["download_url"]).status_code, 401)
        stale = f"/api/library/{native.FIRST}/playback/{'0' * 64}/audio.opus"
        self.assertEqual(self.go(client, "GET", stale).status_code, 409)

    def test_encode_failure_publishes_no_copy(self):
        self.recording()
        client, _ = self.signed_in()
        with mock.patch.object(mobile_audio, "prepare", side_effect=ValueError("encode failed")):
            self.assertEqual(self.go(client, "GET", f"/api/library/{native.FIRST}/playback-info").status_code, 503)

    def test_smaller_original_is_delivered_without_increasing_mobile_data(self):
        self.recording()
        client, _ = self.signed_in()
        # The tiny transport fixture is shorter than a loudness measurement window.
        with mock.patch.object(mobile_audio, 'measure_loudness', return_value={'input_i':-16,'input_tp':-3}):
            track = self.go(client, "GET", f"/api/library/{native.FIRST}/playback-info").json
        self.assertEqual(track["download_url"], f"/api/library/{native.FIRST}/download")

    def test_codec_overshoot_reencodes_before_publishing(self):
        item, target, manifest, _ = self.recording()
        with mock.patch.object(mobile_audio, 'measure_loudness', side_effect=[
                {'input_i':-16,'input_tp':2.5}, {'input_i':-16.1,'input_tp':-1.5}]) as measure:
            with mock.patch.object(self.intake, 'run', wraps=self.intake.run) as commands:
                result = mobile_audio.prepare(self.intake, str(item), str(target), manifest['import']['library_sha256'])
        self.assertEqual(measure.call_count, 2)
        encodes = [c.args[0] for c in commands.call_args_list if '96k' in c.args[0]]
        self.assertEqual(len(encodes), 2)
        self.assertNotIn('-af', encodes[0])
        self.assertIn('loudnorm=I=-16.00:TP=-4.00:LRA=50', encodes[1])
        self.assertTrue(result.endswith('.opus'))

    def test_persistent_codec_overshoot_never_publishes_audio(self):
        item, target, manifest, _ = self.recording()
        with mock.patch.object(mobile_audio, 'measure_loudness', return_value={'input_i':-16,'input_tp':4}):
            with self.assertRaises(ValueError):
                mobile_audio.prepare(self.intake, str(item), str(target), manifest['import']['library_sha256'])
        self.assertEqual(list(item.glob('*.opus')), [])
