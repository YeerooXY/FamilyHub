# Playback, discovery and interface verification ? 12 November 2026

Implemented and deployed to the private music service. Existing Windows app uses the same service/UI. Original audio remains unchanged.

## Playback

Content-addressed measurements use FFmpeg integrated loudness/true peak and -50 dB boundary silence detection, preserving 80 ms at each cue. Track gain targets -16 LUFS, capped at +12 dB and -1.5 dB true peak headroom. Unknown tracks begin at a conservative -6 dB until measurement is available; measurements are cached after complete audio is validated. Internal musical pauses are retained. Full duration comes from catalogue/validated metadata rather than a growing HLS snapshot.

| Saved recording | Leading silence measured | Playback cue | Gain |
| --- | ---: | ---: | ---: |
| 4 Strings ? Take Me Away | 1.449 s | 1.369 s | +4.66 dB |
| Lady Gaga ? Bad Romance (Lyrics) | 0.348 s | 0.268 s | -8.45 dB |
| Martin Garrix & Dua Lipa ? Scared To Be Lonely | 3.022 s | 2.942 s | -6.29 dB |

Reproduced HTTP 410 fragment failures before the fix. Preview eviction now uses one priority policy, protects current/next and recently accessed audio, and updates queued priority when queue order changes. Crossfade waits for actual incoming media-clock progress after seeking, uses incoming playback progress for its ramp, preserves its deck/position on promotion and respects measured end cues. Manual Next crossfades when the target deck is prepared; otherwise the old song fades out before replacement. Pause/resume uses a 180 ms output ramp. No unrelated-song fallback was introduced.

Live Chromium tests: both decks had measured audio during automatic 4 Strings ? Bad Romance and manual Next ? Scared transitions (37 and 39 overlapping 100 ms samples). Incoming playback continued for 6.5 seconds after each handoff without resetting. No fatal HLS, media HTTP404/410 or page errors. Evidence: `.local/music-browser/live-audio-result.json` and `live-audio-fixed.png`.

## Discovery and startup

Artist-based recommendations run when selecting a new artist, rather than waiting for the library queue to empty. No claim of measured genre compatibility. Initial Player queue includes saved songs; Play starts it, and mix ordering remembers the previous artist. Search caches 30 provider results and exposes pages of 8/8/8/6. Long compilations/albums follow single-song candidates. Scrolling loads more; a keyboard-accessible Show more songs control remains. Up to eight search results are prepared at a time, behind playback/up-next work. Later pages replace the search preview batch. These are bounded background acquisitions, not an exact ten-second-only download implementation.

Progressive acquisition reuses yt-dlp extraction metadata through a private bounded temporary JSON file, eliminating the second normal-path extraction. yt-dlp may re-extract on a download failure. Cached recordings reuse validated originals.

Single live observations (not latency guarantees): saved Michael Jackson Don't Stop Til You Get Enough crossed RMS .005 in 0.555 s. Previously unsaved official NEFFEX Grateful (83RUhxsfLWs) began audible playback at 7.491 s, before its library import completed at 19.563 s. Cold network playback remains a limitation; preloading can hide the initial wait. Discovery selected an unsaved Michael Jackson audio track first. Pagination returned 30 unique results. Discovery test suppressed background queue downloads, so it does not establish concurrent preloading performance. Evidence: `.local/music-browser/live-discovery-startup-result.json` and `live-cold-neffex-result.json`.

## Interface and agents

Centered transport and search icon, current-row highlight/animated equalizer, Up next marker, larger search rows, avatar-only profile menu with Settings. Internal statuses remain accessible to screen readers; retry/cancel recovery controls remain visible on failure. No imported-file UI was added.

Two Codex workers handled bounded UI/search changes and a Codex worker independently exercised live audio. User-requested Claude Code route was signed in through claude.ai Pro; model alias sonnet resolved to claude-sonnet-5-5 with medium effort. It changed only shell.css for original hover/press, navigation, profile, cover and loading motion. No permission denials. Reduced-motion and coarse-pointer rules included. Evidence: `.local/music/sonnet-motion-result.json`.

## Checks and limits

83 Python tests passed, 4 optional/environment tests skipped. Browser recovery verifies growing playlists, audible crossfade, pause ramps, manual skip continuity, natural autoplay, failed-next preservation and stable deck reuse. Four browser profiles passed focus/keyboard (Tab, Shift+Tab, Enter, Space, Escape), overflow, profile menu, icon alignment and search row checks. Screenshots inspected for Windows Chromium, emulated Mac WebKit, Android Chromium and iPhone WebKit. WebKit on this Windows host lacks audio support: actual Mac/iPhone playback and physical-device rendering remain unverified. Windows Chromium/live audio and the installed native app are separate checks. Final native smoke result: `.local/music/volume-desktop-smoke.json`.

Deployment backups and file hashes: `.local/music/volume-deployment.json`. Only familyhub-music-web.service was restarted; Tailscale, Paddock and the VM were not restarted. Existing app sessions may need Music ? Reconnect.


## Opening-chunk preload follow-up

Added page-local opening audio cache (`prefix-cache.js`), bounded to 8 MiB and two concurrent prefix readers with a two-minute lifetime. Once server HLS is available, upcoming/search previews fetch initialization and roughly six seconds of audio beyond the measured start cue, capped at twelve seconds. HLS consumes those exact in-memory bytes when selected; growing playlists are always refreshed rather than cached. Selected prepared recordings start before the promotion API returns. Active MSE playback buffers roughly twelve seconds ahead in two-second segments. The server still completes and validates the original file; this change controls client buffering, not partial-only server storage. Native-HLS-only browsers retain their native buffering path.

Moved the existing Mix/Shuffle icon to the right player controls (beside volume on desktop; right of transport on phones). Keyboard focus order remains DOM-based.

`node tests/music_prefix.cjs` verified prefix arrival before clicking, absence of whole-track background fetch, no duplicate init/opening requests, continued playback and 300 ms startup with an intentionally delayed 2000 ms promotion API. This is a controlled browser test, not a cold-network latency claim. Recovery and four-profile browser checks passed; screenshots inspected. Physical Apple/Android checks remain open. Deployed UI/static files only with no service restart; `.local/music/prefix-deployment.json` records hashes/backup. Completely new sources still require upstream preparation before any prefix can be cached.
