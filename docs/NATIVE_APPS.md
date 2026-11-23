# Native FamilyHub Music apps

The [iPhone and platform release plan](PLATFORM_RELEASE_PLAN.md) records free-signing research, proposed Apple rollout steps, device acceptance checks and future release maintenance.

The shared MAUI app is in `clients/FamilyHub.App`; server communication and offline storage are in `clients/FamilyHub.Client.Core`. Windows and Android builds have been produced. Physical-device playback and installation results must be recorded separately from build success.

The native interface links the original web client's `music_web/static/shell.css` directly into its build and reuses its icon shapes, top search, artwork rows, genre controls, navigation and player layout. Downloads, editable playlists and Queue extend that layout. Artwork uses authenticated server requests and account-specific offline caches. Volume and shuffle operate on the native player.

The iPhone source and build workflow are included. No Mac is available locally, and the iOS build and installation remain unverified. The owner-reported test version is iOS 26.6.2. See [Private iPhone installation](IOS_PRIVATE_INSTALL.md) for the build, signing, and refresh requirements.

## Server and offline use

Enter the HTTPS FamilyHub server address, connect, then choose a profile. Use **Switch profile** to change profiles. The app keeps a protected profile's password in memory until you switch profiles or close the app. On the next launch, sign in again to use that profile online.

