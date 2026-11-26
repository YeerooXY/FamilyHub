"""Offline related-film route tests. Run from tests with unittest discovery."""
import io
import json
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import test_music_web


def tmdb_reply(value):
    return io.BytesIO(json.dumps(value).encode())


class MovieRelated(test_music_web.Base):
    extra = {
        'FAMILY_PROFILES': True,
        'JELLYFIN_PUBLIC_URL': 'https://movies.test',
        'JELLYFIN_PROFILES': {'sample-a': {'username': 'viewer', 'password': 'fixture'}},
        'MOVIE_REQUESTS': {'tmdb_read_token': 'fixture-secret'},
    }
    route = '/api/movies/related?tmdb=42&kind=movie'

    def viewer(self, name='sample-a'):
        client = self.app.test_client()
        bootstrap = self.go(client, 'GET', '/api/connect').json
        response = self.post(client, bootstrap['csrf_token'], '/api/profile/select',
                             json=self.profile_credentials(name))
        self.assertEqual(response.status_code, 200)
        return client

    @patch('music_web.movies.urllib.request.build_opener')
    def test_collection_first_with_stable_deduplication_and_cache(self, opener):
        sequel = {'id': 44, 'title': 'Sequel', 'poster_path': '/valid.jpg', 'backdrop_path': '/scene.jpg',
                  'release_date': '2021-01-01'}
        recommendation = {**sequel, 'id': 47, 'title': 'Recommendation'}
        opener.return_value.open.side_effect = [
            tmdb_reply({'belongs_to_collection': {'id': 202}, 'recommendations': {'results': [
                sequel, {'id': 42, 'title': 'Current film'}, recommendation,
                {**sequel, 'id': 51, 'title': 'Adult film', 'adult': True},
                {**sequel, 'id': 52, 'title': 'Untitled Home Alone Film'},
                {**sequel, 'id': 53, 'title': 'Coming Later', 'release_date': '2999-01-01'},
                {**sequel, 'id': 54, 'title': 'Missing date', 'release_date': ''},
                {**sequel, 'id': 55, 'title': 'Invalid date', 'release_date': '2021-02-30'},
            ]}}),
            tmdb_reply({'parts': [None, {'id': 42, 'title': 'Current film'}, sequel,
                                  {**sequel, 'id': 40, 'title': 'Prequel', 'poster_path': '//example.test/a.jpg'}]}),
        ]
        viewer = self.viewer()
        result = self.go(viewer, 'GET', self.route)
        self.assertEqual(result.status_code, 200)
        matches = result.json['matches']
        self.assertEqual([film['id'] for film in matches], [44, 47])
        self.assertEqual(matches[0]['poster'], 'https://image.tmdb.org/t/p/w342/valid.jpg')
        self.assertEqual(matches[0]['backdrop'], 'https://image.tmdb.org/t/p/w780/scene.jpg')
        self.assertEqual([film['id'] for film in result.json['library_matches']], [40, 52, 53, 54, 55])
        self.assertEqual(set(result.json['library_matches'][0]), {'id', 'title', 'year'})
        self.assertNotIn('fixture-secret', result.get_data(as_text=True))
        self.assertEqual(self.go(viewer, 'GET', self.route).json, result.json)
        calls = opener.return_value.open.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual([urlsplit(call.args[0].full_url).path for call in calls],
                         ['/3/movie/42', '/3/collection/202'])
        self.assertEqual(parse_qs(urlsplit(calls[0].args[0].full_url).query), {'append_to_response': ['recommendations']})
        for call in calls:
            self.assertEqual(call.kwargs['timeout'], 4)
            self.assertEqual(call.args[0].get_header('Authorization'), 'Bearer fixture-secret')

    @patch('music_web.movies.urllib.request.build_opener')
    def test_requires_a_linked_profile_and_a_valid_film(self, opener):
        self.assertEqual(self.go(self.app.test_client(), 'GET', self.route).status_code, 401)
        self.assertEqual(self.go(self.viewer('sample-b'), 'GET', self.route).status_code, 403)
        viewer = self.viewer()
        for query in ('', 'tmdb=0&kind=movie', 'tmdb=42&kind=tv', 'tmdb=1%2F2&kind=movie',
                      'tmdb=99999999999&kind=movie'):
            self.assertEqual(self.go(viewer, 'GET', '/api/movies/related?' + query).status_code, 400)
        opener.assert_not_called()

    @patch('music_web.movies.urllib.request.build_opener')
    def test_timeout_is_a_bounded_generic_failure(self, opener):
        opener.return_value.open.side_effect = TimeoutError('fixture-secret')
        result = self.go(self.viewer(), 'GET', self.route)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.json, {'error': 'Related films are unavailable.'})
