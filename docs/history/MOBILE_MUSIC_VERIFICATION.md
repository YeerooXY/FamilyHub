# Mobile music verification

## Live integration after focused fixes, 11 November 2026

The revised app is deployed at `https://familyhub.example.ts.net:8444/`. Only `familyhub-music-web.service` was restarted. Tailscale remained Running/online, Paddock remained available and the existing player at port 8443 returned HTTPS 200. Previous app/CLI/runtime files were retained for rollback. No commit or push was made.

- Focused fixes: task `68450afe-b5dd-4ec9-b127-951ee0f72963`, `codex:default`, GPT-6.1-Sol medium. It applies the accepted findings from the prior single Claude Sonnet medium review; no additional review loop ran. Listen-save behavior was preserved intentionally.
- Final Windows portable check: 72 tests, passed, four expected network/symlink skips. Final isolated Debian check using the replacement runtime: 72 tests, passed, only the opt-in network test skipped. The portable checker requires FFmpeg/ffprobe and avoids the earlier nested-PowerShell PATH error.
- The final analysis CLI, executed as UID 2000 on the exact packaged source and a ten-minute synthetic WAV, detected 120.185 BPM with a reliable grid, took 2.56 seconds and peaked at 370,088 KiB RSS. Earlier approximately 2 GiB figures came from a whole-array helper probe and must not be used as the final windowed CLI measurement. The live unit uses MemoryMax 1 GiB, MemoryHigh 768 MiB, one-CPU quota and a private writable compiler cache. After real playback its observed service peak was 308,293,632 bytes; `ProtectSystem=strict` and `NoNewPrivileges=yes` remain enabled.
- The replacement runtime installed successfully; its 42-package dependency audit reported no known vulnerabilities. Compiler-cache creation and beat-tracker execution passed as the service user. This is point-in-time dependency evidence, not a guarantee about future advisories.
- Existing NEFFEX / Fight Back / Creator Downloads media was associated with its verified original video ID `CYDP_8UTAus` in an archival-source staging record. The original Wikimedia provenance/license and original local staging record remain. Its library SHA-256 was unchanged and no second library file was created. The new app lists and reuses this saved source.
- A preflight against the real saved file passed sign-in, completed preparation, authorized HLS 200, immutable byte Range 206 and anonymous media 401, with acquisition disabled to prove reuse.
- Actual private HTTPS Windows Chromium sign-in and saved-source Listen passed. Non-silent decoded audio was measured at the connected mixing output; no JavaScript errors were recorded and CSP was present. The real recording's grid was marked unreliable, so it uses normal crossfade rather than forced beat matching. Evidence: `.local/music/sol-live-browser-result.json` and `.local/music-browser/live-windows-chromium.png`.
- The prior four-profile rendered/focus checks and native/forced-hls.js synthetic overlap checks remain applicable: this focused patch changed backend contracts and analysis, with no UI source changes. Windows Chromium and emulated Android Chromium decoded synthetic audio; Mac/iPhone WebKit coverage was emulated and this host lacks their audio capabilities. Physical Android/iPhone, background/lock-screen behavior and perceptual phase/pitch quality remain owner checks.
- A real anonymous yt-dlp acquisition of the licensed Fight Back recording passed through the installed progressive pipeline in temporary quarantine. First segment availability was 11.1 seconds; complete validated staging was 19.01 seconds. This is one cold-source observation, not a latency guarantee or a precise upstream-EOF measurement. Synthetic EOF-barrier tests establish early decoding before source completion. The real test was not imported, and its temporary files were removed.

Current limits: future/search caches acquire full temporary tracks rather than prefix-only resumable buffers; they use more bandwidth. The source-ID queue does not cover every older upload or Navidrome-only item. Beat blending has conservative fallback and does not claim phrase/downbeat matching. No physical-phone or offline-download pass is claimed.

The sections below retain the implementation and verification history; the live integration evidence above supersedes earlier deployment/browser blockers.

