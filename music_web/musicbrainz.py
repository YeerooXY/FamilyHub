"""Shared, bounded MusicBrainz reads. No audio or credentials leave the server."""
import json
from email.utils import parsedate_to_datetime
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

_lock = threading.Lock()
_next = 0.0
_cooldown = 0.0

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Metadata service redirected the request.')

class Throttled(Exception):
    def __init__(self, message, delay=120):
        super().__init__(message)
        self.delay = delay


def retry_delay(header):
    if header:
        if header.strip().isdigit():
            return int(header)
        try:
            return max(0, parsedate_to_datetime(header).timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            pass
    return 0

def read(path, **parameters):
    global _next, _cooldown
    if not re.fullmatch(r'(?:artist|recording)(?:/[0-9a-f-]{36})?/?', path):
        raise ValueError('Invalid metadata endpoint.')
    query=urllib.parse.urlencode(dict(parameters,fmt='json'))
    # MusicBrainz allows about one request a second per server and answers 503 when asked
    # faster; keep 1.5 s apart and, on a 503, wait longer before the same request again.
    for wait in (0, 2, 5, 10):
        with _lock:
            remaining = _cooldown - time.monotonic()
            if remaining > 0:
                raise Throttled('MusicBrainz asked to slow down.', remaining)
            _next=max(_next,time.monotonic()+wait)
            time.sleep(max(0,_next-time.monotonic()))
            _next=time.monotonic()+1.5
        request=urllib.request.Request('https://musicbrainz.org/ws/2/'+path+'?'+query,
            headers={'User-Agent':'FamilyHubMusic/0.1 (https://github.com/YeerooXY/FamilyHub)','Accept':'application/json'})
        try:
            with urllib.request.build_opener(NoRedirect).open(request,timeout=8) as response:
                data=response.read(1048577)
            break
        except urllib.error.HTTPError as error:
            if error.code not in (429, 503): raise
            delay = retry_delay(error.headers.get('Retry-After'))
            if delay or error.code == 429 or wait == 10:
                with _lock:
                    delay = max(120, delay)
                    _cooldown = max(_cooldown, time.monotonic() + delay)
                raise Throttled('MusicBrainz asked to slow down.', delay) from error
    else:
        raise Throttled('MusicBrainz asked to slow down.')
    if len(data)>1048576: raise ValueError('Metadata response is too large.')
    return json.loads(data)
