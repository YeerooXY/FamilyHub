# Player bar verification · 19 November 2026

Screenshots show the Windows Razor components running in a local Blazor host with fixture tracks, artwork and playback. Captures use headless Playwright on Windows with reduced motion enabled. Desktop captures show the full viewport width around the player.

| Profile | Tooltip gap | Tooltip centre error | Playlist hit area left edge, short and long titles | Screenshots |
| --- | ---: | ---: | ---: | --- |
| Windows Chromium, 1280 × 900 | 9 px | 0 px | 236 px | [Long title and hover](windows-1280.png) · [Short title and added check](windows-1280-short-title.png) |
| Windows Chromium, 2000 × 1060 | 9 px | 0 px | 236 px | [Hover](windows-2000.png) · [Idle](windows-2000-idle.png) |
| Emulated Mac desktop WebKit, 1440 × 900 | 9 px | 0.008 px | 236 px | [Hover](mac-webkit-emulated.png) |
| Emulated Android Pixel 7 Chromium, 412 × 839 | | | | [Mini player](android-chromium-emulated.png) · [Now Playing](android-chromium-emulated-expanded.png) |
| Emulated iPhone 13 WebKit, 390 × 664 | | | | [Mini player](iphone-webkit-emulated.png) · [Now Playing](iphone-webkit-emulated-expanded.png) |

The desktop tooltip gap is measured from its bottom edge to the painted track’s top edge. Centre error is measured against the pointer away from the clamped ends. Playwright also checked both end clamps, keyboard Tab and Shift+Tab, the focus outline, drag release outside the slider, rendered seek colours and thumb visibility, title ellipsis, and a shared vertical centre for artwork, text and playlist action. The desktop transport has a 32 px white play circle, 16 px icons, 8 px control gaps, 11 px `#a7a7a7` time labels and a 4 px track.

The Android profile exercised a browser-emulated touch drag and release. The iPhone profile used synthetic touch pointer events to check drag and cancellation states. The rendered desktop playlist picker accepted Enter and returned focus to the playlist button after Escape.

The Windows build, portable client and player suites, and the Playwright player bar, phone playback, Home and playlist focus checks passed. The Windows build reported the existing nullability warning in `MainPage.xaml.cs`. Physical Mac and phone testing, native shell and OS font rendering, screen readers and audible playback remain outside this verification.
