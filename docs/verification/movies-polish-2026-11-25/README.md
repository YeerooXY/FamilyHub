# Movies & TV 1.5.1 verification

Fixture execution and screenshot inspection are pending with the lead. The captures will use local artwork, intercepted Jellyfin requests and simulated app responses.

| Profile | Fixture coverage |
| --- | --- |
| Windows Chromium | Headless at 1280, 1920 and 2000 CSS pixels, plus narrow and tablet widths |
| Mac Safari | Desktop WebKit emulated on Windows |
| Android Chrome | Pixel 7 Chromium profile emulated on Windows at 390 CSS pixels |
| iPhone Safari | iPhone 13 WebKit profile emulated on Windows with reduced motion |

`movies_visual.cjs` writes Home, status banner, detail, series, recovery and phone card captures here. It checks layout overflow, shelf deduplication, the independent download label, the banner's live region and unchanged focus, both episode metadata sources, season picker scrolling, and Tab, Shift+Tab, Enter and Space. Opening and returning from title details uses a 200 ms ease-out fade and slide. The new screen receives focus immediately. Reduced motion and effects off show it immediately without animation.

`movies_player.cjs` writes the player error captures here. Its fixture rejects direct play, waits for the server HLS request, returns a stream error and checks the retry action and focus. `movies_downloads.cjs` checks active jobs and the strip geometry. `movies_audio_tracks.cjs` checks completion, source deletion and focus in title details. `movies_episodes.cjs` checks season selection and player navigation.

Physical Mac and phone rendering, native keyboard and remote behavior, screen-reader speech and In Time playback on the owner's Jellyfin server remain unverified.
