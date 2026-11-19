# Popup verification · 19 November 2026

The before captures use FamilyHub 0.1.71 (`148ee3d`). The after captures use the popup changes on `codex-popups`. Both runs rendered the Windows Razor components against synthetic profiles, songs, audio devices and server data. The phone profiles exercise the responsive layout with the Windows implementation of native integrations. Playwright ran headless in background jobs at idle priority.

## Screenshots and measurements

The 404 before and after captures were reviewed in paired sheets, with the revised forms and controls reopened at full size. Each folder contains lossless full-viewport WebP captures at 1 image pixel per CSS pixel and the Playwright measurements for that run.

| Browser and viewport | Before | After |
| --- | --- | --- |
| Windows Chromium, 1280 × 900 | [Screenshots](before/windows-1280/) · [Measurements](before/windows-1280/measurements.json) | [Screenshots](after/windows-1280/) · [Measurements](after/windows-1280/measurements.json) |
| Windows Chromium, 2000 × 1060 | [Screenshots](before/windows-2000/) · [Measurements](before/windows-2000/measurements.json) | [Screenshots](after/windows-2000/) · [Measurements](after/windows-2000/measurements.json) |
| Mac Safari engine emulated on Windows, 850 × 900 | [Screenshots](before/mac-webkit-850/) · [Measurements](before/mac-webkit-850/measurements.json) | [Screenshots](after/mac-webkit-850/) · [Measurements](after/mac-webkit-850/measurements.json) |
| Android Chrome emulated on Windows, 390 × 844 | [Screenshots](before/android-chrome-390/) · [Measurements](before/android-chrome-390/measurements.json) | [Screenshots](after/android-chrome-390/) · [Measurements](after/android-chrome-390/measurements.json) |
| iPhone Safari engine and iPhone 13 profile emulated on Windows, 390 × 844 | [Screenshots](before/iphone-webkit-390/) · [Measurements](before/iphone-webkit-390/measurements.json) | [Screenshots](after/iphone-webkit-390/) · [Measurements](after/iphone-webkit-390/measurements.json) |

The screen captures include Home, Search results, Library, Playlist, Album, active playback, Lyrics, Queue, Server work, Song review, Artist mappings, Leaderboard, Wrapped and Settings. Now Playing uses the existing desktop player bar and phone full-screen view. Upload shows a file selected inside Add songs. Trim request shows the result of the existing saved-song action.

## Findings and fixes

| Finding | Fix | Before and after |
| --- | --- | --- |
| Connect, centered dialogs, anchor menus and the profile menu used different surfaces, corner radii, placement and entry transitions. | The same opaque, borderless Connect surface, shadow, header and motion now render as a right panel on desktop and as a bottom sheet on phones. Forms retain widths suited to their content. | Connect [before](before/windows-1280/connect.webp) · [after](after/windows-1280/connect.webp). Create playlist [before](before/windows-1280/create-playlist.webp) · [after](after/windows-1280/create-playlist.webp). |
| The song menu put the Needs trimming icon 16 px left of the Add to playlist icon at 1280 px, and lacked an entry for the report form. | Every row starts in the heading’s icon column. Report problem opens the existing Report song form with the selected saved song, and closes back to that row. | Song menu [before](before/windows-1280/song-menu.webp) · [after](after/windows-1280/song-menu.webp). Report [before](before/windows-1280/report.webp) · [after](after/windows-1280/report.webp). |
| Playlist actions used 19 px icons. Sort menus lacked a close control and selection icon. Profile links needed to follow the same row layout without duplicating desktop navigation. | Playlist, sort and profile menus use the same 20 px outline icon column, 12 px label gap and close header. Sort rows show a check for the selected option. The phone-only profile links remain available on the phone. | Playlist menu [before](before/windows-1280/playlist-menu.webp) · [after](after/windows-1280/playlist-menu.webp). Sort [before](before/windows-1280/song-sort.webp) · [after](after/windows-1280/song-sort.webp). Profile [before](before/iphone-webkit-390/profile-menu.webp) · [after](after/iphone-webkit-390/profile-menu.webp). |
| The phone player sheet used a handle as its keyboard close control, showed Report song twice and used 24 px icons. | The handle and named close button now have separate roles. Each action has one visible label and the same icon and text columns as the song menu. The player uses the song menu’s download and follow controls. | Player menu [before](before/android-chrome-390/player-menu.webp) · [after](after/android-chrome-390/player-menu.webp). |
| Lyrics used a lighter gradient with a different close control. | Lyrics use the Connect surface and an opaque header, with a brighter active line. The timing controls stay available and the panel ends above the player. | Lyrics [before](before/iphone-webkit-390/lyrics.webp) · [after](after/iphone-webkit-390/lyrics.webp). |
| In Create playlist and Add songs, a global label rule made Choose songs sit 14 px lower than Choose a folder, with a different content layout. “One song or several” repeated the affordance. Add songs had two Close controls and reused “Add to playlist” for the destination toggle and submit button. | Both upload choices now share the same box, icon and label geometry. The upload limit and folder behavior remain visible. The form uses its header close button and calls the playlist submit action “Add songs.” | Add songs [before](before/android-chrome-390/add-songs.webp) · [after](after/android-chrome-390/add-songs.webp). File selected [before](before/android-chrome-390/upload.webp) · [after](after/android-chrome-390/upload.webp). |
| Listen Together’s “Invite listeners, then choose your music” repeated the controls. The incoming request used a different card and dismiss layout. | The shared header carries the close action. The incoming request keeps its nonmodal behavior and opens with the same surface. | Listen Together [before](before/windows-1280/listen-together.webp) · [after](after/windows-1280/listen-together.webp). Incoming request [before](before/iphone-webkit-390/listening-request.webp) · [after](after/iphone-webkit-390/listening-request.webp). |
| Song picker, playlist details, co-authors, metadata, import, download and confirmation dialogs had inconsistent headers and surface styles. Choose saved songs repeated its filter prompt. | These forms use the shared header and surface. Headers stay opaque during scrolling. Focus returns to the opener or the next relevant control. The saved-song filter uses one prompt and spans the list. | Song picker [before](before/windows-1280/song-playlist-picker.webp) · [after](after/windows-1280/song-playlist-picker.webp). Saved songs [before](before/iphone-webkit-390/choose-saved-songs.webp) · [after](after/iphone-webkit-390/choose-saved-songs.webp). Playlist details [before](before/mac-webkit-850/playlist-details.webp) · [after](after/mac-webkit-850/playlist-details.webp). Metadata [before](before/iphone-webkit-390/song-metadata.webp) · [after](after/iphone-webkit-390/song-metadata.webp). |
| The startup update repeated its version in the title and body. Report song repeated its first reason in supporting text. | The version appears once beside the download information. The report reasons retain the details that clarify what happens. | Update [before](before/windows-1280/update.webp) · [after](after/windows-1280/update.webp). Report [before](before/windows-1280/report.webp) · [after](after/windows-1280/report.webp). |
| The Spotify question needs two lines at 390 px when using the Connect heading size. | Form headings can wrap with the close button centered against the full title. | Spotify question [before](before/iphone-webkit-390/spotify-question.webp) · [after](after/iphone-webkit-390/spotify-question.webp). |
| Server work and Leaderboard titles were centered above left-aligned content. In Artist mappings, the explanation began 21 px left of the results text on desktop. | Titles align to the content wrapper at narrow and wide widths. The Artist mappings explanation, feedback and list text use the same inset. | Server work [before](before/windows-2000/server-work.webp) · [after](after/windows-2000/server-work.webp). Leaderboard [before](before/windows-2000/leaderboard.webp) · [after](after/windows-2000/leaderboard.webp). Artist mappings [before](before/windows-1280/artist-mappings.webp) · [after](after/windows-1280/artist-mappings.webp). |
| Home’s Radio shortcut used a platform emoji alongside the app’s outline icons. | The existing 16 px radio icon uses the app’s 24 px grid and aligns vertically with the title. | Home [before](before/iphone-webkit-390/home.webp) · [after](after/iphone-webkit-390/home.webp). |

