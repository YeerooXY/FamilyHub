# Add audio track verification

Playwright ran the source picker, result card and manual sync fixtures in Chromium and WebKit at 1280 px and with the Pixel 7 and iPhone 13 profiles. Each browser and profile has a source, result and sync screenshot in this folder.

- The source picker opens from a title’s details and the player’s Audio menu. The fixture covers the Hungarian default, source name and audio stream metadata, job submission, result reporting, delete confirmation and focus restoration.
- The player fixture switches to a Hungarian external stream at the current position and checks the submitted audio stream index. Keyboard and touch exercises apply 100 ms steps to a simulated media clock and keep focus on the control.
- Python fixtures cover the 1.2 s shift, PAL rate differences in both directions, a different cut, season filename matching, gateway authorization and CSRF, real FFmpeg sidecar creation and verification before source deletion.

The browser runs used reduced motion and simulated streams. Normal-motion review, screen-reader speech, physical devices and live Jellyfin refresh from a regular viewer account remain unverified.
