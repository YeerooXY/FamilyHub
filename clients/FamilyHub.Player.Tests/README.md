# Playback control regressions

Run `dotnet run --project clients/FamilyHub.Player.Tests` with .NET 10.

This console harness compiles the actual `MusicPlayer.cs` and substitutes deterministic session, dispatcher, and audio-device implementations. Deferred downloads deliberately ignore cancellation until released so tests can detect stale completion and error handling.

Checks cover pause during preparation, paused Next/Previous, rapid navigation, latest-selection wins, Stop during download, stale failures/end events, duplicate queue occurrences, shuffle history and rollback, and volume bounds.

This verifies playback coordination. Real Windows codecs, source events, audio output, and mobile controls require native app tests.
