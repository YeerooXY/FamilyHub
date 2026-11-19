# FamilyHub notices · 19 November 2026

The [inventory](inventory.md) records the pre-change messages and their triggers. Each web sample shows all four inline levels and the empty state. Native captures show the actual Razor Search and Server work components in a local Blazor host. Both clients use the same notice CSS and toast code.

| Profile | CSS viewport | Captures | Toast clearance above player, web / native | Clearance above bottom nav, web / native |
| --- | --- | --- | ---: | ---: |
| Windows Chromium | 1280 × 900 | [Web samples](windows-1280-web.png) · [Native Search](windows-1280-native.png) · [Native retries](windows-1280-native-retry.png) | 12 / 12 px | |
| Windows Chromium | 2000 × 1060 | [Web samples](windows-2000-web.png) · [Native Search](windows-2000-native.png) | 12 / 12 px | |
| Windows Chromium | 850 × 900 | [Web samples](windows-850-web.png) · [Native Search](windows-850-native.png) | 12 / 12 px | |
| Mac Safari profile, emulated WebKit on Windows | 1280 × 900 | [Web samples](mac-webkit-web.png) · [Native Search](mac-webkit-native.png) | 12 / 12 px | |
| Android Pixel 7 profile, emulated Chromium | 390 × 839 | [Web samples](android-chromium-web.png) · [Native Search](android-chromium-native.png) | 12 / 12 px | 104 / 88 px |
| iPhone 13 profile, emulated WebKit | 390 × 664 | [Web samples](iphone-webkit-web.png) · [Web toasts](iphone-webkit-web-toasts.png) · [Native Search](iphone-webkit-native.png) · [Native retries](iphone-webkit-native-retry.png) | 12 / 12 px | 104 / 88 px |

Playwright measured notice, icon, first-line text and action rectangles in CSS pixels. The 20 px icons use the app’s 24 px grid and 2 px strokes. The icon starts 13 px from the card’s outer edge, including its 1 px border. The icon-to-text gap is 10 px and the first-line center difference is 0 px. Text is 14 px with a 20 px line height. Actions are 34 px tall on desktop and 44 px tall on phones. The long error wraps over two desktop lines and three phone lines. On phones its action sits under the text. At 2000 px the error card stays 640 px wide. The toast stack sits 16 px from the right edge and uses an 8 px gap between confirmations. The [measurement file](measurements.json) contains individual geometry and action positions.

Each capture was opened for visual inspection. The short desktop empty state now keeps the action beside its text. Shorter empty Search copy fits beside its action at 390 px. The iPhone web use cases have separate captures because the display area for all five sample cards and two toasts is too short to show them together without contact. The Server work failure path omits the empty worker grid so both retry controls fit above the player.

Playwright checked the polite status and alert roles, rejection of raw HTTP error text, keyboard reachability, the three-toast cap, automatic dismissal, hover and focus pause, and both motion preferences. The web Search retry restored focus to the Search heading and Edit search opened the field on demand. Native Server work and song review retries restored focus to their refresh controls. Browser playback retry, device handoff and incremental-search regression suites also passed. Fixture responses were local and all browser tests ran headless at idle priority.

The Windows x64 build passed with the existing nullability warning in `MainPage.xaml.cs`. The client core passed 911 checks and the server work, picker and playlist suites passed. The player suite passed on an isolated rerun after its crossfade envelope assertion failed during concurrent verification. The Python web suite passed 40 tests.

Physical Apple and Android devices, OS keyboard and safe-area behavior, and screen-reader speech remain unverified. The native browser fixture exercises the Windows-built Razor assembly through Blazor. It uses synthetic API responses and bypasses MAUI audio, device pickers, and native window chrome. The screenshots cover the shared levels and surfaces alongside the native search and two operational errors. The inventory covers additional call sites by source inspection.

## Reproduce

Render the Flask template with `python tests/music_browser_fixture.py`. With Playwright installed and both Chromium and WebKit binaries available, run `node tests/music_notices.cjs`. Set `FAMILYHUB_NOTICE_SCREENSHOTS` to a directory to save captures and measurements.

For native coverage, build the Windows x64 app in Debug, put its `win-x64` output directory on `PATH`, and run `dotnet run --no-launch-profile` from `tests/fixtures/notices-native`. Set `FAMILYHUB_NATIVE_NOTICE_FIXTURE=http://127.0.0.1:38876/` for the Playwright run.
