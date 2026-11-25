"""Offline catalogue index, fallback, and API compatibility checks."""

import gzip
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from test_music_web import Base
import test_native_music_api as native
from music_web.library_index import LibraryIndex, search_words
from music_web.library_loudness import measurement_path
from music_web.state import write_json


ITEM = re.compile(r'local-[0-9a-f]{16}')
A, B, C, D = (f'local-{number:016x}' for number in range(4))
FIRST, SECOND = native.FIRST, native.SECOND


class LibraryIndexTests(unittest.TestCase):
    def setUp(self):
        root = TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.workspace = Path(root.name)
        self.path = self.workspace / 'library.sqlite3'
        self.overrides = {}
        self.reads = []
        self.index = self.open_index()

    def open_index(self):
        return LibraryIndex(self.path, self.workspace, ITEM, str(self.workspace), lambda folders: [],
                            lambda identifier, deps: self.overrides.get(identifier), self.project)

    def write(self, identifier, title='Árvíztűrő tükörfúrógép'):
        folder = self.workspace / identifier
        folder.mkdir(exist_ok=True)
        (folder / 'manifest.json').write_text(json.dumps(dict(title=title)), encoding='utf-8')

    def remove(self, identifier):
        folder = self.workspace / identifier
        (folder / 'manifest.json').unlink()
        folder.rmdir()

    def project(self, identifier, folders):
        self.reads.append(identifier)
        data = json.loads((self.workspace / folders[0] / 'manifest.json').read_text(encoding='utf-8'))
        row = dict(id=identifier, title=data['title'], channel='Müller', library_album='Őszi esték',
                   genre='Rock', duration=100, saved=True)
        row.update(self.overrides.get(identifier, {}))
        return row, '2026-11-24', 'a' * 64, 'local', self.overrides.get(identifier, {})

    def test_build_and_reopen_without_manifest_reads(self):
        self.write(A)
        self.assertIsNone(self.index.query())
        self.assertTrue(self.index.reconcile())
        self.assertEqual(self.index.candidates(A), [A])
        self.assertEqual(self.index.candidates(B), [])
        self.reads.clear()
        reopened = self.open_index()
        self.assertEqual(reopened.get(A)['id'], A)
        self.assertTrue(reopened.reconcile())
        self.assertEqual(self.reads, [])

    def test_incremental_publication_override_and_delete(self):
        self.assertTrue(self.index.reconcile())
        self.write(A)
        self.index.update({A: [A]})
        self.assertEqual(self.index.get(A)['genre'], 'Rock')
        self.overrides[A] = {'title': 'Edited title', 'genre': 'Jazz'}
        self.index.update({A: ()})
        self.assertEqual(self.index.get(A)['title'], 'Edited title')
        self.assertEqual(self.index.query(words=search_words('arviz')), [])
        self.assertEqual(len(self.index.query(words=search_words('edited'))), 1)
        self.assertEqual(self.index.genres(), [('Jazz', 1)])
        self.remove(A)
        self.index.update({A: ()})
        self.assertEqual(self.index.query(), [])
        self.assertEqual(self.index.genres(), [])

    def test_reconcile_add_remove_and_change(self):
        for identifier in (A, B, C):
            self.write(identifier)
        self.assertTrue(self.index.reconcile())
        self.reads.clear()
        self.remove(A)
        self.write(B, 'New version with a different size')
        self.write(D)
        self.assertTrue(self.index.reconcile())
        self.assertEqual(self.reads, [B, D])
        self.assertEqual([row['id'] for row in self.index.query()], [B, C, D])
        self.assertEqual(self.index.get(B)['title'], 'New version with a different size')

    def test_cancelled_reconcile_uses_fallback_until_complete(self):
        self.write(A)
        self.assertTrue(self.index.reconcile())
        self.write(A, 'Longer title replacing the initial one')
        self.write(B)
        with patch.object(self.index, 'project', wraps=self.project) as project:
            self.assertFalse(self.index.reconcile(lambda: not project.called))
        self.assertIsNone(self.index.query())
        self.assertTrue(self.index.reconcile())
        self.assertEqual(len(self.index.query()), 2)

    def test_accent_insensitive_prefix_search_and_stable_keyset(self):
        for identifier in (C, B, A):
            self.write(identifier)
        self.assertTrue(self.index.reconcile())
        query = dict(words=search_words('arviz Müller oszi'), artist='MÜLLER', album='ŐSZI ESTÉK', genre='rock')
        page = self.index.query(**query, limit=2)
        self.assertEqual([row['id'] for row in page], [A, B])
        self.remove(B)
        self.index.update({B: ()})
        self.write(D)
        self.index.update({D: [D]})
        self.assertEqual([row['id'] for row in self.index.query(**query, after=page[-1]['id'])], [C, D])

    def test_corrupt_file_recovers_and_preserves_manifests(self):
        self.write(A)
        self.path.write_bytes(b'damaged database')
        index = self.open_index()
        self.assertIsNone(index.query())
        self.assertTrue(index.reconcile())
        self.assertEqual(index.get(A)['id'], A)
        self.path.write_bytes(b'damaged again')
        self.assertIsNone(index.query())
        self.assertTrue(index.reconcile())
        self.assertEqual(index.get(A)['id'], A)


