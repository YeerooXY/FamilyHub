"""The administrator's web page: sign in, then watch torrent seeding. It only reads."""
from pathlib import Path

from flask import abort, send_from_directory

FILES = {'admin.css': 'text/css', 'admin.js': 'text/javascript'}
ROOT = Path(__file__).with_name('admin_static')
WEBROOT = ROOT.parents[1] / 'clients' / 'FamilyHub.App' / 'wwwroot'
SHARED = {'service-status.css': 'text/css', 'service-status.js': 'text/javascript',
          'strings.js': 'text/javascript', 'strings.hu.json': 'application/json'}


def register(app):
    @app.get('/admin')
    def admin_page():
        response = send_from_directory(ROOT, 'admin.html', mimetype='text/html')
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/admin/<name>')
    def admin_asset(name):
        if name not in FILES and name not in SHARED:
            abort(404)
        folder = WEBROOT if name in SHARED and not (ROOT / name).is_file() else ROOT
        response = send_from_directory(folder, name, mimetype=(SHARED | FILES)[name])
        response.headers['Cache-Control'] = 'no-store'
        return response
