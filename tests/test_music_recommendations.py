from unittest import mock
from test_music_web import Base, URL


class Recommendations(Base):
    def test_genres_are_added_without_changing_search_or_starting_downloads(self):
        client, token = self.signed_in()
        track = {'id': 'dQw4w9WgXcQ', 'url': URL, 'title': 'Linkin Park - Faint',
                 'channel': 'Uploader', 'duration': 180}
        with mock.patch.object(self.intake, 'cmd_search', return_value={'results': [track]}), \
                mock.patch('music_web.GenreLabels.get', return_value='Rock') as genres:
            response = self.post(client, token, '/api/recommendations',
                                 json={'query': 'linkin park official audio', 'seed_artist': 'linkin park'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['seed_genre'], 'Rock')
            self.assertEqual(response.json['results'][0]['genre'], 'Rock')
            self.assertIn(mock.call('Linkin Park'), genres.call_args_list)
            self.assertIn(mock.call('linkin park'), genres.call_args_list)
            search = self.post(client, token, '/api/search', json={'query': 'Linkin Park'})
            self.assertNotIn('genre', search.json['results'][0])
        self.assertFalse(self.state.jobs)

    def test_invalid_seed(self):
        client, token = self.signed_in()
        for seed in (None, [], 'x' * 121, 'bad\nartist'):
            response = self.post(client, token, '/api/recommendations',
                                 json={'query': 'music', 'seed_artist': seed})
            self.assertEqual(response.status_code, 400)
