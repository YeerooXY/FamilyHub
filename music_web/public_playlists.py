"""Complete public Spotify metadata through a signed-out web player session."""
import copy
import math
import time
import re

from .playlists import PlaylistError, playlist_id
from .resources import PROVIDERS

ENDPOINT = "https://api-partner.spotify.com/pathfinder/v2/query"
_spotify = PROVIDERS["spotify"]


def read_artist_catalogue(aid, name, fetch_releases, fetch_tracks, progress=None):
    """Read every release page and track page, then deduplicate artist recordings."""
    albums, offset, expected = [], 0, None
    while True:
        page = fetch_releases(offset)
        total, rows = page['totalCount'], page['items']
        if type(total) is not int or not 0 <= total <= 2000 or not isinstance(rows, list):
            raise PlaylistError('Invalid artist release list.')
        if expected is None: expected = total
        if total != expected or len(rows) > total - offset or (not rows and offset < total):
            raise PlaylistError('The artist release list changed or is incomplete. Try again.')
        for row in rows:
            releases = row['releases']['items']
            if not releases: raise PlaylistError('An artist release is unavailable.')
            album = releases[0]['uri']
            if not re.fullmatch(r'spotify:album:[A-Za-z0-9]{22}', album):
                raise PlaylistError('Invalid artist release.')
            if album not in albums: albums.append(album)
        offset += len(rows)
        if offset == total: break
    tracks, seen, signatures = [], set(), set()
    if progress: progress(0, len(albums))
    for number, album in enumerate(albums):
        offset, expected_tracks = 0, None
        while True:
            page = fetch_tracks(album, offset)
            total, rows = page['totalCount'], page['items']
            if type(total) is not int or not 0 <= total <= 10000 or not isinstance(rows, list):
                raise PlaylistError('Invalid album track list.')
            if expected_tracks is None: expected_tracks = total
            if total != expected_tracks or len(rows) > total - offset or (not rows and offset < total):
                raise PlaylistError('An album track list changed or is incomplete. Try again.')
            for row in rows:
                track = row['track']
                artists = track['artists']['items']
                if not any(a.get('uri') == 'spotify:artist:' + aid for a in artists): continue
                converted = _track({'itemV2': {'data': dict(track, __typename='Track', trackDuration=track['duration'])}}, len(tracks))
                uri = converted['spotify_uri']
                if not re.fullmatch(r'spotify:track:[A-Za-z0-9]{22}', uri): raise PlaylistError('Invalid artist track.')
                signature = (converted['title'].casefold(), converted['artist'].casefold(), converted['duration'])
                if uri not in seen and signature not in signatures:
                    tracks.append(converted); seen.add(uri); signatures.add(signature)
                if len(tracks) > 10000: raise PlaylistError('An artist import can contain up to 10,000 songs.')
            offset += len(rows)
            if offset == total: break
        if progress: progress(number + 1, len(albums))
    return dict(id=aid, name=name[:200], url='https://open.spotify.com/artist/' + aid,
                tracks=tracks, notice=f'{len(tracks)} recordings imported from {len(albums)} releases.',
                source=dict(reader='spotify-public-artist', total=len(tracks), releases=len(albums), complete=True))