The native profile flow requires `FAMILY_PROFILES: true`. Keep the service on the private family network. Set `PROFILE_PASSWORD_HASHES` before enabling administrator access, linking a profile to Jellyfin, or opening **Your files**. Ordinary shared profiles can keep one-tap selection. Legacy Navidrome web sign-in remains available with `FAMILY_PROFILES: false`. See [profile password setup](SECURITY_REVIEW.md#profile-password-setup).

On first enablement, `ALLOWED_USERS` seeds profiles with the exact existing usernames as IDs, preserving their playlists. New profiles receive stable generated IDs, with up to 12 profiles in total. Profiles and playback preferences are stored in `WORKSPACE/.family-profiles.json`. Every profile uses the same existing server music catalogue; profile selection does not copy or replace recordings.

Volume and shuffle preferences belong to the selected profile. Native changes are saved locally, sent to the server when connected, and retried on reconnect when changed offline. Downloads, cached playlists, artwork and preferences are separated by server and profile. The browser restores ordinary profiles after server restarts. Protected profiles must sign in again.

Downloaded recordings are stored on the device for offline listening, including after an app restart. Download integrity is checked against the server's SHA-256 metadata. Offline playback requires a completed local download; server operations require connectivity. Keep the installed app and its data when updating to retain downloaded recordings.

Playlists support creating, renaming, adding saved library recordings, removing entries, reordering, and deletion. New and existing playlists are private until their owner enables sharing. Other profiles can read and play shared playlists; only the owner can edit, delete or change sharing. Playlist identity includes its owner, so two profiles can import the same Spotify playlist independently. Duplicate recordings retain their positions. Edits require connectivity and use a revision number: a stale edit receives HTTP 409 and requires refreshing the playlist. Existing Spotify playlists remain readable and editable by their owner.

The Queue tab displays queued recordings. Recommend similar searches the server and includes unsaved recordings; results stay anchored to the selected song's artist/known genre. Playing a new recording explicitly starts server acquisition. Broad genre labels cannot guarantee a perfect stylistic match.

Online playback first prepares a complete verified file in a bounded temporary cache, which can delay playback. Use Download to retain songs for offline use. The native client does not yet include the browser's Spotify import/matching controls, mixer/crossfade, or offline playlist editing. Use the existing web importer for new Spotify imports. These builds are an initial native client, with physical mobile tests still outstanding.

## Local build commands

```powershell
./scripts/build-native-app.ps1 -Platform Windows
./scripts/build-native-app.ps1 -Platform Android
```

Artifacts are written under `.local/artifacts/native/windows` and `.local/artifacts/native/android`. Extract the entire Windows ZIP and run `FamilyHub.App.exe`; its neighboring files are required. The Android script produces a debug-signed private APK. Future APK updates must use the same signing key to install over this build and retain app data. See the scripts for SDK and JDK requirements.

## Python verification

Using `.local/playlist-reader-venv/Scripts/python`:

- `test_native_music_api.py`: 12 tests; 11 passed, one symlink test skipped because Windows denied symlink creation.
- `test_music_playlists.py`: six passed.
- `test_music_web.py`: 26 passed.
- `test_public_playlists.py`: eight passed.
- `test_family_profiles.py`: ten passed, covering opt-in mode, passwordless selection, CSRF/host/origin checks, profile limits, preference persistence, shared-playlist ownership, remembered browser selection after restart, logout and removed profiles.

`node tests/music_family_profiles.cjs` passed Chromium checks for Tab, Shift+Tab, Enter and Space in the profile chooser, Add profile focus, same-ID playlists owned by different profiles, and read-only shared-playlist controls.

The broader `test*music*.py` run before the concurrency regression test contained 116 tests: two errors and 23 skips. Both errors came from missing `numpy` in that environment, in existing audio-analysis tests. This run does not establish full-suite success.

The native API tests use actual WAV files and validated manifests. They cover authenticated full/HEAD/ranged downloads, checksums, file changes and path rejection, listing more than 200 recordings, playlist persistence and account isolation, CSRF, duplicate order, stale revisions, and concurrent matching versus playlist edits. Matching rejects a changed revision after its external search so results cannot attach to a reordered entry.

## Native verification

The .NET client and linked MusicSession checks pass 110 assertions for profile bootstrap/selection, remembered and offline profile switching, preference persistence, removed-profile rejection, login/CSRF, origin boundaries, verified interrupted-download resume, reopening offline metadata, playlist revisions, account isolation and authenticated artwork validation. An isolated harness using the actual MusicPlayer source checked shuffle occurrence preservation, failure rollback and volume boundaries across 100 runs; its native playback endpoint was stubbed.

The Windows self-contained app was launched and tested through its actual embedded WebView. Two silent 30-second WAV fixtures used an unreachable server (`https://127.0.0.1:1/`) and no saved login. Checks passed for playback after a full process restart, pause/resume, seek, next-track playback, duplicate playlist order and occurrence selection, and deleting the currently playing download. Tab, Shift+Tab, Enter and Space worked; removing a download returned focus to the song filter. A 390-pixel viewport had no horizontal overflow. This viewport check does not establish physical mobile compatibility.

Windows uses a direct native MediaPlayer adapter with seekable file streams. Testing found that native path-based decoding stalled on the 272-character download path, and the toolkit player stalled during source replacement. Stream playback through the adapter passed switching and seeking. Android and iPhone continue to use their toolkit native players.

Windows and Android packages compile locally. Android installation/playback and iPhone build/installation/playback still need physical-device checks. The test fixture did not exercise a live production login or download; server API and portable client tests cover those boundaries separately. The family-profile server update was deployed on 13 November 2026. No iOS workflow run was performed.

The restored style was checked in the Windows app at desktop and phone viewport sizes. Its served stylesheet matched the original source exactly. Cached artwork appeared offline, genre filtering worked, decimal seeking and volume/shuffle controls operated, and keyboard focus survived clearing search and removing a download. A focused download-button removal was also checked through the focus helper; a live server download completion remains a separate integration check.

Implementation was split between the lead and three same-session Codex workers for core storage, platform packaging/playback, and server tests. An initial external worker route failed before editing files; no output from that attempt was accepted.

## Family profile acceptance, 13 November 2026

The live Windows app connected without a music password, selected the existing `yeeroo` profile, and displayed all 101 catalogue titles in the exact order returned by the same server API. Both existing playlists remained available. A full process restart reopened the selected profile and library without showing the chooser. Explicit Switch profile opened the chooser; Enter, Space, Tab, Shift+Tab and Escape checks passed. The chooser and connection screen had no horizontal overflow at 320, 390 and 1440 pixels. These are embedded Windows WebView viewport checks, not physical mobile tests.

Windows and Android packages built without warnings or errors. The Windows ZIP excludes the local WebView browser profile. The deployed Spotify reader also retrieved all 549 acceptance-playlist entries in six pages as the service user; its ordered URI hash matched the original acceptance artifact. Existing saved playlist contents were preserved: the older saved DnB record still has 100 entries and was not automatically reimported.

## Native playback and animation corrections

Playback selection now exposes the selected recording immediately, records play/pause intent during preparation, and lets each new selection supersede an older load. Next/Previous preserve a paused state. Windows callbacks belong to a specific native player instance, so callbacks from a replaced source cannot start or advance the current song. The durable linked-player regression harness is `dotnet run --project clients/FamilyHub.Player.Tests`; it checks delayed pause, paused skipping, rapid Next/Next/Previous, stale requests/errors, Stop during preparation, queue occurrences, shuffle and volume.

The playback cache persists for the current profile, memoizes verified files with metadata/hash invalidation, and prunes in the background while protecting active/preparing recordings. Warm repeated switches measured about 0.5?0.6 seconds to advancing playback in the real Windows app with server Opus recordings. First uncached playback still waits for full authenticated download and checksum verification. The checks verified native playback position, not audible speaker output.

The native interface restores search-as-you-type with the original 450 ms delay, cancellation of outdated searches, loading shimmer, row entrance animations and animated playing bars over artwork. Reduced-motion checks passed. Successful library refresh no longer displays ?Library updated.? Keyboard focus returns to search after clearing it. Windows and Android builds passed after these playback changes; physical mobile playback remains unverified.

## Integrated top bar

The native header contains Home, search, profile and desktop view history. Windows extends this header into the title area, removes MAUI's duplicate title row and keeps native caption buttons. Explicit interactive regions exclude search/profile/navigation controls from the drag area. Native hit tests passed for caption background, search/profile and minimize/maximize/close; caption double-click maximized and restored the real window. The embedded app passed Home/back/forward, Enter/Space/Tab/Shift+Tab/Escape and profile focus checks. Windows and Android builds passed; native Snap menu appearance and physical mobile layout remain unverified.

The final top bar also passed real Windows resizing at 1400, 1000 and 700 pixels with no horizontal overflow or overlap with native caption controls. Focus moves to search if a focused history control becomes hidden at the narrow layout. A separate first uncached real-server recording reached advancing playback in 654 ms on this connection; transfer time will vary with file size and network speed.

## Panels, compact player and shared effects

Opaque grey navigation and content panels sit above the themed outer frame. Desktop navigation collapses to icons. Genre pills stick to the panel edge with a solid theme-coloured backing while scrolling. The desktop player is 96px tall with a wider seek bar; the phone layout is 144px with 44px transport/mute targets. The volume button mutes and restores the last audible level during the session. Hover/press feedback respects reduced motion.

The canonical `packages/paddock-effects` package contains Paddock's eleven palettes and original canvas renderer. The native project and build helpers copy those assets automatically; app-specific panel styles remain in FamilyHub. Theme/effects/navigation choices are remembered per server/profile on this device. Paddock itself is not connected to the shared package yet. See [Shared effects](SHARED_EFFECTS.md) for the consumer API and next integration step.

Actual Windows checks passed for collapsed-navigation keyboard focus, sticky pills, theme persistence over restart, exact shared palette values, one reused canvas, effects/RGB pausing, and keyboard mute/unmute restoring37% volume. Responsive CSS checks passed320/390/768px bounds and44px player targets in Chromium emulation; physical mobile verification remains pending. Both Windows and Android packages built successfully.
