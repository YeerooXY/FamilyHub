import unittest

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


if __name__ == '__main__':
    unittest.main()


class LibraryAllowlistTests(unittest.TestCase):
    def test_next_up_is_readable(self):
        self.assertTrue(movie_media.LIBRARY_READ.fullmatch('Shows/NextUp'))
        self.assertIsNone(movie_media.LIBRARY_WRITE.fullmatch('Shows/NextUp'))