## Focused backend fixes, 11 November 2026

Working tree only. This worker changed `music_web/__init__.py`, `music_web/analysis.py`, `tests/test_music_progressive.py`, `scripts/check-music.py` and these narrow deployment/verification notes. Existing unrelated changes are preserved. No commit, push, deployment, service, tunnel or credential changes were made.

- Eviction catches intake validation failures as well as filesystem failures. Missing previews/items and modified temporary items cannot abort the next acquisition. Deletion still requires a validated, unimported YouTube cache directly under WORKSPACE, matching the job's source identity. Invalid items are retained for administrator inspection; saved library files and local staged originals are excluded.
- Listen cancels obsolete source-backed playback work. Upload/stage/import jobs continue. Deduplication takes the minimum numeric priority; weaker queue/prefetch requests retain the stronger preparation priority and current-song flag. An explicit Listen promotes to zero. A fresh queue still cancels unrequested speculative work.
- Status contains only BPM, reliability, confidence and reason. Internal beat arrays remain available to transition planning. No frontend changes are required.
- A 256-entry in-memory LRU reuses validated source lookups. Manifest and audio signatures include inode/device, size and nanosecond modification/change times; containing directories are checked for links and inode/device identity. Every reuse checks links, containment and signatures; changes force fresh manifest/source/hash validation. Manifests remain the catalogue. Repeated library requests do not rehash unchanged recordings.
- Generation counters live in server-session records, so logout, re-login and expiry remove them with those records. Stale generations remain rejected.
- Explicit metadata replaces the dictionary under the coordinator lock. Acquisition completion checks automatic metadata under that same lock. At the guarded import boundary, work snapshots current metadata and locks further edits; differing edits during import or after commitment receive 409. Identical repeat requests remain usable. Published artist/title use the accepted metadata. This avoids acknowledging edits after tagging has begun.
- Listen continues to save played originals. Unplayed speculative recordings remain temporary.

Analysis retains the existing serialized subprocess, 30-second float32 input windows, ten-minute track bound, 120-second deadline, stability/support/phase checks and explicit unavailable fallback. Onset spectra now use a 1024-point FFT and 64 mel bands rather than the larger defaults. This reduces spectral allocation and frequency detail; it does not identify phrases or downbeats. Known-tempo, phase/alignment, silence, changing-tempo and multi-window grid tests remain required.

A fresh Windows subprocess running the revised `analyze_file` on 600 seconds of synthetic 120 BPM clicks completed successfully in 4.10 seconds with 1,160 beats, 120.185 BPM and `reliable=true`. In-process Windows `GetProcessMemoryInfo` recorded peak working set **323,256 KiB** and peak private commit **1,811,396 KiB**. Numba's cache was warm under `.local/numba-cache`. These are Windows process measurements, not Debian cgroup measurements or a 512 MiB fit claim. The lead's earlier Debian 2,123,596 KiB ten-minute result remains the conservative runtime evidence until the revised source is measured there. Recommend a finite **3 GiB application cap**, one serialized analysis, and an integration measurement including the web parent and FFmpeg before reducing that cap. Set `NUMBA_CACHE_DIR` to a writable directory under WORKSPACE for the service user. This worker changed no runtime limits.

Final Windows check: **72 tests passed, four expected network/symlink skips**, in 20.33 seconds. The 25-test affected group also passed with FFmpeg available. After the full run, the cache entry was tightened to store the signature validated during hashing and use directory identity rather than unrelated directory timestamps; the affected saved-source/cache regression passed again (one test, 0.91 seconds). Timeout/missing-analysis-dependency and duration-limit regressions verify explicit fallback and worker cleanup.

