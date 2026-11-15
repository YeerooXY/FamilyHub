# Mobile music app

A private Flask music interface using family profiles and the staging/import helpers in `scripts/music-intake.py`. It connects selected-result Listen, optional Edit details, authenticated HLS, a queue and browser mixing. The existing layout provides Library, Search, Queue, Import file and Settings with persistent bottom playback controls; it also adapts to mobile. Family profiles require the opt-in flag below. Legacy Navidrome password sign-in remains available when that flag is off. See [the native apps](NATIVE_APPS.md) and [the earlier Windows client](DESKTOP_MUSIC.md).

Historical deployment: the password-based version was verified in the VM through [FamilyHub Music](https://familyhub.example.ts.net:8444/) on 11 November 2026. The family-profile changes described here are implemented and locally tested; this document does not claim their live deployment. See [the desktop verification](DESKTOP_MUSIC.md#verification-11-november-2026) and [earlier verification](MOBILE_MUSIC_VERIFICATION.md) for that version's device limitations.

## Family profiles

Set `FAMILY_PROFILES` to JSON `true` on the private family server. The web client asks who is listening once, then remembers that profile. The native apps first ask for the HTTPS server address, connect, and show the same profile chooser. Use **Switch profile** to change the listener. No Navidrome password is required in this mode. The private network controls access; profiles organize personal data and are not password-protected accounts.

On first enablement, `ALLOWED_USERS` seeds profiles using the exact existing usernames as IDs, including `yeeroo`, so existing playlists remain attached to their owner. New profiles have stable generated IDs. The server supports up to 12 profiles and saves them with volume/shuffle preferences in `WORKSPACE/.family-profiles.json`. Every profile sees the same existing music catalogue.

Playlists are private by default. Owners can share a playlist with other family profiles; shared playlists are read-only for everyone else. Owner ID and playlist ID together identify a playlist, including when two people import the same Spotify link. Matching, editing and deletion remain scoped to the owner.

The native apps cache the selected profile, playlists, preferences and downloaded songs by server and profile. Completed downloads play offline after restart. Native volume/shuffle changes save locally and synchronize when connected; pending offline changes retry on reconnect. Playlist edits require a server connection. The browser retains its profile choice in its signed cookie for up to ten years and restores its session after server restart. **Switch profile** clears that choice. Clearing browser data or removing the profile requires choosing again.

## Music flow, 11 November 2026

- Search chooses one exact source ID. Listen uses validated defaults; Edit details remains optional. Pasted links and the existing upload/import form remain available. Extracted title/channel supply automatic details; they are not verified artist identities.
- Allow new music downloads and discovery is initially off. Local mode prepares validated saved source IDs only. Turning it on permits queued downloads, optional caching of the first two search results and artist-query discovery when autoplay runs out of candidates. Manual search still sends its query to YouTube. The legacy explicit-link API remains compatible; the browser sends its allow-new setting on Listen.
- One supervised acquisition writes an exact `original.spool` and feeds a bounded FFmpeg pipe. Published HLS segments can play before EOF for sequential sources. EOF-dependent M4A uses a completed-file fallback from the same spool. Source quality is not substituted. Completed audio is remuxed with copied packets, packet hashes are compared, full decoding and decoded duration are checked, and only then can `cmd_import` publish a library file.
- Native HLS is preferred; locally hosted hls.js 1.6.15 supplies MSE playback where supported. Media requests remain authenticated and owner-scoped. Play rejection, buffering, errors and retry use stable audio elements; saving does not replace an attached presentation.
- The single coordinator prioritizes current acquisition, the immediate next recording, beat analysis of that pair, up to five following recordings and two optional search previews. Repeated canonical source requests are promoted/coalesced. Queue changes cancel obsolete preparation. Each queued presentation currently acquires a **complete temporary original**, including its opening buffer. It does not stop at a short prefix or implement provider-range resume. Preemption can therefore duplicate discarded prefix bytes on restart; the synthetic test measures this explicitly. Prepared copies remain separate from permanent library imports.
- Cache limits: 12 queued/running jobs, 50 retained jobs, eight ready previews, a 2 GiB per-source spool, 4 GiB aggregate workspace bytes and a 256 MiB free-space reserve. The aggregate includes retained staged originals, so an administrator may eventually need to archive/remove old staged data. Preview expiry is two hours of media inactivity; expired files are reclaimed lazily on a later job request. Originals already imported into the library are preserved. Abandoned files after a process crash are not automatically removed without confirming writer ownership.
- Acquisition has a 30-minute deadline, a 45-second byte-idle limit and bounded queues. Metadata has a two-minute deadline. Shared subprocess checks enforce deadlines, cancellation, output limits and scratch capacity. POSIX process groups and Windows job objects supervise descendants. Cancellation cannot undo a committed library publication.
- Queue order, Previous/Next and autoplay are connected to the decks. Shuffle draws without repeats until the eligible pool is exhausted. Recommended mix ranks related artists, available beat compatibility, recent plays/skips and artist diversity deterministically. Genre/key only contribute if actually supplied; this app does not infer or populate either. It has no trained recommendation model. Play/skip history is session-local. Integrated local selection covers validated YouTube-source manifests; unrelated uploads and Navidrome-only songs remain accessible through Open player.
- Crossfade uses Web Audio gain ramps between two media elements. DJ mode uses librosa beat grids, onset support, phase error and tempo stability, with a conservative heuristic confidence score. Compatible pairs use a pitch-preserving playback rate from 0.94 to 1.06 and source-clock cue correction. Uncertain/variable grids, missing pitch support and incompatible tempos use a normal fade. Unsupported/suspended audio contexts play tracks separately with a visible recovery message. Native media seeking/startup prevents a claim of sample-accurate phase alignment; phrase/downbeat alignment remains unknown.
- Analysis decodes mono 22.05 kHz audio and processes 30-second float32 windows using 1024-point onset FFTs and 64 mel bands, with a ten-minute track limit and 120-second analysis-process deadline. Longer tracks use a normal fade. The final ten-minute CLI probe as UID 2000 peaked at 370,088 KiB RSS; the live service has a finite 1 GiB limit, a 768 MiB soft limit and one-CPU quota. `NUMBA_CACHE_DIR` is a private writer-owned directory under WORKSPACE. Synthetic Chromium playback and overlap passed; physical-phone output, musical phase quality and background behavior remain acceptance checks.

New runtime dependency: [librosa 0.11.0](https://pypi.org/project/librosa/0.11.0/) (ISC), declared in `requirements-mobile.txt`. Beat-tracker semantics follow the [versioned librosa documentation](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html). Pitch correction uses the platform's [`preservesPitch`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch) property; physical-device quality is not established by that API's existence.

Vendored [hls.js 1.6.15](https://www.npmjs.com/package/hls.js/v/1.6.15) is Apache-2.0; the upstream license notice is at `music_web/static/vendor/hls.LICENSE`. Its light minified build SHA-256 is `9467b9a3278bce740773e59423409a02fbcbb8dc668371f17198b18c2a1ab336`. Workers are disabled, so CSP permits same-origin scripts/connections and same-origin/blob media with `worker-src 'none'`.

Analysis dependencies resolved in the workspace Windows venv are listed below. Versions/licenses come from the installed wheel metadata; bundled native components retain their own notices. Sources are the corresponding versioned PyPI distributions. These are recorded resolutions, not a verified Debian lockfile or a completed dependency security audit.

| Distribution | Version | Declared license |
| --- | --- | --- |
| numpy | 2.5.4 | BSD-3-Clause, 0BSD, MIT, Zlib, CC0-1.0 |
| scipy | 1.18.1 | BSD-3-Clause; bundled component notices apply |
| numba | 0.68.1 | BSD |
| llvmlite | 0.50.0 | BSD-2-Clause and Apache-2.0 with LLVM exception |
| scikit-learn | 1.9.1 | BSD-3-Clause |
| soundfile | 0.14.0 | BSD-3-Clause; bundled libsndfile notices apply |
| soxr | 1.1.0 | LGPL-2.1-or-later |
| audioread | 3.1.0 | MIT |
| pooch | 1.9.0 | BSD-3-Clause |
| joblib | 1.6.0 | BSD-3-Clause |
| decorator | 5.3.1 | BSD-2-Clause |
| lazy_loader | 0.6 | BSD-3-Clause |
| typing_extensions | 4.16.0 | PSF-2.0 |
| standard-aifc, standard-sunau, standard-chunk | 3.13.0 | PSF-2.0 |
| audioop-lts | 0.2.2 | PSF-2.0 |
| narwhals | 2.28.0 | MIT |
| threadpoolctl | 3.8.0 | BSD-3-Clause |
| cffi | 2.1.1 | MIT-0 |
| pycparser | 3.12 | BSD-3-Clause |
| cloudpickle | 3.1.2 | BSD-3-Clause |

## Run

```
python -m venv venv && venv/bin/pip install -r requirements-mobile.txt
venv/bin/python -m playwright install --with-deps chromium
FAMILYHUB_MUSIC_CONFIG=/etc/familyhub/music-web.json venv/bin/python -m music_web
```

`python -m music_web` serves with waitress on `127.0.0.1:8765` only. A TLS proxy (Tailscale Serve on port 8444) must publish it; the app sets Secure cookies and HSTS and rejects any `Host` other than the `PUBLIC_ORIGIN` host, so direct `127.0.0.1` requests get 400.

## Configuration

JSON file named by `FAMILYHUB_MUSIC_CONFIG`. Every key is optional; defaults are the intended VM values.

| Key | Default |
| --- | --- |
| `CLI_PATH` | `/usr/local/lib/familyhub/music-intake.py` |
| `WORKSPACE` | `/srv/familyhub/data/quarantine/music/intake` |
| `LIBRARY` | `/srv/familyhub/data/media/music` |
| `NAVIDROME_URL` | `http://127.0.0.1:4533` (native Navidrome; port confirmed by live health check) |
| `PLAYER_URL` | `https://familyhub.example.ts.net:8443/` |
| `PUBLIC_ORIGIN` | `https://familyhub.example.ts.net:8444` |
| `ALLOWED_USERS` | `[]`; legacy sign-in allowlist and initial family-profile IDs, for example `["sample-a", "yeeroo"]` |
| `FAMILY_PROFILES` | `false`; set JSON `true` to enable passwordless profiles on the private family network |
| `SECRET_FILE` | `/etc/familyhub/music-web.secret` (at least 32 random characters) |
| `MAX_UPLOAD` | 134217728 (128 MiB) |

The service user must be able to write `WORKSPACE` and `LIBRARY` (intended: UID 2000). `yt-dlp`, `ffmpeg` and `ffprobe` must be on its `PATH`. `create_app(test_config)` accepts the same keys plus `SECRET_KEY`.

## Behavior

- Family mode: `/api/connect` provides profiles and a CSRF token; selection establishes the existing app session without a Navidrome password. Host, origin and CSRF checks remain enforced. The `familyhub_music` cookie is signed, Secure, HttpOnly and SameSite=Lax. Its remembered profile ID restores a missing or expired in-memory session after confirming that the profile still exists.
- Legacy mode (`FAMILY_PROFILES: false`): the server checks `ALLOWED_USERS` and asks Navidrome `/rest/ping.view` using a fresh salted token. The web service stores and logs no password. Sessions last 12 hours, or 30 days with Remember, and end on service restart. The earlier Windows wrapper separately stores its login with current-user DPAPI.
- Search: Topic-channel results first (the CLI ranking), eight metadata results. Listen chooses the exact recording; details are optional. Enabled queue/search caching can prepare recordings before Listen. A pasted link is validated by `video_id`.
- Import file: audio extensions accepted by the CLI, up to 128 MiB, saved under a random name in the workspace and removed after the job.
- One coordinator runs acquisition/import/analysis work. Same-source requests coalesce and queue requests wait by priority. Uploads and another owner's competing immediate acquisition can receive 409. Status polls every two seconds. Each user sees only their own jobs.
- Errors shown to the browser are fixed short messages. Server logs record the job id, failed step and exception type, without raw provider URLs or local file paths.
- Imported files appear in the player after Navidrome's next library scan. The app does not trigger a scan or store admin credentials.

## Limits

- Sessions and jobs are in memory. Family profile choices survive restart through the signed browser cookie; legacy password sessions end. A restart forgets job status; an import already started in the CLI is not undone.
- Rate limits (login 8 per user and 30 total per 5 minutes, search 10 per minute per user) are per process.
- The uploaded file's original name is not kept; the title you enter names the library file.
- Metadata search and fetching depend on yt-dlp working against the provider; the app makes no quality claim beyond what the CLI manifest records.
- Queue/autoplay are supported as described above. Public Spotify playlist import is documented in [Public playlist reader](PUBLIC_PLAYLIST_READER.md). No trimming interface or album matching is added.

## Development installation

- App: `/usr/local/lib/familyhub/mobile/music_web`, dependencies: `/usr/local/lib/familyhub/web-venv-dj-d42753f5`. The previous app, CLI and runtime were retained for rollback; local deployment metadata is `.local/music/sol-deployment.json`.
- Service: `familyhub-music-web.service`, enabled and active, writer UID/GID 2000, bound only to `127.0.0.1:8765`.
- Configuration: `/etc/familyhub-music-web/config.json`, signing key: `/etc/familyhub-music-web/secret`. Both files are root-owned, group 2000, mode 0640, inside a 0750 directory. Their values are outside Git and Results.
- The existing allowlist includes `sample-a` and `yeeroo`. Enabling family mode seeds those exact profile IDs. Additional family profiles can then be created through the chooser without adding Navidrome accounts or changing the allowlist. Password-based deployments continue to require explicitly allowed accounts.
- The unit uses `NoNewPrivileges`, a private temporary directory, protected system/home paths, a 1 GiB memory cap and a one-CPU cap. Writes remain limited to the music workspace, Deno cache and music library. The compiler cache is `/srv/familyhub/data/quarantine/music/intake/.numba-cache-dj`; numerical-library threads are limited to one. The service runs as UID/GID 2000.
- The private app address uses port 8444, forwarding through workstation loopback `127.0.0.1:18765` to VM loopback `127.0.0.1:8765`. The player remains on port 8443. Both Serve routes are private to the tailnet; no Funnel was enabled.
- Keep the Windows PC, Debian VM and Tailscale running. Serve stays in the background; the SSH forwarding processes are not boot-persistent and need restoring after a reboot or disconnection.

## Data and privacy

Search sends the query to YouTube through yt-dlp. A selected download contacts YouTube and its media hosts. No external analytics, advertising SDK or client-side third-party script is included. Download only audio you own or have permission to copy.

Uploaded audio is held under a random temporary filename, then staged and imported through the existing CLI. The temporary upload is removed after the job. Staged originals, manifests and library files remain until the administrator removes them. This interface has no delete action. The family library is shared; job status is restricted to the requesting username.

Family mode remembers a profile choice in the existing signed browser cookie, including across service restarts, until Switch profile, browser-data removal or cookie expiry. It stores no music-account password. Legacy password sessions expire after 12 hours or 30 days with Remember, and end on logout or service restart. Changing a Navidrome password alone does not immediately revoke an existing legacy app session. Completed jobs are held in memory, capped at 50; the API lists the requesting profile's retained jobs.

## Tests

`python -m unittest tests.test_music_web` (skipped if Flask is not installed). Navidrome and the CLI operations are faked; no network or real music is used.

Family-mode coverage: `python -m unittest discover -s tests -p test_family_profiles.py` passes ten tests for selection, remembered cookies after restart, logout, removed profiles, preference isolation, sharing permissions and the disabled legacy default. `node tests/music_family_profiles.cjs` checks the rendered chooser's keyboard controls and shared-playlist owner identity in Chromium.
