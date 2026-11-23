# Server dashboard verification

23 November 2026 · `codex-downloads` working tree based on `efe74ef` · FamilyHub 1.1.0

The existing interactive Blazor fixture hosted the Windows app assembly and returned synthetic server measurements. It used the app's Server navigation, Razor components, CSS and keyboard handling. Playwright ran headless at below-normal priority on Windows.

| Profile | CSS viewport | Browser engines |
| --- | --- | --- |
| Desktop | 1280 × 900 | Chromium and WebKit |
| TV width | 2000 × 1080 | Chromium and WebKit |
| Pixel 7 emulation | 412 × 839 | Chromium and WebKit |
| iPhone 13 emulation | 390 × 664 | Chromium and WebKit |

Each run saved a current readings and a history screenshot. The phone profiles also captured the power and temperature tiles after scrolling. The iPhone profile ran with reduced motion. The other profiles ran with the normal motion preference. WebKit on Windows approximates the Safari engine. The phone viewports, touch input, and TV-width arrow keys were emulated. Physical-device rendering, mobile WebViews, a physical remote, and screen-reader announcements remain unverified.

## Checks

- All eight runs checked the Server entry, current values, warm and hot text, Ethernet and VPN charts, solid and dashed lines, range totals, keyboard or touch range changes, the chart data table, focus retention, and horizontal overflow. The 2000 px runs checked arrow movement between the refresh action, selected range and chart controls.
- Both 1280 px runs checked that a timed-out history request retained its snapshot and left current readings visible. They also checked current-reading errors, both Retry actions, 90-day selection, empty history, focus restoration after a chart disappeared, and the regular profile's Server work screen.
- The Windows app build passed. Thirty-two Python tests covered server measurements, server work, request dispatch and family profiles. A WSL Linux smoke test confirmed one collector thread, real proc and root filesystem readings, and a WAL database.
- Debian RAPL and hwmon permissions, SMART, VPN counters, and a configured power meter still need testing on the target server. [Debian setup](../../SERVER_HEALTH.md)

## Repeat the browser checks

Build the Windows target, point the existing fixture at its output, and start the fixture from that native output directory so Windows can load the runtime DLLs. The fixture listens on loopback port 38869 by default. Use an installed Playwright with Chromium and WebKit. Set `PLAYWRIGHT_MODULE` to its module path if Node cannot find it.

```powershell
dotnet build clients/FamilyHub.App/FamilyHub.App.csproj -p:FamilyHubTargetFramework=net10.0-windows10.0.19041.0 -p:WindowsAppSDKSelfContained=true
$native = (Resolve-Path clients/FamilyHub.App/bin/Debug/net10.0-windows10.0.19041.0/win-x64).Path
dotnet build tests/fixtures/music-popup-host/MusicPopupHost.csproj "-p:FixtureNative=$native"
$fixture = (Resolve-Path tests/fixtures/music-popup-host/bin/Debug/net10.0-windows10.0.19041.0/MusicPopupHost.dll).Path
$fixtureProcess = Start-Process dotnet -ArgumentList @("`"$fixture`"") -WorkingDirectory $native -WindowStyle Hidden -PassThru
$fixtureProcess.PriorityClass = 'BelowNormal'
$checks = Start-Process node -ArgumentList 'tests/server_dashboard.cjs' -WindowStyle Hidden -PassThru
$checks.PriorityClass = 'BelowNormal'
$checks.WaitForExit()
Stop-Process -Id $fixtureProcess.Id
if ($checks.ExitCode -ne 0) { throw 'Server dashboard checks failed' }
```
