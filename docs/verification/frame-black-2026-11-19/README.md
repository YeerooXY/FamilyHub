# Desktop frame verification · 19 November 2026

FamilyHub 0.1.71 desktop frame, Home, Search, and player. Captures use synthetic tracks and artwork with reduced motion. The browser captures render the app's Razor components in a local Blazor host. The Windows Chromium profile reserves 144 CSS px for caption controls.

| Browser profile | Viewport in CSS px | Scale | Search width before → after | Input height | Capture |
| --- | --- | ---: | ---: | ---: | --- |
| Windows Chromium | 1280 × 901 | 100% | 602 → 402 px | 40 px | [Screenshot](windows-1280.png) |
| Windows Chromium | 2000 × 1061 | 100% | 602 → 402 px | 40 px | [Screenshot](windows-2000.png) |
| Windows Chromium | 850 × 641 | 100% | 424 → 279.4 px | 40 px | [Screenshot](windows-850.png) |
| Windows Chromium | 850 × 641 | 125% emulated | 424 → 279.4 px | 40 px | [Screenshot](windows-850-dpr125.png) |
| Windows Chromium | 1280 × 901 | 150% emulated | 602 → 402 px | 40 px | [Screenshot](windows-1280-dpr150.png) |
| Mac Safari profile, WebKit on Windows | 1440 × 901 | 200% emulated | 602 → 402 px | 48 px | [Screenshot](mac-safari-emulated.png) |
| Android Chrome, Pixel 7 profile | 412 × 839 | Emulated | 232 px | | [Screenshot](android-chrome-emulated.png) |
| iPhone Safari, iPhone 13 profile | 390 × 664 | Emulated | 210 px | | [Screenshot](iphone-safari-emulated.png) |

All desktop captures contained **zero non-black pixels** in each of the last four image rows. Samples at the centers of the two outer gutters, the gap between panels, and the gutter above the player were `#000000`. The 850 px run repeated the gutter checks with effects enabled for all 11 theme palettes. Both panels retained their gradients and star canvases.

Desktop artwork, transport, and seek row moved down 5 CSS px. The tooltip kept its 9 px gap from the track and its pointer and keyboard alignment. The active-device and remote-player status rows use green text on black. At 850 px, Shift+Tab from search reached the submit button, Tab returned to the input, and Enter showed the matching fixture track. Clearing the query returned focus to search.

## Windows build

An isolated WinUI/WebView2 build used fixture session data, a separate instance name, and a temporary browser profile. Captures used the real Windows window at 96 DPI. Win32 `PrintWindow` included the native frame and caption buttons, and separate WebView captures verified the client pixels and panel gutters.

| Window state | WebView viewport in CSS px | Window capture in physical px | Non-black pixels on final row, window / WebView | Capture |
| --- | --- | --- | --- | --- |
| Restored | 850 × 641 | 852 × 642 | 0 / 0 | [Screenshot](native-window-850.png) |
| Restored | 1280 × 901 | 1282 × 902 | 0 / 0 | [Screenshot](native-window-1280.png) |
| Restored | 2000 × 1061 | 2002 × 1062 | 0 / 0 | [Screenshot](native-window-2000.png) |
| Maximized | 2560 × 1392 | 2560 × 1392 | 0 / 0 | [Screenshot](native-window-maximized.png) |
| Restored after maximizing | 1280 × 902 | 1282 × 903 | 0 / 0 | [Screenshot](native-window-restored.png) |

All four bottom rows were black in each window and WebView capture. At 850 × 641 CSS px, WebView2 also passed the bottom-row and gutter checks with CDP device-scale emulation at 125% and 150%. Native Windows display scaling at 125% and 150%, the native macOS window, physical phones, and platform assistive technology remain open.

The Windows build and the headless Playwright player and Home suites passed. Player coverage included rendered seek colors, mouse and keyboard tooltip alignment, both track ends, drag release, and Android touch and iPhone synthetic touch states. The Home suite covered focus, reduced motion and shelf layout. Loading and error states, screen readers, and broader Search accessibility remain open. The desktop Home toolbar and sidebar still expose two controls labeled “Home” in `Components/Pages/Music.razor`.
