"""Torrent subtitle selection, timing, and sidecars with local fixtures."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Lock
import unittest
from unittest.mock import Mock, patch

from music_web import movie_import, movie_subtitle_import as subtitles, movie_subtitles


ASS = (b'[Script Info]\nTitle: Example\n[Events]\n'
       b'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
       b'Dialogue: 0,0:00:01.20,0:00:03.40,Default,,0,0,0,,{\\i1}Hello, world!\\N{\\b1}Next line\n'
       b'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 12 5\n')
ASS_CONVERTED = b'1\n00:00:01,200 --> 00:00:03,400\nHello, world!\nNext line\n'


def srt(*starts, text='Fixture'):
    return ('\n\n'.join(f'{index}\n{subtitles.timestamp(start)} --> {subtitles.timestamp(start + 750)}\n{text}'
                        for index, start in enumerate(starts, 1)) + '\n').encode()


def silence(*gaps):
    return '\n'.join(f'[Parsed_silencedetect_0 @ fixture] silence_{kind}: {value}'
                     for start, end in gaps for kind, value in (('start', start), ('end', end))).encode()


class SubtitleImportTests(unittest.TestCase):
    def test_language_tokens_and_jellyfin_names(self):
        source = Path('pack/The.English.Patient.mkv')
        for relative, expected in [('The.English.Patient.en.srt', ('en', False)),
                                   ('The.English.Patient-HUN.SDH.srt', ('hu', True)),
                                   ('Subs/Magyar/1.ass', ('hu', False)), ('Subs/2_English.ssa', ('en', False)),
                                   ('The.English.Patient.de.srt', (None, False)), ('Bengal.enough.srt', (None, False))]:
            with self.subTest(relative=relative):
                self.assertEqual(subtitles.subtitle_label(source.parent / relative, source), expected)

    def test_ass_and_ssa_retain_cue_timing_and_plain_text(self):
        self.assertEqual(subtitles.ass_to_srt(ASS, 'en'), ASS_CONVERTED)
        ssa = b'[Events]\nFormat: Marked, Start, End, Text\nDialogue: Marked=0,2:01:02.05,2:01:03.50,A, B\n'
        self.assertEqual(subtitles.ass_to_srt(ssa, 'en'), b'1\n02:01:02,050 --> 02:01:03,500\nA, B\n')
        with self.assertRaises(movie_subtitles.SubtitleError):
            subtitles.ass_to_srt(b'[Events]\nDialogue: invalid', 'en')

    def test_shift_requires_leading_silence_and_repeated_alignment(self):
        track = srt(1000, 20000, 49000)
        report = silence((0, 4), (18, 23.2), (46, 52))
        offset = subtitles.sync_offset(track, report)
        self.assertEqual(offset, 3000)
        self.assertEqual(subtitles.shift_srt(track, offset), srt(4000, 23000, 52000))
        self.assertEqual(subtitles.sync_offset(srt(7000, 26200, 55000), report), -3000)
        self.assertEqual(subtitles.sync_offset(track, silence((0, 3), (18, 22), (46, 51))), 0)
        self.assertEqual(subtitles.sync_offset(track, silence((0, 4), (15, 18), (40, 44))), 0)
        self.assertEqual(subtitles.sync_offset(track, silence((1, 4), (18, 23), (46, 52))), 0)

    def test_release_hash_uses_only_a_valid_torrent_identifier(self):
        self.assertEqual(movie_import.release_hash('A' * 40, None), 'a' * 40)
        self.assertEqual(movie_import.release_hash(None, 'magnet:?xt=urn:btih:' + 'A' * 32), '0' * 40)
        self.assertEqual(movie_import.release_hash(None, 'magnet:?dn=lookalike&xt=other'), '')
        self.assertEqual(movie_import.release_hash(None, 'magnet:?dn=lookalike%26xt%3Durn:btih:' + 'A' * 32), '')


@unittest.skipUnless(hasattr(os, 'O_PATH') and hasattr(os, 'O_NOFOLLOW'), 'Linux media paths')
class SubtitleImportFileTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory())).resolve()
        self.release = self.root / 'pack'
        self.release.mkdir()
        self.source = self.release / 'Example.mkv'
        self.source.write_bytes(b'fixture')
        self.video = self.root / 'Example.mkv'
        self.video.write_bytes(b'fixture')

    def file(self, name, data):
        path = self.release / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_full_then_srt_then_larger_line_count(self):
        large = srt(1000, 2500, 4500)
        paths = [self.file('Subs/English/en.ass', ASS), self.file('Subs/1.eng.srt', srt(1000)),
                 self.file('Subs/2.English.srt', large), self.file('Subs/English.SDH.srt', srt(1, 2, 3, 4)),
                 self.file('Subs/English.forced.srt', srt(5, 6, 7, 8)), self.file('Subs/hu.ssa', ASS),
                 self.file('Subs/de.srt', large)]
        self.assertEqual(subtitles.select_text(paths, self.source, ('en', 'hu')), {'en': large, 'hu': ASS_CONVERTED})
        variant = subtitles.select_text([paths[0], paths[3], paths[4]], self.source, ('en',))
        self.assertEqual(variant, {'en': ASS_CONVERTED})

    def test_ocr_only_after_text_sources_and_bounded_docker(self):
        text = self.file('Example.en.srt', srt(1000))
        idx = self.file('Subs/Example.idx', b'# VobSub index file, v7\nid: en, index: 0\n')
        sub = self.file('Subs/Example.sub', b'fixture bitmap')
        fallback = Mock(return_value=None)

        def docker(command, **kwargs):
            self.assertIn('vobsub-try', command)
            self.assertEqual(command[-4:], ['/src/build/bin/vobsub2srt', '--lang', 'en', 'subtitle'])
            self.assertEqual(kwargs['timeout'], 90)
            mount = command[command.index('--mount') + 1]
            scratch = Path(mount.removeprefix('type=bind,source=').removesuffix(',target=/work'))
            self.assertEqual((scratch / 'subtitle.sub').read_bytes(), b'fixture bitmap')
            (scratch / 'subtitle.srt').write_bytes(srt(2000))

        with patch.object(subtitles.shutil, 'which', return_value='docker'), \
                patch.object(subtitles, 'background_command', side_effect=lambda command, **kwargs: command), \
                patch.object(subtitles.subprocess, 'run', side_effect=docker) as run:
            subtitles.import_subtitles(self.video, self.source, [text, idx, sub], ['en'], fallback, None, None)
            run.assert_not_called()
            output = self.video.with_suffix('.en.srt')
            self.assertEqual(output.read_bytes(), srt(1000))
            output.unlink()
            with patch.object(subtitles, 'embedded_text', return_value={'en'}):
                subtitles.import_subtitles(self.video, self.source, [idx, sub], ['en'], fallback, None, None)
            run.assert_not_called()
            subtitles.import_subtitles(self.video, self.source, [idx, sub], ['en'], fallback, None, None)
            run.assert_called_once()
            self.assertEqual(output.read_bytes(), srt(2000))
        fallback.assert_not_called()

    def test_publish_applies_shift_and_skips_unrequested_hungarian(self):
        english = self.file('Example.en.srt', srt(1000, 20000, 49000))
        hungarian = self.file('Example.hu.srt', srt(1000))
        report = silence((0, 4), (18, 23.2), (46, 52))
        with patch.object(subtitles, 'media_command', return_value=report) as ffmpeg, \
                self.assertLogs(subtitles.log, 'INFO') as log:
            subtitles.import_subtitles(self.video, self.source, [english, hungarian], ['en'],
                                      Mock(return_value=None), 'ffmpeg', None)
        self.assertEqual(self.video.with_suffix('.en.srt').read_bytes(), srt(4000, 23000, 52000))
        self.assertFalse(self.video.with_suffix('.hu.srt').exists())
        self.assertIn('3000 ms', log.output[0])
        self.assertIn('900', ffmpeg.call_args.args[2])
        self.assertEqual(ffmpeg.call_args.kwargs, {'timeout': 120, 'diagnostics': True})

    def test_optional_audio_reuses_existing_matching_and_sidecar_flow(self):
        origin = self.file('Example.hun.ac3', b'fixture audio')
        english = {'language': 'eng', 'index': 2, 'duration': 90}
        hungarian = {'language': 'und', 'index': 0, 'duration': 90}
        report = {'offset_ms': 123, 'speed_ratio': 1}
        tracks = movie_import.audio_tracks
        with patch.object(tracks, 'probe_audio', side_effect=[[english], [hungarian]]) as probe, \
                patch.object(tracks, 'match_track', return_value=report) as match, \
                patch.object(tracks, 'write_sidecar') as write:
            movie_import.import_hungarian_audio(self.video, self.source, [origin], 'ffmpeg', 'ffprobe')
        self.assertEqual([call.args[1] for call in probe.call_args_list], [self.video, origin])
        self.assertEqual(match.call_args.args[:6], ('ffmpeg', self.video, origin, 2, None, 0))
        self.assertEqual(write.call_args.args[:8], ('ffmpeg', 'ffprobe', origin, self.video,
                                                   hungarian, 'hu', 'Hungarian', report))

    def test_poll_carries_options_selects_episode_subtitles_and_records_fallback(self):
        shows, movies = self.root / 'shows', self.root / 'movies'
        shows.mkdir()
        movies.mkdir()
        ident = 'a' * 40
        name = 'Fixture.Show.S02.1080p'
        row = dict(hash=ident, name=name, category='familyhub', state='stalledUP', progress=1,
                   amount_left=0, save_path='/data/downloads')
        first = self.file('Fixture.Show.S02E01.mkv', b'video')
        second = self.file('Fixture.Show.S02E02.mkv', b'video')
        self.file('Subs/Fixture.Show.S02E01/English.ass', ASS)
        hungarian = self.file('Subs/Fixture.Show.S02E02/1.Magyar.srt', srt(3000))
        files = [dict(name=p.relative_to(self.root).as_posix(), size=p.stat().st_size, progress=1, priority=1)
                 for p in (first, second, hungarian)]
        database = self.root / movie_import.DATABASE
        movie_import.record_options({'STATE_DIR': self.root, 'MOVIE_DOWNLOADS': {'import': {'enabled': True}}},
                                    name, ident, (True, True))
        provider = Mock(configured=True, **{'fetch.side_effect': movie_subtitles.SubtitleError('Quota', 429)})
        refresh = Mock()
        importer = movie_import.MovieImport(database, (self.root, movies, shows), lambda: [row], lambda _: files,
                                             refresh, (provider, Lock()))
        with patch.object(movie_import, 'import_hungarian_audio') as audio:
            importer.poll()
            self.assertEqual(audio.call_count, 2)
        season = shows / 'Fixture Show' / 'Season 02'
        self.assertEqual((season / 'Fixture Show - S02E01.en.srt').read_bytes(), ASS_CONVERTED)
        self.assertEqual((season / 'Fixture Show - S02E02.hu.srt').read_bytes(), srt(3000))
        self.assertEqual([call.args[0]['languages'] for call in provider.fetch.call_args_list], ['hu', 'en'])
        self.assertTrue(movie_import.subtitle_managed(database, (self.root, movies, shows),
                        '/data/tv/Fixture Show/Season 02/Fixture Show - S02E02.mkv'))
        refresh.assert_called_once()
        with closing(sqlite3.connect(database)) as db, db:
            self.assertEqual(db.execute("SELECT language FROM subtitle_imports WHERE language != '' ORDER BY language").fetchall(),
                             [('en',), ('hu',)])
            self.assertEqual(db.execute('SELECT count(*) FROM download_options').fetchone(), (0,))
            db.execute('DELETE FROM imported')  # Simulate a restart before the finished import was recorded.
        importer.poll()
        self.assertEqual(provider.fetch.call_count, 2)
