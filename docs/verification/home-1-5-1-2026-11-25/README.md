# FamilyHub 1.5.1 Home verification

Fixtures cover the Home radio shortcuts and album details from the `c80d17e2` working tree. The lead runs the checks and reviews the captures.

| Browser profile | CSS widths |
| --- | --- |
| PC Chromium | 1280, 2000 px |
| Mac Safari emulation (desktop WebKit) | 768 px |
| Android Chrome emulation (Pixel 7 / Chromium) | 320 px |
| iPhone Safari emulation (iPhone 13 / WebKit) | 390 px |

- `tests/music_native_similar.cjs` opens Home in the loopback Razor host, checks the album tile width and page overflow, plays a mix, opens an album by keyboard or touch, retries a lookup, checks the missing-song label, starts playback, and verifies that a completed download joins the queue. It checks focus through retry, playback and return to the opener, with reduced motion enabled. Home and album screenshots go to `.local/music-1-5-1/`.
- `tests/test_home_music.py` uses a mocked Deezer reader and a local Flask test client. It covers album pagination, caching, incomplete results, private playlist preparation, genre and time-of-day selection, queue deduplication and empty history.
- `clients/FamilyHub.Client.Core.Tests/Program.cs` uses an in-memory HTTP handler for album and radio response shapes, the device time offset and repeated preparation of the same album.

Rendered layout, visual appearance, motion, focus and keyboard, accessibility and state coverage are pending for Home Radio and album details. Wording was checked in source. Standard motion, physical devices, native WebViews and screen-reader speech remain open.
