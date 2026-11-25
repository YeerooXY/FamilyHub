# Movie player verification

PASS records the last completed browser round, which passed 15 of 16 tests. The rerun after the popup fixture fix hit `spawnSync ... node.exe EPERM` before starting any test. Captures in this folder are from earlier runs.

- `movies_player` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_visual` PASS. Chromium at 320, 768, 1280, 1920 and 2000 px, desktop WebKit at 1280 px, Pixel 7 Chromium at 390 px and iPhone 13 WebKit with reduced motion.
- `movies_episodes` PASS. Chromium at 768, 1280 and 2000 px, desktop WebKit at 1280 px, Pixel 7 at 360 px and iPhone 13 with reduced motion.
- `movies_audio_tracks` PASS. Chromium and WebKit at 1280 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_subtitles` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_autosubtitles` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_sound` PASS. Desktop Chromium, touch Chromium and 1920 px Chromium with a TV user agent.
- `movies_data_saver` PASS. Chromium and WebKit at 1280 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_tracks` PASS. Desktop Chromium and WebKit, Pixel 7 Chromium and iPhone 13 WebKit.
- `movies_web` PASS. Desktop Chromium and WebKit, Pixel 7 Chromium and iPhone 13 WebKit.
- `movies_downloads` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_releases` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_youtube` PASS. Chromium and WebKit at 1280 and 2000 px, each with Pixel 7 and iPhone 13 device profiles.
- `movies_genre_shelves` PASS. Desktop Chromium, Pixel 7 Chromium and iPhone 13 WebKit.
- `movies_typing` PASS. Desktop Chromium and WebKit at 1280 px.
- `music_popup_unification` pending a fixture rebuild and rerun. Configured for Chromium at 1280 and 2000 px, desktop WebKit at 850 px, Pixel 7 Chromium and iPhone 13 WebKit.

Playback controls fade in or out over 250 ms with ease when input wakes them or after three idle seconds. New input interrupts the fade. A visible keyboard focus ring or an open popover holds the controls awake. The focused transport control stays in the document while idle. Test focus after Tab, Shift+Tab, Enter and Space, and after closing the popover with Escape or an outside click.

Subtitles move above the seek row over 200 ms with ease as the controls wake. Volume expansion uses a 160 ms ease when hovered or keyboard-focused. Reduced motion removes these transitions and the spinner rotation while idle hiding still runs. Menus open and close immediately. Opening focuses the close button or the current track or episode. Closing restores the opener. The search status and buffering indicator use live status text.

Movies Settings captures and checks still need the rebuilt Razor fixture. Landscape phones, native WebView2 taskbar behavior, screen-reader speech and physical devices remain pending. Earlier captures are recorded in the [fullscreen header checks](../movie-fullscreen-2026-11-24/README.md).

The control layout draws on Netflix's playback shortcuts, hover volume and combined track chooser, and Prime Video's playback track selection. [Netflix shortcuts](https://help.netflix.com/en/node/24855), [Netflix sound controls](https://help.netflix.com/en/node/468), [Netflix track selection](https://help.netflix.com/en/node/25079), [Prime Video accessibility](https://digprjsurvey.amazon.com/csad/help/node/GUDJ59LP3GNG49G7).
