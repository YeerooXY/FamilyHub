"""Subtitle alignment and timing metadata tests with local fixtures."""
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from music_web import audio_tracks, movie_subtitle_import as importer, subtitle_sync


def srt(seconds, text=b'Fixture'):
    return f'1\n00:00:{seconds:02},000 --> 00:00:{seconds + 1:02},000\n'.encode() + text + b'\n'


class AlignmentTests(unittest.TestCase):
    video = Path('/library/Film, part 1.mkv')

    def setUp(self):
        self.enterContext(patch.object(subtitle_sync.shutil, 'which', side_effect=lambda name: name))
        self.enterContext(patch.object(subtitle_sync, 'media_command', return_value=b'20.0\n'))
        self.enterContext(patch.object(subtitle_sync.os, 'geteuid', return_value=65534, create=True))
        self.enterContext(patch.object(subtitle_sync.os, 'getegid', return_value=65534, create=True))
        self.priority = self.enterContext(patch.object(subtitle_sync, 'background_command', side_effect=lambda command, **_: command))
        self.enterContext(patch.object(importer, 'read_file', side_effect=lambda path, size: path.read_bytes()))

    def output(self, data):
        def run(command, **kwargs):
            mount = command[command.index('--mount') + 1]
            scratch = Path(mount.removeprefix('type=bind,source=').removesuffix(',target=/work'))
            (scratch / 'out.srt').write_bytes(data)
            self.assertEqual((scratch / 'incorrect.srt').read_bytes(), srt(1))
            if command[-3] == 'reference.srt':
                self.assertEqual((scratch / 'reference.srt').read_bytes(), srt(2))
        return patch.object(subtitle_sync.subprocess, 'run', side_effect=run)

    def test_container_limits_and_reference_mounts(self):
        for reference, timeout in ((None, 600), (srt(2), 120)):
            with self.subTest(timeout=timeout), self.output(srt(3)) as run:
                self.assertEqual(subtitle_sync.align(self.video, srt(1), reference), srt(3))
                command = run.call_args.args[0]
                for flag in ('--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
                             '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=1g', '--cpus=1',
                             '--cpu-shares=2', '--user', '65534:65534'):
                    self.assertIn(flag, command)
                self.assertEqual(command[-4:], ['familyhub-alass', 'reference.srt' if reference else '/work/video.mkv',
                                                'incorrect.srt', 'out.srt'])
                self.assertEqual(command.count('--mount'), 1 if reference else 2)
                if reference is None:
                    self.assertIn(f'type=bind,"source={self.video}",target=/work/video.mkv,readonly', command)
                self.assertEqual(run.call_args.kwargs['timeout'], timeout)
                self.assertTrue(run.call_args.kwargs['check'])
                self.assertEqual(self.priority.call_args.kwargs, {'nice': 19})

    def test_unavailable_alass_timeout_and_invalid_output(self):
        with patch.object(subtitle_sync.shutil, 'which', return_value=None), \
                patch.object(subtitle_sync.subprocess, 'run') as run:
            self.assertIsNone(subtitle_sync.align(self.video, srt(1)))
            run.assert_not_called()
        for error in (subprocess.CalledProcessError(125, 'docker'), subprocess.TimeoutExpired('docker', 600)):
            with patch.object(subtitle_sync.subprocess, 'run', side_effect=[error, None]) as run:
                self.assertIsNone(subtitle_sync.align(self.video, srt(1)))
                if isinstance(error, subprocess.TimeoutExpired):
                    container = run.call_args_list[0].args[0]
                    self.assertEqual(run.call_args.args[0], ['docker', 'rm', '-f', container[container.index('--name') + 1]])
                    self.assertEqual(run.call_args.kwargs['timeout'], 5)
                else:
                    run.assert_called_once()
        for invalid in (b'not a subtitle', srt(19).replace(b'20,000', b'21,000'),
                        srt(2) + b'\n' + srt(3), srt(2) + b'\nnot a cue'):
            with self.subTest(invalid=invalid), self.output(invalid):
                self.assertIsNone(subtitle_sync.align(self.video, srt(1)))
        with patch.object(subtitle_sync.subprocess, 'run') as run:
            self.assertIsNone(subtitle_sync.align(self.video, srt(1), srt(1)))
            run.assert_not_called()


