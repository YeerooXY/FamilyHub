"""Family file sharing: private and shared folders, uploads, and one-off share links."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import io
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from test_music_web import Base, PROFILE_HASH


class PausedUpload(io.RawIOBase):
    def __init__(self, data):
        self.body = io.BytesIO(data)
        self.reading = threading.Event()
        self.resume = threading.Event()

    def readinto(self, target):
        self.reading.set()
        if not self.resume.wait(5):
            raise TimeoutError('The test did not release the upload stream.')
        return self.body.readinto(target)


class FileBase(Base):
    files_extra = {}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.files_root = os.path.join(tmp.name, 'files')
        self.extra = {'FAMILY_PROFILES': True, 'FILES_ROOT': self.files_root, 'FILES_FREE_RESERVE': 0,
                      'ADMIN_USERS': ['sample-b'], 'PROFILE_PASSWORD_HASHES': dict.fromkeys(('sample-a', 'sample-b'), PROFILE_HASH),
                      **self.files_extra}
        super().setUp()
        store = self.app.extensions.get('files')
        if store:
            self.addCleanup(store.db.close)
        self.a, self.ta = self.select('sample-a')
        self.b, self.tb = self.select('sample-b')

    def select(self, name):
        client = self.app.test_client()
        bootstrap = self.go(client, 'GET', '/api/connect').json
        reply = self.post(client, bootstrap['csrf_token'], '/api/profile/select', json=self.profile_credentials(name))
        return client, reply.json['csrf_token']

    def call(self, client, token, method, path, **kw):
        kw.setdefault('headers', {})['X-CSRFToken'] = token
        return self.go(client, method, path, **kw)

    def upload(self, who, space, name, data=b'hello', folder='', **kw):
        client, token = (self.a, self.ta) if who == 'a' else (self.b, self.tb)
        return self.call(client, token, 'PUT', f'/api/files/upload?space={space}&path={folder}&name={name}', data=data, **kw)

    @contextmanager
    def paused_upload(self, space, name, data, folder=''):
        stream = PausedUpload(data)
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(self.upload, 'a', space, name, data, folder, environ_overrides={'wsgi.input': stream})
            try:
                self.assertTrue(stream.reading.wait(5), 'The upload did not start reading.')
                yield result, stream.resume
            finally:
                stream.resume.set()

    def names(self, client, space, path=''):
        return [e['name'] for e in self.go(client, 'GET', f'/api/files/list?space={space}&path={path}').json['entries']]


class FileSharing(FileBase):
    def test_shared_folder_rename_keeps_ownership_and_retires_old_links(self):
        self.call(self.a, self.ta, 'POST', '/api/files/folder', json={'space': 'family', 'name': 'Shared'})
        self.assertEqual(self.upload('b', 'family', 'owned.txt', folder='Shared').status_code, 201)
        link = self.call(self.a, self.ta, 'POST', '/api/files/links', json={
            'space': 'family', 'path': 'Shared/owned.txt', 'expires_hours': 1}).json
        delete = '/api/files?space=family&path=Shared&recursive=true'
        self.assertEqual(self.call(self.a, self.ta, 'DELETE', delete).status_code, 403)
        rename = self.call(self.a, self.ta, 'POST', '/api/files/rename', json={
            'space': 'family', 'path': 'Shared', 'name': 'Moved'})
        self.assertEqual(rename.status_code, 200)
        self.assertEqual(self.call(self.a, self.ta, 'DELETE', '/api/files?space=family&path=Moved/owned.txt').status_code, 403)
        self.assertEqual(self.go(self.app.test_client(), 'GET', link['url']).status_code, 404)

    def test_private_space_rejects_linked_profile_root(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        try:
            os.symlink(outside.name, os.path.join(self.files_root, 'profiles', 'sample-a'), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('Symlinks are unavailable')
        self.assertEqual(self.go(self.a, 'GET', '/api/files/list?space=mine').status_code, 404)

    def test_folders_upload_download_and_name_clashes(self):
        reply = self.call(self.a, self.ta, 'POST', '/api/files/folder', json={'space': 'mine', 'path': '', 'name': 'Trips'})
        self.assertEqual(reply.status_code, 201)
        self.assertEqual(self.upload('a', 'mine', 'plan.txt', b'one', 'Trips').json['name'], 'plan.txt')
        self.assertEqual(self.upload('a', 'mine', 'plan.txt', b'two', 'Trips').json['name'], 'plan (2).txt')
        self.assertEqual(self.names(self.a, 'mine', 'Trips'), ['plan (2).txt', 'plan.txt'])
        got = self.go(self.a, 'GET', '/api/files/download?space=mine&path=Trips/plan.txt')
        self.assertEqual((got.status_code, got.data), (200, b'one'))
        self.assertIn('attachment', got.headers['Content-Disposition'])
        self.assertEqual(got.headers['Content-Type'], 'application/octet-stream')
        self.assertEqual(got.headers['X-Content-Type-Options'], 'nosniff')
        part = self.go(self.a, 'GET', '/api/files/download?space=mine&path=Trips/plan.txt', headers={'Range': 'bytes=1-2'})
        self.assertEqual((part.status_code, part.data), (206, b'ne'))

    def test_overlapping_uploads_keep_both_same_name_files(self):
        with self.paused_upload('family', 'plan.txt', b'first') as (first, resume):
            second = self.upload('b', 'family', 'plan.txt', b'second')
            self.assertEqual((second.status_code, second.json['name']), (201, 'plan.txt'))
            resume.set()
            reply = first.result(timeout=5)
            self.assertEqual((reply.status_code, reply.json['name']), (201, 'plan (2).txt'))
        for name, data, owner in (('plan.txt', b'second', 'sample-b'), ('plan (2).txt', b'first', 'sample-a')):
            reply = self.go(self.a, 'GET', f'/api/files/download?space=family&path={name}')
            self.assertEqual((reply.status_code, reply.data), (200, data))
            self.assertEqual(self.app.extensions['files'].owner('family', [name]), owner)

    def test_destination_changes_reject_an_upload_to_a_replacement(self):
        for change in ('rename', 'delete'):
            with self.subTest(change=change):
                folder = f'{change}/Nested'
                self.assertEqual(self.call(self.b, self.tb, 'POST', '/api/files/folder',
                                           json={'space': 'family', 'path': '', 'name': change}).status_code, 201)
                self.assertEqual(self.call(self.b, self.tb, 'POST', '/api/files/folder',
                                           json={'space': 'family', 'path': change, 'name': 'Nested'}).status_code, 201)
                with self.paused_upload('family', 'plan.txt', b'first', folder) as (first, resume):
                    if change == 'rename':
                        reply = self.call(self.b, self.tb, 'POST', '/api/files/rename',
                                          json={'space': 'family', 'path': change, 'name': 'Moved'})
                        self.assertEqual(reply.status_code, 200)
                    else:
                        reply = self.call(self.b, self.tb, 'DELETE', f'/api/files?space=family&path={change}&recursive=true')
                        self.assertEqual(reply.status_code, 204)
                    self.assertEqual(self.call(self.b, self.tb, 'POST', '/api/files/folder',
                                               json={'space': 'family', 'path': '', 'name': change}).status_code, 201)
                    self.assertEqual(self.call(self.b, self.tb, 'POST', '/api/files/folder',
                                               json={'space': 'family', 'path': change, 'name': 'Nested'}).status_code, 201)
                    resume.set()
                    reply = first.result(timeout=5)
                    self.assertEqual(reply.status_code, 409)
                    self.assertIn('upload again', reply.json['error'])
                self.assertEqual(self.names(self.a, 'family', folder), [])
                self.assertEqual(os.listdir(os.path.join(self.files_root, '.uploading')), [])
        self.assertEqual(self.names(self.a, 'family', 'Moved/Nested'), [])

    def test_private_files_stay_private_and_family_files_are_shared(self):
        self.upload('a', 'mine', 'diary.txt')
        self.assertEqual(self.names(self.b, 'mine'), [])
        self.assertEqual(self.go(self.b, 'GET', '/api/files/download?space=mine&path=diary.txt').status_code, 404)
        self.upload('a', 'family', 'photo.jpg')
        self.assertEqual(self.names(self.b, 'family'), ['photo.jpg'])

    def test_shared_folder_changes_need_the_uploader_or_an_administrator(self):
        self.upload('b', 'family', 'b-note.txt')
        self.upload('a', 'family', 'a-note.txt')
        self.assertEqual(self.call(self.a, self.ta, 'DELETE', '/api/files?space=family&path=b-note.txt').status_code, 403)
        self.assertEqual(self.call(self.a, self.ta, 'POST', '/api/files/rename', json={'space': 'family', 'path': 'b-note.txt', 'name': 'x.txt'}).status_code, 403)
        self.assertEqual(self.call(self.a, self.ta, 'DELETE', '/api/files?space=family&path=a-note.txt').status_code, 204)
        self.upload('a', 'family', 'again.txt')
        self.assertEqual(self.call(self.b, self.tb, 'DELETE', '/api/files?space=family&path=again.txt').status_code, 204)

    def test_paths_and_names_cannot_leave_the_space(self):
        for path in ('..', '../x', 'a/../../x', '/etc', 'a%5Cb', '.hidden', 'a/..'):
            reply = self.go(self.a, 'GET', '/api/files/list?space=mine&path=' + path)
            self.assertIn(reply.status_code, (400, 404), path)
        for name in ('..%2Fevil', 'a%2Fb', '.dot', 'a%3Ab', '', 'x' * 121, 'q%3F'):
            self.assertEqual(self.upload('a', 'mine', name).status_code, 400, name)
        self.assertEqual(self.go(self.a, 'GET', '/api/files/list?space=other').status_code, 400)
        self.assertEqual(os.listdir(os.path.join(self.files_root, 'profiles', 'sample-a')), [])

    def test_symbolic_links_are_refused(self):
        folder = os.path.join(self.files_root, 'profiles', 'sample-a')
        os.makedirs(folder, exist_ok=True)
        outside = os.path.join(os.path.dirname(self.files_root), 'secret.txt')
        with open(outside, 'w') as handle:
            handle.write('secret')
        try:
            os.symlink(outside, os.path.join(folder, 'link.txt'))
        except (OSError, NotImplementedError):
            self.skipTest('symbolic links are not available here')
        self.assertEqual(self.names(self.a, 'mine'), [])
        self.assertEqual(self.go(self.a, 'GET', '/api/files/download?space=mine&path=link.txt').status_code, 404)

    def test_empty_upload_and_no_leftovers(self):
        self.assertEqual(self.upload('a', 'mine', 'empty.txt', b'').status_code, 400)
        self.upload('a', 'mine', 'ok.txt')
        self.assertEqual(os.listdir(os.path.join(self.files_root, '.uploading')), [])

    def test_link_lifecycle_one_off(self):
        self.upload('a', 'mine', 'report.pdf', b'PDFDATA')
        made = self.call(self.a, self.ta, 'POST', '/api/files/links', json={'space': 'mine', 'path': 'report.pdf', 'expires_hours': 24, 'max_downloads': 1}).json
        url = made['url']
        self.assertNotIn('report', url)
        stranger = self.app.test_client()
        page = self.go(stranger, 'GET', url)
        self.assertEqual(page.status_code, 200)
        self.assertIn('report.pdf', page.get_data(as_text=True))
        self.assertEqual(page.headers['Referrer-Policy'], 'strict-origin')
        self.assertEqual(self.go(stranger, 'HEAD', url + '/download').status_code, 200)
        self.assertEqual(self.go(stranger, 'GET', url).status_code, 200)  # previews and reloads do not use the link
        first = self.go(stranger, 'GET', url + '/download')
        self.assertEqual((first.status_code, first.data), (200, b'PDFDATA'))
        self.assertIn('attachment', first.headers['Content-Disposition'])
        self.assertEqual(self.go(stranger, 'GET', url + '/download').status_code, 404)
        self.assertEqual(self.go(stranger, 'GET', url).status_code, 404)
        db = sqlite3.connect(os.path.join(self.files_root, '.familyhub-files.db'))
        self.addCleanup(db.close)
        stored = ' '.join(str(v) for row in db.execute('SELECT * FROM links') for v in row)
        self.assertNotIn(url.rsplit('/', 1)[-1], stored)

    def test_password_links(self):
        self.upload('a', 'mine', 'secret.txt', b'TOPSECRET')
        url = self.call(self.a, self.ta, 'POST', '/api/files/links', json={'space': 'mine', 'path': 'secret.txt', 'expires_hours': 24, 'password': 'pa55word'}).json['url']
        stranger = self.app.test_client()
        self.assertIn('type="password"', self.go(stranger, 'GET', url).get_data(as_text=True))
        early = self.go(stranger, 'GET', url + '/download')
        self.assertNotIn(b'TOPSECRET', early.data)
        self.assertEqual(self.go(stranger, 'POST', url + '/download', data={'password': 'nope'}).status_code, 403)
        ok = self.go(stranger, 'POST', url + '/download', data={'password': 'pa55word'})
        self.assertEqual((ok.status_code, ok.data), (200, b'TOPSECRET'))

    def test_expiry_revoking_and_deleting_end_a_link(self):
        for name in ('x.txt', 'y.txt', 'z.txt'):
            self.upload('a', 'mine', name, b'data')
        make = lambda name: self.call(self.a, self.ta, 'POST', '/api/files/links', json={'space': 'mine', 'path': name, 'expires_hours': 1}).json
        x, y, z = make('x.txt'), make('y.txt'), make('z.txt')
        stranger = self.app.test_client()
        db = sqlite3.connect(os.path.join(self.files_root, '.familyhub-files.db'))
        self.addCleanup(db.close)
        db.execute('UPDATE links SET expires = ? WHERE id = ?', (time.time() - 5, x['id']))
        db.commit()
        self.assertEqual(self.go(stranger, 'GET', x['url']).status_code, 404)
        self.assertEqual(self.call(self.a, self.ta, 'DELETE', '/api/files/links/' + y['id']).status_code, 204)
        self.assertEqual(self.go(stranger, 'GET', y['url']).status_code, 404)
        self.assertEqual(self.go(stranger, 'GET', z['url']).status_code, 200)
        self.call(self.a, self.ta, 'DELETE', '/api/files?space=mine&path=z.txt')
        self.assertEqual(self.go(stranger, 'GET', z['url']).status_code, 404)
        listed = self.go(self.a, 'GET', '/api/files/links').json['links']
        self.assertEqual({item['name']: item['active'] for item in listed}, {'x.txt': False, 'y.txt': False, 'z.txt': False})
        self.assertNotIn('url', listed[0])
        self.assertEqual(self.go(self.b, 'GET', '/api/files/links').json['links'], [])

    def test_links_need_a_real_file_and_sane_options(self):
        self.call(self.a, self.ta, 'POST', '/api/files/folder', json={'space': 'mine', 'path': '', 'name': 'Dir'})
        self.upload('a', 'mine', 'f.txt')
        make = lambda path='f.txt', **extra: self.call(self.a, self.ta, 'POST', '/api/files/links', json={'space': 'mine', 'path': path, 'expires_hours': 24, **extra}).status_code
        self.assertEqual(make('Dir'), 400)
        self.assertEqual(make('nope.txt'), 404)
        self.assertEqual(make(expires_hours=99999), 400)
        self.assertEqual(make(max_downloads=0), 400)
        self.assertEqual(make(password='abc'), 400)
        self.assertEqual(make(), 201)

    def test_bad_secrets_all_look_the_same(self):
        stranger = self.app.test_client()
        for url in ('/api/share/short', '/api/share/' + 'A' * 43, '/api/share/' + '-' * 30):
            self.assertEqual(self.go(stranger, 'GET', url).status_code, 404)

    def test_the_server_stays_closed_to_strangers_outside_share_links(self):
        stranger = self.app.test_client()
        self.assertEqual(self.go(stranger, 'GET', '/api/files/list?space=family').status_code, 401)


class FileLimits(FileBase):
    files_extra = {'FILES_MAX_UPLOAD': 10, 'FILES_QUOTA': 25}

    def test_size_and_quota_limits(self):
        self.assertEqual(self.upload('a', 'mine', 'big.bin', b'x' * 11).status_code, 413)
        self.assertEqual(self.upload('a', 'mine', 'a.bin', b'x' * 10).status_code, 201)
        self.assertEqual(self.upload('a', 'mine', 'b.bin', b'x' * 10).status_code, 201)
        self.assertEqual(self.upload('a', 'mine', 'c.bin', b'x' * 10).status_code, 507)
        self.assertEqual(self.upload('b', 'mine', 'a.bin', b'x' * 10).status_code, 201)

    def test_overlapping_uploads_reserve_the_shared_quota(self):
        self.assertEqual(self.upload('a', 'family', 'existing.bin', b'x' * 10).status_code, 201)
        with self.paused_upload('family', 'first.bin', b'x' * 10) as (first, resume):
            self.assertEqual(self.upload('b', 'family', 'second.bin', b'x' * 10).status_code, 507)
            self.assertEqual(self.upload('b', 'mine', 'second.bin', b'x' * 10).status_code, 201)
            resume.set()
            self.assertEqual(first.result(timeout=5).status_code, 201)
        self.assertEqual(self.upload('b', 'family', 'second.bin', b'x' * 5).status_code, 201)
        self.assertEqual(self.names(self.a, 'family'), ['existing.bin', 'first.bin', 'second.bin'])


class FileReserve(FileBase):
    files_extra = {'FILES_FREE_RESERVE': 1 << 60}

    def test_a_nearly_full_disk_refuses_uploads(self):
        self.assertEqual(self.upload('a', 'mine', 'a.bin').status_code, 507)


class ConcurrentFileReserve(FileBase):
    files_extra = {'FILES_FREE_RESERVE': 1}

    def test_finished_staging_uses_disk_space_once(self):
        store = self.app.extensions['files']
        staged, publish = threading.Event(), threading.Event()
        staging = os.path.join(self.files_root, '.uploading')

        @contextmanager
        def pause_before_publish(path, mode):
            with open(path, mode) as handle:
                yield handle
            if threading.current_thread() is not threading.main_thread():
                staged.set()
                if not publish.wait(5):
                    raise TimeoutError('The test did not release the staged upload.')

        def free_bytes():
            folders = (staging, store.base('family', 'sample-a'), store.base('mine', 'sample-b'))
            used = sum(os.path.getsize(os.path.join(folder, name)) for folder in folders
                       if os.path.isdir(folder) for name in os.listdir(folder))
            return 13 - used

        with patch.object(store, 'free_bytes', side_effect=free_bytes), patch('music_web.files.open', pause_before_publish, create=True):
            with self.paused_upload('family', 'first.bin', b'x' * 6) as (first, resume):
                try:
                    self.assertEqual(self.upload('b', 'mine', 'second.bin', b'x' * 7).status_code, 507)
                    resume.set()
                    self.assertTrue(staged.wait(5), 'The first file was not staged.')
                    self.assertEqual(self.upload('b', 'mine', 'second.bin', b'x' * 6).status_code, 201)
                finally:
                    publish.set()
                self.assertEqual(first.result(timeout=5).status_code, 201)
        self.assertEqual(os.listdir(staging), [])


class FilesDisabled(Base):
    extra = {'FAMILY_PROFILES': True}

    def test_without_a_files_root_the_endpoints_say_so(self):
        client = self.app.test_client()
        bootstrap = self.go(client, 'GET', '/api/connect').json
        self.post(client, bootstrap['csrf_token'], '/api/profile/select', json={'profile_id': 'sample-a'})
        self.assertEqual(self.go(client, 'GET', '/api/files/list?space=mine').status_code, 503)
        self.assertEqual(self.go(client, 'GET', '/api/share/' + 'A' * 43).status_code, 404)


if __name__ == '__main__':
    unittest.main()
