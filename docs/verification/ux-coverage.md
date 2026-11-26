# Interface verification

## 26 November 2026 Movie download options

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Torrent Download options, initial, cancelled, retry and submitted | never | never | never | never | never | Source check, 26 Nov 2026, current branch | never |

The existing release browser fixture exercises unchecked defaults, Escape, focus return, Tab, Space, Enter and retaining choices on retry. The dialog uses the shared native modal with immediate state changes and the existing release status messages. Rendered browser and physical-device checks are pending.

## 26 November 2026 Admin per-torrent seeding goals

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Admin Seeding summary, active, waiting, goal reached, stopped, stale and empty | never | never | never | never | never | Source check, 26 Nov 2026 | never |

The admin browser fixture covers the capped meter, real ratio, upload speeds, state order and active count. Headless execution and physical-device checks are pending.

## 26 November 2026 Movies & TV 1.6.0 details

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Film detail, backdrop and logo fallback, favourites, related films and release search | never | never | never | never | never | Source check, 26 Nov 2026 | never |
| Series detail, with and without cast, seasons and episodes | never | never | never | never | never | Source check, 26 Nov 2026 | never |

The film and series fixture suites cover headless Chromium and WebKit desktop and phone profiles. Browser execution, visual inspection and physical-device checks are pending.

## 25 November 2026 Admin torrent activity

| Screen and states | Layout and visual | Motion | Focus and keyboard | Accessibility | Wording and states |
| --- | --- | --- | --- | --- | --- |
| Admin sign-in, Downloads and Seeding | Six browser profiles. Inspected Windows Chromium, macOS Safari via WebKit, Pixel 7 and iPhone 13 profiles. | Summary meter transition plus reduced motion | Tab, Shift+Tab, Enter and Space. Sign-in and retry land on Downloads. | Named progress bars and live activity status checked. Screen-reader speech pending. | Active downloads, metadata, idle seeding, poster fallback, stale, empty and retry checked. Signed-in live browser and physical-device checks pending. |

[Screenshots](admin-torrents-2026-11-25). Run `node tests/admin_page.cjs docs/verification/admin-torrents-2026-11-25` from the repository. The live sampler recorded current percentages, transfer speeds and both seasons uploading. The deployed page and signed-out access checks passed.

## 25 November 2026 Movies & TV 1.6.0 Home

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Home, loading, empty library and retry | never | never | never | never | never | Source check, 25 Nov 2026 | never |
| Home title search, empty results and release handoff | never | never | never | never | never | Source check, 25 Nov 2026 | never |
| Movies settings, Layout preview, background style and preset colour | never | never | never | never | never | Source check, 26 Nov 2026 | never |
| Preview library and collection titles | never | never | never | never | never | Source check, 25 Nov 2026 | never |

`tests/movies_home_layout.cjs` measures five widths and covers normal motion, reduced motion and effects off. The visual fixture covers Chromium and WebKit profiles. Rendered checks and real-device verification are pending.

## 25 November 2026 Movies & TV 1.5.2

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Movies Home, series and film loading | never | never | never | never | never | Source check, 25 Nov 2026 | never |
| Movie player, fullscreen and retry | never | never | never | never | never | Source check, 25 Nov 2026 | never |
| Header history, including film, series, album and playlist details | never | never | never | never | never | Source check, 25 Nov 2026 | never |

[Fixture profiles and pending checks](movies-1-5-2-2026-11-25/README.md)

## 25 November 2026 Music loudness

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Music Settings, Even out song volume on and off | never | never | never | never | never | Source check, 25 Nov 2026 | never |

[Playback, test and device checks](loudness-2026-11-25/README.md)

## 25 November 2026 Home albums and radio

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Home Radio, loading, empty and retry | never | never | never | never | never | Source check, 25 Nov 2026 | never |
| Album details, loading, partial library, retry and ready | never | never | never | never | never | Source check, 25 Nov 2026 | never |

[Fixture and capture record](home-1-5-1-2026-11-25/README.md)

## 25 November 2026 Movies & TV 1.5.1

Layout, visuals, motion, focus and keyboard, accessibility, wording and states are pending for Movies Home and Downloading, film details, series and episodes, player recovery and the shared app status banner. The [fixture and capture record](movies-polish-2026-11-25/README.md) lists the profiles and checks.

## 25 November 2026 Movies browser suite