Checks: `.local/tools/mobile-venv/Scripts/python.exe scripts/check-music.py` requires FFmpeg and ffprobe, prepends the known local Windows bin when present, runs only `test_music*.py` using its own interpreter from the repository root, and propagates failures. The restricted Windows token additionally required the lead's existing ignored test-only ACL shim via `PYTHONPATH=.local/test-runtime;.`. The check script does not change source or install tools. Missing-media checks cannot silently produce a green run.

Browser/device checks were not rerun: UI and its consumed fields are unchanged; status intentionally omits internal grid arrays. Lead integration should rerun the existing browser harness against this revision. Physical iPhone/Android, live HTTPS/background behavior and revised Debian memory measurements remain open.

## Current correction, 11 November 2026, working tree only

This section supersedes earlier coverage for the changed music code. No commit, push, deployment, live credentials, commercial audio, tunnel, Tailscale/Paddock restart or service change was used.

### Lead verification after the worker and review

The worker's browser-launch limitation below was resolved for verification by using the lead's normal execution environment. The automatic task-check command expanded PATH incorrectly and skipped 20 tests despite returning success; that output is not the accepted media-test evidence.

- Correctly configured Windows run: 64 tests, passed, four expected network/symlink skips. Isolated Debian run on the final source snapshot: 64 tests, passed, only the opt-in network test skipped. Evidence: `.local/music/sol-windows-test-result.json`, `sol-debian-test-result.json` and `sol-validation-source-hashes.json`.
- The four-target browser harness passed in the lead environment. Windows Chromium and emulated Android Chromium decoded non-silent synthetic HLS and completed a queued overlap with pitch preservation enabled. Both native HLS and a deliberately forced hls.js fallback passed. This establishes connected synthetic playback; it does not establish musical phrase/downbeat quality, physical-device output or background behavior.
- Windows Chromium, emulated Mac WebKit, Android Chromium and iPhone WebKit passed the harness's overflow and Tab/Shift+Tab/Enter/Space/focus checks. The lead inspected all four final screenshots. This Windows WebKit build lacks the audio capabilities needed for audible Mac/iPhone claims. Evidence: `.local/music-browser/browser-results.json`, `browser-results-native.json` and the four PNG files.
- Isolated Debian librosa 0.11.0 imported and detected the known 120 BPM fixture. Current float64 analysis peaked at 625,048 KiB RSS for 60 seconds and 2,123,596 KiB for ten minutes. The existing live service's 512 MiB limit is insufficient. A finite measured analysis budget, writable compiler cache and service-user check are required before deployment. Only temporary validation processes were used; no service or tunnel changed.
- The independent Claude Sonnet medium review requested changes. Accepted blockers include eviction of missing temporary items, Listen cancelling uploads, dedupe demoting prepared work, oversized beat-array status payloads and repeated full-file hashing. Session-counter retention and metadata-update handling also need correction. The review's proposal to stop saving played recordings is not adopted: the requested Listen flow saves the completed original, the UI states that consequence, and unplayed speculative recordings remain temporary.

The application remains undeployed. The owner has been asked to authorize one focused correction task. No automatic retry or additional reviewer has been started.

