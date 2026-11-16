import io
import unittest
import urllib.error
from unittest import mock

from music_web import musicbrainz


class MusicBrainzTests(unittest.TestCase):
    def setUp(self):
        musicbrainz._next = 0.0

    def busy(self):
        return urllib.error.HTTPError("https://musicbrainz.org", 503, "Service Temporarily Unavailable", {}, io.BytesIO(b""))

    def test_a_503_is_retried_after_waiting(self):
        opener = mock.Mock()
        response = mock.MagicMock(); response.__enter__.return_value.read.return_value = b'{"artists": []}'
        opener.open.side_effect = [self.busy(), response]
        with mock.patch.object(musicbrainz.urllib.request, "build_opener", return_value=opener),                 mock.patch.object(musicbrainz.time, "sleep") as sleep:
            self.assertEqual(musicbrainz.read("artist/", query="x"), {"artists": []})
        self.assertEqual(opener.open.call_count, 2)
        self.assertGreaterEqual(max(call.args[0] for call in sleep.call_args_list), 1.5)

    def test_repeated_503_raises_throttled(self):
        opener = mock.Mock(); opener.open.side_effect = lambda *a, **k: (_ for _ in ()).throw(self.busy())
        with mock.patch.object(musicbrainz.urllib.request, "build_opener", return_value=opener),                 mock.patch.object(musicbrainz.time, "sleep"):
            with self.assertRaises(musicbrainz.Throttled):
                musicbrainz.read("artist/", query="x")
        self.assertEqual(opener.open.call_count, 4)


if __name__ == "__main__":
    unittest.main()
