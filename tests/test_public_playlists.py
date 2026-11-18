import copy
import tempfile
import unittest

from music_web.public_playlists import read_pages
from music_web.playlists import PlaylistError, PlaylistStore, rank_matches

PID = '6CCDIMytDCox2aDcNi1ztu'


def row(index):
    return {'itemV2': {'data': {'__typename': 'Track', 'name': f'Track {index}',
            'uri': f'spotify:track:{index}', 'artists': {'items': [{'profile': {'name': 'Artist'}}]},
            'trackDuration': {'totalMilliseconds': 123000}}}}


def page(rows, total, offset, revision='revision'):
    return {'data': {'playlistV2': {'uri': 'spotify:playlist:' + PID, 'name': 'Test',
            'revisionId': revision, 'content': {'items': rows, 'totalCount': total,
                                             'pagingInfo': {'offset': offset}}}}}


class PublicPlaylists(unittest.TestCase):
    def reader(self, rows, size=100):
        calls = []
        def fetch(offset):
            calls.append(offset)
            return page(rows[offset:offset + size], len(rows), offset)
        return read_pages(PID, fetch), calls

    def test_sizes_order_duplicates_and_short_pages(self):
        for count in (0, 1, 14, 100, 101, 549, 1001):
            with self.subTest(count=count):
                rows = [row(i % 103) for i in range(count)]
                result, calls = self.reader(rows, 37)
                self.assertEqual([t['spotify_uri'] for t in result['tracks']],
                                 [r['itemV2']['data']['uri'] for r in rows])
                self.assertEqual(calls, (list(range(0, count, 37)) or [0]) + [0])
                self.assertEqual(result['source']['total'], count)

    def test_local_without_artist_keeps_position_and_format(self):
        local = {'itemV2': {'data': {'__typename': 'LocalTrack', 'name': 'Local title',
                 'uri': 'spotify:local:::Local+title:123', 'artistName': '',
                 'localTrackDuration': {'totalMilliseconds': 123000}}}}
        result, _ = self.reader([row(1), local, row(1)])
        track = result['tracks'][1]
        self.assertEqual(track['artist'], '')
        self.assertEqual(set(track), set(result['tracks'][0]))
        candidate = {'title': 'Local title', 'channel': 'Uploader', 'duration': 123}
        self.assertFalse(rank_matches(track, [candidate])[0]['recommended'])

    def test_rejects_empty_early_page(self):
        with self.assertRaisesRegex(PlaylistError, 'incomplete'):
            read_pages(PID, lambda offset: page([row(0)] if offset == 0 else [], 2, offset))

    def test_rejects_wrong_offset_identity_count_revision_and_errors(self):
        for change in ('offset', 'uri', 'total', 'revision', 'errors'):
            def fetch(offset):
                result = page([row(offset)], 2, offset)
                if offset:
                    playlist = result['data']['playlistV2']
                    if change == 'offset': playlist['content']['pagingInfo']['offset'] = 0
                    if change == 'uri': playlist['uri'] = 'spotify:playlist:other'
                    if change == 'total': playlist['content']['totalCount'] = 3
                    if change == 'revision': playlist['revisionId'] = 'changed'
                    if change == 'errors': result['errors'] = [{'message': 'failed'}]
                return result
            with self.subTest(change=change), self.assertRaises(PlaylistError):
                read_pages(PID, fetch)

    def test_final_revision_check(self):
        responses = iter([page([row(0)], 1, 0), page([row(0)], 1, 0, 'changed')])
        with self.assertRaisesRegex(PlaylistError, 'changed'):
            read_pages(PID, lambda offset: next(responses))

    def test_unavailable_is_not_silently_dropped(self):
        with self.assertRaisesRegex(PlaylistError, 'entry 2'):
            self.reader([row(0), {'itemV2': {'data': None}}, row(2)])

    def test_page_error_propagates(self):
        def fetch(offset):
            if offset: raise PlaylistError('HTTP 429')
            return page([row(0)], 2, 0)
        with self.assertRaisesRegex(PlaylistError, '429'):
            read_pages(PID, fetch)

    def test_reimport_refreshes_order_and_keeps_a_repeated_song_once(self):
        with tempfile.TemporaryDirectory() as folder:
            store = PlaylistStore(folder)
            old, _ = self.reader([row(1), row(1)])
            old['tracks'][0].update(state='saved', job_id='first')
            old['tracks'][1].update(state='ready', job_id='second')
            store.save('user', old)
            fresh, _ = self.reader([row(2), row(1), row(1), row(3)])
            result = store.import_playlist('user', copy.deepcopy(fresh))
            self.assertEqual([t['title'] for t in result['tracks']], ['Track 2', 'Track 1', 'Track 3'])
            self.assertEqual([t['state'] for t in result['tracks']], ['unmatched', 'saved', 'unmatched'])
            self.assertEqual(result['tracks'][1]['job_id'], 'first')
            self.assertEqual(store.read('user', PID), result)
            self.assertEqual(store.list('other'), [])


if __name__ == '__main__':
    unittest.main()
