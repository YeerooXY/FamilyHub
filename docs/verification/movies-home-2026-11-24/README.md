# Movies & TV verification

The fixture uses local artwork and video, intercepted Jellyfin requests, and simulated bridge responses. It includes a six-season series with seasons 1 and 2 available, missing artwork, a long title, a failed library lookup, an empty library, and active and duplicate completed audio jobs.

`tests/movies_visual.cjs` writes captures in this folder by default. It covers loading, home, title details, failed library lookup, available and missing seasons, release search, home recovery, the empty library, player controls, and the track sheet. The fixture checks shelf width, equal poster dimensions, directional focus, focus return, the 60 px television targets, season selection, background import, and the Windows fullscreen bridge.

PASS records the last completed browser round, which passed 15 of 16 tests. The rerun after the popup fixture fix hit `spawnSync ... node.exe EPERM` before starting any test. Captures in this folder are from earlier runs.

- `movies_visual` PASS. Chromium at 320, 768, 1280, 1920 and 2000 px, desktop WebKit at 1280 px, Pixel 7 Chromium at 390 px and iPhone 13 WebKit with reduced motion.
- `movies_web` PASS. Desktop Chromium and WebKit, Pixel 7 Chromium and iPhone 13 WebKit.
- `movies_downloads` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_releases` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_youtube` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_genre_shelves` PASS. Desktop Chromium, Pixel 7 Chromium and iPhone 13 WebKit.
- `movies_typing` PASS. Desktop Chromium and WebKit at 1280 px.
- `movies_player` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_episodes` PASS. Chromium at 768, 1280 and 2000 px, desktop WebKit at 1280 px, Pixel 7 Chromium at 360 px and iPhone 13 WebKit with reduced motion.
- `movies_audio_tracks` PASS. Chromium and WebKit at 1280 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_subtitles` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_autosubtitles` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_sound` PASS. Desktop Chromium, touch Chromium and 1920 px Chromium with a TV user agent.
- `movies_data_saver` PASS. Chromium and WebKit at 1280 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_tracks` PASS. Desktop Chromium and WebKit, Pixel 7 Chromium and iPhone 13 WebKit.
- `music_popup_unification` pending a fixture rebuild and rerun. Configured for Chromium at 1280 and 2000 px, desktop WebKit at 850 px, Pixel 7 Chromium and iPhone 13 WebKit.

Physical devices, screen-reader speech and native Windows taskbar behavior remain pending. [Player verification](../movie-player-2026-11-24/README.md)

Loading and season swaps use immediate replacement. The home live region announces loading and completion, and focus moves to the library landmark when the initial view opens. The season selector keeps focus during a switch. Shelf arrows fade over 180 ms on hover or focus, reverse on pointer exit, and switch immediately with reduced motion.

Layout references [Netflix title information and rows](https://www.netflix.com/tudum/articles/netflix-new-tv-layout) and [Prime Video featured artwork and title cards](https://www.aboutamazon.com/news/entertainment/prime-video-updated-steaming-experience).