Round 3 passed 15 of 16 fixture tests across Movies Home, episodes, search, Downloading, player controls, volume, audio jobs, subtitles and quality negotiation. The popup test reached Leaderboard, where the fixture lacked the annual listening response on `/api/activity/stats`. The fixture source now serves that response. The rerun returned `spawnSync ... node.exe EPERM` before starting any browser tests. The rebuilt fixture still needs rendered Movies Settings checks for layout, visuals, motion, focus and keyboard, accessibility, wording and states. [Movies Home checks](movies-home-2026-11-24/README.md) and [player checks](movie-player-2026-11-24/README.md).

## 24 November 2026 · Movie fullscreen header

| Screen | Layout and visual | Motion | Focus and keyboard | Accessibility | Wording and states |
| --- | --- | --- | --- | --- | --- |
| Expanded movie player and return to Movies | Six browser profiles. Video covers the viewport and the shell header is hidden. | Idle and wake with standard and reduced motion | Tab, Shift+Tab, Enter, Space, Back and touch checked. Focus returns to the title. | Shell header and skip link leave the focus order. Screen-reader output pending. | Idle, controls awake, and exit checked. Native fullscreen and physical-device behavior pending. |

[Fullscreen screenshots and checks](movie-fullscreen-2026-11-24/README.md)

## 24 November 2026 · FamilyHub 1.4.0 Movies and admin

| Screen | Layout and visual | Motion | Focus and keyboard | Accessibility | Wording and states |
| --- | --- | --- | --- | --- | --- |
| Movies releases and Downloading | Six browser profiles, including 360, 768, 1280 and 2000 px | Standard-motion releases and reduced-motion iPhone fixture | Search, quality guide, download receipt, and audio action focus checked | Regions, disclosure and progress values checked. Screen-reader speech pending. | Results, unavailable downloads, and empty queue checked. Live acquisition pending. |
| Series and episodes | Same profiles, including missing artwork | Immediate disclosure with and without reduced motion | Enter, Space, Tab, Escape and touch checked | State labels and visible disclosures checked. Screen-reader speech pending. | Available, downloading, missing, retry and episode pictures checked. Live stills pending. |
| Admin sign-in and seeding | Same profiles | Meter transitions with standard motion and reduced-motion iPhone | Tab, Shift+Tab, Enter, Space, and retry focus checked | Named progress bars, sign-in fields, alerts and live status checked. Screen-reader speech pending. | Signed out, wrong password, non-admin, success, refresh failure and recovery checked. |

[Screenshots and verification commands](movies-polish-2026-11-24/README.md)

## 24 November 2026 · Add audio track

| Screen | Layout and visual | Motion | Focus and keyboard | Accessibility | Wording and states |
| --- | --- | --- | --- | --- | --- |
| Title details and Add audio track | Chromium and WebKit at 1280 px, Pixel 7 and iPhone 13 | Reduced motion checked. Normal motion pending. | Open, submit, close and return to the opener | Dialog names and form labels checked. Screen-reader speech pending. | Loading, source metadata, Hungarian default and success checked. Empty and server error states pending browser verification. |
| Player Audio and Subtitles | Same browser profiles | Reduced motion checked. Normal motion pending. | Track switch reapplies playback position and focuses the active radio. Keyboard and touch keep focus on Sync. | Dialog, radio and Sync control names checked. Screen-reader speech pending. | External language, one-track list and both directions of adjustment checked. Actual HLS timing pending. |
| On the server audio jobs | Same browser profiles | Reduced motion checked. Normal motion pending. | Delete confirmation, cancellation and success checked | Status role and confirmation labels checked. Screen-reader speech pending. | Completed job and source deletion checked. Live progress and server error states pending browser verification. |

[Audio track screenshots and fixture details](audio-tracks-2026-11-23/README.md)

## 24 November 2026 · Data saver

| Screen | Layout and visual | Motion | Focus and keyboard | Accessibility | Wording and states |
| --- | --- | --- | --- | --- | --- |
| Movie player settings | Chromium and WebKit at 1280 px, Pixel 7 and iPhone 13 | Reduced motion during reopen, normal motion pending | Enter, Escape and focus during a delayed rebuild and after quality selection | Dialog and radio names and selection state checked. Screen-reader speech pending. | Four levels, estimates, current resolution, loading and the one-time cellular hint checked. Stream failure still uses the existing recovery. |
| Movies settings | Same browser profiles in the Razor shell fixture | Reduced motion, normal motion pending | Focus visible on the select and saved choice verified after reload | Label and help association checked. Screen-reader speech pending. | Default and saved choice checked. Save errors pending. |
| Music settings | Same browser profiles in the Razor shell fixture | Reduced motion, normal motion pending | Space toggles the switch | Name and help association checked. Screen-reader speech pending. | Both switch states checked. C# tests cover cellular streaming and preloading policy. |

