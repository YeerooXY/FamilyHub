# Movies & TV 1.5.2 verification

This change was prepared from 1.5.1 (`563ebc8`). The checks below are ready for the lead to run. Browser runs, screenshots, and native verification are pending.

| Fixture profile | Coverage |
| --- | --- |
| Windows desktop Chromium | Headless browser at 1280 and 2000 CSS px. The fullscreen bridge is simulated in the Movies visual fixture. |
| macOS Safari | Desktop WebKit emulation at 1280 CSS px. |
| Android Chrome | Pixel 7 Chromium emulation with touch and a 390 CSS px visual viewport. |
| iPhone Safari | iPhone 13 WebKit emulation at 390 CSS px with touch and reduced motion. |

- `tests/movies_visual.cjs` holds the local fixture responses to capture the Movies billboard and shelves, season pills and episode stills, and film hero during loading. It compares loading and ready dimensions, checks overflow, and verifies that effects off and reduced motion stop the pulse. It also exercises Movie detail and player history replay. With the local Razor fixture URL, it checks the actual header arrows and focus when an arrow becomes unavailable.
- `tests/movies_player.cjs` simulates playback failure and verifies cursor hiding, pointer and keyboard recovery, and the visible, focusable retry action. It also checks the forced transcode request and diagnostic fields. `tests/movies_audio_tracks.cjs` covers the embedded default and explicit selection of an added DTS track.
- `tests/test_movies.py` checks the report log and its handling of malformed fields and private values. The portable C# checks cover tab, series, player and playlist history order, forward history after closing a detail, and branch reset.

The fixtures use intercepted requests or a local stub. Native Windows caption restoration after fullscreen, playback of *In Time (2011)*, screen-reader announcements and physical-device behavior remain unverified. Manifest and segment HTTP status is available through the hls.js loader.
