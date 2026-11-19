# Interface verification

## 19 November 2026 · Notices and recovery

The native and web notice audit, pixel measurements, keyboard paths and captures are in the [notice verification record](notices-2026-11-19/README.md). Physical Mac and phone behavior and screen-reader speech remain open.

## 19 November 2026 — Desktop frame, player and search header

Frame and panel layout, player alignment and seek interactions, and the narrow desktop search flow were checked in the Windows build and browser profiles. The [desktop frame verification record](frame-black-2026-11-19/README.md) has pixel counts, captures, and coverage limits.

## 19 November 2026 — Music player bar

Desktop and phone player layout, track states, keyboard focus, reduced motion, title truncation and playlist action placement were checked in headless Chromium and WebKit. The measurements, screenshots and device limits are in the [player bar verification record](player-bar-2026-11-19/README.md).

## 19 November 2026 — Music Home shelves, album details and Search

Headless Playwright rendered the built Windows Razor components in a local
Blazor host with synthetic tracks and artwork. The host emulated the MAUI
dispatcher, cache hit and audio deck. The web discovery checks used the rendered
Flask template and browser assets with fixture API responses. All captures use
reduced motion.

| Profile | Playlist and album tile width | Screenshots |
| --- | ---: | --- |
| Windows Chromium, 1280 × 900 | 224 px | [Home](music-home-tiles/windows-1280.png) · [Playlists and albums](music-home-tiles/windows-1280-playlists-albums.png) · [Album](music-home-tiles/windows-1280-album.png) · [Empty Search](music-home-tiles/windows-1280-search.png) |
| Windows Chromium, 2000 × 1060 | 248 px | [Home](music-home-tiles/windows-2000.png) · [Playlists and albums](music-home-tiles/windows-2000-playlists-albums.png) |
| macOS Safari engine emulated on Windows, 1440 × 900 | 248 px | [Home](music-home-tiles/mac-webkit-emulated.png) · [Playlists and albums](music-home-tiles/mac-webkit-emulated-playlists-albums.png) |
| Pixel 7 Chromium profile emulated on Windows, 412 × 839 | 148 px | [Home](music-home-tiles/android-chromium-emulated.png) · [Playlists and albums](music-home-tiles/android-chromium-emulated-playlists-albums.png) · [Album](music-home-tiles/android-chromium-emulated-album.png) · [Empty Search](music-home-tiles/android-chromium-emulated-search.png) |
| iPhone 13 WebKit profile emulated on Windows, 390 × 664 | 148 px | [Home](music-home-tiles/iphone-webkit-emulated.png) · [Playlists](music-home-tiles/iphone-webkit-emulated-playlists.png) · [Albums](music-home-tiles/iphone-webkit-emulated-playlists-albums.png) · [Album](music-home-tiles/iphone-webkit-emulated-album.png) · [Empty Search](music-home-tiles/iphone-webkit-emulated-search.png) |
| Flask discovery, Windows Chromium and emulated Pixel 7 | — | [Windows](music-home-tiles/web-windows-1280.png) · [Pixel 7](music-home-tiles/web-android-emulated.png) |

- Home layout checks covered the tile cap, square artworks and missing-cover tile,
  matching radio and recent tile styles, shelf arrow alignment and scrolling,
  and page overflow. The existing Playwright Home fixture also exercised
  hover, keyboard focus, save-button targets and reduced motion at six widths or profiles.
- Album and playlist tiles opened details with the player idle. The explicit
  album play control started the fixture deck. Back returned focus to the album tile.
  Empty Search kept the search controls visible and the results pane clear. On
  phone profiles the Search tab focused the accessible heading.
- The radio fixture delayed the create response by 2.5 seconds. The selected song
  started during the delay, then the remaining tracks appeared in the queue
  through a preparation request carrying the background activity header.
- Discovery and radio passed 20 Python tests. Discovery coverage included a
  13-track album, duplicate cover art across artists, separate remix releases,
  the artist cap, and first-round artist rotation. The portable client passed
  891 checks. The player checks passed on an isolated retry after a crossfade
  envelope timing assertion failed in the first run. The Windows build completed
  with two existing nullability warnings in `MainPage.xaml.cs`.

Full assistive-technology checks, physical Mac and phone checks, native OS fonts
and keyboard behavior, and audible playback against a live server remain open.
The album checks cover the normal opening and play path. The Search checks cover
empty and cleared input. Broader error, loading and accessibility coverage remains
open for those screens. WebKit rendered the fixture art and reported its
cross-origin canvas sampling restriction during artwork processing.

## 17 November 2026 — Home and playlists

Scope: playlist contributor pictures/names, playlist owner bylines, cover cropping,
playlist search, Create playlist, Home shortcuts/greeting and sticky column labels.
The current branch and unrelated work were preserved.