def fetch_public_artist(url, *, progress=None):
    from .playlists import spotify_source
    kind, aid = spotify_source(url)
    if kind != 'artist': raise PlaylistError('Enter a Spotify artist link.')
    try:
        from playwright.sync_api import sync_playwright, Error
    except ImportError:
        raise PlaylistError('The Spotify public reader is unavailable.') from None
    deadline = time.monotonic() + 600
    def timeout():
        left = int((deadline - time.monotonic()) * 1000)
        if left <= 0: raise PlaylistError('Artist import timed out. No partial catalogue was imported.')
        return min(left, 60000)
    try:
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(headless=True)
            try:
                context = browser.new_context(); page = context.new_page(); captured = {}
                def capture(response):
                    if response.url == ENDPOINT and response.request.method == 'POST':
                        request = response.request
                        body = request.post_data_json
                        if isinstance(body, dict): captured[body.get('operationName')] = request
                page.on('response', capture)
                with _spotify.request():
                    page.goto('https://open.spotify.com/artist/' + aid, wait_until='domcontentloaded', timeout=timeout())
                with _spotify.request():
                    page.locator('a[href*=discography]').first.click(timeout=timeout())
                while not all(op in captured for op in ('queryArtistOverview', 'queryArtistDiscographyAll', 'queryAlbumTracks')):
                    page.wait_for_timeout(min(250, timeout()))
                def query(operation, **variables):
                    request = captured[operation]; body = copy.deepcopy(request.post_data_json)
                    body['variables'].update(variables)
                    headers = {k: v for k, v in request.all_headers().items() if k in ('authorization', 'client-token', 'app-platform', 'spotify-app-version', 'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent')}
                    with _spotify.request():
                        response = context.request.post(ENDPOINT, data=body, headers=headers, timeout=timeout(), max_redirects=0)
                    try:
                        if response.status != 200: raise PlaylistError(f'Spotify artist reader returned HTTP {response.status}. Try again.')
                        result = response.json()
                        if result.get('errors'): raise PlaylistError('Spotify could not read this artist catalogue.')
                        return result['data']
                    finally: response.dispose()
                overview = query('queryArtistOverview', uri='spotify:artist:' + aid)['artistUnion']
                if overview['uri'] != 'spotify:artist:' + aid: raise PlaylistError('Spotify returned a different artist.')
                return read_artist_catalogue(aid, overview['profile']['name'],
                    lambda offset: query('queryArtistDiscographyAll', uri='spotify:artist:' + aid, offset=offset, limit=50)['artistUnion']['discography']['all'],
                    lambda album, offset: query('queryAlbumTracks', uri=album, offset=offset, limit=300)['albumUnion']['tracksV2'], progress)
            finally: browser.close()
    except (KeyError, TypeError, ValueError) as error:
        if isinstance(error, PlaylistError): raise
        raise PlaylistError('Spotify returned incomplete artist metadata. No partial catalogue was imported.') from None
    except Error:
        raise PlaylistError('Spotify artist reading could not finish. Try again.') from None


def read_album(aid, fetch_page, progress=None):
    """Read every page of one album's track list, in album order, and check that the list did not change."""
    tracks, offset, expected, name = [], 0, None, ''
    while True:
        album = fetch_page(offset)
        if album.get('uri') != 'spotify:album:' + aid: raise PlaylistError('Spotify returned a different album.')
        page = album['tracksV2']
        total, rows = page['totalCount'], page['items']
        if type(total) is not int or not 0 <= total <= 10000 or not isinstance(rows, list):
            raise PlaylistError('Invalid album track list.')
        if expected is None: expected, name = total, album.get('name')
        if not isinstance(name, str) or not name: raise PlaylistError('Spotify returned an album without a name.')
        if total != expected or len(rows) > total - offset or (not rows and offset < total):
            raise PlaylistError('The album track list changed or is incomplete. Try again.')
        for row in rows:
            track = row['track']
            converted = _track({'itemV2': {'data': dict(track, __typename='Track', trackDuration=track['duration'])}}, len(tracks))
            converted['album'] = name[:300]
            if not re.fullmatch(r'spotify:track:[A-Za-z0-9]{22}', converted['spotify_uri']): raise PlaylistError('Invalid album track.')
            tracks.append(converted)
        offset += len(rows)
        if progress: progress(offset, total)
        if offset == total: break
    return dict(id=aid, name=name[:200], url='https://open.spotify.com/album/' + aid, tracks=tracks,
                notice=f'{len(tracks)} tracks imported in album order.',
                source=dict(reader='spotify-public-album', total=len(tracks), complete=True))