[Screenshots, emulation details and HEVC findings](data-saver-2026-11-23/README.md)

## 23 November 2026 · Server health dashboard

Reviewed in the Server work and release tile style on the `codex-downloads` working tree based on `efe74ef`.

| Screen | Layout and visual | Motion | Focus and keyboard | Accessibility | Wording and states |
| --- | --- | --- | --- | --- | --- |
| Server current readings and history | Inspected Windows Chromium and WebKit at 1280 and 2000 px and both phone profiles | Checked with normal motion and reduced motion | Checked range arrows, TV controls, chart tables, Retry, and focus restoration | Checked region, radio and table semantics, line patterns and temperature text. Screen readers remain unverified. | Checked readings, unavailable sensors, loading, stale snapshots, timeouts, Retry, empty history, and regular-profile navigation. |

The [verification record](server-dashboard-2026-11-23/README.md) includes screenshots and the emulation limits.

## 23 November 2026 · Movies search and YouTube cards

Windows Chromium and WebKit fixtures cover the open result lists, card layout,
keyboard and touch actions, late metadata, and download states. The
[verification record](youtube-cards-2026-11-23/README.md) has eight captures
and describes the emulated coverage and remaining device checks.

## 19 November 2026 — Playlist download status and song pickers

Headless Playwright measured and inspected the playlist header, live row status,
playlist menu, Create playlist and Add songs at 850, 1280 and 2000 px on Windows
Chromium and in emulated Mac Safari, Android Chrome and iPhone Safari profiles.
The [playlist download verification record](download-states-2026-11-19/README.md)
includes before and after screenshots, pixel measurements, focus and selection
checks, download regressions and the remaining physical-device coverage.

## 19 November 2026 — Accounts, settings and resilience

Account, settings, update, playback recovery and empty statistics checks used the
local fixture server, the Windows shell and four browser profiles. The
[verification record](accounts-resilience-2026-11-19.md) lists cases and device limits.

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

## 19 November 2026 · Shared music popups

The native music screens and their popups were rendered before and after in
Windows Chromium at 1280 and 2000 px, emulated Mac WebKit at 850 px, and emulated
Android Chromium and iPhone WebKit at 390 px. The record links full-viewport
captures, measured geometry, and keyboard and touch coverage.
[Popup verification](popup-unification-2026-11-19/README.md)

The popup profiles await a rerun with main 0.1.72 integrated.

## 20 November 2026 · Playback diagnostics

Settings was checked against a local server fixture in Chromium at 1280 × 840
and 390 × 840. Enter loaded the timings and kept focus on Refresh timings.
Tab reached the first play, Space opened its device and server events, and
Shift+Tab returned to Refresh timings. Fixture timings exercise presentation.
Physical phone playback, battery use, and metered-network performance remain open.

The Android exit reason sentence received a source wording check on 26 November 2026. Rendered layout, visual, motion, focus and keyboard, accessibility, and states checks are pending for this addition.

The combined native UI fixture passed the music popup suite at 1280 and
2000 px in Chromium, 850 px in WebKit, and 390 px in both Android Chromium
and iPhone WebKit emulation. The suite covers the Library and Downloaded
filters, playlist ownership, pins, recents and navigation focus, centered
playlist creation, the profile menu, review status filters, diagnostics,
and the annual comparison table and member selector. The annual table also
fit 320 × 720, 768 × 1024 and 844 × 390 without page overflow. The captures are in
`.local/task-tmp/combined-ui/`. Physical platforms, enlarged text and
assistive-technology output still require verification.

## 21 November 2026 · Movies & TV development client

