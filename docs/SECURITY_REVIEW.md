# FamilyHub security review

Task 8 covers `codex-downloads`, app version 1.1.0. The review used local source, temporary workspaces, mocked upstream services and browser fixtures.

## Findings

| Severity | Status | Location | Impact and fix or recommendation |
| --- | --- | --- | --- |
| High | Fixed | `music_web/__init__.py:500`, `:523`, `:560`, `:609` | A tailnet client could select a FamilyHub administrator or linked movie viewer without a credential. Both selection paths now require a profile password for these identities. Protected sessions use a newly issued server-side ID and end on expiry, logout or restart. Older passwordless cookies cannot restore a protected identity. The tests cover both selection paths, rate limits and session replay. |
| High | Fixed | `clients/FamilyHub.App/Services/AppUpdater.cs:27`, `clients/FamilyHub.Client.Core/PublicAppReleases.cs:45` | A compromised mirror could advertise its own executable package and matching hash. The installer now checks official GitHub metadata at install time, rejects same-version and older releases, and permits the Windows mirror only for identical version, digest and length. Downloads follow only approved HTTPS asset redirects. Windows and Android check the actual bytes before extraction or installer handoff. Portable tests cover altered metadata, altered bytes, downgrade and blocked redirects. |
| Medium | Fixed | `music_web/files.py:250`, `:302`, `:507` | A member could select another passwordless profile and read its private files or manage its private share links. Family-mode **Your files** and private link management now require a password-protected profile. Shared files remain accessible to signed-in family profiles. The tests cover access to both spaces and existing private share links. |
| Medium | Fixed | `music_web/movies.py:126`, `:138`, `:171`, `music_web/__init__.py:974` | A non-admin could see the movie download queue, a configured download member could start downloads, and any profile could see server work details. Download access now requires both administrator membership and the movie download allowlist. Both `/api/server/` routes require an administrator. The separate signed-in Leaderboard route omits host and worker details. Duplicate Seerr account mappings fail closed. Tests verify member denial, admin access, shared leaderboard access and upstream call boundaries. |
| Medium | Fixed | `music_web/movie_media.py:69`, `:114`, `:148`, `:164`, `clients/FamilyHub.App/wwwroot/movies.js:67` | A Jellyfin access token was returned to the app and added to video and subtitle URLs. A party that obtained one of those URLs could reuse the Jellyfin account token. FamilyHub now keeps it server-side, sends it to Jellyfin in an authorization header and strips it from JSON and HLS URLs. Movie API requests require the issuing FamilyHub session and CSRF. Media grants expire after eight hours at most and stop working on view close or when the issuing session ends. Tests cover scoped routes, separate sessions, HLS rewriting and revocation. |
| Medium | Fixed | `music_web/files.py:132`, `:175`, `:182`, `:244`, `:562` | A linked private-space root could direct operations outside the intended folder. A shared folder owner could delete somebody else's descendants or erase their ownership on rename. Stale links could resolve to a replacement under the old name. Files checks root and component links, preserves descendant ownership on rename, checks ownership before recursive delete and revokes old-path shares. Share redemption rechecks expiry under the store lock. HEAD probes preserve one-time downloads. Tests cover these cases with temporary folders and local clients. |
| Medium | Fixed | `music_web/__init__.py:351`, `:446`, `music_web/feedback.py:39`, `music_web/files.py:515`, `:522` | Rejected host and origin checks could log a share URL, and activity labels could retain a pasted credential-bearing URL. Logs now use fixed endpoint names and error types and redact URLs and credential fields from activity text. Share pages send the origin only as the referrer, and attachments omit it. Logs and link headers have regression tests. |
| Medium | Fixed | `music_web/__init__.py:657`, `:3317`, `music_web/http_limits.py:19`, `music_web/movie_youtube_downloads.py:82` | Large non-upload bodies could consume Waitress buffers before route validation. A movie transfer could run indefinitely or fill the downloads volume. Waitress applies limits before reading bodies and retains separate allowances for feedback attachments and explicit uploads. Flask bounds JSON reads and rate-limits audio uploads. The movie worker bounds queue size, runtime and transfer space, preserves a free-space reserve and removes staging files at completion or failure. Tests cover fixed-length and chunked bodies, transfer cancellation and cleanup. |
| Medium | Fixed | `music_web/__init__.py:171`, `:2936`, `music_web/movies.py:46`, `music_web/movie_search.py:49`, `:290` | Some fixed-host requests followed redirects before validating the destination. A redirect could cause an unintended internal request or forward provider credentials. Artwork, Navidrome sign-in, Gemini and Wordle requests refuse redirects. Service configuration URLs are parsed, and movie thumbnails are restricted to known YouTube image hosts. Tests cover artwork redirect refusal and normal provider fixtures. |
| Medium | Fixed | `clients/FamilyHub.Client.Core/FileDownload.cs:7`, `music_web/files.py:44`, `scripts/music-intake.py:1236`, `:1245` | Concurrent device downloads could overwrite a pre-existing copy. File names could contain reserved Windows names or start with a hyphen. The device creates downloads exclusively and removes partial files on failure. The server validates names and applies the existing input protocol and format allowlists to FFmpeg trimming. Portable tests cover concurrent saves and invalid names. Python tests cover safe intake filenames and path checks. |
| Medium | Fixed | `clients/FamilyHub.App/MainPage.xaml.cs:288`, `:344`, `clients/FamilyHub.App/wwwroot/movies.js:728` | Broad WebView navigation checks and an unchecked JavaScript link fallback could expose the interop surface or open an unexpected URL. Navigation stays on MAUI's local app origin. Android file, content and mixed-content access are disabled. Windows host objects are disabled. Both link paths accept canonical HTTPS YouTube watch links. Builds and browser fixtures cover the affected app paths. |
| High | Fixed | `docs/NEW_SERVER.md:22` | The setup guide granted a named SSH key unrestricted passwordless root access. The guide now requires owner verification of a temporary key, applies OpenSSH key restrictions and keeps privileged setup under owner control. Review the guide against any existing passwordless grant during migration. |
| Medium | Fixed | `compose.playback.yaml:9`, `compose.acquisition.yaml:9`, `compose.acquisition.vpn.yaml:6` | A compromised service could use a writable image filesystem or unnecessary default capabilities. Playback containers now use read-only root filesystems and bounded temporary storage. Acquisition services drop capabilities they do not need for their published ports and normal responsibilities. The VPN retains `NET_ADMIN` and `/dev/net/tun`. Compose configuration was validated locally. Container startup and media imports still need a disposable Linux environment. |
| Low | Open | `music_web/__init__.py:523`, `:541`, `music_web/profiles.py:98` | Ordinary profiles still support trusted-network selection and profile creation. A family member can act as another ordinary profile, including editing its personal music state. Set passwords for profiles that need individual privacy. Restrict tailnet membership and consider requiring owner approval for creating profiles. |
| Low | Open | `music_web/public_playlists.py:82`, `:226`, `scripts/music-intake.py:704` | Spotify's browser and provider extractors process responses from their providers. A provider compromise could widen their outbound traffic. Initial URLs are canonical and Spotify API replay blocks redirects. Isolate acquisition traffic from the LAN and tailnet using an egress policy that permits the providers and media CDNs. |
| Low | Open | `music_web/__init__.py:392`, `music_web/files.py:218`, `:533` | Music stream and file share URLs are bearer credentials. Proxy access logs, history, clipboard managers or recipients can retain these URLs. Exclude ticket paths and queries from logs and use the shortest useful share expiry. For stricter music revocation, bind music tickets to a live session and verify device reconnect and background playback. |
| Low | Open | `music_web/__main__.py:28`, `music_web/files.py:97`, `:191` | Waitress buffers explicit uploads before Flask validates their sessions. Authenticated transfers retain size and disk checks. Use a separate upload spool with a filesystem quota and proxy-level concurrent upload limits if the tailnet includes untrusted devices. Set a per-space `FILES_QUOTA` where appropriate. |
| Low | Open | `music_web/files.py:132`, `music_web/__init__.py:2950` | Files and the library assume trusted local writers. A process with concurrent write access to those roots can race filesystem checks. Limit write permissions to the service and approved importers. If unrelated local users need write access, consider descriptor-relative operations with no-follow semantics. |
| Low | Open | `clients/FamilyHub.App/Platforms/Android/MainActivity.cs:62`, `clients/FamilyHub.App/Platforms/iOS/Info.plist:1`, `clients/FamilyHub.App/Components/FilesView.razor:160` | Android 13 and later hide recent-task screenshots. Manual screenshots, other platform previews and copied share URLs can still expose displayed data. Decide whether to mask private views in app switchers and mark copied share links sensitive where the OS supports it. |
| Low | Open | `clients/FamilyHub.App/Services/AppUpdater.cs:72`, `:102`, `docs/IOS_PRIVATE_INSTALL.md:1` | Windows trusts GitHub's TLS and asset digest. Android adds OS package signature and downgrade enforcement. iOS hands off to SideStore, which controls the source and re-signs the IPA. Consider Authenticode or a pinned release-signing key for Windows, keep the Android signing key stable and confirm SideStore uses the official source. |
| Low | Open | `docs/MOBILE_MUSIC.md:109`, `docs/SERVER_HEALTH.md:27`, `compose.acquisition.yaml:27` | The live unit and acquisition image startup behavior sit outside this checkout. Test the systemd settings and image-specific read-only filesystems below on a disposable Debian environment before rollout. |