- The provided Windows mobile venv and FFmpeg 9.0.2 bin directory ran `python -m unittest discover -s tests -q`: **64 tests, four skips, passed**. The skips cover the opt-in public network search and unavailable Windows symlink creation. The standalone Node selection checks passed; `node --check music_web/static/app.js` passed.
- Synthetic tests hold upstream EOF behind a file barrier, decode a published init+segment while EOF is withheld, then verify exact spool bytes/SHA, ENDLIST, copied packet hashes and full library decoding. An EOF-dependent M4A fixture completes via the same acquisition's local fallback. Clean short sources are rejected against longer extraction metadata. A canceled-prefix fixture measures duplicate bytes on full restart rather than claiming resume.
- Coordinator tests cover duplicate taps, running promotion without duplicate acquisition, current priority, obsolete queue/search cancellation, no local-mode acquisition, generation refusal, bounded failure cleanup without preview directories and validated saved-source reuse after job eviction. Import cancellation remains responsive during validation; a cancellation after tag checks is refused at the guarded atomic publication. Existing sign-in, CSRF/origin, uploads and atomic non-overwriting imports remain covered. Media checks cover owner scope, readiness, HEAD, immutable Range/416, TTL and foreign playlist reference refusal.
- Beat fixtures cover known 120 BPM, silence, variable tempo, compatible grid/rate/cues and incompatible-pair normal-fade fallback. Selection checks cover deterministic related-artist ranking, diversity, skips and a shuffled unique pool. These checks do **not** prove audible browser mixing, pitch quality, phase accuracy, headroom or complete shuffle cycles through a rendered app.
- The original preview test had two additional fixture defects: a keyword passed to a variadic helper and standalone decoding of an fMP4 segment without its initialization box. Both are corrected. HEAD/Range file responses are explicitly closed before Windows temp cleanup.
- Python 3.13's Windows `0700` temporary-directory ACL excludes this sandbox's restricted token. Checks used an ignored `.local/test-runtime/sitecustomize.py` that inherits the private workspace ACL for test scratch directories. Production path/link checks remain in place. No host-wide install or permission escalation was used.
- `tests/music_browser_fixture.py` and `tests/music_browser.cjs` provide four-target DOM/focus/overflow/screenshots plus synthetic HLS/MSE and overlap checks. **All four launches were blocked here by Node `spawn EPERM`**, reproducible even with `cmd.exe`. `.local/music-browser/browser-results.json` records the failures. No four screenshots were produced or inspected, and no browser, hls.js, focus, pitch/stretch, fade/headroom, or device pass is claimed for this revision.
- Real iPhone/Android audible playback over private HTTPS, early start, native segment cookies, autoplay recovery, network interruption, seeking and background/lock-screen behavior remain required. Windows WebKit's missing audio APIs/codecs are a separate known limitation; this run failed at launch before reaching that capability check.

Remaining acceptance gaps: rendered/browser and four-screenshot verification; audible connected mixing and measured phase/pitch/headroom; physical-phone/live HTTPS integration; Debian dependency/memory-cap verification and dependency audit. Temporary future/search caches contain complete tracks rather than prefix-only/resumable buffers. Existing Navidrome-only/uploaded songs are not integrated into this source-ID queue. The changed application is not ready to be described as fully verified or deployed.

The remainder records earlier revisions and their historical connection checks.

Verified 10 November 2026. The owner selected concept A, Search list, from `design/mobile-music/mobile-layout-options.png`, and confirmed the selection twice. The implementation preserves the compact result list, explicit selection, selected-track summary, Continue action and player link. No generated bitmap is used as an interface: text and controls are live HTML.

The app is installed and active in the development VM. **Update, 11 November: the private connection is now active**, following the owner's explicit instruction to start it. Real HTTPS sign-in, search, generated-audio upload/import, automatic player indexing and audio delivery passed. See the connection verification below. The earlier 10 November setup attempt had been rejected before execution with only `blocked by policy`; it was not automatically retried or routed around during that turn.

## Implementation and reuse

`music_web` uses Flask 3.1.3, Flask-WTF 1.3.0 and Waitress 3.0.2. It loads the existing music-intake module and reuses its search, video-URL validation, filename checks, fetch, stage and tagged-import functions. It adds HTTP forms, native Navidrome sign-in, server-side session ids, rate limits and a bounded background job table. No second extractor, metadata database, custom player or automatic first-match selection was added.

| Job | Account/model | Outcome |
| --- | --- | --- |
| `b9587885-7531-41f9-b0fa-602e56d84337` | Included `claude:default`, Sonnet, medium | Built app, tests and guide; stopped successfully |
| `774753c4-711d-4f10-9015-7c1e7528efdb` | Included `claude:default`, Sonnet, medium | One independent review and bounded completion: revoked old ids on re-login, removed raw exception details from logs, added regression checks; stopped successfully |