def fetch_public_album(url, *, progress=None):
    """Read a public album through a signed-out web player session, like the artist reader."""
    from .playlists import spotify_source
    kind, aid = spotify_source(url)
    if kind != 'album': raise PlaylistError('Enter a Spotify album link.')
    try:
        from playwright.sync_api import sync_playwright, Error
    except ImportError:
        raise PlaylistError('The Spotify public reader is unavailable.') from None
    deadline = time.monotonic() + 300
    def timeout():
        left = int((deadline - time.monotonic()) * 1000)
        if left <= 0: raise PlaylistError('Album import timed out. No partial album was imported.')
        return min(left, 60000)
    try:
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(headless=True)
            try:
                context = browser.new_context(); page = context.new_page(); captured = {}
                def capture(response):
                    if response.url == ENDPOINT and response.request.method == 'POST':
                        body = response.request.post_data_json
                        if isinstance(body, dict): captured[body.get('operationName')] = response.request
                page.on('response', capture)
                with _spotify.request():
                    page.goto('https://open.spotify.com/album/' + aid, wait_until='domcontentloaded', timeout=timeout())
                while 'getAlbum' not in captured: page.wait_for_timeout(min(250, timeout()))
                def fetch_page(offset):
                    request = captured['getAlbum']; body = copy.deepcopy(request.post_data_json)
                    body['variables'].update(offset=offset, limit=300)
                    headers = {k: v for k, v in request.all_headers().items() if k in ('authorization', 'client-token', 'app-platform', 'spotify-app-version', 'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent')}
                    with _spotify.request():
                        response = context.request.post(ENDPOINT, data=body, headers=headers, timeout=timeout(), max_redirects=0)
                    try:
                        if response.status != 200: raise PlaylistError(f'Spotify album reader returned HTTP {response.status}. Try again.')
                        result = response.json()
                        if result.get('errors'): raise PlaylistError('Spotify could not read this album.')
                        return result['data']['albumUnion']
                    finally: response.dispose()
                return read_album(aid, fetch_page, progress)
            finally: browser.close()
    except (KeyError, TypeError, ValueError) as error:
        if isinstance(error, PlaylistError): raise
        raise PlaylistError('Spotify returned incomplete album metadata. No partial album was imported.') from None
    except Error:
        raise PlaylistError('Spotify album reading could not finish. Try again.') from None


def _page(payload, pid, offset):
    try:
        if payload.get("errors"):
            raise ValueError
        playlist = payload["data"]["playlistV2"]
        content = playlist["content"]
        total = content["totalCount"]
        if (playlist["uri"] != "spotify:playlist:" + pid
                or type(total) is not int or total < 0
                or content["pagingInfo"]["offset"] != offset
                or not isinstance(content["items"], list)
                or not isinstance(playlist["revisionId"], str)
                or not playlist["revisionId"]
                or not isinstance(playlist["name"], str)):
            raise ValueError
        return playlist, content
    except (KeyError, TypeError, ValueError, AttributeError):
        raise PlaylistError("Spotify returned an invalid or unavailable public playlist page.") from None


def _track(row, position):
    try:
        track = row["itemV2"]["data"]
        title, uri = track["name"], track["uri"]
        local = track["__typename"] == "LocalTrack"
        artists = ([track["artistName"]] if local else
                   [item["profile"]["name"] for item in track["artists"]["items"]])
        duration = track["localTrackDuration" if local else "trackDuration"]["totalMilliseconds"]
        if (track["__typename"] not in ("Track", "LocalTrack") or not isinstance(title, str)
                or not title or not isinstance(uri, str)
                or not uri.startswith("spotify:local:" if local else "spotify:track:")
                or not artists or not all(isinstance(a, str) and (a or local) for a in artists)
                or type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0):
            raise ValueError
        return {"title": title[:300], "artist": ", ".join(artists).replace("\u00a0", " ")[:300],
                "duration": round(duration / 1000), "spotify_uri": uri,
                "album": str((track.get("albumOfTrack") or {}).get("name") or "")[:300],
                "candidates": [], "state": "unmatched"}
    except (KeyError, TypeError, ValueError, AttributeError):
        raise PlaylistError(f"Playlist entry {position + 1} has unavailable or unsupported track metadata. No partial list was returned.") from None