class ReferenceTests(unittest.TestCase):
    def test_embedded_reference_precedes_audio_and_is_never_aligned_to_itself(self):
        video = Path('/library/Film.mkv')
        data, embedded, aligned = srt(1), srt(2), srt(3)
        with patch.object(importer, 'embedded_text', return_value={'en': 2}), \
                patch.object(importer, 'extract_english', return_value=embedded) as extract, \
                patch.object(subtitle_sync, 'align', return_value=aligned) as align:
            self.assertEqual(importer.time_subtitle(video, 0, 'en', data, 'ffmpeg', 'ffprobe'), (aligned, 'embedded'))
            align.assert_called_once_with(video, data, embedded)
            extract.assert_called_once_with('ffmpeg', video, 2)
            align.reset_mock()
            self.assertEqual(importer.time_subtitle(video, 0, 'en', embedded, 'ffmpeg', 'ffprobe'), (embedded, 'release'))
            align.assert_not_called()
            extract.return_value = None
            self.assertEqual(importer.time_subtitle(video, 0, 'en', data, 'ffmpeg', 'ffprobe'), (aligned, 'audio'))
            align.assert_called_once_with(video, data, None)

    def test_hungarian_uses_final_english_sidecar_then_audio(self):
        video = Path('/library/Film.mkv')
        hungarian, english, aligned = srt(1, b'Hungarian'), srt(2), srt(3, b'Hungarian')
        with patch.object(importer, 'read_sidecar', return_value=(english, None)) as read, \
                patch.object(subtitle_sync, 'align', return_value=aligned) as align:
            self.assertEqual(importer.time_subtitle(video, 0, 'hu', hungarian, None, None), (aligned, 'english'))
            read.assert_called_once_with(0, 'Film.en.srt')
            align.assert_called_once_with(video, hungarian, english)
            align.reset_mock()
            read.side_effect = FileNotFoundError
            self.assertEqual(importer.time_subtitle(video, 0, 'hu', hungarian, None, None), (aligned, 'audio'))
            align.assert_called_once_with(video, hungarian, None)
            read.reset_mock()
            align.reset_mock()
            with patch.object(subtitle_sync, 'sync_running', return_value=True):
                self.assertEqual(importer.time_subtitle(video, 0, 'hu', hungarian, None, None), (aligned, 'audio'))
            read.assert_not_called()
            align.assert_called_once_with(video, hungarian, None)


@unittest.skipUnless(hasattr(os, 'O_PATH') and hasattr(os, 'O_NOFOLLOW'), 'Linux media paths')
class MetadataTests(unittest.TestCase):
    def test_metadata_merges_entries_and_does_not_follow_symlinks(self):
        with TemporaryDirectory() as location:
            root = Path(location)
            video = root / 'Film.mkv'
            video.touch()
            path = root / subtitle_sync.METADATA
            with audio_tracks.opened(root, directory=True) as folder:
                owner = video.stat()
                self.assertTrue(subtitle_sync.record_timing(video, folder, owner, 'Film.en.srt', 'audio'))
                with path.open('rb') as previous:
                    self.assertTrue(subtitle_sync.record_timing(video, folder, owner, 'Film.hu.srt', 'english'))
                    self.assertEqual(set(json.load(previous)), {'Film.en.srt'})
                data, _ = subtitle_sync.metadata(folder)
                self.assertEqual({name: item['method'] for name, item in data.items()},
                                 {'Film.en.srt': 'audio', 'Film.hu.srt': 'english'})
                self.assertTrue(all(item['synced_at'].endswith('+00:00') for item in data.values()))
                self.assertEqual(path.stat().st_mode & 0o777, 0o660)
                self.assertEqual((path.stat().st_uid, path.stat().st_gid), (owner.st_uid, owner.st_gid))
                outside = root / 'untouched.json'
                path.rename(outside)
                path.symlink_to(outside)
                self.assertFalse(subtitle_sync.record_timing(video, folder, owner, 'Film.en.srt', 'offset'))
                self.assertEqual(json.loads(outside.read_bytes()), data)
