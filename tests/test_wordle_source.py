from datetime import date
from io import BytesIO
from unittest import TestCase
from unittest.mock import patch

from music_web.wordle_source import published_answer


class PublishedPuzzleTests(TestCase):
    day = date(2026, 11, 21)

    def test_matching_edition(self):
        with patch("music_web.wordle_source.urlopen", return_value=BytesIO(
            b'{"print_date":"2026-11-21","solution":"crane"}'
        )) as fetch:
            self.assertEqual(published_answer(self.day), "crane")
            fetch.assert_called_once_with("https://www.nytimes.com/svc/wordle/v2/2026-11-21.json", timeout=4)

    def test_invalid_or_unavailable_edition(self):
        for raw in (b'{"print_date":"2026-11-20","solution":"crane"}',
                    b'{"print_date":"2026-11-21","solution":"longer"}', b'[]', b'error', b' ' * 8193):
            with self.subTest(raw=raw[:55]), patch("music_web.wordle_source.urlopen", return_value=BytesIO(raw)):
                self.assertIsNone(published_answer(self.day))
        with patch("music_web.wordle_source.urlopen", side_effect=TimeoutError):
            self.assertIsNone(published_answer(self.day))