## Profile password setup

1. Use the stable ID shown by the local profile list or in `STATE_DIR/.family-profiles.json`. When `STATE_DIR` is unset, use `WORKSPACE/.family-profiles.json`. Add a distinct passphrase for each administrator, each Jellyfin-linked viewer and any profile that uses **Your files**.
2. Generate a Werkzeug password hash on a trusted machine. This command prompts for the password without echoing it or placing it in shell history.

   ```sh
   python -c 'from getpass import getpass; from werkzeug.security import generate_password_hash; print(generate_password_hash(getpass("Profile password: ")))'
   ```

3. Store the hash in the protected JSON loaded through `FAMILYHUB_MUSIC_CONFIG`, for example `"PROFILE_PASSWORD_HASHES": {"profile-id": "<generated hash>"}`. The server owner and service account need read access. The client asks for the passphrase when selecting this profile.
4. Roll out the server and native apps together. Earlier apps cannot send profile passwords or use the new movie gateway. Verify admin sign-in, ordinary profile selection and private-file access after restart. Revoke Jellyfin tokens issued to older clients if their URLs may have been retained in logs.

### Requiring a password for every profile

Set `"REQUIRE_PROFILE_PASSWORDS": true` in `FAMILYHUB_MUSIC_CONFIG` (default `false`) to require a password on every family profile, including newly created profiles. Profiles that already have a hash in `PROFILE_PASSWORD_HASHES` or `.profile-passwords.json` keep signing in with their existing password. Profiles without a stored hash show the create-password screen and must choose a password of at least 8 characters before starting a session.

