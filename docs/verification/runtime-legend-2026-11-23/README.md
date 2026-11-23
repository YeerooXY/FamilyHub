# Runtime and quality guide

Headless Playwright ran on Windows at below-normal priority. Both Chromium and
WebKit used the same four profiles. The Playwright phone profiles emulate
viewport, device scale, user agent and touch. The captures use reduced motion
and one image pixel per CSS pixel.

| Profile | Emulated viewport (CSS pixels) | Chromium | WebKit |
| --- | --- | --- | --- |
| 1280 desktop | 1280 × 850 | [Releases](chromium-1280-release.png) · [YouTube](chromium-1280-youtube.png) | [Releases](webkit-1280-release.png) · [YouTube](webkit-1280-youtube.png) |
| 2000 desktop | 2000 × 1000 | [Releases](chromium-2000-release.png) · [YouTube](chromium-2000-youtube.png) | [Releases](webkit-2000-release.png) · [YouTube](webkit-2000-youtube.png) |
| Pixel 7 | 412 × 839 | [Releases](chromium-pixel7-release.png) · [YouTube](chromium-pixel7-youtube.png) | [Releases](webkit-pixel7-release.png) · [YouTube](webkit-pixel7-youtube.png) |
| iPhone 13 | 390 × 664 | [Releases](chromium-iphone13-release.png) · [YouTube](chromium-iphone13-youtube.png) | [Releases](webkit-iphone13-release.png) · [YouTube](webkit-iphone13-youtube.png) |

The release fixture covers a season total, Hungarian search text, the quality
guide, sort order, and download times for 390, 22, and zero people sharing.
The series-pack fixture captures an estimated quality badge and a warning for a
small 1080p file. [Chromium desktop](chromium-1280-estimated.png) · [WebKit iPhone 13](webkit-iphone13-estimated.png)

The YouTube fixture covers all three duration markers and focus during metadata
updates, retries, and download confirmation. The Python fixtures verify episode
runtime sums, caching, entity decoding, and Hungarian-only results with one
additional query per source. All search responses and artwork are fixtures.
Live services, physical devices, and native WebViews remain unverified.

```powershell
node tests/movies_releases.cjs docs/verification/runtime-legend-2026-11-23
node tests/movies_youtube.cjs docs/verification/runtime-legend-2026-11-23
python -m unittest discover -s tests -p "test_movie*.py"
```