The Windows app built successfully. Chromium exercised the movie client against the
Debian Jellyfin fixture from a separate local web origin. The 1080p sample advanced
during playback, switched audio, loaded two Hungarian WebVTT cues, and returned
focus to the selected title using Enter, Tab, Shift+Tab and Space. Catalogue content
fit 390 and 768 px widths. The keyboard playback path also ran at 1280 px.
The movie and family profile tests cover regular users, rejected admin sessions and
unlinked profiles. A later check used a 90-minute fixture with two independent
Chromium sessions. The same viewer resumed at 20:00 from both Continue watching
and a catalogue opened before the first device saved progress. Switching to
Hungarian audio preserved the position with native HLS and with the bundled HLS
player. A different viewer started at the beginning. Library
search found the 1080p film and the S01E01 episode by title on the live server.
Physical phone and projector playback,
screen-reader announcements, enlarged text, motion, visual review inside the
installed app, and the complete network recovery flow remain unverified.

## 21 November 2026 · Server work and annual listening

The merged development client passed the dashboard and annual profile-switch
flows in desktop Chromium and iPhone WebKit emulation. The recording-choice
flow also passed at 850 px in WebKit and 412 px in Chromium. Checks covered
keyboard opening, dismissal, selection, focus restoration, replacement errors
and retry, and preserving all nine metrics for one viewer. The desktop annual
panel was visually inspected. The Windows client built and the component suite
checked shared refresh and independent failure recovery. Physical device
behavior, enlarged text, screen-reader speech, and full motion coverage remain
unverified.

### Server work Seeding

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seeding list, loading, empty, stale and retry | never | never | never | never | never | Source check, 24 Nov 2026 | never |

The progress bar uses a native control with immediate updates. Loading, stale,
error and completion use live announcements. The section action keeps the
same button while its label changes. Windows Chromium, emulated Mac
Safari/WebKit, Android Chrome and iPhone Safari checks are pending.

## 21 November 2026 — Hub and version tracker

The Hub opened Daily Wordle and Music and returned to the app switcher on
1280 px desktop Chromium, Pixel 7 Chromium and iPhone 13 WebKit browser
profiles. The desktop glass cards and phone game board were visually inspected.
Settings version checks covered the installed build, release states, keyboard
navigation and reuse of one server update request across five browser profiles.
Physical devices, screen-reader speech and enlarged text remain unverified.

## 21 November 2026 — Daily Wordle

The Windows client build passed. The rendered MAUI components ran against the
local fixture in desktop Chromium at 1280 px, desktop WebKit at 850 px, emulated
Android Chromium at 390 px and emulated iPhone WebKit at 320 px. The board stays
within its available width. The fixture covered light and dark themes, physical
keys, touch keys, rejected and stale-device guesses, win results, family totals,
the reduced-motion setting, and focus through Tab, Shift+Tab, Enter, Space and
Escape. A finished game opened the next day's board at its scheduled reset and
restored focus after removing the result. Screenshot captures are in
`.local/task-tmp/wordle-native-review/`.

Marked tile and key text contrast is at least 5.55:1 in these palettes. Physical
devices, screen-reader speech, enlarged text and full-motion timing still need
verification.

The Wordle keyboard revision passed the same four browser profiles in both
themes. Tests measured the bottom row within 20 CSS pixels of the viewport
edge and checked white unused keys. With a four-second delay on every guess
save, the client rejected an unknown word and scored two consecutive rows,
including a repeated-letter guess, before the first save completed.

Family progress cards passed the four Wordle viewport checks with a two-profile
fixture. Checks covered the 30 cells per board, color marks, accessible profile
labels, keyboard position and guess submission. The API test verifies private
letters stay out of the family progress response.

The keyboard palette now follows the supplied reference. Current checks assert
white legends on gray unused keys in both themes and verify bottom alignment.

## 22 November 2026 — Hub navigation and library scrolling

Desktop Chromium checks measured the app switcher and music navigation icon
centers in expanded and compact layouts. Desktop Chromium and iPhone WebKit
loaded library rows in 50-song pages, restored 100 visible rows after clearing
a search, and reached the final partial page. Both opened Movies from the Hub
and retained the top bar. These checks used browser fixtures.

## 22 November 2026 — Wordle family statistics and settings

Desktop Chromium, desktop WebKit, Android Chromium and iPhone WebKit opened the
family statistics disclosures by keyboard. Before the player finished, the
disclosure showed historical favorite-guess counts and withheld today's rows.
After a win, it showed each letter and location in the submitted guess.
Desktop Chromium saved the spoiler setting with focus on the checkbox and
reopened Wordle with family boards hidden. API tests checked per-profile
persistence, CSRF, and exclusion of other players' current-day words and counts.
Captures are in `.local/task-tmp/wordle-settings-review/`. Physical devices,
screen-reader speech and enlarged text remain unverified.