Rollout notes:

- Set the server owner and administrator passwords first, either in `PROFILE_PASSWORD_HASHES` before restarting or by signing in to those profiles immediately after enabling the flag.
- Turning `REQUIRE_PROFILE_PASSWORDS` on signs everyone out until they sign in with or create a password. Existing browser and app cookies for profiles without a password hash stop working on restart, so each client returns to the profile list and the create-password card.

## Route authentication and CSRF

The host check applies to every request. Unsafe methods require a matching `Origin` or same-origin `Referer`, followed by Flask-WTF CSRF validation. `POST /api/share/<secret>/download` uses the share credential, optional password and origin check because recipients have no FamilyHub session. Cookies use `Secure`, `HttpOnly` and `SameSite=Lax`. Profile selection rotates the session ID and CSRF token. Ordinary passwordless family profiles can be restored after a restart under the trusted-network model. Legacy Navidrome sign-in requires a password and also rotates the session.

| Routes without a FamilyHub session | Access and purpose |
| --- | --- |
| `GET, POST /login` | Browser sign-in and profile selection. POST requires CSRF and the password when the selected account requires one. |
| `GET /static/<path:filename>` | Browser assets. Browser-disabled mode removes access to this route. |
| `GET /api/connect` | Family-mode bootstrap returns public profile labels and provides CSRF. |
| `POST /api/profiles` | Adds an ordinary family profile within the profile limit. Requires CSRF and a creation rate limit. |
| `POST /api/profile/select` | Establishes a profile session. Requires CSRF and the configured password for protected profiles. |
| `GET /api/profile-images/<owner_key>/<digest>.jpg` | Versioned avatar for the family profile picker. |
| `GET /api/app-updates/<platform>`, `GET /api/app-updates/<platform>/<digest>` | Update metadata and packages before profile selection in family mode. Installers verify publisher metadata independently. |
| `GET /api/share/<secret>`, `GET, POST /api/share/<secret>/download` | Public recipients need the random share credential, plus the link password if configured. Expiry, revocation and download count apply. |
| `GET, HEAD, OPTIONS /api/movies/media/<ticket>/<path:resource>` | Video, HLS and subtitles use a limited grant tied to a live session. The HTTP player can fetch with the grant alone. |
| `GET, HEAD /api/jobs/<job_id>/media/<asset>`, `GET, HEAD /api/library/<source_id>/download`, `GET, HEAD /api/library/<source_id>/playback-source/<digest>`, `GET, HEAD /api/library/<source_id>/playback/<digest>/audio.m4a`, `GET, HEAD /api/library/<source_id>/playback/<digest>/audio.opus` | Music playback and download use a signed, path-bound music ticket or an active session where the route permits it. The playback-source route always requires a ticket and matching digest. |

