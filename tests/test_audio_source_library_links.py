import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from music_web import audio_tracks


class LibraryHardLinkTests(unittest.TestCase):
    """A completed download hard-linked into the library is the library video itself, so it is not offered as a source."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.libraries = {'movies': base / 'media/movies', 'tv': base / 'media/tv'}
        season = self.libraries['tv'] / 'Show/Season 01'
        season.mkdir(parents=True)
        self.download = base / 'downloads/complete/Show.S01.1080p'
        self.download.mkdir(parents=True)
        for number in (1, 2):
            file = self.download / f'Show.S01E0{number}.mkv'
            file.write_bytes(b'video')
            os.link(file, season / f'Show S01E0{number}.mkv')
        self.dub = base / 'downloads/complete/Show.S01E02.HUN.mkv'
        self.dub.write_bytes(b'dub')
        self.season = season

    def tearDown(self):
        self.temp.cleanup()

    def test_the_episode_download_and_its_season_folder_are_skipped_but_a_dub_is_kept(self):
        with patch.object(audio_tracks, 'LIBRARIES', self.libraries):
            own = audio_tracks.library_inodes({'Path': '/data/tv/Show/Season 01/Show S01E02.mkv'})
            self.assertEqual(len(own), 1)
            self.assertTrue(audio_tracks.same_as_library(self.download / 'Show.S01E02.mkv', False, own))
            self.assertFalse(audio_tracks.same_as_library(self.dub, False, own))
            season = audio_tracks.library_inodes({'Path': str(self.season)})
            self.assertEqual(len(season), 2)
            self.assertTrue(audio_tracks.same_as_library(self.download, True, season))

    def test_a_title_outside_the_library_folders_has_no_own_files(self):
        with patch.object(audio_tracks, 'LIBRARIES', self.libraries):
            self.assertEqual(audio_tracks.library_inodes({'Path': '/elsewhere/film.mkv'}), set())
            self.assertFalse(audio_tracks.same_as_library(self.dub, False, set()))


if __name__ == '__main__':
    unittest.main()
