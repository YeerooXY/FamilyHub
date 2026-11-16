"""Shared, bounded MusicBrainz reads. No audio or credentials leave the server."""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

_lock = threading.Lock()
_next = 0.0

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Metadata service redirected the request.')

class Throttled(Exception):
    """MusicBrainz kept answering 503 (slow down); the caller should pause, not count a failure."""

def read(path, **parameters):
    global _next
    if not re.fullmatch(r'(?:artist|recording)(?:/[0-9a-f-]{36})?/?', path):
        raise ValueError('Invalid metadata endpoint.')
    query=urllib.parse.urlencode(dict(parameters,fmt='json'))
    # MusicBrainz allows about one request a second per server and answers 503 when asked
    # faster; keep 1.5 s apart and, on a 503, wait longer before the same request again.
    for wait in (0, 2, 5, 10):
        with _lock:
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
            if error.code!=503: raise
    else:
        raise Throttled('MusicBrainz asked to slow down.')
    if len(data)>1048576: raise ValueError('Metadata response is too large.')
    return json.loads(data)
