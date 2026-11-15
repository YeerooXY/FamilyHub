"""Serve administrator-published app packages through the private FamilyHub server."""
import json
import re
from pathlib import Path

from flask import abort, jsonify, send_file


def register(app, workspace, require_family):
    root = Path(workspace) / '.app-updates'

    def release(platform):
        require_family()
        if platform not in ('windows-x64', 'android'):
            abort(404)
        directory = root / platform
        try:
            manifest = directory / 'latest.json'
            if manifest.stat().st_size > 16384:
                abort(503)
            data = json.loads(manifest.read_text(encoding='utf-8'))
            extension = 'zip' if platform == 'windows-x64' else 'apk'
            if (not re.fullmatch(r'\d+\.\d+\.\d+', data['version'])
                    or not re.fullmatch(r'[0-9a-f]{64}', data['sha256'])
                    or not re.fullmatch(r'FamilyHub-Music-[A-Za-z0-9.-]+\.' + extension, data['file'])
                    or not 0 < data['size'] <= 250 * 1024 * 1024):
                abort(503)
            package = directory / data['file']
            if package.is_symlink() or package.stat().st_size != data['size']:
                abort(503)
            return data, package
        except FileNotFoundError:
            abort(404)
        except (KeyError, TypeError, ValueError):
            abort(503)

    @app.get('/api/app-updates/<platform>')
    def app_update_manifest(platform):
        data, _ = release(platform)
        return jsonify(version=data['version'], sha256=data['sha256'], size=data['size'],
                       download_url=f"/api/app-updates/{platform}/{data['sha256']}")

    @app.route('/api/app-updates/<platform>/<digest>', methods=['GET', 'HEAD'])
    def app_update_package(platform, digest):
        data, package = release(platform)
        if digest != data['sha256']:
            abort(404)
        return send_file(package, as_attachment=True, download_name=data['file'],
                         conditional=True, etag=data['sha256'], max_age=0)
