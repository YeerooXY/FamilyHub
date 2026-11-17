# Search, queue and desktop update

Implemented 12 November 2026.

- Combined Play & search view includes results and Up next. Library remains separate.
- Search rows have an accessible Add to queue action. Explicit selections precede automatic recommendations and survive subsequent song selections; duplicate additions are ignored without moving focus.
- Single SVG tick: playable temporary server preview. Double SVG tick: permanent library import. Unsaved/unprepared rows use a download arrow. Status updates preserve existing row buttons and focus.
- Search preloading is independent of autoplay discovery. Up to eight results with known durations from 1 to 600 seconds are prepared. Existing bounded server cache may hold full source recordings; browser prefix cache fetches opening segments. Full cached originals are reused on selection. Search previews are temporary, not permanent library additions.
- Search loading uses skeleton shimmer and result entry motion; reduced-motion preference disables animations. Existing results remain usable while searching.
- Native WebView2 zoom controls and pinch zoom disabled; initial zoom reset to 1. Browser accessibility zoom outside the native app is unchanged.

Verification:
- Python suite: 91 tests, OK, four skipped. Added independent search preload, duration bounds and explicit queue-selection coverage.
- Four-profile browser suite passed, keyboard/focus and queue addition/deduplication checked. Screenshots inspected for Windows Chromium, Mac WebKit emulation, Android Chromium emulation and iPhone WebKit emulation. Physical Apple/Android checks remain open; Windows WebKit lacks audio decoding support.
- Saved badge regression passed with focus retained.
- Prefix regression passed: opening segments fetched before selection, reused on Play, continued playback, 305ms synthetic startup despite 2s import-promotion delay. This is a controlled test, not a guarantee for uncached internet sources.
- Native build passed; installed smoke run confirmed audible media advancing, zoom factor 1, zoom controls false, pinch zoom false.
- Music web service alone restarted; deployment health 200. Tailscale and Paddock untouched.

Evidence: .local/music/search-player-tests.log, search-player-desktop.json, search-player-deployment.json; .local/music-browser/browser-results.json and platform screenshots.

Scope review: no new third-party dependencies, authentication/storage boundaries unchanged; queue endpoint retains authentication/CSRF/generation limits and validates new boolean flags. Search metadata remains textContent-only. New controls have accessible names and keyboard operation. Existing privacy details updated for temporary preloading and tick meanings. No commerce, payment, email or new personal-data collection introduced. This is a scoped change review, not a new whole-product security certification.


## Follow-up: visible results and queue order

Deployed 12 November 2026. Selection now queues the rows after the selected song, preserving explicit additions. Recommendations append; they do not jump ahead. Library selections follow the visible filtered library. Search typing waits 450ms, cancels stale responses and has a 44px clear button. Infinite scroll fetches additional provider batches beyond the first thirty results (until exhaustion or the 3,000-result service limit).

Search has no heading/count clutter, lower queue list, right-hand Now playing rail, or visible scrollbar. Long mixes are in Settings. Rows are 104px desktop / 88px mobile, with larger bottom-player text and a blue background. Native Music/Account menus and the old window frame are replaced by a dark draggable/resizable caption and an ellipsis menu preserving account/reconnect actions.

Preloading extends the existing coordinator and browser prefix cache. Visible eligible rows (up to sixteen, known duration at most ten minutes) enter the same job queue, following the immediate next song. Completed temporary jobs survive viewport changes and are reused. Background loudness measurement now joins the existing analysis phase behind pending preview preparation; selected imports still measure loudness. No second acquisition path or audio cache was added.