Administrator checks also apply to catalogue edits, undo, bulk resolutions, report management and source-quality administration, artist mappings, feedback inbox and status, and listening history for other profiles. Files scope access to the profile, the uploader or an administrator as appropriate. Playlist access follows ownership, co-author and share rules. Movie search, requests and releases apply their Jellyfin, Seerr and release mappings and allowlists.

`POST /api/movies/subtitle` requires a mapped Movies profile, a session-bound media grant, CSRF and a per-profile rate limit. The server reads the video path from Jellyfin, publishes without replacing existing subtitles, and uses the server's Jellyfin key only for the item refresh when that key is configured.

Movie audio routes require an active FamilyHub session, administrator membership and a profile on the movie downloads allowlist. Mutations use bounded JSON and CSRF. Starting a job also checks the media grant against the issuing session. Server-side source IDs resolve within the completed downloads and imports roots. Jellyfin supplies the destination through the server-side movie session. The worker opens media through no-follow descriptors, restricts FFmpeg and FFprobe to local files and known formats, and runs one batch at a time. Job history stays in `STATE_DIR`. Source deletion checks both stored file identities and probes the published audio again.

Read-only searches and stream preparation can populate caches and start bounded server work. Share download uses GET for passwordless recipients and consumes its allowance on redemption. GET and HEAD on the share landing page preserve that allowance. The inventory below lists Flask rules with GET's implicit HEAD and default OPTIONS omitted.

## Implementation checks