## 22 November 2026 — Wordle board review and timing

The larger board dialog reflowed at 320 CSS pixels and up in Windows Chromium
and emulated desktop WebKit, Android Chromium, and iPhone WebKit. Clicking or
tapping outside restored the card's focus. Escape, Enter, Space, Tab, and
Shift+Tab were checked in the Wordle flow. Chromium opened a lucky result after
the reveal and an unlucky result with reduced motion, then returned focus to
Statistics on close. API tests covered remaining words, repeated letters,
spoilers, and foreground time across closed, expired, and replaced views.
Captures are in `.local/task-tmp/wordle-review-2026-11-22/`. Physical devices,
screen-reader speech, and enlarged text remain unverified.

## 22 November 2026 — Profile editor layout

The Windows build rendered the Profile editor in desktop Chromium, desktop
WebKit, Android Chromium and iPhone WebKit down to 320 CSS pixels. Screenshots
cover the initial form, a duplicate name, and a saved name. Checks measured the
gap between photo and field, label and feedback alignment, control height, and
overflow. Tab, Shift+Tab, Enter, and Space verified the rename flow and focus
retention. Captures are in `.local/task-tmp/profile-editor-review/`. Physical
devices, native photo selection, screen-reader speech, and enlarged text remain
unverified for this change.

## 22 November 2026 — Seek bar with decimal-comma settings

The Windows Razor build in a Chromium fixture reproduced `NaN:NaN` with a
Hungarian locale and a 317.5-second track before the fix. The same fixture passed
hover, click, drag, keyboard seek, and focus checks after the fix. The player bar
suite measured the track and tooltip across three desktop widths, desktop
WebKit, and emulated Android and iPhone profiles. The track remained visible
when given a malformed maximum and gradient. Physical Windows 10, the native
audio engine, and screen readers remain unverified for this change.

## 22 November 2026 — Profile feedback

Desktop Chromium, desktop WebKit, emulated Android Chromium, and iPhone WebKit
at 320 CSS pixels opened Feedback through the profile menu. Checks covered the
shared description field, category motion and reduced motion, filename and
thumbnail, full image viewing, keyboard focus, draft restoration after reload,
and retry after a failed send. Captures are in `.local/task-tmp/feedback-review/`.
API tests covered private report and image access, diagnostic redaction and
request correlation, duplicate submissions, developer replies, and closing a
thread. Physical devices, the native photo picker, screen-reader speech, and
enlarged text remain unverified.

## 22 November 2026 · Movies & TV billboard and shelves

The library now opens with a billboard for the title in progress (else the newest
movie with a backdrop), followed by horizontal shelves with pointer-only circular
chevrons, progress bars, Recently added and lazily loaded genre rows. Arrow keys
move between the billboard, rows and cards. `tests/movies_tracks.cjs` still
passes. `tests/movies_visual.cjs` rendered a dense mocked library in emulated
Windows Chromium (1280 and 2560 px), a 1920 × 1080 television profile, Pixel 7
Chromium, WebKit at 1280 px and iPhone 13 WebKit, with no page overflow and
working keyboard and chevron checks. Screenshots are in
`docs/verification/movies-ui-2026-11-22/`. The mock uses placeholder artwork. Real
posters from the Debian Jellyfin library, real macOS and iOS font rendering, the
LG television itself and a remote's directional pad remain unverified.

## 22 November 2026 · Movies full-screen mode