Observed baseline before deferring background measurement: first 50 Cent preview ready at 9.10s, second 32.40s, third 55.78s, fourth 82.24s; four of twelve ready at 90s. Estimated twelve-preview preparation at that observed rate: roughly 4?5 minutes, not measured completion. Original source-cache presence was not exhaustively classified; the HLS jobs were fresh. Revisit test: nine immediately ready, tenth at 2.06s; ten of twelve ready after 20s. The post-deferral cold throughput improvement has not been measured, so no speedup percentage is claimed. Evidence: .local/music/viewport-preload-live.json and viewport-preload-revisit.json. Upstream extraction and whole-file encoding still make uncached preparation slow. Browser opening-cache regression remains about 306ms with a controlled 2s promotion delay.

Library genre pills use cached MusicBrainz artist tags mapped to broad categories, plus a text filter. Artist identification prefers actual metadata, then artist-title prefix over the uploader. Unmatched/ambiguous entries are Unsorted. This is artist-level categorization, not per-song acoustic classification. Artist-name lookup is disclosed in Settings. Source: https://musicbrainz.org/doc/MusicBrainz_API/Search/ArtistSearch

Verification: 97 Python tests passed, four skipped. Browser regressions cover typing search, sequential skip order, viewport preloads, additional pages, clear-button focus, Settings focus, saved badges and prefix reuse. Four platform-profile layout/keyboard checks passed with screenshots inspected; Mac, Android and iPhone are emulated, physical-device checks remain. Windows native build/self-test/smoke passed and actual app screenshot inspected. Live typo search '50 centy' put a 50 Cent album track first; offset 30 returned eight further results with cursor 38. Music service only restarted; Tailscale and Paddock untouched.

Delegation: gpt-6.1-sol medium implemented template/CSS/icons and visual checks. Antigravity StudentAnti claude-opus-5-5-medium task 735d460c-c7b5-42d0-b864-c57a1fc72217 failed with no final answer or source changes; the lead performed code investigation and live timing measurement. No automatic retry or alternate paid research task was started.

## Continuous star background and simultaneous listeners

12 November 2026: replaced separate panel fills with one dark navy background and a lightweight static SVG star texture. Navigation, workspace, gutters and bottom player share the canvas; native caption/backing color matches. No animation loop or dependency added.

Four browser-profile layout/keyboard checks passed; screenshots inspected for Windows Chromium, desktop WebKit, Android Chromium and iPhone WebKit. Mac/phone checks are emulated; physical-device rendering remains unverified. Native build, self-test and installed playback smoke passed, live screenshot inspected, app reopened. Only the music web service restarted; Paddock and Tailscale unchanged.

Live prepared-stream test over Tailscale: two simultaneous listeners started in 270–285ms; three started in 275ms each. Both phases ran 20 seconds with zero post-start waiting events and no fatal playback errors. Three isolated Chromium sessions on one Windows PC used two distinct existing accounts; the third account could not sign in, so one account was reused. Audio was muted; time progression was measured. This is a short prepared-stream load check, not a physical-device or sustained capacity guarantee.

Preparation remains a separate limitation: simultaneous selection returned HTTP 202, 409, 202. The cross-account preparation guard rejected one request. An initial attempt also timed out after one same-account selection superseded another; sequential preparation allowed the streaming test to proceed. No acquisition/coordinator changes made here. Downloaded originals may still require HLS preparation; a prepared stream is what delivered the measured fast starts.

Evidence: .local/music/listener-load-test.json, stars-deployment.json, stars-desktop.json and stars-desktop.json.png; .local/music-browser/browser-results.json and four profile screenshots.

## Search row spacing and immediate selection

12 November 2026: bottom player uses a near-black surface. Search is centered at a maximum width of 1120px with wider desktop margins; desktop row heights fit ten rows in the content viewport (56px minimum for short windows), while mobile retains 88px touch rows. Infinite scrolling and the existing preview coordinator remain unchanged. Search durations are hidden. The queue plus button shares the row highlight. Selection feedback updates synchronously before any audio fade or preparation; playing indicators still represent actual playback. Storage-state changes animate opacity/scale for 320ms and respect reduced motion.

