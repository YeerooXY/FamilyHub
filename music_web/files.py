"""Family file sharing: a shared folder, a private folder per profile, and one-off share links.

Files live on disk under FILES_ROOT (`family/` and `profiles/<id>/`). Share links keep only a hash of the secret in a small
SQLite database next to the files. A link serves one file as a forced download; the landing page does not count a download,
so a chat app's link preview cannot use up a one-off link. File and folder names are never written to the activity log.
"""
import hashlib
import hmac
import html
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time

from flask import Response, g, jsonify, request, send_file
from werkzeug.security import check_password_hash, generate_password_hash

SPACES = ('family', 'mine')
BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
MAX_NAME, MAX_DEPTH, CHUNK = 120, 12, 1 << 20
EXPIRY_HOURS = (1, 24, 24 * 7, 24 * 30)
GIB = 1 << 30


class FileError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def clean_name(value):
    """One file or folder name: no separators, controls, leading dots or Windows-reserved characters."""
    if not isinstance(value, str):
        raise FileError('Give the item a name.')
    name = value.strip().rstrip('. ')
    if not name or len(name) > MAX_NAME or name.startswith('.') or BAD_NAME.search(name):
        raise FileError('Names need 1 to %d characters and cannot contain / \\ : * ? " < > | or start with a dot.' % MAX_NAME)
    return name


def clean_path(value):
    """A relative path inside a space, as a list of safe names. The empty path is the space itself."""
    if value in (None, '', '/'):
        return []
    if not isinstance(value, str) or len(value) > 2000:
        raise FileError('That folder is not valid.')
    parts = [p for p in value.split('/') if p != '']
    if len(parts) > MAX_DEPTH:
        raise FileError('That folder is nested too deeply.')
    return [clean_name(p) for p in parts]


def unique_name(folder, name):
    """name, or "name (2).ext" when taken."""
    if not os.path.lexists(os.path.join(folder, name)):
        return name
    stem, dot, ext = name.rpartition('.') if '.' in name.strip('.') else (name, '', '')
    for number in range(2, 1000):
        candidate = f'{stem} ({number}){dot}{ext}'
        if not os.path.lexists(os.path.join(folder, candidate)):
            return candidate
    raise FileError('Too many files share that name.', 409)


def like_escape(text):
    """Escape for a LIKE pattern that declares ESCAPE '!'."""
    return text.replace('!', '!!').replace('%', '!%').replace('_', '!_')


def tree_size(folder, budget=5.0):
    """Bytes under a folder. Stops counting after `budget` seconds so a huge tree cannot stall a request."""
    total, stop = 0, time.monotonic() + budget
    for base, dirs, names in os.walk(folder):
        for name in names:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
        if time.monotonic() > stop:
            break
    return total


