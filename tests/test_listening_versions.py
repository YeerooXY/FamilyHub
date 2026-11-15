import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import music_web
from music_web import listening_versions as editions
from test_music_web import Base
import test_native_music_api as native


class ManifestChecks(Base):
    recording = native.NativeMusicApi.recording

    def test_trimmed_download_is_current_and_original_is_preserved(self):
        item, original, manifest, data = self.recording()
        folder = Path(self.ws) / '.listening-versions'
        folder.mkdir()
        path = folder / ('a'*64+'.wav')
        edited = data[:-20]
        path.write_bytes(edited)
        row = dict(source_sha256=manifest['import']['library_sha256'], sha256=hashlib.sha256(edited).hexdigest(),
                   file='.listening-versions/'+path.name, size=len(edited), duration=.01,
                   start=0, end=.01, original_duration=.02)
        (Path(self.ws)/editions.MANIFEST).write_text(json.dumps({'schema':1,'versions':{native.FIRST:row}}))
        # Reload the application, as deployment does after publishing an edition manifest.
        app = music_web.create_app({'SECRET_KEY':'k'*40, 'CLI_PATH':str(native.ROOT/'scripts/music-intake.py'),
            'WORKSPACE':self.ws, 'LIBRARY':self.lib, 'PUBLIC_ORIGIN':native.ORIGIN,
            'PLAYER_URL':'https://player.test/', 'ALLOWED_USERS':['sample-a','sample-b'],
            'REQUIRE_FINISHED_AUDIO':False})
        self.app = app
        client, _ = self.signed_in()
        track = self.go(client,'GET','/api/library').json['results'][0]
        self.assertEqual(track['listening_version'],'trimmed')
        self.assertEqual(track['download_sha256'],row['sha256'])
        self.assertEqual(track['duration'],.01)
        with self.go(client,'GET',track['download_url']) as response:
            self.assertEqual(response.data,edited)
        self.assertEqual(original.read_bytes(),data)
        store = editions.ListeningVersions(self.ws, self.intake)
        self.assertIsNone(store.select(native.FIRST,'b'*64))
        path.write_bytes(b'x'*len(edited))
        with self.assertRaises(self.intake.IntakeError):
            store.select(native.FIRST,row['source_sha256'])


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg required')
class PacketTrims(unittest.TestCase):
    def test_opus_cuts_copy_packets_and_keep_requested_duration(self):
        spec=importlib.util.spec_from_file_location('intake_for_editions',Path(__file__).resolve().parents[1]/'scripts/music-intake.py')
        intake=importlib.util.module_from_spec(spec);spec.loader.exec_module(intake)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.opus'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=8',
                            '-c:a','libopus',str(source)],check=True,capture_output=True)
            digest=intake.sha256_file(str(source))
            row=editions.prepare(intake,directory,str(source),digest,1.25,6.5)
            result=Path(directory)/row['file']
            self.assertAlmostEqual(intake.decode_check(str(result)),5.25,delta=.12)
            self.assertEqual(intake.sha256_file(str(source)),digest)
            self.assertNotEqual(row['sha256'],digest)
            self.assertEqual(row['source_sha256'],digest)
            self.assertTrue(result.exists())
            self.assertEqual(editions.prepare(intake,directory,str(source),digest,1.25,6.5),row)
            with self.assertRaises(ValueError):
                editions.prepare(intake,directory,str(source),digest,7,2)