class LibraryIndexApiTests(Base):
    extra = {'LIBRARY_INDEX_WORKER': True, 'ADMIN_USERS': ['sample-a']}

    def test_loudness_sidecar_refreshes_catalogue_and_playback_metadata(self):
        item, _, manifest, _ = native.NativeMusicApi.recording(self, FIRST)
        index = self.state.library_index
        index.wake.set()
        deadline = time.monotonic() + 10
        while index.get(FIRST) is None and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertIsNone(index.get(FIRST)['lufs'])
        path = measurement_path(Path(self.ws) / '.library-loudness-v1', manifest['import']['library_sha256'])
        write_json(path, {"lufs": -7.6, "true_peak": 4.0})
        index.update({FIRST: (item.name,)})
        client, _ = self.signed_in()
        results = [self.go(client, 'GET', '/api/library?id=' + FIRST).json['results'][0],
                   self.go(client, 'GET', '/api/library/' + FIRST + '/playback-info?quality=max').json]
        for row in results:
            self.assertEqual((row['lufs'], row['true_peak'], row['over_peak']), (-7.6, 4.0, True))

    def test_index_serves_legacy_rows_and_paged_search_after_review_edit(self):
        native.NativeMusicApi.recording(self, FIRST, 'Árvíztűrő')
        native.NativeMusicApi.recording(self, SECOND, 'Another song')
        index = self.state.library_index
        index.wake.set()
        deadline = time.monotonic() + 10
        while len(index.query() or ()) != 2 and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(len(index.query() or ()), 2)
        client, token = self.signed_in()
        with patch.object(self.intake, 'read_manifest', side_effect=AssertionError('unexpected scan')):
            response = self.go(client, 'GET', '/api/library')
            self.assertEqual(set(response.json), {'results'})
            self.assertEqual(set(row['id'] for row in response.json['results']), {FIRST, SECOND})
            conditional = self.go(client, 'GET', '/api/library', headers={'If-None-Match': response.headers['ETag']})
            self.assertEqual(conditional.status_code, 304)
            compressed = self.go(client, 'GET', '/api/library', headers={'Accept-Encoding': 'gzip'})
            self.assertEqual(compressed.headers['Content-Encoding'], 'gzip')
            self.assertEqual(json.loads(gzip.decompress(compressed.data)), response.json)
            page = self.go(client, 'GET', '/api/library?limit=1&genre_filters=1').json
            self.assertEqual(page['next_after'], SECOND)
            self.assertEqual(page['genre_keys'], {'Unsorted': 'unsorted'})
            following = self.go(client, 'GET', '/api/library?limit=1&after=' + SECOND).json
            self.assertEqual(following['results'][0]['id'], FIRST)
            self.assertIsNone(following['next_after'])
            search = self.go(client, 'GET', '/api/library?q=arviz&limit=1').json
            self.assertEqual(search['results'][0]['id'], FIRST)
        review = self.go(client, 'GET', '/api/catalogue/review').json
        row = next(entry for entry in review['metadata'] if entry['id'] == FIRST)
        updated = self.go(client, 'PATCH', '/api/catalogue/metadata/' + FIRST,
                          headers={'X-CSRFToken': token}, json=dict(revision=row['revision'], values={'genre': 'Jazz'}))
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(self.go(client, 'GET', '/api/library?genre=jazz').json['results'][0]['id'], FIRST)