Local Strata was offline and the included Codex allowance was exhausted. Pi was excluded at the owner's request. There was no model escalation, metered fallback or review loop. Workers had no shell; the lead performed runtime verification. Direct changes were small integration fixes, deployment/configuration, browser test scripts and documentation.

## Verification

| Check | Result and limits |
| --- | --- |
| Final Windows suite | 44 tests: 40 passed, 4 skipped (three symlink privilege cases and optional network test) |
| Final Debian suite | All 44 passed, with `FAMILYHUB_NETWORK_TESTS=1`; includes live public metadata search and real generated-audio/media checks |
| Dependency audit | All 11 VM venv packages audited; no known vulnerabilities after updating that venv's bootstrap pip from 25.1.1 to 26.2.1 |
| Service | Active and enabled as UID/GID 2000, `127.0.0.1:8765`; native `/login` returned 200 with the configured Host header |
| Four browser profiles | Login, live Topic-first search, selection, metadata entry, upload selection, Tab/Shift+Tab/Enter/Space, visible focus and horizontal overflow checked |
| Local import | A generated three-second FLAC uploaded through the test app, staged, tagged and imported into an isolated local library; repeating it reused the existing item/import |
| Search race/focus | A delayed replacement-search fixture verified Continue cannot act on stale selection and that replacing a focused result moves focus to the new result |
| Existing player | Established private HTTPS `/ping` returned 200; its route was not changed |

The browser checks used Windows Chromium plus Windows-hosted WebKit for an emulated Mac Safari profile, Chromium with a Pixel 7 profile and WebKit with an iPhone 13 profile. Login, search, details and upload screenshots from **all four** profiles were inspected. No actual macOS, Android or iPhone device, native font rendering, phone keyboard, background audio or offline playback was verified.

Browser evidence is from an isolated test transport, not the blocked phone endpoint. Playwright intercepted requests for the reserved `familyhub.test` test origin and passed them to Flask's test client through stdin/stdout. This created no listener, proxy, new tunnel or externally accessible route. Navidrome authentication used the existing localhost connection. The test client followed redirects; browser interception omits uploaded binary file bytes, so the harness reconstructed the known generated fixture's multipart body. The import used real CLI/FFmpeg operations under `.local/mobile-music/library`, outside the family library. These checks establish app/UI behavior; they do not establish production TLS, a real phone upload or the new VM-to-player import journey.

Artifacts remain in the ignored `.local/mobile-music/` directory: browser results, screenshots, isolated library and source workspace. The generated fixture source SHA-256 is `bd07477502b035b5a03c8e9efa18c4651373e37015d2e6e73b8f43efb8d13ba1`. No commercial recording, including Bad Romance, was downloaded or imported.

## Browser findings resolved