Verification: four-profile browser suite passed, screenshots inspected for Windows Chromium, desktop WebKit, Android Chromium and iPhone WebKit. Added checks for ten-row geometry, contained queue action, hidden duration and synchronous selection. Keyboard/focus and playback regressions passed. Mac/phone checks are emulated; physical-device checks remain. Deployment health 200, music service only. Evidence: .local/music/search-rows-deployment.json and .local/music-browser/browser-results.json plus profile screenshots.

## Full-width player and seek focus repair

12 November 2026: desktop player extends through the 8px shell gutters. Added an explicit assertion that its bounds reach both viewport edges; the previous screenshot review missed this gap. Seek progress now pauses updates only during pointer dragging, instead of for the entire time the range retains focus. Pointer release/cancel and blur resume updates while preserving keyboard focus. Four browser-profile regressions passed, including focused seek progression, drag protection and release; screenshots inspected. Mac/Android/iPhone checks are emulated, with physical-device checks outstanding.

Switching investigation: the existing MusicPrefixCache already warms opening segments locally. Server originals and prepared HLS streams are distinct; saved status alone does not prove preparation readiness. Unbuffered switching also awaits the deliberate 190ms smooth-pause path. Full local downloads would remove network fetches but not decoding, preparation bugs or fade timing. No second download/cache system added and no new switching latency improvement claimed. Evidence: .local/music/player-seek-deployment.json; .local/music-browser/browser-results.json and screenshots.

## Autoplay identity and listening history

