"""The administrator's web page: sign in, then watch torrent seeding. It only reads."""
from pathlib import Path

from flask import abort, send_from_directory

FILES = {'admin.css': 'text/css', 'admin.js': 'text/javascript'}
ROOT = Path(__file__).with_name('admin_static')


def register(app):
    @app.get('/admin')
    def admin_page():
        response = send_from_directory(ROOT, 'admin.html', mimetype='text/html')
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/admin/<name>')
    def admin_asset(name):
        if name not in FILES:
            abort(404)
        response = send_from_directory(ROOT, name, mimetype=FILES[name])
        response.headers['Cache-Control'] = 'no-store'
        return response