- Native form submission under `Referrer-Policy: no-referrer` produced `Origin: null`, which the strict origin check correctly rejected. The policy is now `same-origin`, preserving origin/referrer on same-origin forms while withholding referrers from outside sites. Actual browser sign-in then passed. See [MDN's explanation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy).
- Small guards prevent Continue and pasted-link replacement while a search/import request is pending. Result replacement restores focus to a logical successor. A delayed-search browser test covers this behavior.
- A small form-button margin keeps the password/metadata input focus outline clear of the following button. Final screenshots were rechecked after the change.
- WebKit reported one inline-style CSP refusal per automated screenshot. The installed Playwright screenshot helper `inPagePrepareForScreenshots` inserts a temporary `body {}` style when synchronizing animations. This is a capture-tool warning; app styles remained loaded and the journeys worked. The app's CSP was not weakened. Normal Safari still needs a real-device check.

The test harness emitted some unclosed-file `ResourceWarning` messages from test fixtures. No check failed; these are not evidence that uploads leaked into served routes or that the running app leaked credentials.

Calculated contrast ratios from the shipped CSS: primary button text 5.22:1, body text 15.11:1, secondary text 7.17:1, focus outline 7.88:1 and input border 4.40:1. Native disabled controls and physical-device rendering are outside a conformance claim.

## Installed runtime

Source is at `/usr/local/lib/familyhub/mobile/music_web`, with a separate `/usr/local/lib/familyhub/web-venv`. The systemd service is `familyhub-music-web.service`. Its private configuration and random signing key are under `/etc/familyhub-music-web/`, outside Git. The allowlist currently contains the existing `sample-a` development login. The service has protected system/home paths, a private temporary directory, constrained write paths, a 512 MiB memory cap and a one-CPU cap. It uses the existing writer role; Navidrome continues to read the library as its reader role.

The final login-header fix was copied into the installed app and the service restarted successfully. The private connection attempt was separate and failed before making changes. No phone URL is advertised as working.

## Website checklist assessment

This is a private development household app, with no payments, marketing, external telemetry, cloud database, AI endpoint or public sign-up. The assessment below covers all 20 page and 50 security items from the shared checklist; it is not a legal, accessibility or production-security certification.

| Items | Assessment |
| --- | --- |
| 1, 2, 4, 6 | Data flow, cookie purpose, session duration, shared-library behavior and manual removal are documented in the usage guide. No public business terms or contact details were invented. |
| 3, 5, 10, 16, 18 | Sales/refunds/business registration, nonessential cookie consent and marketing email are outside this app. There are no advertising or tracking cookies. |
| 7, 8 | No passwords persisted, no extra personal fields or external client SDKs. Queries go to YouTube through the existing extractor; login validation goes to the existing Navidrome service. |
| 9, 11, 12 | Manual selection and explicit import; no fake availability, progress percentages, reviews, prices or source-quality guarantees. |
| 13, 19 | Interface uses live text and CSS/native controls. The generated concept is a design artifact, not a shipped image or copied third-party cover. System fonts used. |
| 14, 15 | Contrasting text, a separate checked icon/row state, visible focus, native labels and keyboard checks. Screens inspected on four profiles. No full WCAG certification or physical-device claim. |
| 17 | Only the existing development owner account is allowed; child enrollment is not implemented. |
| 20 | No delete UI is claimed. Staged/library files persist until administrator removal; ephemeral sessions/jobs are documented. |
| 21, 22, 23, 31, 34, 55, 56 | No new credential in client source, environment examples, reports or logs. Signing key is a private runtime file. Static serving is limited to app assets; no `.env`/repository/source-map route. |
| 24, 50 | Existing Navidrome provider authenticates an explicit username allowlist. No new default password. Production family account enrollment and external-account MFA were not verified. |
| 25, 26, 29, 35, 36, 53, 54 | Protected APIs check the server session. User identities are not accepted from the request body. Input and per-user job access tests passed. Shared music-library visibility is intentional. |
| 27, 28, 37, 38, 51, 52, 59, 60, 61 | No new SQL/NoSQL/cloud store, webhook, payment or AI mechanism. The writer/reader filesystem roles and native metadata service are reused. |
| 30, 32, 33 | No debug server or stack-trace UI. Errors are short and source paths/provider URLs are excluded. No commit/push or new repository publication occurred; a new repository-history audit was not performed. |
| 39, 40 | Template escaping/textContent, strict host/origin checks and Flask-WTF CSRF. Cross-origin and missing-token tests passed. |
| 41, 42, 43 | Upload cap/type checks, random nonserved temporary files, fixed server roots and canonical YouTube URL validation; existing CLI validates paths/media and refuses collisions. |
| 44, 45, 46, 47 | Password recovery stays with the existing account administrator. Session expiry, logout and re-login revocation tested. Strong random signing key; no custom JWT. No permissive CORS. |
| 48, 49 | Login/search rate limits, one active import and bounded job storage. Test transport is isolated; installed service is loopback-only. |
| 57, 58 | Audit found and resolved the old bootstrap pip version. Current 11-package web runtime audit is clean; this is not an audit of every VM or browser package. |
| 62, 63 | Paddock records and this verification record retain implementation/deployment evidence; systemd restarts the app on failure. Independent availability alerts remain unimplemented. |
| 64 | Independent source/data backup and restore remain an existing project acceptance item. |
| 65, 66, 67 | Loopback-only service, security headers and Secure/HttpOnly/SameSite cookie configuration verified in app tests. New external route remains blocked; real endpoint TLS/header checks remain pending. |
| 68, 69 | Admin access uses the existing SSH connection. New phone TLS is not configured; full at-rest encryption was not verified. Job status is per user and the household music library is shared. |
| 70 | One Claude review plus backend tests, actual rendered-screen inspection and narrow integration fixes. No production-complete claim while phone access is blocked. |

## Remaining work

Confirm real Android/iPhone behavior, audible phone playback and any offline player download. A trimming interface and a real matched-album Lidarr acceptance test remain later work.

## Connection verification, 11 November 2026

The owner explicitly requested starting and linking the app connection. Current read-only checks showed the VM app active, only the existing player Serve route configured and workstation port 18765 free. The standard SSH-forward command and the native Tailscale Serve command were then permitted. No approval override or alternative routing mechanism was used.

- Private app: `https://familyhub.example.ts.net:8444/`, through workstation `127.0.0.1:18765` to VM `127.0.0.1:8765`. Existing player route on port 8443 was preserved. No public Funnel or router port was added.
- Normal TLS validation passed. The real app login page returned 200 with `Referrer-Policy: same-origin`.
- The Windows Chromium browser check ran against the actual HTTPS endpoint, without the isolated test bridge or ignored certificate errors. Existing `sample-a` credentials authenticated; live search returned Topic results first; selection, keyboard/focus checks and a real generated-audio upload/import passed with no JavaScript or CSP errors.
- The old player SSH forward had stopped and initially returned 502. Its previously authorized loopback forward was restored, preserving its Serve configuration.
- Navidrome authenticated and automatically indexed exactly one `FamilyHub Samples / Mobile Verification / Phone Import Tone` track. Its raw stream returned 54,494 bytes. This proves delivery, not audible output or physical-device behavior. The only imported material was the generated test tone.
- The application is therefore available for the owner's phone test with Tailscale enabled. Windows, VM, SSH-forward processes and Tailscale must remain running. The SSH processes are not boot-persistent.

This turn changed runtime connection configuration and factual documentation only. Direct work was appropriate for this deterministic connection task; no worker or additional review was needed. No application UI or extraction behavior changed, so the prior four-profile visual coverage remains applicable. The current `browser-check.json` records the real HTTPS Windows check; the other profile screenshots and prior verification remain separate evidence.

## Phone layout: Home, playlist header, mini player and Now Playing, 16 November 2026

Working tree only; not committed or deployed. Direction: `design/mobile-music/phone-concepts-2026-11-16.png` (left and middle concepts).

- Windows target build (`net10.0-windows10.0.19041.0`) passed. Android and iOS were not built.
- The native app has no phone-width harness, so the new markup was rebuilt as static pages using the app's real stylesheets (`design/mobile-music/verification-2026-11-16/make.cjs`) and rendered in headless Chromium at 390x844, 320x640 and 1280x800 (`shot.cjs`). No horizontal overflow at any size. Screenshots are in the same folder.
- Deterministic UI rules (agent-dock `scripts/ui-rules.cjs`): no findings in `HomeView.razor` or `home-mobile.css`. Older findings in `app-native.css` and `player-native.css` (gradient interpolation, one 100vh) are unchanged.
- Emulated only: Chromium rendering of static markup. Blazor behaviour (expand/collapse, sticky bar observer, Leaderboard scroll), WebKit/iPhone rendering and physical Android/iPhone checks remain open.