The phone search placeholder clips at 390 px on the base revision. The header and search-bar layout are in the concurrent frame worktree.

## Integration with main 0.1.72

The captures and results in this record cover the original popup revision. Verification of the combined popup, notice, and download changes is pending in Windows Chromium at 1280 and 2000 px, emulated Mac WebKit at 850 px, and emulated Android Chromium and iPhone WebKit at 390 px.

## Regression checks

The Playwright test reads the computed surface, shadow, border, radius, backdrop and animation from Connect and compares them with the other panels. It measures header and close alignment, row and icon rectangles, first-glyph positions and relative text baselines. Standard menu rows measure 44 px on desktop and 56 px on phones. The tested leading icon and label columns sit 16 and 48 px inside desktop panels, and 24 and 56 px inside phone panels. The recorded tolerance is under 0.11 CSS px. Upload actions also match in width, height, icon position and label position.

| Viewport | Connect width × height | Song menu width × height | Song menu icon x | Song menu label x |
| --- | ---: | ---: | ---: | ---: |
| Windows 1280 px | 282 × 748 | 340 × 748 | 948 | 980 |
| Windows 2000 px | 282 × 908 | 340 × 908 | 1668 | 1700 |
| Mac WebKit 850 px | 282 × 748 | 340 × 748 | 518 | 550 |
| Android Chromium 390 px | 390 × 759.89 | 390 × 640 | 24 | 56 |
| iPhone WebKit 390 px | 390 × 759.89 | 390 × 640 | 24 | 56 |

The interaction run covers Escape, Tab and Shift+Tab boundaries, focus restoration after a nested report, the report action in the phone player, the desktop backdrop, reduced motion and downward swipes. Chromium uses injected touch input through the browser protocol. The iPhone WebKit run dispatches touch events in the emulated browser. Physical gestures, macOS and iOS fonts, OS file pickers, Bluetooth, VoiceOver, virtual keyboards, native audio and lock-screen integration remain device checks.

The Windows build, 899 portable client checks, six-profile Home regression and five-profile popup regression passed.

Run the fixture after building the Windows client. Start the host and Playwright in separate PowerShell processes from the checkout, with each process set to idle priority.

```powershell
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'Idle'
dotnet build clients/FamilyHub.App -p:FamilyHubTargetFramework=net10.0-windows10.0.19041.0 -p:Platform=x64 --disable-build-servers
$popupNative = Resolve-Path 'clients/FamilyHub.App/bin/x64/Debug/net10.0-windows10.0.19041.0/win-x64'
$env:Path = "$popupNative;$env:Path"
dotnet run --project tests/fixtures/music-popup-host --no-launch-profile --disable-build-servers
```

```powershell
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'Idle'
$env:POPUP_CAPTURE = '.local/popup-captures'
node tests/music_popup_unification.cjs
```
