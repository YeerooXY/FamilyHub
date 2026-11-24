# FamilyHub 1.4.0 Movies and admin verification

The captures use headless Windows Chromium at 1280 and 2000 px, a Chromium touch tablet at 768 px, a Pixel 7 profile at 360 px, Windows WebKit at 1280 px as a Safari engine check, and the iPhone 13 profile with reduced motion. Android, iPhone, and Mac use emulated browser profiles.

- **Movies**. The season rows show Available, Downloading with progress and time left, and Missing. The captures include an episode with a still, an episode without a still, and a release with its poster and open quality table. The browser checked Tab, Shift+Tab, Space, Enter, Escape, touch activation, focus after leaving the series, and horizontal overflow.
- **Admin**. The browser checked signed-out and non-admin responses, a rejected password, successful sign-in, global and per-file meters, stale data during a failed refresh, and focus on retry. The server tests checked the page with the browser player disabled, access control on seeding data, and the still cache's disk and path handling.

Run `node tests/movies_visual.cjs docs/verification/movies-polish-2026-11-24` and `node tests/admin_page.cjs docs/verification/movies-polish-2026-11-24` from the checkout. Set `MOVIES_FIXTURE_URL` to the running `music-popup-host` address to repeat the Windows Chromium check through the Razor shell and .NET bridge. That run opened Movies from the app switcher, found a single page heading, and rendered the downloading season and episode still returned by the fixture.

The screenshots use fixture data. Physical-device layout, Safari font rendering on Apple devices, native WebViews, screen-reader speech, and enlarged text remain open. Live playback, matching TMDB stills and Jellyfin subtitles, Windows fullscreen over the taskbar, and Reconnect remain open.
