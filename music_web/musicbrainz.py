"""Shared, bounded MusicBrainz reads. No audio or credentials leave the server."""
import json
import re
import threading
import time
import urllib.parse
import urllib.request

_lock = threading.Lock()
_next = 0.0

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Metadata service redirected the request.')

def read(path, **parameters):
    global _next
    if not re.fullmatch(r'(?:artist|recording)(?:/[0-9a-f-]{36})?/?', path):
        raise ValueError('Invalid metadata endpoint.')
    with _lock:
        time.sleep(max(0,_next-time.monotonic()))
        _next=time.monotonic()+1.1
    query=urllib.parse.urlencode(dict(parameters,fmt='json'))
    request=urllib.request.Request('https://musicbrainz.org/ws/2/'+path+'?'+query,
        headers={'User-Agent':'FamilyHubMusic/0.1 (https://github.com/YeerooXY)','Accept':'application/json'})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=8) as response:
        data=response.read(1048577)
    if len(data)>1048576: raise ValueError('Metadata response is too large.')
    return json.loads(data)