- **Files and audio.** Share secrets come from 32 random bytes and SQLite stores the SHA-256 digest. Optional share passwords use Werkzeug hashes. File downloads force `application/octet-stream` and attachment disposition. Revisions, content hashes and real-path checks govern library and artwork reads. Audio uploads feed FFmpeg restricted formats and local protocols.
- **Network and subprocesses.** Request paths choose fixed hosts or configured services. Parsed URLs and canonical provider IDs feed argument lists, with `--ignore-config` and end-of-options markers for yt-dlp URL arguments. Search text stays inside a search argument. Known Python HTTP fetches use timeouts and bounded response reads. Prowlarr receives only an indexer result reference bound to the profile. Search and release lookup have per-profile limits, and server queues and worker lanes have separate capacity limits.
- **Data and rendering.** Request data uses bounded JSON and structured validation. SQLite queries bind values, including path prefixes. Jinja and Razor encode displayed text. `MarkupString` in `MusicIcon.razor:3` reads fixed SVG shapes. `movie-releases.js:129` inserts a static template. Titles and subtitle cues enter text nodes, including text decoded from HTML entities. Dynamic imports use packaged paths. The app has no custom incoming `postMessage` handlers. The MAUI bridge runs in the local app context. External tabs use `noopener noreferrer`.
- **Native network and storage.** Android disables backup and cleartext. iOS uses default ATS restrictions. The Android launcher is exported for the launcher intent. The playback service is private. The app uses outbound SideStore links and has no incoming custom deep-link handler. The client retains profile passwords, cookies and CSRF values in memory. Preferences hold server and profile IDs, cached state and playback settings. HTTPS and normal certificate validation apply to FamilyHub and release downloads. Clipboard reads, copy and share follow explicit UI actions.
- **Host and containers.** Waitress binds to loopback behind Tailscale Serve. The checked-in Compose files use loopback publishing, `no-new-privileges`, and no privileged containers or Docker socket mounts. Playback mounts state and cache paths explicitly. Acquisition images still have writable root filesystems for entrypoint and supervisor setup.
- **Server state.** `STATE_DIR` holds profile and playback state, listening and catalogue data, playlist and discovery caches, verified-audio stamps, the Files database, feedback and activity logs. Without it, these entries use `WORKSPACE` and the Files database uses `FILES_ROOT`. Shared file contents stay under `FILES_ROOT`, and native update packages stay under `WORKSPACE/.app-updates`. Restrict service state, migration archives and any `STATE_BACKUP_DIR` snapshots to authorized accounts. See [Server operations](SERVER_OPERATIONS.md#small-state-on-the-system-disk) for migration and backup paths.

## Systemd hardening to validate on Debian

Keep the unit's unprivileged service account, `ProtectSystem=strict`, `PrivateDevices=yes`, `NoNewPrivileges=yes`, and narrow `ReadWritePaths=`. Test a drop-in with the following settings against music intake, movie playback, file uploads and hardware counters.

```ini
[Service]
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native
SystemCallFilter=~@mount @module @raw-io @reboot @swap @obsolete @clock
```

Use `systemd-analyze verify` and `systemd-analyze security` on the disposable unit. Keep sysfs and proc entries needed by Server Health readable. Tailscale Serve reaches Waitress over loopback. A loopback and tailnet-only `IPAddressAllow=` policy requires a separate egress proxy or namespace for public YouTube, Spotify, Deezer, lyrics and metadata traffic. Verify DNS, public CDN access and tracker routing before applying such a policy. Test `read_only` for each acquisition image with writable `/run`, `/tmp` and configured state mounts as needed.

## Owner decisions

- Select which ordinary profiles need passwords and prepare hashes for admins, linked movie accounts and private Files users. Schedule the server and app update together.
- Decide how to isolate server-side acquisition egress and where to cap upload spool usage. Validate the systemd drop-in and Compose startup on disposable Debian.
- Verify Android installer handoff, native iOS playback and SideStore source on physical devices. Decide whether to add Windows package signing and broader screenshot protection.

Existing wording flagged during the review. The introduction in `docs/FILES.md` called Files “FamilyHub's own take on a family cloud drive, in the spirit of Nextcloud.” It now states the two storage options and how sharing works. The historical fixture note in `docs/MOVIES.md` identifies the track as the film's music-and-effects mix.

## Local verification

- Python discovery ran 701 tests with 37 skips. FFmpeg/FFprobe integrations and Windows symlink cases were among the skips. The new regression tests exercise session rotation and replay, route access, private file metadata, share expiry and ownership, range forwarding, HLS rewriting, upload limits, and log handling.
- The .NET client suite passed 962 checks. The server-work component fixture passed. Windows and Android builds passed, and nine Movies fixture suites passed in emulated Chromium or WebKit profiles.
- Compose validation checked playback, acquisition and the VPN overlay. The unit sandbox, container runtime, iOS native playback and device installer handoff remain deployment checks.
- After merging `rc-1.2.0`, the VM ran 710 Python tests. The route inventory, profile password and state migration checks passed. The run had three skips and three known baseline failures in tempo analysis and scratch quota. Three .NET test projects, the Windows and Android builds, and all 15 requested Playwright suites passed.

## Complete route inventory

The authenticated POST to `/api/playback/diagnostics` accepts the `client_exit` stage. It logs allow-listed Android exit reasons and importance, relative timings, and up to three managed method names with the exception type. The existing request limits and CSRF checks apply.

The following rules are registered with family mode enabled. Feature flags and profile mappings can make individual routes unavailable.

```text
GET /
GET /admin
GET /admin/<name>
GET /api/activity/stats
GET /api/admin/discovery
POST /api/admin/discovery
GET /api/app-updates/<platform>
GET /api/app-updates/<platform>/<digest>
GET /api/artwork/<source_id>
POST /api/catalogue/<section>/resolve-all
PATCH /api/catalogue/metadata/<identifier>
POST /api/catalogue/metadata/<identifier>/undo
GET /api/catalogue/reports
POST /api/catalogue/reports
POST /api/catalogue/reports/replace
POST /api/catalogue/reports/resolve
GET /api/catalogue/review
GET /api/catalogue/source-quality
POST /api/catalogue/source-quality/<identifier>/<action>
POST /api/catalogue/source-quality/replace-all
POST /api/catalogue/trimming
POST /api/catalogue/trimming/<identifier>/resolve
GET /api/connect
GET /api/discovery
POST /api/discovery/<identifier>/play
POST /api/discovery/<identifier>/state
GET /api/discovery/covers/<image_id>.jpg
GET /api/discovery/follow
POST /api/discovery/follow
GET /api/feedback
POST /api/feedback
GET /api/feedback/<report>
PATCH /api/feedback/<report>
GET /api/feedback/<report>/images/<int:index>
POST /api/feedback/<report>/replies
DELETE /api/files
GET /api/files/download
POST /api/files/folder
GET /api/files/links
POST /api/files/links
DELETE /api/files/links/<link_id>
GET /api/files/list
POST /api/files/rename
PUT /api/files/upload
GET /api/jobs
POST /api/jobs
GET /api/jobs/<job_id>
POST /api/jobs/<job_id>/cancel
GET /api/jobs/<job_id>/media/<asset>
GET /api/library
GET /api/library/<source_id>/download
GET /api/library/<source_id>/lyrics
GET /api/library/<source_id>/playback-info
GET /api/library/<source_id>/playback-source/<digest>
GET /api/library/<source_id>/playback/<digest>/audio.m4a
GET /api/library/<source_id>/playback/<digest>/audio.opus
GET /api/library/additions
POST /api/library/additions
GET /api/listening/events
POST /api/listening/events
DELETE /api/listening/history
POST /api/listening/invites
GET,POST /api/listening/pokes
DELETE /api/listening/pokes/<key>
GET,POST /api/listening/rooms
DELETE,GET,PUT /api/listening/rooms/<key>
POST /api/listening/rooms/<key>/join
GET /api/listening/summary
GET /api/listening/wrapped
GET /api/movies/audio-sources
POST /api/movies/audio-track
POST /api/movies/audio-track/<job_id>/delete-source
POST /api/movies/download
GET /api/movies/downloads
POST /api/movies/find
GET /api/movies/health
POST /api/movies/library
POST /api/movies/matches
GET /api/movies/media/<ticket>/<path:resource>
POST /api/movies/media/close
POST /api/movies/releases
POST /api/movies/report
POST /api/movies/request
POST /api/movies/request-search
POST /api/movies/season-episodes
POST /api/movies/session
POST /api/movies/subtitle
POST /api/movies/videa-download
POST /api/movies/videa-search
POST /api/movies/youtube-download
POST /api/movies/youtube-metadata
POST /api/playback/activity
POST /api/playback/control
GET /api/playback/devices
GET,POST /api/playback/diagnostics
GET /api/playback/handoff/<command_id>
POST /api/playback/takeover
POST /api/playback/transfer
GET /api/playlists
POST /api/playlists
GET /api/playlists/<owner>/<pid>/artwork/<digest>.jpg
DELETE,PATCH /api/playlists/<pid>
POST /api/playlists/<pid>/download
POST /api/playlists/<pid>/import
GET /api/playlists/<pid>/match
POST /api/playlists/<pid>/match
DELETE,GET,POST /api/playlists/<pid>/prepare
POST /api/playlists/<pid>/recording
GET /api/playlists/link-name
POST /api/playlists/spotify
POST /api/playlists/youtube
GET /api/profile-images/<owner_key>/<digest>.jpg
POST /api/profile/image
POST /api/profile/password-setup
PATCH /api/profile/name
GET,PATCH,PUT /api/profile/playback
GET,PATCH /api/profile/preferences
POST /api/profile/select
POST /api/profiles
POST /api/queue
GET /api/home/radio
POST /api/home/album
POST /api/home/album/play
POST /api/radio
POST /api/recommendations
POST /api/recommendations/match
POST /api/search
GET /api/server/seeding
GET /api/server/stats
GET /api/server/stats/now
GET /api/share/<secret>
GET,POST /api/share/<secret>/download
POST /api/transition
POST /api/uploads
PUT /api/wordle/activity
GET /api/wordle/family
POST /api/wordle/guess
GET,PUT /api/wordle/settings
GET /api/wordle/stats
GET /api/wordle/today
GET,POST /login
POST /logout
GET /static/<path:filename>
```
