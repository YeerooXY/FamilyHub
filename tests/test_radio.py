"""Song and artist radio built from Deezer's artist radio and related artists (no network)."""
import unittest
from music_web import radio
from music_web.playlists import PlaylistError


def song(i, artist, title, duration=200):
    return {"id": i, "title": title, "duration": duration, "artist": {"id": 1, "name": artist}, "album": {"title": "Album"}}


PAGES = {
    "track/9": song(9, "Taio Cruz", "Dynamite") | {"artist": {"id": 1, "name": "Taio Cruz"}},
    "artist/1/radio?limit=50": {"data": [song(10 + n, "Taio Cruz", f"Hit {n}") for n in range(6)] + [song(30, "INNA", "Club Rocker (Radio Edit)"), song(31, "INNA", "Endless")]},
    "artist/1/related?limit=8": {"data": [{"id": 2, "name": "Flo Rida"}, {"id": 3, "name": "Pitbull"}]},
    "artist/2/top?limit=5": {"data": [song(40, "Flo Rida", "Right Round"), song(41, "Flo Rida", "Low")]},
    "artist/3/top?limit=5": {"data": [song(50, "Pitbull", "Fun"), song(9, "Taio Cruz", "Dynamite")]},
}


class Radio(unittest.TestCase):
    def test_valmar_featured_artist_and_upload_noise_are_removed_before_search(self):
        requested = []
        def read(path):
            requested.append(path)
            return {'data': [song(99, 'VALMAR', 'Álmatlan esték')]}
        result = radio.seed('VALMAR ft. Nemazalany & Sofi',
                            'VALMAR ft. Nemazalany & Sofi - Almatlan estek (Official Music Video)', read=read)
        self.assertEqual(result[0], 'familyhub-radio:track:99')
        self.assertEqual(requested, ['search?q=VALMAR+Almatlan+estek&limit=10'])

    def test_empty_artist_radio_falls_back_to_top_tracks(self):
        pages = {'artist/1/radio?limit=50': {'data': []}, 'artist/1/related?limit=8': {'data': []},
                 'artist/1/top?limit=50': {'data': [song(21, 'VALMAR', 'Other song')]}}
        result = radio.read_radio('familyhub-radio:artist:1', 'VALMAR Radio', read=pages.__getitem__)
        self.assertEqual(result['tracks'][0]['title'], 'Other song')

    def test_error_payload_is_not_an_empty_search(self):
        with self.assertRaises(OSError):
            radio.seed('VALMAR', read=lambda _: {'error': {'code': 4}})

    def test_library_fallback_matches_primary_credit_or_known_genre(self):
        rows = [dict(id='one', title='VALMAR ft. Sofi - Other', channel='Uploader'),
                dict(id='two', title='Other song', channel='Other', genre='Pop'),
                dict(id='three', title='Unknown', channel='Other', genre='Unsorted')]
        self.assertEqual(radio.related_library('VALMAR ft. Nemazalany', 'Pop', rows), rows[:2])

    def test_seed_song_first_variety_and_no_variants(self):
        data = radio.read_radio("familyhub-radio:track:9", "Dynamite Radio", read=PAGES.__getitem__)
        titles = [(r["artist"], r["title"]) for r in data["tracks"]]
        self.assertEqual(titles[0], ("Taio Cruz", "Dynamite"))
        self.assertLessEqual(sum(a == "Taio Cruz" for a, _ in titles), radio.PER_ARTIST)
        self.assertIn(("Flo Rida", "Right Round"), titles)
        self.assertNotIn(("INNA", "Club Rocker (Radio Edit)"), titles, "edits and remixes are left out")
        self.assertEqual(len(titles), len(set(titles)), "a song appears once")
        self.assertEqual(data["tracks"][0]["spotify_uri"], "deezer:9")

    def test_seed_picks_the_matching_song_or_best_known_artist(self):
        pages = {"search?q=Taio+Cruz+Dynamite&limit=10": {"data": [song(8, "Someone", "Dynamite"), song(9, "Taio Cruz", "Dynamite")]},
                 "search/artist?q=Pendulum&limit=10": {"data": [{"id": 5, "name": "Pendulum", "nb_fan": 3}, {"id": 281, "name": "Pendulum", "nb_fan": 900000}]}}
        self.assertEqual(radio.seed("Taio Cruz, Lolly", "Taio Cruz - Dynamite (Official Video)", read=pages.__getitem__), ("familyhub-radio:track:9", "Dynamite Radio"))
        self.assertEqual(radio.seed("Pendulum", read=pages.__getitem__), ("familyhub-radio:artist:281", "Pendulum Radio"))
        with self.assertRaises(PlaylistError): radio.seed("", read=pages.__getitem__)
        with self.assertRaises(PlaylistError): radio.read_radio("https://evil.test/radio", "x", read=pages.__getitem__)

    def test_seed_finds_one_artist_of_a_collaboration(self):
        # The app sends "Koven & ShockOne" normalized as "koven shockone".
        pages = {"search?q=koven+shockone+Collecting+Thoughts&limit=10": {"data": [song(70, "Koven", "Collecting Thoughts")]},
                 "search/artist?q=mazare+runn&limit=10": {"data": [{"id": 6, "name": "RUNN", "nb_fan": 10}, {"id": 7, "name": "Runner", "nb_fan": 99}]}}
        self.assertEqual(radio.seed("koven shockone", "Collecting Thoughts", read=pages.__getitem__)[0], "familyhub-radio:track:70")
        self.assertEqual(radio.seed("mazare runn", read=pages.__getitem__)[0], "familyhub-radio:artist:6")

    def test_song_radio_names_preserve_meaningful_title_text(self):
        def read(path):
            rows = [{"id": 5, "name": "beton hofi"}] if path.startswith("search/artist?") else []
            return {"data": rows}

        for source, expected in (
            ("BETON.HOFI - PÁNCZÉL (OFFICIAL AUDIO) [HD]", "PÁNCZÉL Radio"),
            ("Colors (Original Life is Strange Inspired Song)", "Colors Radio"),
            ("Tonight (Live) (Official Video) [Lyrics]", "Tonight (Live) Radio"),
            ("Song (Original Sin) – Part II", "Song (Original Sin) – Part II Radio"),
        ):
            with self.subTest(source=source):
                self.assertEqual(radio.seed("beton hofi", source, read=read)[1], expected)

    def test_seed_separates_no_match_from_deezer_failure(self):
        empty = {"search?q=nobody+Song&limit=10": {"data": []}, "search/artist?q=nobody&limit=10": {"data": []}}
        with self.assertRaises(PlaylistError): radio.seed("nobody", "Song", read=empty.__getitem__)
        def failing(path): raise PlaylistError("Deezer could not find this playlist. Check that it is public.")
        with self.assertRaises(OSError): radio.seed("nobody", "Song", read=failing)
