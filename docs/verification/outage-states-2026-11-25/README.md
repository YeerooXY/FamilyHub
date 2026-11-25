# Server unavailable states

Source revision `c80d17e2c34192e2a1abe2df893c257e379fc296`, 25 November 2026.

| Screen | Existing failure or recovery state |
| --- | --- |
| Startup and Connect | Initial server probe and connection form errors. The opening splash itself is a loading state. |
| Music, library, playlists, Home and search | Session reconnect warning, empty offline library, radio connection hints, cached views and transport failures during song search. |
| Movies & TV | Session open, library search and shelves, genres, episode metadata, YouTube and release lookup. Playback and track selection have separate media errors. |
| Files | View initialization, folder listing, share-link listing and bridge failures. Mutations also have form-specific recovery, including recursive delete confirmation. |
| Server work and leaderboard | Offline or failed snapshots, movie server health, current and historical readings, seeding and song review. |
| Daily Wordle | Puzzle load, statistics, guess validation and device-saved guess sync. |
| Wordle settings | Preference load and save. |
| Discovery shelf | Release/recording lookup and dismissal failures. A failed initial fetch previously left the shelf hidden. |
| Lyrics | Fetch failures previously hid the preview and retried in the background. A song without lyrics is an ordinary empty result. |
| Listen Together | Offline session list and failed session actions. An empty list is an ordinary empty result. |
| Add songs | Disconnected form, failed submission and background job status. |
| Upload songs and playlist picker | Failed save, transfer or status lookups. A failed response can follow an accepted write. |
| Playback diagnostics | Offline or failed server timings, with device timing fallback. |
| Artist mappings | Offline snapshot and failed mapping refresh. |
| Not found | Missing address with a link back to the library. The route has no server request to retry. |
| Web admin | Profile discovery and seeding read failures, including cached readings. Sign-in has separate password and rate-limit feedback. |
| Reporting and transfers | Song reports, feedback, playlist progress, download attempts and app updates. |
| Shared Notice | Used for feedback across the app, including ordinary empty states, permission errors and successful actions. |

Existing wording examples include “Movies are unavailable. Check the Jellyfin connection for this profile.” in Movies & TV and “Saved on this device · Retry sync” on the Wordle board. Playlist transfers, downloads, updates and feedback also have operation-specific failure messages. Automatic write retries need an existing idempotency safeguard.

## Verification

`tests/outage_states.cjs` uses the loopback music-popup host, the movie bridge fixture and intercepted Files and admin responses. It writes captures here for emulated Windows Chromium, Mac Safari, Pixel 7 Chrome and iPhone 13 Safari. It checks the card structure, wording, action labels and targets, motion settings, focus on recovery, retry backoff and viewport overflow.

Rendered checks, screenshots, the movie suite, the full-screen update test and the Android build are pending Paddock execution. Physical devices, installed WebViews and screen-reader speech are unverified. The existing movie suite has a reported failure at `#lb-wrapped-title` in `music_popup_unification`.

The fixture covers the main outage views and selected recovery paths. Movie requests and playback, Wordle guess validation, Files mutations, and feedback submission still have operation-specific failure states. Their outage and write-recovery paths lack dedicated fixture coverage.
