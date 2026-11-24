"""Poster and title matches from The Movie Database, for personal non-commercial use.

The key stays on the server. Clients receive title, year, overview and a poster address on image.tmdb.org.
"""
import json
import re
import urllib.parse
import urllib.request

IMAGE = 'https://image.tmdb.org/t/p/w342'
SEARCH = 'https://api.themoviedb.org/3/search/multi'
YEAR = re.compile(r'(?:19|20)\d\d')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def parse(reply, limit=6):
    """Reduce a TMDB multi-search reply to movie and series matches."""
    matches = []
    for item in reply.get('results', []) if isinstance(reply, dict) else []:
        kind = item.get('media_type')
        ident = item.get('id')
        if kind not in ('movie', 'tv') or type(ident) is not int:
            continue
        title = item.get('title') if kind == 'movie' else item.get('name')
        date = item.get('release_date') if kind == 'movie' else item.get('first_air_date')
        if not isinstance(title, str) or not title.strip():
            continue
        poster = item.get('poster_path')
        overview = item.get('overview')
        matches.append({
            'id': ident, 'kind': kind, 'title': title.strip()[:150],
            'year': int(date[:4]) if isinstance(date, str) and YEAR.fullmatch(date[:4] or '') else None,
            'poster': IMAGE + poster if isinstance(poster, str) and re.fullmatch(r'/[\w.-]{4,80}', poster) else None,
            'overview': overview.strip()[:300] if isinstance(overview, str) else ''})
        if len(matches) >= limit:
            break
    return matches


def search(api_key, query, limit=6, opener=None):
    """Return matches, or None when TMDB does not answer."""
    params = urllib.parse.urlencode({'api_key': api_key, 'query': query[:120], 'include_adult': 'false', 'language': 'en-US'})
    request = urllib.request.Request(SEARCH + '?' + params, headers={'Accept': 'application/json'})
    try:
        with (opener or urllib.request.build_opener(_NoRedirect)).open(request, timeout=6) as reply:
            return parse(json.loads(reply.read(1024 * 1024)), limit)
    except (OSError, ValueError):
        return None
