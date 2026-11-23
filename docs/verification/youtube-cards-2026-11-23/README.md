# Movies search and YouTube cards

Headless Playwright ran on Windows with Chromium and WebKit. Both engines used
1280 × 850 and 2000 × 1000 desktop viewports, plus Playwright's Pixel 7 and
iPhone 13 device profiles. The phone profiles emulate viewport, device scale,
and touch. Every capture uses reduced motion and one image pixel per CSS pixel.

| Profile | Chromium | WebKit |
| --- | --- | --- |
| 1280 px | [Capture](chromium-1280.png) | [Capture](webkit-1280.png) |
| 2000 px | [Capture](chromium-2000.png) | [Capture](webkit-2000.png) |
| Pixel 7 | [Capture](chromium-pixel7.png) | [Capture](webkit-pixel7.png) |
| iPhone 13 | [Capture](chromium-iphone13.png) | [Capture](webkit-iphone13.png) |

- YouTube candidates appear before metadata. The test checks in-place updates,
  thumbnail placement, quality colors, duration and views, and horizontal overflow.
  Thumbnails come from FamilyHub's existing Movies artwork.
- Keyboard and touch checks cover the watch action, download, retry, focus during
  metadata and queue updates, and the progress bar. Release checks cover the
  first eight tiles, Show all releases, and focus on the ninth tile.
- The browser fixture simulates Jellyfin, the app bridge, and download progress.
  Python tests mock yt-dlp and check permissions, URL validation, metadata and
  caching, download arguments, the single-worker queue, and progress states.

Live YouTube transfers, native WebViews, physical devices, and screen-reader
announcements remain unverified.
