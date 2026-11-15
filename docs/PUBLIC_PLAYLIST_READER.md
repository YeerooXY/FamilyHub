# Public playlist reader

Verified 13 November 2026 against [DnB](https://open.spotify.com/playlist/6CCDIMytDCox2aDcNi1ztu).

The importer now uses a fresh signed-out Chromium session to discover Spotify's current web-player playlist request, then requests every page through that session. It requires neither playlist ownership nor a Spotify account, developer key, stored login cookie, or third-party metadata service. The web-player endpoint is undocumented and can change.

## Acceptance result

- 549 entries, including 37 local-file entries.
- Six pages at offsets 0, 100, 200, 300, 400 and 500; the final page contains 49 entries.
- A second signed-out session retrieved 15 pages of up to 37 entries. Every normalized track record matched the first read in order.
- Both reads reported revision `AAACw0RjXnHffOWWgVQgeopCtBqYaczs`.
- First entry: **Change — hayve, Skyelle**. Last entry: **Safe In Sound — Sub Focus**.
- SHA-256 of newline-joined ordered Spotify URIs: `1c7d2b8f95cdd891ddd79230582fa3d73240c027e8d2f46591f60a90f758f8e8`.

The metadata-only acceptance command writes all entries and page evidence:

```powershell
python scripts/check-public-playlist.py https://open.spotify.com/playlist/6CCDIMytDCox2aDcNi1ztu --expected-count 549 --output .local/music/public-dnb-acceptance.json
```

The result is a snapshot; playlist edits can change its count, revision and digest. This check performs no audio searches or downloads.

## Data and failure handling

Small and large playlists return the same `id`, `name`, `url`, `tracks`, `notice` and `source` fields. Each track retains the importer's `title`, `artist`, `duration`, `spotify_uri`, `candidates` and `state` fields. Pagination consumes source order and preserves duplicate occurrences. Local-file metadata uses that same format; a missing artist stays empty and cannot produce an automatically recommended recording match.

Each page must match the requested playlist and offset, declared total and revision. A final request checks the revision again. Early empty pages, changed revisions, upstream errors and unavailable or unsupported entry metadata fail the entire read. Episodes are unsupported. Empty playlists return an empty track list. Reads have a ten-minute deadline and individual requests have a sixty-second timeout. There is no embed fallback or partial success.

Re-importing replaces old partial metadata with the complete list. Existing candidates, saved state and job references are retained by URI occurrence in source order. Recording choices in the browser reset after re-import. A failed read leaves the saved playlist intact. Reading local-file metadata does not retrieve the original local audio file.

## Setup and checks

Install `requirements-mobile.txt` (which includes `requirements-playlists.txt`), then install the browser **as the account running the music service**, or configure a shared `PLAYWRIGHT_BROWSERS_PATH` accessible to that account:

```sh
python -m playwright install --with-deps chromium
```

The reader launches a separate browser for each import and closes it after reading. Service memory limits must accommodate Chromium. This change was verified locally; the running server has not been deployed or measured with Chromium.

Checks: reader unit tests cover sizes 0 through 1,001, duplicate order, local entries, incomplete pages, wrong identities and offsets, revision changes, upstream failure and state preservation. Route tests cover refresh, failed-import preservation and user isolation. The isolated Chromium import-form test renders 549 entries and checks stale-choice reset and Tab, Shift+Tab, Enter and Space behavior. It verifies interaction, not visual design or native devices.

Implementation references: the [Spotify web player](https://open.spotify.com/) supplies the live request and schema; an [independent public-reader implementation](https://github.com/knownasrazi/spotify-api/blob/main/server.js) helped identify the web-player pagination route. FamilyHub discovers the request from its own fresh session rather than using that project's token-generation implementation.
