# Android screen-off playback

FamilyHub 1.5.1 · 25 November 2026

## Fixture checks

The C# player fixtures cover immediate preparation for a saved song, the 15-second threshold for an unsaved song, Wi-Fi and cellular policy, data saver, cancellation on queue replacement and pause, and stream fallback when the cache is full. The Python fixtures cover the screen and warm-up diagnostics and their playback positions. Both suites use local fixtures. The checks were added and await the lead’s run.

## Release APK on a Samsung phone

Play a queue on Wi-Fi with Data saver off. Turn the screen off and listen through several transitions. Compare the gap after each song with the screen-on baseline. Check a saved next song, an unsaved next song and a song already cached. In Settings, confirm that Open app settings opens FamilyHub’s Android app details. Repeat with FamilyHub’s Battery option set to Unrestricted and record which setting was used.

Compare the screen and warm-up events with the next song’s start and buffering timings. A queue change or pause can cancel a warm-up after its start event. The Android service uses a partial CPU lock and a Wi-Fi lock, plus ExoPlayer’s network wake mode through the existing MediaElement player binding. Check on the phone that the service locks release on pause, stop and playback failure, and after a 15-minute stall without playback. Cellular and Data saver use the existing conservative preparation path.

Physical screen-off audio, Android power behavior, Settings layout, visual appearance, motion, keyboard focus, accessibility and launch/error states await device verification. The wording and accessible button name were checked in source.
