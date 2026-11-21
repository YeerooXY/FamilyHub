"""Issue a regular Jellyfin session for the active FamilyHub profile."""
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from flask import g, jsonify


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def register_movies(app, cfg, body, allow):
    base = cfg.get('JELLYFIN_INTERNAL_URL', 'http://127.0.0.1:8096').rstrip('/')

    @app.get('/api/movies/health')
    def movie_health():
        if not cfg.get('JELLYFIN_PUBLIC_URL') or g.user not in cfg.get('JELLYFIN_PROFILES', {}):
            return jsonify(error='Movies are not set up for this profile.'), 404
        try:
            with urllib.request.build_opener(NoRedirect).open(base + '/health', timeout=2) as reply:
                healthy = reply.read(64).strip() == b'Healthy'
        except (OSError, ValueError):
            healthy = False
        return jsonify(healthy=healthy)

    @app.post('/api/movies/session')
    def movie_session():
        accounts = cfg.get('JELLYFIN_PROFILES', {})
        account = accounts.get(g.user)
        public = cfg.get('JELLYFIN_PUBLIC_URL', '').rstrip('/')
        origin = urllib.parse.urlsplit(public)
        if not account or origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
            return jsonify(error='Movies are not set up for this profile.'), 503
        device = body().get('device', '')
        if not isinstance(device, str) or not re.fullmatch('[a-f0-9]{32}', device):
            return jsonify(error='Invalid movie device.'), 400
        if not allow('movie-session:' + g.user, 20, 60):
            return jsonify(error='Wait a minute before opening movies again.'), 429
        username = account['username']
        if sum(a['username'].casefold() == username.casefold() for a in accounts.values()) != 1:
            return jsonify(error='Each profile needs a separate Jellyfin user.'), 503
        auth = f'MediaBrowser Client="FamilyHub", Device="FamilyHub Movies", DeviceId="{device}", Version="1"'
        opener = urllib.request.build_opener(NoRedirect)
        req = urllib.request.Request(base + '/Users/AuthenticateByName',
            data=json.dumps({'Username': username, 'Pw': account['password']}).encode(),
            headers={'Authorization': auth, 'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=6) as reply:
                data = json.load(reply)
            user = data['User']
            if user['Policy']['IsAdministrator'] is not False or user['Name'].casefold() != username.casefold():
                logout = urllib.request.Request(base + '/Sessions/Logout', data=b'',
                    headers={'Authorization': auth + ', Token="' + data['AccessToken'] + '"'})
                with opener.open(logout, timeout=6):
                    pass
                return jsonify(error='Link a regular Jellyfin account to this profile.'), 403
            response = jsonify(url=public, user=user['Id'], token=data['AccessToken'], device=device)
            response.headers['Cache-Control'] = 'no-store'
            return response
        except (OSError, ValueError, KeyError, TypeError):
            return jsonify(error='Could not connect this profile to Jellyfin.'), 503
