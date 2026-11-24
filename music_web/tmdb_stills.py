"""Episode pictures from TMDB, downloaded once and kept on the server.

The client asks the server for a season's episodes; each picture is fetched from image.tmdb.org the first time it is
needed and read from disk afterwards, so TMDB is not asked again for a stored image.
"""
import base64
import re
import urllib.request

from .catalog_search import NoRedirect
from .state import state_path

IMAGE = 'https://image.tmdb.org/t/p/w300'
MAX_BYTES = 300 * 1024
STILL_PATH = re.compile(r'/[A-Za-z0-9]{6,40}\.jpg')


class StillCache:
    def __init__(self, cfg, timeout=4):
        self.root = state_path(cfg, '.tmdb-stills')
        self.timeout = timeout

    def file(self, series, season, episode):
        if not all(type(value) is int and 0 <= value <= 99999 for value in (series, season, episode)):
            return None
        return self.root / str(series) / f'{season}-{episode}.jpg'

    def read(self, series, season, episode):
        path = self.file(series, season, episode)
        try:
            return path.read_bytes() if path and path.is_file() else None
        except OSError:
            return None

    def fetch(self, series, season, episode, still_path, opener=None):
        """The stored picture, downloading it once. None when TMDB has none or does not answer."""
        stored = self.read(series, season, episode)
        if stored is not None:
            return stored
        path = self.file(series, season, episode)
        if path is None or not isinstance(still_path, str) or not STILL_PATH.fullmatch(still_path):
            return None
        try:
            opener = opener or urllib.request.build_opener(NoRedirect())
            with opener.open(urllib.request.Request(IMAGE + still_path), timeout=self.timeout) as reply:
                data = reply.read(MAX_BYTES + 1)
            if not data or len(data) > MAX_BYTES or not data.startswith(b'\xff\xd8'):
                return None
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix('.part')
            partial.write_bytes(data)
            partial.replace(path)
            return data
        except (OSError, ValueError):
            return None

    @staticmethod
    def data_url(data):
        return 'data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii') if data else None