def read_pages(pid, fetch_page, progress=None):
    """Consume consecutive offsets without deduplicating playlist occurrences."""
    tracks, pages = [], []
    first, content = _page(fetch_page(0), pid, 0)
    revision, total = first["revisionId"], content["totalCount"]
    if total > 10000: raise PlaylistError("A playlist can contain up to 10,000 songs.")
    playlist = first
    while True:
        offset = len(tracks)
        if playlist["revisionId"] != revision or content["totalCount"] != total:
            raise PlaylistError("The playlist changed while reading it. Try again.")
        rows = content["items"]
        if len(rows) > total - offset or (not rows and offset < total):
            raise PlaylistError("Spotify returned an incomplete playlist page. Try again.")
        pages.append({"offset": offset, "count": len(rows)})
        batch = [_track(row, offset + i) for i, row in enumerate(rows)]
        tracks.extend(batch)
        if batch and (publish := getattr(progress, "publish_page", None)):
            publish(first["name"][:200], revision, batch)
        if progress: progress(len(tracks), total)
        if len(tracks) == total:
            break
        playlist, content = _page(fetch_page(len(tracks)), pid, len(tracks))
    # Catch edits made after the last page was served, including one-page lists.
    final, final_content = _page(fetch_page(0), pid, 0)
    if final["revisionId"] != revision or final_content["totalCount"] != total:
        raise PlaylistError("The playlist changed while reading it. Try again.")
    return {"id": pid, "name": first["name"][:200],
            "url": "https://open.spotify.com/playlist/" + pid, "tracks": tracks,
            "notice": f"{total} tracks imported in playlist order.",
            "source": {"reader": "spotify-public-web", "total": total,
                       "revision": revision, "pages": pages, "complete": True}}


def fetch_public_playlist(url, *, page_size=100, progress=None):
    """Use a fresh signed-out web player session; no owner login or stored cookies."""
    pid = playlist_id(url)
    if getattr(progress, "publish_page", None):
        page_size = min(page_size, 25)
    if type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError("Page size must be between 1 and 100.")
    try:
        from playwright.sync_api import sync_playwright, Error
    except ImportError:
        raise PlaylistError("Install requirements-playlists.txt and Playwright Chromium to use the public reader.") from None
    deadline = time.monotonic() + 600

    def remaining():
        milliseconds = int((deadline - time.monotonic()) * 1000)
        if milliseconds <= 0:
            raise PlaylistError("Public playlist reading timed out. No partial list was returned.")
        return min(milliseconds, 60_000)

    def is_playlist(response):
        if response.url != ENDPOINT or response.request.method != "POST":
            return False
        body = response.request.post_data_json
        return (isinstance(body, dict) and body.get("operationName") == "fetchPlaylist"
                and body.get("variables", {}).get("uri") == "spotify:playlist:" + pid)

    try:
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(headless=True)
            try:
                context = browser.new_context()
                page = context.new_page()
                with _spotify.request(), page.expect_response(is_playlist, timeout=remaining()) as pending:
                    page.goto("https://open.spotify.com/playlist/" + pid,
                              wait_until="domcontentloaded", timeout=remaining())
                captured = pending.value.request
                template = captured.post_data_json
                # Discover the current operation and session headers from the web player.
                headers = {k: v for k, v in captured.all_headers().items()
                           if k in ("authorization", "client-token", "app-platform",
                                    "spotify-app-version", "accept", "accept-language",
                                    "content-type", "origin", "referer", "user-agent")}

                def fetch_page(offset):
                    body = copy.deepcopy(template)
                    body["variables"].update(offset=offset, limit=page_size)
                    with _spotify.request():
                        response = context.request.post(ENDPOINT, data=body, headers=headers,
                                                        timeout=remaining(), max_redirects=0)
                    try:
                        if response.status != 200:
                            raise PlaylistError(f"Spotify public reader returned HTTP {response.status}. No partial list was returned.")
                        return response.json()
                    except ValueError:
                        raise PlaylistError("Spotify returned invalid playlist data.") from None
                    finally:
                        response.dispose()

                return read_pages(pid, fetch_page, progress)
            finally:
                browser.close()
    except Error:
        # Browser errors can contain session headers; never expose them to callers.
        raise PlaylistError("Spotify public reader could not finish. Check browser setup and connectivity, then try again.") from None
