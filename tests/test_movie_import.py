"""Exercise torrent hand-off with temporary media and fake upstreams."""
import errno
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from music_web import movie_import


class MovieImportTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.roots = tuple(root / name for name in ('downloads', 'Movies', 'Shows'))
        for directory in self.roots:
            directory.mkdir()
        self.database = root / movie_import.DATABASE
        self.row = dict(hash='a' * 40, name='Tears.of.Steel.2012.1080p.WEB-DL',
                        category='familyhub', state='stalledUP', progress=1, amount_left=0,
                        save_path='/data/downloads/complete')
        self.torrents = Mock(return_value=[self.row])
        self.files = Mock(return_value=[])
        self.refresh = Mock()

    def importer(self):
        return movie_import.MovieImport(self.database, self.roots, self.torrents, self.files, self.refresh)

    def video(self, name):
        path = self.roots[0] / 'complete' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture')
        path.chmod(0o660)
        self.files.return_value.append(dict(name=name, progress=1, priority=1, size=7))
        return path

    def test_season_pack_hardlinks_completed_episodes_and_retries_refresh_after_restart(self):
        self.row['name'] = 'Peaky.Blinders.S01.1080p.BluRay'
        sources = [self.video(f'pack/Peaky.Blinders.S01E{number:02d}.mkv') for number in (1, 2)]
        self.video('pack/Sample/dummy.mkv')
        self.refresh.side_effect = TimeoutError
        with self.assertRaises(TimeoutError):
            self.importer().poll()
        season = self.roots[2] / 'Peaky Blinders' / 'Season 01'
        targets = sorted(season.iterdir())
        self.assertEqual([p.name for p in targets], ['Peaky Blinders - S01E01.mkv', 'Peaky Blinders - S01E02.mkv'])
        self.assertTrue(all(source.samefile(target) for source, target in zip(sources, targets)))
        self.refresh.side_effect = None
        with self.assertLogs('music_web.movie_import', level='WARNING'):
            self.torrents.side_effect = TimeoutError
            self.importer().poll()
        self.torrents.side_effect = None
        self.importer().poll()
        self.files.assert_called_once_with(self.row['hash'])
        self.assertEqual(self.refresh.call_count, 2)

    def test_movie_copy_is_atomic_and_keeps_original(self):
        source = self.video('pack/Tears.of.Steel.2012.mkv')
        target = self.roots[1] / 'Tears of Steel (2012)' / 'Tears of Steel (2012).mkv'
        real_link = os.link

        def separate_mounts(src, dst, **kwargs):
            if src == source:
                raise OSError(errno.EXDEV, 'cross-device link')
            return real_link(src, dst, **kwargs)

        with patch.object(movie_import.os, 'link', side_effect=separate_mounts), patch.object(movie_import, 'FREE_RESERVE', 0):
            self.importer().poll()
        self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertFalse(target.samefile(source))
        self.assertEqual(list(target.parent.iterdir()), [target])
        self.refresh.assert_called_once()

    def test_copy_does_not_replace_a_concurrent_library_write(self):
        source = self.video('Tears.of.Steel.2012.mkv')
        target = self.roots[1] / 'Tears of Steel (2012)' / 'Tears of Steel (2012).mkv'
        real_link = os.link

        def concurrent_write(src, dst, **kwargs):
            if src == source:
                raise OSError(errno.EXDEV, 'cross-device link')
            target.write_bytes(b'concurrent movie')
            return real_link(src, dst, **kwargs)

        with patch.object(movie_import.os, 'link', side_effect=concurrent_write), patch.object(movie_import, 'FREE_RESERVE', 0):
            with self.assertLogs('music_web.movie_import', level='WARNING'):
                self.importer().poll()
        self.assertEqual(target.read_bytes(), b'concurrent movie')
        self.assertEqual(source.read_bytes(), b'fixture')
        self.assertEqual(list(target.parent.iterdir()), [target])
        self.importer().poll()
        self.refresh.assert_called_once()

    def test_dry_run_and_ineligible_torrents_leave_disk_and_jellyfin_untouched(self):
        self.video('Tears.of.Steel.2012.mkv')
        self.torrents.return_value += [dict(self.row, hash='b' * 40, category='other'),
                                       dict(self.row, hash='c' * 40, state='moving'),
                                       dict(self.row, hash='d' * 40, progress=0.9)]
        with self.assertLogs('music_web.movie_import', level='INFO') as log:
            self.importer().poll(dry_run=True)
        self.assertIn('Tears of Steel (2012).mkv', log.output[0])
        self.assertFalse(self.database.exists())
        self.assertEqual(list(self.roots[1].iterdir()), [])
        self.files.assert_called_once_with(self.row['hash'])
        self.refresh.assert_not_called()

    def test_traversal_is_rejected_and_existing_movie_is_preserved(self):
        self.video('Tears.of.Steel.2012.mkv')
        self.files.return_value[0]['name'] = '../escape.mkv'
        with self.assertLogs('music_web.movie_import', level='WARNING'):
            self.importer().poll()
        self.refresh.assert_not_called()
        folder = self.roots[1] / 'Tears of Steel (2012)'
        folder.mkdir()
        existing = folder / 'Manual copy.mp4'
        existing.write_bytes(b'keep')
        self.files.return_value[0]['name'] = 'Tears.of.Steel.2012.mkv'
        self.importer().poll()
        self.assertEqual(list(folder.iterdir()), [existing])
        self.assertEqual(existing.read_bytes(), b'keep')
        self.refresh.assert_called_once()