12 November 2026. Research: Spotify describes listening, skipping and saving as taste-profile signals, and recent-play memory for fewer repeats (https://www.spotify.com/uk/safetyandprivacy/understanding-recommendations/plain). Spotify Research separates session context from longer-term preferences (https://research.atspotify.com/2021/4/contextual-and-sequential-user-embeddings-for-music-recommendation). MusicBrainz identifies recordings independently of release tracks (https://musicbrainz.org/doc/Recording). These sources describe useful principles, not Spotify's proprietary duplicate-detection code.

Implemented a small deterministic metadata identity/history module, using the existing queue and prefix cache. Recommended search playback no longer copies the following search rows. Explicit Queue order retains that behavior; both automatic paths remove alternate uploads by normalized artist/title. Feature credits, uploader presentation labels and bracketed versions are normalized; this intentionally groups radio/album variants for autoplay. Search results remain unchanged and manual queue additions take precedence. Artist/genre/tempo scoring remains, with bounded artist affinity from listening and queue/skip events. No new provider, model service, download path or background job system.

History is browser-local and account-scoped, survives reload, retains at most 500 events for 90 days, and can be cleared in Settings with focus retained. Meaningful playback counts after 30 seconds (or 80% of a shorter song), measured from small advancing time deltas rather than seek position. Early explicit skips after 2–30 seconds are negative signals. Automatic candidates exclude meaningful listens for 24 hours and early skips for seven days; manual choices override this. There is no cross-device history sync yet. Heuristic matching can miss mislabeled uploads or group distinct versions; no audio fingerprint or reliable ISRC metadata is available. Exhausted eligible pools are not silently reset to repeat recent songs.

Verification: Node identity/deduplication, history persistence, expiry, account isolation and corrupt-storage tests passed. Four browser-profile tests cover integration deduplication, recent-play exclusion, manual queue override and clear-history keyboard focus; playback/seek/queue and layout regressions passed. Windows Chromium plus emulated desktop WebKit/Android Chromium/iPhone WebKit; physical-device verification remains. Evidence: tests/music_recommendations.cjs, tests/music_browser.cjs, .local/music-browser/browser-results.json and listening-history screenshots. Deployment record: .local/music/autoplay-history-deployment.json.

## Queue entry and replay history

12 November 2026: the entire bottom-left song area is one accessible Open playback queue button, including cover, title and next-song text. Opening it scrolls to the top and focuses the queue heading. Current song is shown before upcoming songs; Previously played expands recent session tracks and persisted meaningful listens (up to 100 distinct sources, newest session first). Clicking an earlier track plays it through the existing player while retaining upcoming entries. Current/history rows update on track changes, preserving focus when a replayed row disappears. Clear history also clears the session replay list.

Four browser-profile tests passed: keyboard entry, current-first rendering, history expansion/replay and focus after updates, alongside existing queue/seek/playback tests. Screenshots inspected for Windows Chromium, desktop WebKit, Android Chromium and iPhone WebKit; Mac/phone checks emulated, physical-device checks remain. Evidence: .local/music-browser/*-queue-timeline.png, browser-results.json, .local/music/queue-timeline-deployment.json. Music service only restarted.

## Storage direction and next playlist import

User decision, 13 November 2026: acquisition saves to the shared server by default. Download to this device should be explicit, persistent and usable offline. The desktop interface must eventually open locally when the server is unavailable; the current remote WebView shell does not meet that requirement. Temporary segment caching is not offline-download support.

Next requested feature: Spotify playlist import. Treat Spotify as a source of track metadata and playlist order, then match recordings through FamilyHub's existing acquisition sources, reuse saved recordings and expose unmatched/ambiguous tracks. Do not imply Spotify encrypted audio is being extracted. Default destination remains server; optional device downloads are a separate action. No importer is implemented yet. Awaiting a sample playlist link and public/private status to verify access before choosing the metadata integration. Current repository has no Spotify connection/configuration. Spotify's February 2026 migration guide documents changed development-mode access and playlist endpoints: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide . Private playlist access requires an authorized connection, not credentials pasted in chat.

## Spotify playlist import

13 November 2026: implemented public playlist metadata import from Spotify's embed page. This supersedes the preceding pending-import note. Library > Playlists accepts a full HTTPS Spotify playlist link, shows the public entries in order, finds candidate recordings with the existing search, and saves selected recordings to the shared server. Candidates require matching title/primary artist and close duration to be suggested; remixes, speed changes, bass boosts and other labeled edits are excluded unless requested by the source title. Users can review/select another candidate or leave an entry unselected. Public embed data can be incomplete and private playlists require a future authorized connection; no anonymous token is used and no Spotify audio is extracted.

Playlist metadata and matched-source choices persist in account-separated server JSON files. Downloads reuse the single existing coordinator and original-file cache. Playlist jobs are protected from viewport/preload reconciliation cancellation. Batch advancement runs in the open client; closing it leaves the current server job running and completed entries remain resumable. Stop finishes the current song then stops advancing. Imported playlist repetitions are explicit queue entries, so recommended-autoplay deduplication does not remove them; repeated audio reuses the same saved file.

Validation: five new backend tests cover allowed link hosts/schemes, unavailable metadata, ordered repeated entries, conservative matching, user isolation and job integration. All 26 existing web/backend tests passed. Four browser-profile tests cover importing, matching, saving and layout alongside existing playback/queue/focus regressions; screenshots inspected. Mac/Android/iPhone checks are emulated, physical-device checks remain. Evidence: tests/test_music_playlists.py, .local/music-browser/*-playlist-import.png, browser-results.json, .local/music/playlist-import-deployment.json.

The previous 502 was caused by absent Windows SSH forwards, not a stopped music service. Restored the existing localhost ports 18765 and 14533 using strict host-key verification and hidden SSH; Tailscale's settings and process were unchanged. These forwards are still not boot-persistent. Offline local interface/device downloads remain outstanding and are not delivered by this importer.

Live sample result: larp (3ZOpGHzrl9qpQ3qTSxn5Nl) imported with 13 of 14 entries saved to the server, representing 12 unique recordings because MOKKA occurs twice. BE VAGYOK ZARVA remains unselected: Spotify lists 132 seconds while the available candidate is 182 seconds. Final deployment health and authenticated playlist persistence both returned HTTP 200 after the music service restart. Latest four-profile screenshots inspected; no new overflow found. Evidence: .local/music/spotify-playlist-import.json and spotify-playlist-matches.json.