class Store:
    """Folders on disk plus the link table. One instance per server."""

    def __init__(self, root, cfg):
        self.root = os.path.realpath(root)
        self.max_upload = int(cfg.get('FILES_MAX_UPLOAD', 500 * GIB))
        self.quota = int(cfg.get('FILES_QUOTA', 0))  # 0: no limit per folder
        self.reserve = int(cfg.get('FILES_FREE_RESERVE', 20 * GIB))
        self.max_link_days = int(cfg.get('FILES_LINK_MAX_DAYS', 30))
        self.public_url = (cfg.get('FILES_PUBLIC_URL') or '').rstrip('/')
        for sub in ('family', 'profiles', '.uploading'):
            os.makedirs(os.path.join(self.root, sub), exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(os.path.join(self.root, '.familyhub-files.db'), check_same_thread=False, isolation_level=None)
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS owners (space TEXT NOT NULL, path TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY (space, path));
            CREATE TABLE IF NOT EXISTS links (
                id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, space TEXT NOT NULL, path TEXT NOT NULL,
                created REAL NOT NULL, expires REAL NOT NULL, max_downloads INTEGER, downloads INTEGER NOT NULL DEFAULT 0,
                password_hash TEXT, revoked INTEGER NOT NULL DEFAULT 0);''')
        for leftover in os.listdir(os.path.join(self.root, '.uploading')):
            os.unlink(os.path.join(self.root, '.uploading', leftover))

    # ---- paths ----
    def base(self, space, user):
        if space == 'family':
            return os.path.join(self.root, 'family')
        if space == 'mine':
            if not re.fullmatch(r'[A-Za-z0-9_.@-]{1,80}', user or ''):
                raise FileError('Sign in again to use your files.', 401)
            return os.path.join(self.root, 'profiles', user)
        raise FileError('Unknown space.')

    def resolve(self, space, user, parts, must_exist=True):
        """Absolute path for a validated list of names. Symbolic links anywhere inside are refused."""
        base = self.base(space, user)
        os.makedirs(base, exist_ok=True)
        path = base
        for part in parts:
            path = os.path.join(path, part)
            if os.path.islink(path):
                raise FileError('That item is not available.', 404)
        if must_exist and not os.path.lexists(path):
            raise FileError('That item no longer exists.', 404)
        real = os.path.realpath(path)
        if os.path.commonpath([real, os.path.realpath(base)]) != os.path.realpath(base):
            raise FileError('That item is not available.', 404)
        return path

    # ---- owners (shared folder only) ----
    def set_owner(self, space, parts, user):
        if space == 'family':
            self.db.execute('INSERT OR REPLACE INTO owners VALUES (?,?,?)', ('family', '/'.join(parts), user))

    def owner(self, space, parts):
        if space != 'family':
            return None
        row = self.db.execute('SELECT owner FROM owners WHERE space=? AND path=?', ('family', '/'.join(parts))).fetchone()
        return row[0] if row else None

    def drop_owners(self, space, parts):
        prefix = '/'.join(parts)
        self.db.execute("DELETE FROM owners WHERE space=? AND (path=? OR path LIKE ? ESCAPE '!')",
                        (space, prefix, like_escape(prefix) + '/%'))

    def may_change(self, space, parts, user, admin):
        """Private files belong to their profile. In the shared folder the uploader or an administrator may change an item."""
        if space == 'mine' or admin:
            return True
        return self.owner(space, parts) in (None, user)

    # ---- space accounting ----
    def free_bytes(self):
        return shutil.disk_usage(self.root).free

    def check_room(self, space, user, incoming):
        if incoming > self.max_upload:
            raise FileError('Files can be up to %d GB.' % (self.max_upload // GIB), 413)
        if self.free_bytes() - incoming < self.reserve:
            raise FileError('The server is nearly out of disk space. Ask the administrator.', 507)
        if self.quota and tree_size(self.base(space, user)) + incoming > self.quota:
            raise FileError('This folder is full (%d GB limit).' % (self.quota // GIB), 507)

    # ---- links ----
    def create_link(self, owner, space, parts, hours, password, max_downloads):
        if hours not in EXPIRY_HOURS or hours > self.max_link_days * 24:
            raise FileError('Choose how long the link works.')
        if max_downloads is not None and (type(max_downloads) is not int or not 1 <= max_downloads <= 1000):
            raise FileError('The download limit is 1 to 1000.')
        if password is not None and (not isinstance(password, str) or not 4 <= len(password) <= 200):
            raise FileError('The password needs 4 to 200 characters.')
        target = self.resolve(space, owner, parts)
        if not os.path.isfile(target):
            raise FileError('Only files can be shared by link.')
        secret = secrets.token_urlsafe(32)
        link_id = secrets.token_hex(8)
        now = time.time()
        self.db.execute('INSERT INTO links (id, secret_hash, owner, space, path, created, expires, max_downloads, password_hash) VALUES (?,?,?,?,?,?,?,?,?)',
                        (link_id, hashlib.sha256(secret.encode()).hexdigest(), owner, space, '/'.join(parts), now, now + hours * 3600,
                         max_downloads, generate_password_hash(password) if password else None))
        return link_id, secret, now + hours * 3600

    def find_link(self, secret):
        """The live link for a secret, or None. A secret is never compared as text: only its hash is looked up."""
        row = self.db.execute('SELECT id, owner, space, path, expires, max_downloads, downloads, password_hash, revoked FROM links WHERE secret_hash=?',
                              (hashlib.sha256(str(secret).encode()).hexdigest(),)).fetchone()
        if not row or row[8] or row[4] < time.time() or (row[5] is not None and row[6] >= row[5]):
            return None
        return dict(id=row[0], owner=row[1], space=row[2], parts=[p for p in row[3].split('/') if p], expires=row[4], password_hash=row[7])

    def use_link(self, link_id):
        """Count one download if the limit allows it; False when the link has just run out."""
        with self.lock:
            cursor = self.db.execute('UPDATE links SET downloads = downloads + 1 WHERE id=? AND revoked=0 AND (max_downloads IS NULL OR downloads < max_downloads)', (link_id,))
            return cursor.rowcount == 1

    def my_links(self, owner):
        now = time.time()
        rows = self.db.execute('SELECT id, space, path, created, expires, max_downloads, downloads, password_hash IS NOT NULL, revoked FROM links WHERE owner=? ORDER BY created DESC LIMIT 200', (owner,)).fetchall()
        return [dict(id=r[0], space=r[1], path=r[2], name=r[2].rsplit('/', 1)[-1], created=r[3], expires=r[4], max_downloads=r[5], downloads=r[6],
                     protected=bool(r[7]), active=not r[8] and r[4] > now and (r[5] is None or r[6] < r[5])) for r in rows]

    def revoke(self, owner, link_id, admin):
        cursor = self.db.execute('UPDATE links SET revoked=1 WHERE id=? AND (owner=? OR ?)', (link_id, owner, 1 if admin else 0))
        return cursor.rowcount == 1

    def revoke_path(self, space, user, parts):
        """Withdraw every link to a deleted file or to anything inside a deleted folder."""
        path = '/'.join(parts)
        escaped = like_escape(path)
        sql = "UPDATE links SET revoked=1 WHERE space=? AND (path=? OR path LIKE ? ESCAPE '!')"
        arguments = [space, path, escaped + '/%']
        if space == 'mine':
            sql += ' AND owner=?'
            arguments.append(user)
        self.db.execute(sql, arguments)

    def purge_expired(self):
        self.db.execute('DELETE FROM links WHERE expires < ?', (time.time() - 30 * 86400,))


def landing(name, size, expires, secret, protected, error=''):
    """Plain HTML for the person who opens a link. Styled by a same-origin file because the server's CSP blocks inline styles."""
    form = ('<form method="post" action="/api/share/%s/download"><label>Password <input type="password" name="password" autocomplete="off" required></label>'
            '<button type="submit">Download</button></form>' % secret if protected else
            '<p><a class="button" href="/api/share/%s/download">Download</a></p>' % secret)
    message = '<p role="alert" class="error">%s</p>' % html.escape(error) if error else ''
    megabytes = size / (1 << 20)
    shown = f'{megabytes:.1f} MB' if megabytes >= 1 else f'{max(1, size // 1024)} KB'
    until = time.strftime('%d %B %Y, %H:%M UTC', time.gmtime(expires))
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="robots" content="noindex"><title>A file shared with you</title><link rel="stylesheet" href="/static/share.css"></head>'
            '<body><main><h1>%s</h1><p>%s. The link works until %s.</p>%s%s</main></body></html>' % (html.escape(name), shown, until, message, form))


def register_files(app, cfg, allow, is_admin, csrf_exempt):
    root = cfg.get('FILES_ROOT')
    store = Store(root, cfg) if root else None

    def guard():
        if store is None:
            return jsonify(error='File sharing is not set up on this server.'), 503
        return None

    def fail(error):
        return jsonify(error=str(error)), error.status

    def space_and_parts(data):
        space = data.get('space')
        if space not in SPACES:
            raise FileError('Choose family files or your files.')
        return space, clean_path(data.get('path'))

    def listing(space, parts):
        folder = store.resolve(space, g.user, parts)
        if not os.path.isdir(folder):
            raise FileError('That is not a folder.')
        entries = []
        for entry in sorted(os.scandir(folder), key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.casefold())):
            if entry.name.startswith('.') or entry.is_symlink():
                continue
            info = entry.stat(follow_symlinks=False)
            entries.append(dict(name=entry.name, type='dir' if entry.is_dir(follow_symlinks=False) else 'file',
                                size=0 if entry.is_dir(follow_symlinks=False) else info.st_size, modified=info.st_mtime,
                                owner=store.owner(space, parts + [entry.name])))
        return entries

    @app.get('/api/files/list')
    def files_list():
        if (unavailable := guard()):
            return unavailable
        try:
            space, parts = space_and_parts(request.args)
            return jsonify(space=space, path='/'.join(parts), entries=listing(space, parts), free_bytes=store.free_bytes(),
                           max_upload=store.max_upload, quota=store.quota)
        except FileError as error:
            return fail(error)

    @app.post('/api/files/folder')
    def files_folder():
        if (unavailable := guard()):
            return unavailable
        try:
            data = request.get_json(silent=True) or {}
            space, parts = space_and_parts(data)
            name = clean_name(data.get('name'))
            folder = store.resolve(space, g.user, parts)
            if not os.path.isdir(folder):
                raise FileError('That is not a folder.')
            target = os.path.join(folder, name)
            if os.path.lexists(target):
                raise FileError('Something with that name already exists.', 409)
            os.mkdir(target)
            store.set_owner(space, parts + [name], g.user)
            return jsonify(name=name), 201
        except FileError as error:
            return fail(error)

    @app.put('/api/files/upload')
    def files_upload():
        if (unavailable := guard()):
            return unavailable
        if not allow('files-upload:' + g.user, 60, 60):
            return jsonify(error='Too many uploads. Wait a minute.'), 429
        try:
            space, parts = space_and_parts(request.args)
            name = clean_name(request.args.get('name'))
            size = request.content_length
            if size is None or size <= 0:
                raise FileError('The file is empty.')
            store.check_room(space, g.user, size)
            folder = store.resolve(space, g.user, parts)
            if not os.path.isdir(folder):
                raise FileError('That is not a folder.')
            request.max_content_length = store.max_upload + CHUNK
            temporary = os.path.join(store.root, '.uploading', secrets.token_hex(16))
            received = 0
            try:
                with open(temporary, 'xb') as out:
                    while True:
                        chunk = request.stream.read(CHUNK)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > size:
                            raise FileError('The upload was larger than announced.')
                        out.write(chunk)
                if received != size:
                    raise FileError('The upload did not finish. Try again.')
                with store.lock:
                    final = unique_name(folder, name)
                    os.replace(temporary, os.path.join(folder, final))
                    store.set_owner(space, parts + [final], g.user)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return jsonify(name=final, size=size), 201
        except FileError as error:
            return fail(error)

    @app.get('/api/files/download')
    def files_download():
        if (unavailable := guard()):
            return unavailable
        try:
            space, parts = space_and_parts(request.args)
            if not parts:
                raise FileError('Choose a file.')
            target = store.resolve(space, g.user, parts)
            if not os.path.isfile(target):
                raise FileError('That is not a file.', 404)
            return send_attachment(target, parts[-1])
        except FileError as error:
            return fail(error)

    @app.post('/api/files/rename')
    def files_rename():
        if (unavailable := guard()):
            return unavailable
        try:
            data = request.get_json(silent=True) or {}
            space, parts = space_and_parts(data)
            if not parts:
                raise FileError('Choose an item.')
            name = clean_name(data.get('name'))
            source = store.resolve(space, g.user, parts)
            if not store.may_change(space, parts, g.user, is_admin()):
                raise FileError('Only the person who added it can change it.', 403)
            target = os.path.join(os.path.dirname(source), name)
            if os.path.lexists(target):
                raise FileError('Something with that name already exists.', 409)
            os.rename(source, target)
            owner = store.owner(space, parts)
            store.drop_owners(space, parts)
            if owner:
                store.set_owner(space, parts[:-1] + [name], owner)
            return jsonify(name=name)
        except FileError as error:
            return fail(error)

    @app.delete('/api/files')
    def files_delete():
        if (unavailable := guard()):
            return unavailable
        try:
            space, parts = space_and_parts(request.args)
            if not parts:
                raise FileError('Choose an item.')
            target = store.resolve(space, g.user, parts)
            if not store.may_change(space, parts, g.user, is_admin()):
                raise FileError('Only the person who added it can delete it.', 403)
            if os.path.isdir(target):
                if os.listdir(target) and request.args.get('recursive') != 'true':
                    raise FileError('That folder is not empty.', 409)
                shutil.rmtree(target)
            else:
                os.unlink(target)
            store.drop_owners(space, parts)
            store.revoke_path(space, g.user, parts)
            return '', 204
        except FileError as error:
            return fail(error)

    def link_url(secret):
        return (store.public_url or '') + '/api/share/' + secret

    @app.post('/api/files/links')
    def files_link_create():
        if (unavailable := guard()):
            return unavailable
        if not allow('files-link:' + g.user, 20, 3600):
            return jsonify(error='Too many links made this hour. Try later.'), 429
        try:
            data = request.get_json(silent=True) or {}
            space, parts = space_and_parts(data)
            link_id, secret, expires = store.create_link(g.user, space, parts, data.get('expires_hours'), data.get('password') or None, data.get('max_downloads'))
            return jsonify(id=link_id, url=link_url(secret), expires=expires), 201
        except FileError as error:
            return fail(error)

    @app.get('/api/files/links')
    def files_links():
        if (unavailable := guard()):
            return unavailable
        return jsonify(links=store.my_links(g.user))

    @app.delete('/api/files/links/<link_id>')
    def files_link_revoke(link_id):
        if (unavailable := guard()):
            return unavailable
        if not re.fullmatch('[a-f0-9]{16}', link_id) or not store.revoke(g.user, link_id, is_admin()):
            return jsonify(error='That link no longer exists.'), 404
        return '', 204

    # ---- public side: no sign-in; the secret in the address is the credential ----
    def send_attachment(path, name):
        response = send_file(path, mimetype='application/octet-stream', as_attachment=True, download_name=name, conditional=True, max_age=0)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Cache-Control'] = 'private, no-store'
        return response

    def page(body, status=200):
        response = Response(body, status=status, mimetype='text/html')
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Robots-Tag'] = 'noindex'
        return response

    def gone():
        return page('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    '<meta name="robots" content="noindex"><title>Link not available</title><link rel="stylesheet" href="/static/share.css"></head>'
                    '<body><main><h1>This link is not available</h1><p>It may have expired, run out of downloads or been withdrawn. Ask the sender for a new one.</p></main></body></html>', 404)

    def open_link(secret):
        if store is None or not isinstance(secret, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,64}', secret):
            return None, None
        if not allow('share-ip:' + (request.remote_addr or '-'), 60, 60) or not allow('share-link:' + secret[:12], 30, 60):
            return None, None
        link = store.find_link(secret)
        if not link:
            return None, None
        try:
            target = store.resolve(link['space'], link['owner'], link['parts'])
        except FileError:
            return None, None
        return (link, target) if os.path.isfile(target) else (None, None)

    @app.get('/api/share/<secret>', endpoint='share_landing')
    def share_landing(secret):
        link, target = open_link(secret)
        if not link:
            return gone()
        return page(landing(os.path.basename(target), os.path.getsize(target), link['expires'], secret, bool(link['password_hash'])))

    @app.route('/api/share/<secret>/download', methods=['GET', 'POST'], endpoint='share_download')
    def share_download(secret):
        link, target = open_link(secret)
        if not link:
            return gone()
        if link['password_hash']:
            if request.method != 'POST':
                return page(landing(os.path.basename(target), os.path.getsize(target), link['expires'], secret, True))
            if not allow('share-try:' + secret[:12], 8, 300):
                return page(landing(os.path.basename(target), os.path.getsize(target), link['expires'], secret, True, 'Too many tries. Wait a few minutes.'), 429)
            if not check_password_hash(link['password_hash'], request.form.get('password', '')[:200]):
                return page(landing(os.path.basename(target), os.path.getsize(target), link['expires'], secret, True, 'That password is not right.'), 403)
        if not store.use_link(link['id']):
            return gone()
        return send_attachment(target, os.path.basename(target))

    # The password form is posted by someone with no FamilyHub session; the secret in the address is the credential.
    csrf_exempt(share_download)
    app.extensions['files'] = store
    return store