The Android app's WebView has no HTML fullscreen support, so the player's native
fullscreen button did nothing. The player now has a **Full screen** button that makes the
player cover the whole window (the browser's own fullscreen is tried first). The title
bar, track menus and Exit button hide after 3.5 seconds of inactivity while the film
plays and return on touch, pointer or key input; they stay while a keyboard-focused control is
inside them. Escape exits. Leaving the player, an audio change and a failed open all reset it.
`tests/movies_tracks.cjs` covers entering, Escape, focus return and tab order in desktop and
mobile Chromium and WebKit. The real 1080p film was checked on an emulated Pixel 7 in portrait
(412 × 839) and landscape (915 × 412), through the Debian Jellyfin server. A real Android phone,
automatic landscape locking in the WebView, and the Android Back button remain unverified.

## 22 November 2026 · Movies & TV player (supersedes the Full screen button above)

The player is now a custom, always full-window layout: centred title and a close control
at the top, a large play/pause between 10-second skips, a seek bar with the remaining
time, and Episodes, Audio & Subtitles and Next Episode below. Episodes and Next
Episode exist only for a title that belongs to a series; a film shows neither. Audio &
Subtitles and Episodes open as sheets with one named close control and return focus to
their button. Controls hide while the film plays; tap toggles them on touch and play on a
mouse; arrow keys seek, Space and Enter toggle play, and the TV remote's Back key closes.
`tests/movies_tracks.cjs` and `tests/movies_episodes.cjs` pass in desktop and mobile
Chromium and WebKit. The real 1080p film was driven on an emulated Pixel 7 (portrait and
landscape) and at 1920 × 1080 through the Debian Jellyfin server: play, pause, a 10-second
skip, the remaining-time label and the Audio & Subtitles sheet. Open items: subtitles
overlap the seek bar while the controls are visible; the Android Back button, a real
phone, an LG remote and a real series with several seasons remain unverified.

## 23 November 2026 — Wordle phone fit

Daily Wordle sizes its board from the play-area height (container units), so all six rows sit above the keyboard with no scrolling at 412x915, 390x844, 375x667 and 1280x800; Chromium and WebKit emulation, screenshots in `docs/verification/wordle-fit-2026-11-23/`. Real Samsung/iPhone check remains open.

## 23 November 2026 — Movie and TV requests

The [request screenshots](movie-requests-2026-11-23/) use Windows Chromium and emulated Mac Safari, Android Chrome (Pixel 7) and iPhone Safari (iPhone 13). Checked label alignment, title wrapping, no horizontal overflow and the empty library with both search actions. No icons were added.

`node tests/movies_web.cjs` checks Enter, Space, Tab, Shift+Tab, mobile taps, focus after a successful request, and focus on the retryable action after an error. It checks the iPhone profile with reduced motion enabled. Search and request updates appear immediately, with live status text for loading, success and errors. Python movie tests check request permissions, media IDs, all-season requests and duplicate handling against fixtures.

Open checks for this screen are physical-device layout and controls, native WebView keyboard behavior, screen-reader speech, and a live request through download, import and playback.

The exact search `Az ördög jobb és bal keze` preserved the Hungarian characters and selected *They Call Me Trinity* (1970, TMDB 9394) in the Seerr fixture. The [capture](movie-requests-2026-11-23/trinity-fixture.png) shows the original and the separately selectable 1971 sequel. On the live Debian server at verification time, Jellyfin returned only the 1971 sequel for that search, with one external Hungarian subtitle track. Seerr, Radarr, Sonarr and Bazarr were not running there. The browser test also verifies that refreshing while a request is pending cannot replace the row before its receipt arrives.

## 23 November 2026 — Release search

`node tests/movies_releases.cjs` renders the search panel with captured Prowlarr results for *Regular Show* Season 1. The interactive preview and four screenshots are in `.local/release-search-preview/`. Windows Chromium and emulated Mac Safari, Android Chrome and iPhone Safari cover wrapping, alignment, horizontal overflow, keyboard submission, Tab and Shift+Tab, touch disclosure, focus after closing, and reduced motion on iPhone. They also check that 1080p sorts first when it fits the upload time budget, and that increasing estimated upload time can put a smaller release first. The API test covers profile scope, partial source failures and private link handling. Native WebView layout, screen-reader speech and physical-device behavior remain open.

### 23 November 2026 · Release search in Movies title results

`node tests/movies_releases.cjs` now exercises the actual Movies view with a simulated Jellyfin session and the Season 2 release title from the supplied screenshot. Windows Chromium and emulated Mac Safari, Android Chrome and iPhone Safari covered the source actions, long titles, wrapping and overflow, keyboard focus, pending, empty, retry, and successful searches. The iPhone profile ran with reduced motion. The test checks that a smaller release leads when the 1080p pack exceeds the budget and that a cleared search ignores late results. Captures are in `.local/release-search-preview/`. Native WebViews, television width, real devices and screen-reader speech remain open.

### 23 November 2026 · Unified Movies search

The Movies fixtures cover a locally available season, a Season 2 request, a full-length YouTube link, and expandable torrent and trailer results from the same search. Chromium and WebKit checked the field and action layout at 1280px, 2000px, and phone widths. Captures in `.local/unified-search/` show Windows Chromium and emulated Mac Safari, Android Chrome and iPhone Safari, including search cards without artwork. The keyboard and touch checks cover Tab, Shift+Tab, Enter, Space, disclosure markers, retry, and focus after a request receipt or clearing a pending search. The iPhone profile uses reduced motion. Native-device input, physical TV navigation, screen-reader speech, and live acquisition remain open.

## Files screen (23 November 2026)

Emulated only: Chromium and WebKit, 412x915 and 1280x800, with a fake server behind the .NET bridge (`tests/files_view.cjs`, screenshots in `files-view-2026-11-23/`). Covered: list, tabs, breadcrumb, new folder, rename with a server error, delete and where focus lands, upload progress line, share-link sheet (password, one-off, copy), revoke, Escape and focus return, no sideways scroll. Never reviewed: television width, a real Android or iPhone file picker and share sheet, screen reader output, enlarged text.

## 23 November 2026 · Release downloads, server queue and subtitle search

The [verification record](downloads-2026-11-23/README.md) covers layout, focus, status wording and state changes in Chromium and WebKit. Windows WebKit playback and subtitle cues used fixtures. Live services, physical devices, native WebViews, screen-reader speech, text enlargement and standard-motion behavior remain open.

## 24 November 2026 · Videa in Movies search

`node tests/movies_web.cjs .local/videa-ranked` checks a late 720p Videa match ranking below 1080p results from YouTube and a torrent indexer. The Videa result shows its listed Hungarian audio and uses the existing Download action and server queue. Setting preferred audio to Hungarian advances the match in Best match and preserves resolution order in Quality. The captures cover Windows Chromium and emulated Mac Safari, Android Chrome and iPhone Safari. Checked alignment, wrapping, overflow, Tab, Shift+Tab, Enter, Space, touch activation, live status and focus after sending a download. Videa uses the existing release-card transitions. The iPhone profile uses reduced motion.

FamilyHub's Videa endpoint returned a match for `orult kigyasz` against the live site. Videa's live title search omitted episodes 2 and 3 of *Most Wanted – A hajsza*. Both pages opened from episode 1's related links, and `yt-dlp` read the available video metadata without downloading. The browser fixtures simulate Jellyfin and the app bridge. Physical-device layout, TV input, enlarged text, screen-reader speech and a live download through the deployed FamilyHub server remain open.

### 24 November 2026 · Videa season downloads

Both `Most Wanted A hajsza S2` and `Most Wanted A hajsza 2. évad` returned a season result with episodes 1–10 and a 360p–1080p range in a local FamilyHub API test against live Videa. The browser fixture in `tests/movies_web.cjs` checks one card, one batch request, one queue progress row, activation by Enter and touch, Tab and Shift+Tab, focus after receipt, and no horizontal overflow. Captures are in `.local/videa-season-card/` for Windows Chromium and emulated Mac Safari, Android Chrome and iPhone Safari. The physical-device and live-transfer checks above remain open.

## 24 November 2026 ? Native profile sign-in

The Windows Chromium fixture and emulated Mac Safari, Android Chrome and iPhone Safari show the selected avatar and password fields in one centered column. The captures are in `.local/profile-sign-in-review/`. Checked normal animation, reduced motion on iPhone, Enter and Space selection, touch, Tab and Shift+Tab, focus after Back and Escape, inline rejection, and completion into the app. The fixture uses fallback avatars and simulated server responses. Portable client tests cover saved sign-in after restart and removal after a rejected password, a reset, or Switch profile.

Physical Android and iPhone keyboards, macOS and iOS font rendering, native secure storage on physical devices, enlarged text and screen-reader speech remain open.
## 25 November 2026 · Server unavailable

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Outage audit and fixture scenarios](outage-states-2026-11-25/README.md) | never | never | never | never | never | Source check, 25 Nov 2026 | never |

The browser script covers emulated profiles. Captures, physical devices, and screen-reader speech remain pending.

## 26 November 2026 Native reload and server restart

| Screen and states | Layout | Visual | Motion | Focus and keyboard | Accessibility | Wording | States |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Crash, Reload, and foreground recovery | never | never | never | never | never | Source check, current working tree, 26 Nov 2026 | never |
| Server restart notice, reconnect, recovery, and outage | never | never | never | never | never | Source check, current working tree, 26 Nov 2026 | never |

