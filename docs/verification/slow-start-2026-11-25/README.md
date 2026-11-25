# Music slow-start verification

Source revision `c80d17e2c34192e2a1abe2df893c257e379fc296` (`v1.5.0`).

## Before

In the supplied ABBA playback trace, the device reported a stream failure 12.02 seconds after the tap. The server reported the first preview segment, Windows preview and original at 12.09 seconds. The retry took the library download path and waited through purification, which ran from 20.67 to 105.02 seconds. The device reported failure at 125.92 seconds. The server received five creation requests for the same video. After import, playback kept failing until the app restarted even though the library download returned 200 and its checksum matched.

## After

The client opens a published HLS preview or the verified original while acquisition and import work continue. Windows still waits for an openable HLS manifest and can use the original immediately when it is available. A single creation request survives playback cancellation, and retries read the same job. Status polling uses one-second intervals for the first ten seconds and 2.5-second intervals thereafter. It stops when a stream is selected. A failed preview can switch to the original while purification is running. A library retry reads the specific recording and applies the returned URL, size and checksum before opening it again.

The server serves the last validated playlist snapshot with its published assets. Pending media responses carry `Retry-After`. The app checks the signed URL before handing it to the native deck and waits up to eight seconds for temporary 404 or 503 responses bearing that header. The backoff grows from 250 milliseconds to two seconds and takes the server hint into account. During a wait the player uses its existing “Preparing song...” label and the status notice names the current step. Server timing lines identify the action by a random prefix and include job acceptance, original stream availability, and purification start and finish.

## Verification

Source and fixture inspection covered job reuse, cancellation, HLS publication, temporary media responses, signed range reads, and the targeted stale-record retry. Added portable client coverage in `Program.cs` and `PlaybackFlowChecks.cs`, and Python coverage in `test_play_on_demand.py` and `test_music_web.py`. Paddock owns execution of these checks. The Python checks are intended to run from `tests` with `PYTHONPATH=..`. The Android build check runs from `clients/FamilyHub.App` with `dotnet build -f net10.0-android -p:FamilyHubTargetFramework=net10.0-android --no-restore`. Test and build results are pending. This pass made no requests to the private server or tailnet.

On a physical Android phone, measure tap to first audible audio with a fresh song, a lagging HLS preview, and an original ready during purification. Confirm that retry retains the position where the stream supports seeking. Replay a song after the library record changes in the same app session and check that the refreshed recording opens. Check the Music player and its preparation notice for layout, visuals, motion, keyboard focus, accessibility announcements, wording and waiting, recovery and failure states. Rendered coverage for those seven dimensions remains open. This review covered playback preparation and recovery.

## Changed files

- `clients/FamilyHub.App/Services/MusicPlayer.cs` and `MusicSession.cs`
- `clients/FamilyHub.Client.Core/FamilyHubApi.cs` and `Models.cs`
- `clients/FamilyHub.Client.Core.Tests/Program.cs`, `PlaybackFlowChecks.cs` and `SessionChecks.cs`
- `music_web/__init__.py` and `playback_diagnostics.py`
- `tests/test_play_on_demand.py` and `test_music_web.py`
- `docs/verification/slow-start-2026-11-25/README.md`
