import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from music_web import movie_media

ITEM = '5581b025-e21b-8bcd-45eb-8532408416d7'
QUERY = ('MediaSourceId=5581b025e21b8bcd45eb8532408416d7&PlaySessionId=93e1173ece1842a98170d28076284219&VideoCodec=h264'
         '&AudioCodec=aac&maxWidth=1920&maxHeight=1080&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MinSegments=1'
         '&BreakOnNonKeyFrames=true&AllowVideoStreamCopy=false&runtimeTicks=0&actualSegmentLengthTicks=30000000'
         '&DeviceId=0123456789abcdef0123456789abcdef&Tag=0123456789abcdef0123456789abcdef&AudioStreamIndex=1&AudioBitrate=384000'
         '&VideoBitrate=6720000&MaxFramerate=23.976&RequireAvc=false&EnableAudioVbrEncoding=true&TranscodeReasons=VideoCodecNotSupported'
         '&vc1-level=3&vc1-profile=advanced&vc1-videobitdepth=8&allowVideoStreamCopy=false&allowAudioStreamCopy=false')


class LongFilmPlaylistTests(unittest.TestCase):
    def playlist(self, segments):
        lines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:0']
        for number in range(segments):
            lines += ['#EXTINF:3.000000, nodesc', f'hls1/main/{number}.ts?{QUERY}']
        return '\n'.join(lines + ['#EXT-X-ENDLIST']) + '\n'

    def test_a_long_film_playlist_fits_the_proxy_limit_and_is_rewritten(self):
        text = self.playlist(2200)  # About 2 h at 3 s segments; larger than the old 1 MiB limit.
        self.assertGreater(len(text.encode()), 1 << 20)
        self.assertLess(len(text.encode()) * 2, movie_media.MAX_PLAYLIST_BYTES)
        ticket = 'T' * 43
        rewritten = movie_media.playlist_urls(text, f'videos/{ITEM}/main.m3u8', ticket)
        segments = [line for line in rewritten.splitlines() if line and not line.startswith('#')]
        self.assertEqual(len(segments), 2200)
        self.assertTrue(all(line.startswith(f'/api/movies/media/{ticket}/videos/{ITEM}/hls1/main/') for line in segments))

    def test_a_playlist_with_an_absolute_url_is_still_refused(self):
        with self.assertRaises(ValueError):
            movie_media.playlist_urls('#EXTM3U\nhttps://elsewhere.test/videos/x.ts\n', f'videos/{ITEM}/main.m3u8', 'T' * 43)

    def test_the_usage_id_follows_variant_playlists_and_segments(self):
        text = '#EXTM3U\n#EXT-X-MAP:URI="hls1/init.mp4"\nhls1/0.ts?start=0\n'
        rewritten = movie_media.playlist_urls(text, f'videos/{ITEM}/main.m3u8', 'T' * 43, usage_id='a' * 32)
        self.assertIn(f'init.mp4?fhUsage={"a" * 32}"', rewritten)
        self.assertIn(f'0.ts?start=0&fhUsage={"a" * 32}', rewritten)

    def test_the_trickplay_image_stream_is_dropped_from_the_master_playlist(self):
        # Jellyfin 12 adds this line once trickplay exists; the whole playlist used to fail with 502.
        text = ('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x800\nmain.m3u8?VideoCodec=h264\n'
                '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=10196,RESOLUTION=320x132,CODECS="jpeg",'
                'URI="Trickplay/320/tiles.m3u8?MediaSourceId=abc&ApiKey=secret"\n')
        rewritten = movie_media.playlist_urls(text, f'videos/{ITEM}/master.m3u8', 'T' * 43)
        self.assertNotIn('Trickplay', rewritten)
        self.assertNotIn('secret', rewritten)
        self.assertIn(f'/api/movies/media/{"T" * 43}/videos/{ITEM}/main.m3u8?VideoCodec=h264', rewritten)


class MovieUsageTests(unittest.TestCase):
    def test_estimate_uses_decimal_gigabytes_and_rounds_to_a_tenth(self):
        self.assertEqual([movie_media.hourly_gb(b) for b in (2_500_000, 1_000_000, 500_000)], [1.1, 0.5, 0.2])
        films = [{'MediaSources': [{'Bitrate': b}]} for b in (20_000_000, 8_000_000, 12_000_000, 0, True, None)]
        self.assertEqual(movie_media.film_bitrate_estimate(films), 5.4)
        self.assertEqual(movie_media.film_bitrate_estimate(films[:2]), 6.3)
        self.assertIsNone(movie_media.film_bitrate_estimate(films[3:]))

    @patch('music_web.movie_media.datetime')
    def test_cellular_usage_resets_monthly_and_the_session_keeps_its_total(self, clock):
        clock.now.return_value = datetime(2026, 11, 30, tzinfo=timezone.utc)
        usage = movie_media.MediaUsage(streams={'session': 0})
        usage.connection = 'wifi'
        usage.add('session', 100)
        usage.connection = 'cellular'
        usage.add('session', 200)
        usage.add('unregistered', 900)
        self.assertEqual(usage.snapshot('session'), dict(bytes=300, month='2026-11', cellularBytes=200))
        clock.now.return_value = datetime(2026, 12, 1, tzinfo=timezone.utc)
        usage.add('session', 10)
        self.assertEqual(usage.snapshot('session'), dict(bytes=310, month='2026-12', cellularBytes=10))


if __name__ == '__main__':
    unittest.main()


class LibraryAllowlistTests(unittest.TestCase):
    def test_next_up_is_readable(self):
        self.assertTrue(movie_media.LIBRARY_READ.fullmatch('Shows/NextUp'))
        self.assertIsNone(movie_media.LIBRARY_WRITE.fullmatch('Shows/NextUp'))