| Environment | Coverage | Result |
| --- | --- | --- |
| Windows MAUI / WebView2, 1904 × 1015 | Actual native app against the private server | Passed |
| Windows Chromium, 1440 × 900 | Affected layout with real CSS/JavaScript and synthetic data | Passed |
| Desktop WebKit, 1440 × 900 | Emulated Mac Safari engine/layout | Passed |
| Android Chrome / Pixel 7, 412 × 839 | Emulated device profile | Passed |
| iPhone Safari / iPhone 13, 390 × 664 | Emulated WebKit device profile | Passed |

Screenshots and JSON evidence are in the ignored directory
`.local/native-ui-review/playlist-updates/`. Native captures use the actual catalogue;
browser fixtures use generated test images and names. Apple OS fonts, VoiceOver,
physical phones and native mobile integration remain unverified.

Verified behavior:

- Actual Windows cards displayed 14 profile photos and automatically cropped 10 covers.
  Existing original image bytes remain unchanged. Paired black bands are cropped;
  unpaired borders, completely black images and ordinary images retain their normal fit.
  Replacing a cropped image with a normal one resets the display crop.
- The actual playlist displayed 50 contributor photos. Older entries use the playlist
  owner; new entries record the authenticated actor. Reordering/reimporting preserves
  recorded attribution, including repeated source entries. Offline serialization keeps it.
- The column header is sticky directly under the existing title bar, with 14 px,
  weight-700 text. Album/date labels and values use the existing tooltip renderer.
- Search icon centering, card text truncation, metadata wrapping and overflow passed.
- Enter/Space open Create playlist; closing restores focus to Create playlist.
  Tab and Shift+Tab preserve the expected control. Asynchronous native dialog closing
  was awaited before checking its final focus. Focus did not end on the document body.
- New hover feedback is finite; reduced motion disables the Create icon transition.
  Metadata and cover updates replace no focused controls. Existing themed effects were retained.

Validation: 66 playlist server tests, 726 portable client checks, the four-profile
`tests/music_playlist_metadata.cjs` check, and Windows/Android builds passed.
Existing native nullability/platform warnings remain outside this change.
The installed Windows assembly checksum matches the tested build. Its previous files
were retained in `.local/native-ui-review/playlist-updates/installed-backup/`.
The two server attribution changes were deployed with a backup and an HTTP-200 health
check after confirming the service had no active child work.

### Page and security checklist scope

These entries assess this change, not the entire deployed application.

| Checklist items | Status and evidence |
| --- | --- |
| 1, 7, 20 — personal data, necessary collection, deletion | Checked in the changed flow: one profile ID per new playlist entry, inside existing playlist storage/access/deletion; names/photos reuse existing profile data. No historical attribution was invented. |
| 2–6, 10–11, 16–18 — commercial/legal, consent and email flows | Not applicable to this change: no purchases, new forms collecting personal details, tracking, marketing or account flows. Existing system policies were not audited. |
| 8–9, 12 — SDKs, deceptive patterns, claims | Checked: no new dependency, analytics, external image service or quality/availability claim. |
| 13, 19 — imagery and assets | Checked: existing avatars/icons are reused; visible names supply meaning and avatar images are decorative. Cropping changes presentation only. |
| 14–15 — readable appearance and keyboard | Checked for affected labels, alignment, wrapping, visible focus, keyboard activation and restoration across the profiles above. This is not a complete contrast or accessibility certification. |
| 25–26, 35–36, 39–40, 53–54, 69 — authorization and untrusted data | Checked in affected code/tests: actor comes from the session; forged attribution is rejected; co-author permissions and revisions remain enforced; Razor escapes displayed names. No new request paths or cross-account cache keys. |
| 34, 49, 55, 65 — client data, fixtures, logs and internal access | Checked in the changed flow: no credentials added, browser fixtures are intercepted locally, screenshots/builds are ignored, and app/server access configuration is unchanged. |
| 70 — generated/changed code | Checked by source inspection, server/client tests, native builds and rendered checks. |
| 21–24, 27–33, 37–38, 41–48, 50–52, 56–64, 66–68 | Not applicable to the changed implementation: no database/query, authentication, upload, network-fetch, payment, AI, host, dependency or deployment-policy changes. Existing controls were not re-audited. |

### Coverage remaining

No prior central coverage ledger existed. Search, Library, Downloads, Settings,
Song review, Server stats, Leaderboard, Queue, Now Playing and connection/profile
screens were not re-reviewed for this revision; older records in `docs/NATIVE_APPS.md`
remain dated evidence. Additional 320 px, tablet, landscape, 200% text/zoom and
physical Mac/Android/iPhone checks remain open.
