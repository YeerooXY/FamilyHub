from unittest import mock
from test_music_web import Base, URL
from test_radio import PAGES, song
from music_web import radio, similar_songs


class Recommendations(Base):
    def test_deezer_radio_is_paged_without_searching_youtube_or_starting_downloads(self):
        client, token = self.signed_in()
        pages = PAGES | {"search?q=Taio+Cruz+Dynamite&limit=10": {"data": [song(9, "Taio Cruz", "Dynamite")]}}
        radio_path = "artist/1/radio?limit=50"
        pages[radio_path] = {"data": PAGES[radio_path]["data"] + [song(60, "Example Artist", "A new song"), song(61, "Example Artist", "Another song")]}
        seed, read_radio = radio.seed, radio.read_radio
        with mock.patch.object(self.intake, 'cmd_search', side_effect=AssertionError('Unexpected YouTube search')), \
                mock.patch('music_web.radio.seed', side_effect=lambda a, t, **_: seed(a, t, read=pages.__getitem__)) as lookup, \
                mock.patch('music_web.radio.read_radio', side_effect=lambda u, n, **_: read_radio(u, n, read=pages.__getitem__)), \
                mock.patch('music_web.GenreLabels.get', return_value='Pop'):
            payload = {'seed_artist': 'Taio Cruz', 'seed_title': 'Dynamite'}
            response = self.post(client, token, '/api/recommendations',
                                 json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json['from_deezer'])
            self.assertEqual(response.json['seed_genre'], 'Pop')
            rows = response.json['results']
            self.assertEqual(response.json['next_offset'], 8)
            page = self.post(client, token, '/api/recommendations', json=payload | {'offset': 8})
            self.assertEqual(page.status_code, 200)
            rows += page.json['results']
            self.assertEqual(lookup.call_count, 1)
            self.assertIn(('Flo Rida', 'Right Round'), [(row['channel'], row['title']) for row in rows])
            self.assertTrue(all(row['id'].startswith('deezer:') and not row['saved'] for row in rows))
            self.assertNotIn('Dynamite', [row['title'] for row in rows])
        self.assertFalse(self.state.jobs)

    def test_playing_a_suggestion_uses_the_playlist_matcher(self):
        client, token = self.signed_in()
        candidate = {'id': 'dQw4w9WgXcQ', 'url': URL, 'title': 'Right Round', 'channel': 'Flo Rida'}
        with mock.patch('music_web.similar_songs._deezer', return_value=song(40, 'Flo Rida', 'Right Round')) as read, \
                mock.patch.object(self.intake, 'cmd_search', return_value={'results': []}) as search, \
                mock.patch('music_web.preferred_match', return_value=candidate):
            matched = self.post(client, token, '/api/recommendations/match', json={'id': 'deezer:40'})
            self.assertEqual(matched.json['id'], candidate['id'])
            self.assertEqual(search.call_args.args[0].query, 'Flo Rida - Topic Right Round')
            read.assert_called_once_with('track/40')
            invalid = self.post(client, token, '/api/recommendations/match', json={'id': 'deezer:../../bad'})
            self.assertEqual(invalid.status_code, 400)
            self.assertEqual(read.call_count, 1)
        self.assertFalse(self.state.jobs)

    def test_saved_radio_match_retains_library_record(self):
        saved = {'id': 'dQw4w9WgXcQ', 'title': 'Right Round', 'channel': 'Flo Rida', 'duration': 200, 'saved': True}
        pages = PAGES | {"search?q=Taio+Cruz+Dynamite&limit=10": {"data": [song(9, "Taio Cruz", "Dynamite")]}}
        rows = similar_songs.suggestions('Taio Cruz', 'Dynamite', [saved], read=pages.__getitem__)
        self.assertIn(saved, rows)

    def test_invalid_seed(self):
        client, token = self.signed_in()
        for seed in (None, [], 'x' * 121, 'bad\nartist'):
            response = self.post(client, token, '/api/recommendations',
                                 json={'query': 'music', 'seed_artist': seed})
            self.assertEqual(response.status_code, 400)
