# Progressive music playback research

Research date: 11 November 2026. Planning only. Inspected the current working files over HEAD `da0f3666dec972c827be49d587f7be840cdb921d`, including uncommitted music work. No application, service, dependency or deployment changes.

## Recommendation

Extend the existing import job with **one server-side acquisition, an original-byte spool and an authenticated HLS audio preview**. Use native HLS on iPhone Safari and locally served hls.js where native playback is unavailable, including an Android Chrome capability check. Keep the original recording for the existing validation/import path. Playback can begin once sufficient complete segments exist; extraction, source layout, network speed and browser buffering prevent a guaranteed startup time.

This is the smallest robust candidate for pause, reconnect and playback from the beginning across the requested phones. It is a design recommendation, not a measured compatibility result. The blocking implementation experiment is whether the chosen source format produces decodable audio through a non-seekable input before acquisition EOF. Preserve the selected recording and best-audio policy; do not silently choose another recording or a lower-quality source to make preview work.

## Evidence and existing boundaries

**Observed in source:**

- `music_web/__init__.py`: `current`, `guard`, `CSRFProtect`, `body`, `meta`, `new_job`, `public`, `settle`, `work` and `start` already provide session authentication, request validation, owner-scoped jobs and one active import. `GET /api/jobs` supports reconnecting to an active job. Authentication uses Navidrome only at sign-in; no reusable player credentials are retained.
- `scripts/music-intake.py`: `cmd_search` ranks 30 metadata candidates and returns bounded results; `video_id` canonicalizes the explicit selection. `cmd_fetch` first inspects metadata, then waits for a complete `bestaudio` acquisition and audio extraction. Search never downloads audio. Metadata extraction plus one media acquisition is consistent with the one-acquisition requirement.
- `finish`, `probe`, `decode_check`, `load_item`, `tag_copy`, `packet_hash`, `cmd_import` and the manifest already cover staging, integrity, full decoding, packet-preserving tags and non-overwriting publication. Import bytes can differ because tags/container change; compressed audio packets must match. Preserve this distinction.
- `static/app.js`: reuse `api`, `renderResults`, `selected`, `show`, `showJob` and `poll`. Currently selection leads through mandatory details and Import, then a link to Navidrome. `templates/index.html` has no inline audio player. Retain uploads and Open player.
- `__main__.py` runs four Waitress threads. Jobs and the concurrency lock are process-local; keep a single app process. `run` waits for process completion and kills only its direct child on timeout. It cannot itself provide the required incremental supervision.
- `tests/test_music_web.py` covers authentication, CSRF/origin, ownership, busy responses, uploads and sanitized errors with mocked intake. `tests/test_music_intake.py` covers synthetic audio integrity, tags, duplicate imports and collisions. These tests do not establish progressive playback. `docs/MOBILE_MUSIC.md` and `docs/MUSIC_INTAKE.md` describe the current deployed arrangement and prior verification; those historical passes were not rerun here.

**Verified documentation:** sources below were retrieved during this research. FFmpeg's website timed out, so its official repository documentation was read instead. Moving upstream documentation may describe features newer than the installed build.

## Delivery alternatives

| Approach | Benefit | Limitation and decision |
| --- | --- | --- |
| Incremental HTTP MP3/AAC relay | Few frontend dependencies; potentially early sequential decoding | Needs an open response, explicit buffering/backpressure and reconnect policy. Mobile seeking/range behavior is awkward with unknown final length. Not selected for the required phone journey. |
| Serve an ordinary growing file | Superficially small change | Current file size is not final representation length; MP4 metadata may require seeking or EOF. A normal file sender can stop at today's EOF. Reject as the playback contract. |
| HLS with completed audio segments | Finite authenticated requests, retained earlier segments, reconnect and seeking over available audio | Requires packaging, retention and a browser fallback. Selected; moderate backend work and a small player integration. |
| Handwritten MSE append pipeline | Precise append and buffer control | Adds demuxing/container, timestamp, eviction and recovery work plus platform differences. Reject custom MSE; let hls.js handle it where needed. |

[MDN's Media Source API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API) describes JavaScript-managed media buffers. The [hls.js project](https://github.com/video-dev/hls.js#compatibility) documents MSE requirements and Android support. These establish available mechanisms, not successful playback on the owner's phones. Use native HLS first when the media element reports support; otherwise check `Hls.isSupported()`. Unsupported devices keep the completed-song/Open player path.

## One acquisition, two outputs

Proposed flow:

```text
selected video ID -> metadata validation -> one yt-dlp media acquisition
                                             |
                                      bounded byte pump
                                      /               \
                         original-byte spool       FFmpeg preview
                                  |                completed HLS segments
                         EOF + successful exit              |
                         packet-preserving remux       phone playback
                         if container needs it
                                  |
                         finish -> cmd_import -> Saved
```

The official [yt-dlp README](https://github.com/yt-dlp/yt-dlp#output-template) documents stdout output with `-o -`, explicit format selection and structured metadata output. Its stdout default format differs from ordinary downloads, so specify the validated audio-only format explicitly. Keep `--ignore-config`, canonical URL, no playlist and existing live/duration rejection. Do not run a second yt-dlp for the preview. One acquisition can entail multiple provider fragment requests and bounded retries; it does not mean one HTTP request.

**Design inference:** extend the acquisition portion of `cmd_fetch`, retaining its CLI behavior and final item shape. A supervised pump writes every source byte to private scratch storage before feeding the preview pipe. Hash that spool incrementally. Bounded buffering applies backpressure; a browser never consumes directly from this pipe. Separate metadata/stderr from audio bytes. Preview failure must close/detach its branch and allow the original acquisition to finish, unless a global disk/time limit is hit. Do not let a blocked pipe prevent cancellation or disk-limit enforcement.

[FFmpeg's muxer documentation](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/doc/muxers.texi) describes HLS EVENT playlists, fMP4 segments and `temp_file` publication by rename. Its tee muxer duplicates encoded packets, rather than independently copying original bytes and encoding a preview. Use the byte pump for original preservation. A single FFmpeg process with separate copy/transcode outputs could preserve audio packets, but would not retain the exact input bytes and would couple archival success to preview processing.

Candidate preview: AAC-LC in fMP4 HLS, with one initialization file and numbered media segments. Apple lists AAC stereo as a compatibility baseline and recommends elementary audio or fMP4 in its [HLS authoring specification](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html). Copy compatible AAC packets into the preview when verified; transcode Opus or incompatible audio to an AAC-LC preview, provisionally 128 kbit/s stereo. That preview is lossy and never becomes the library original. Preserve mono where appropriate; test the selected encoder/layout. Do not assume raw ADTS `.aac` supports the tags required by `cmd_import`.

**Critical format gate:** WebM/Opus, Ogg and fragmented MP4 with initialization available first are candidates for sequential input. Ordinary MP4/M4A with metadata at the end can require a seekable complete file. Codec name or extension alone does not prove streamability. [FFmpeg's protocol documentation](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/doc/protocols.texi) distinguishes pipes from seekable descriptors and documents protocol restrictions. Restrict preview input to the pipe/local data; never hand FFmpeg a provider URL or permit arbitrary network protocols. Probe synthetic examples of both streamable and EOF-dependent layouts. If early preview is impossible, continue the same acquisition and display “Preparing playback”; generate preview from the completed local original. Do not claim that fallback meets early-playback acceptance.

On successful acquisition EOF, close the spool and wait for process success. Normalize the archival container locally with stream copy if necessary, such as WebM/Opus to Ogg Opus, while retaining source identity. Compare compressed packet hashes across normalization. Pass the normalized complete file through `finish` and `cmd_import`; retain the manifest's existing SHA semantics. Full decode alone cannot detect every cleanly truncated stream: also check downloader success, complete fragment delivery and plausible duration against trusted extraction metadata, with a documented tolerance. Never import preview segments or incomplete spools.

## Playback and HTTP behavior

**Proposed defaults, requiring measurement:** target roughly two seconds per segment and initially wait for three completed segments, or a completed short recording. This is an amount of media, not a startup-time promise. Do not throttle acquisition to real time. Flush pump writes; atomically publish complete segments and playlist snapshots. FFmpeg probe/encoder buffering and the HTTPS proxy can still delay availability. Avoid aggressive probe reductions until fixtures show that they preserve decoding.

Use an append-only EVENT playlist retaining all segments, with ENDLIST only after preview production completes successfully. Include initialization references and accurate durations. [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216) defines EVENT, ENDLIST, initialization maps and the preferred start offset. Explicitly request beginning-of-recording playback rather than accepting a live-edge default: use a zero start hint and the player API's start position, then verify that the opening audio is heard. Retain already published segments for the session's retention period.

- Pause stops the client, while saving continues. Resume/reconnect uses the same job and retained segments, with the last position restored when available. Seeking is limited to the available seekable timeline; forward seeking cannot create undownloaded audio. Show waiting at its end.
- Keep playing the same HLS presentation after import completes. Update saving status to Saved; do not swap `src` mid-song or equate ENDLIST with successful import. Navidrome may still need its next scan. Later listens may use completed media or the existing player.
- Start `play()` in the Listen gesture when a ready source is available. A POST and buffering wait may outlive user activation. Handle the promise and show a real Play button/native controls when blocked; call `play()` directly on that tap. Do not use silent-audio tricks. [WebKit's gesture guidance](https://webkit.org/blog/6784/new-video-policies-for-ios/) is historical policy context; [MDN's play documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play) specifies rejection handling. Neither guarantees current device autoplay.

For finalized segments/init files, return accurate MIME and Content-Length; ordinary ranges can use conditional `send_file` against a server-selected immutable path. [Werkzeug documents conditional/range support](https://werkzeug.palletsprojects.com/en/stable/utils/#werkzeug.utils.send_file) and warns against untrusted paths. Playlist responses are complete snapshots with no-store caching. A not-ready manifest returns a bounded 503/Retry-After; the client normally waits for readiness before attaching it. Missing segments return 404, retained expired jobs 410, invalid sessions 401 and another owner's IDs 404. GET/HEAD must never start acquisition.

Never invent final Content-Length, Content-Range or a 206 for a growing file. For an experimental sequential relay, use 200 without a guessed length, let the server provide HTTP framing, and explicitly decline range support; a Range request may be ignored with 200. Only immutable known representations should get satisfiable 206 or unsatisfiable 416 with the correct total size. These distinctions follow [RFC 9110 section 14](https://www.rfc-editor.org/rfc/rfc9110#section-14).

[Flask streaming guidance](https://flask.palletsprojects.com/en/stable/patterns/streaming/) notes that middleware can interfere and headers precede the body. [Waitress's design](https://docs.pylonsproject.org/projects/waitress/en/stable/design.html) uses a fixed worker pool; a generator waiting for future audio can occupy a worker. Finite HLS file requests avoid tying up the four application workers for entire songs. Still verify the existing :8444 HTTPS route's behavior without changing tunnels or services.

## Minimum extension and safeguards

Extend the existing job dictionary with canonical `source_id`, acquisition/import `phase`, independent `preview_state`, a relative media URL when ready and expiry. Keep `state=running` through validation/import so the current single-job invariant remains true. Browser playback state belongs to the media element, not a server claim that sound is playing. Internal scratch paths/process handles never enter `public`.

Keep POST `/api/jobs` and existing GET status routes. Add owner-checked GET/HEAD `/api/jobs/<id>/media/<asset>` for a strict allowlist of generated playlist/init/segment names, and CSRF-protected POST `/api/jobs/<id>/cancel`. Perform auth before file lookup on every request, including HEAD and Range. Keeping media under `/api/` preserves the guard's 401 behavior instead of redirecting an audio fetch to a login page. Require the existing session and matching username; an opaque ID alone grants nothing. Never put these files under `/static`.

Reuse `video_id`, `real_dir`, `regular_file`, `inside`, `safe_name` and manifest validation. Reject traversal, symlinks, arbitrary URLs/paths and unrecognized asset names. Only the supported extractor receives the canonical YouTube URL; redirects/media URLs stay private inside it. Restrict subprocess network access where practicable; canonical input alone does not prove upstream redirect/DNS safety. No generic proxy, provider URL returned to clients, external HLS references, cookies or signed URL logging. Keep sanitized exceptions. Locally host hls.js; explicitly allow same-origin media and the required MSE blob URL in CSP, with worker policy tested for the chosen build. No blanket CSP relaxation.

Under the existing lock, coalesce repeated Listen for the same owner/source into the same job; a different active request receives 409. Do not attach another user to an active owner's preview. Browser close/disconnect does not cancel the requested save. Explicit cancel terminates and reaps the acquisition/preview process group, prevents import and removes partials. Serialize cancellation against publication; after commit, report Saved rather than pretend to undo it. Keep the lock held logically until subprocesses have exited and cleanup finishes.

Provisional resource policy: retain current four-hour source limit, 120-second metadata and 1,800-second acquisition deadlines; enforce a hard 2 GiB source-byte cap while writing, plus an aggregate scratch/preview cap and disk-free reserve. Set explicit idle timeout, finite fragment retries, bounded stderr storage and client request rates. Choose aggregate capacity against the real SSD before implementation. Timeouts must cover process groups, pipe writers and decoder stalls; the current `run` helper needs an incremental supervisor, not another synchronous wrapper. One acquisition and one preview encoder at a time; validation remains bounded by existing checks.

After failure/cancel, remove only job-owned partial files. Keep a fully validated staged original if import fails so retry can reuse it. Retain successful preview files for a bounded grace period long enough for playback; propose two hours after completion, then 410 with a saved-song action. Startup cleanup may remove only recognized stale scratch directories after confirming no writer remains. Do not delete staged originals or library files. Process restart may lose active job status, as today; do not promise resumable acquisition or add a persistent queue in this change.

## UX and saved-song reuse

Search -> choose the exact title/channel/duration -> **Listen** -> **Buffering** -> **Playing / Saving** -> **Saved**. Search remains metadata-only and selection remains explicit. For the owner's NEFFEX example, a matching title alone cannot prove the same recording heard in Navidrome.

Show the consequence near Listen: “Saves this recording to the shared library.” Offer Edit details without forcing it for every listen. Reuse the current prefill rules and `Selected recordings` album default; derive defaults from server-validated selected metadata, run `meta` validation and request correction only when necessary. Metadata remains a guess, not an artist identity assertion. Preserve required consequences, upload limits and error recovery. Keep controls stable and update status text without replacing the focused player/button.

Before starting a download, look for a completed, unedited manifest with the same canonical source ID and a valid library import. Reuse `load_item`, containment checks and recorded library hash; return a fresh owner-scoped playback job without acquisition. Build any small in-memory lookup from existing manifests, not a second catalogue. A retained compatible preview can be reused; otherwise package the completed local source under the same bounded media-work policy. Never attach a new owner to another owner's job. Share completed library content according to the existing family-library policy.

This resolves known-source imports only. Songs originally acquired through Lidarr/uploads may have no YouTube source identity. Do not automatically match those by title. Keep Open player for that catalogue; exact cross-catalogue matching/Navidrome API integration is a separate owner decision because this app retains no player credential. Do not redownload a verified known saved source merely because job memory or preview cache expired.

Wording finding: `templates/index.html` repeats the Import action with “Adds the audio to the music library.” Replace that redundant line with the specific Listen/save consequence during authorized implementation. It is unchanged in this research-only assignment.

## Verifiable implementation units

1. **Source/format gate:** synthetic WebM/Opus, AAC fragmented MP4 and MP4 with end metadata. Throttle a local producer and hold EOF behind a test barrier. Fetch and decode an actual published segment while the barrier is still closed. Record first decoded audio and upstream EOF separately. Count exactly one producer/acquisition and ensure segment fetches never start it. A downloaded-byte counter or playlist alone is insufficient evidence.
2. **Acquisition and integrity:** extend `cmd_fetch` using the supervisor/pump; test raw spool SHA against the synthetic input, complete duration/decode, normalized packet hashes and packet-preserving tagged import. Inject clean truncation, failed fragments, preview failure, disk full, stalled pipes, timeout and cancellation. Assert no partial library publication and no surviving children. Preserve CLI/upload behavior and collision checks.
3. **Job/media boundary:** extend existing web tests for same-source concurrent taps, different-source 409, cross-owner 404, expired/absent sessions, CSRF, GET/HEAD without side effects, traversal/symlinks, sanitized output and known-source reuse after job eviction. Exercise immutable 200/206/416 lengths, 503 readiness, 404 missing assets and 410 expiry. Check real Waitress delivery under concurrent segment requests while login/status remains responsive; Flask's test client cannot prove proxy buffering.
4. **Player journey:** verify beginning-of-track playback, buffer exhaustion, pause/resume, seek within available media, reconnect without reacquisition, preview failure with saving continuing, save failure after audible preview and completion without source replacement. Test pending/rejected `play()` and the explicit Play fallback. Confirm correct saved-song reuse and optional details without losing uploads.
5. **Devices/accessibility:** Windows Chromium and emulated WebKit/phone viewports can exercise DOM, status and focus logic. Use Tab, Shift+Tab, Enter and Space through selection, Listen, errors, retry and cancel; inspect activeElement after each rerender. Actual iPhone Safari and Android Chrome over private HTTPS are required for audible start before EOF, cookies on native segment requests, autoplay fallback, seeking, screen lock/background behavior and network interruption. Desktop WebKit emulation cannot certify those behaviors.

## Open decisions and verification limits

- Confirm oldest supported phone/OS versions, the proposed AAC preview quality, segment readiness threshold and retention/disk limits. These are provisional engineering choices, not measured requirements.
- Prove the source-format gate with the installed yt-dlp/FFmpeg versions. If the best source is not incrementally readable, approve either completion-first fallback for that source or an explicit alternative-format policy. Do not silently weaken original preservation.
- Decide whether existing Navidrome-only songs need integrated search now. Known-source reuse needs no catalogue rewrite; arbitrary library matching adds authentication and identity work.
- Expect moderate complexity: the process supervisor and failure/cleanup races dominate. Material additions are a byte pump, HLS preview artifacts/routes and hls.js fallback. No new database, media server, queue, platform rewrite, low-latency HLS or second provider acquisition is justified.

Verification performed: source/test inspection and current primary-document retrieval. No synthetic probe, test suite, commercial download, live service check or real-device playback was performed. No startup latency or codec compatibility measurement is claimed. Next step is owner approval of this implementation direction, then the synthetic source/format gate before building the phone journey.

## Follow-up check: early decoding and queued playback

On 11 November 2026, the coordinator ran a deterministic synthetic check in the existing Debian VM as `familyhub-writer`, using installed FFmpeg 7.1.5. A 40-second WebM/Opus tone was split at byte 206,896 of 413,793. One producer copied bytes to an original spool and FFmpeg stdin. With the second half and EOF withheld, FFmpeg generated fMP4 HLS and an independent decoder successfully decoded its first completed segment to 192,512 PCM bytes. After releasing the remaining bytes and EOF, FFmpeg exited successfully, the full preview decoded, ENDLIST appeared and the spool SHA-256 matched the original fixture. Temporary fixture files were removed; results are in ignored `.local/music/progressive-source-check.json`.

This establishes early decoding for this synthetic WebM/Opus layout. The first segment decoded about 0.158 seconds after the local pipe started; the producer supplied roughly half the recording immediately. That timing is a local processing measurement, not provider extraction time, a network benchmark, a buffer-readiness threshold or phone time to sound. This check did not exercise yt-dlp, HTTP delivery, an authenticated browser, real phones, the application import path or other source layouts.

Read-only runtime inspection confirmed Navidrome 0.64.2. Its [versioned player source](https://github.com/navidrome/navidrome/blob/v0.64.2/ui/src/audioplayer/Player.jsx) prepares stream/transcoding decisions for upcoming queued tracks and configures 200 ms volume fades. The pinned `navidrome-music-player` 4.25.4 package uses the fade-out around pause and one playback audio element; this inspection found no overlapping-track crossfade control. Navidrome's [gapless issue](https://github.com/navidrome/navidrome/issues/745) remains closed as not planned. Source inspection does not establish an audible transition on the owner's phone. The separate FamilyHub import app still has no autoplay queue, recommendation engine or transition implementation.

Proposed queue policy: when autoplay of new recordings is enabled, select and show one upcoming recording, reuse its validated saved copy if present, otherwise prepare its acquisition/preview while the current track plays. Start preparation early enough to absorb provider discovery and buffering; keep one acquisition at a time and prioritize the currently playing track. Re-evaluate pending work when the user skips or changes the queue. If the next recording is not ready at the boundary, report buffering rather than promise a gap-free transition. Recommendation selection and cache preparation are separate responsibilities.

Gapless playback means adjacent tracks meet without an added pause. Crossfade overlaps the ending and beginning with changing volumes. Preparing the next recording helps either approach but does not implement either one. Implement and verify queued preparation first; a configurable crossfade would require additional playback/mixing logic and real mobile foreground/background tests. It remains proposed, with no app or service changes from this check.

## Requested expansion: DJ transitions and predictive cache

Owner requested beat-matched DJ transitions, new-song autoplay, one fully prepared next song, preview buffers for the following 3–5 songs and speculative search-result previews. These features remain unimplemented. The existing public search ranks metadata matches; it is not a recommendation engine. The separate Navidrome player does not supply this acquisition queue to FamilyHub.

Tool findings, 11 November 2026:

- [Mixxx](https://mixxx.org/features/) provides sync, pitch-preserving tempo changes and crossfading as a desktop DJ application. Its [manual](https://manual.mixxx.org/2.5/en/chapters/djing_with_mixxx.html) explains the need for correct beat grids and intro/outro cue placement. It is a useful working reference, not an embedded mobile web player.
- [Essentia RhythmExtractor2013](https://essentia.upf.edu/tutorial_rhythm_beatdetection.html) reports tempo, beat positions and optional confidence. Its documented whole-track analysis supports downloading the next song fully before analysis. It does not establish a downbeat/phrase grid from a few opening seconds.
- The VM's installed FFmpeg exposes `rubberband`, `atempo`, `acrossfade`, `amix` and `astats`. Its default Python environment has none of Essentia, librosa, aubio, NumPy or SciPy. No dependency was installed. Filter availability proves processing capability, not musical transition quality or integrated playback.

Proposed implementation order and boundaries:

1. Complete early playback and safe saved-song reuse from the preceding plan. Keep one prioritized acquisition coordinator. Extend it for speculative jobs rather than bypassing the existing concurrency guard with independent downloads.
2. Add an explicit queue and autoplay modes. Library shuffle draws from a shuffled eligible pool without repeats until exhausted. A recommended mix should rank candidates by seed artist/genre, available tempo/key/energy, likes and skip/recent history, with some diversity. These are proposed heuristics, not an existing trained recommendation system. New-song discovery needs a configured candidate source; YouTube search ranking alone does not provide personal recommendations.
3. Fully acquire the immediate next track when possible. Keep bounded temporary opening previews for the following 3–5 candidates. Search previews should be optional and limited to visible/high-ranked results, with stale queries cancelled. Current playback outranks the next track, which outranks skip buffers and search speculation. Bound bandwidth, disk and TTL; promote an existing speculative job instead of duplicating it. Only a validated complete original can enter the permanent library.
4. Prove source-specific resume and decoding behavior before promising prefix-only caches. A cached ten-second preview is not automatically a resumable prefix of the original container. A separate preview fetch followed by a full acquisition can duplicate some bytes; account for that explicitly. Preserve source identity and avoid claiming universal one-fetch continuation.
5. Add a normal crossfade first, then confident beat-grid alignment, modest pitch-preserving tempo adjustment and phrase/cue selection. Prefer compatible pairs; retain a plain-fade fallback for uncertain beats or incompatible tempos. Beat detection, recommendation ranking and transition rendering are distinct jobs. Do not alter permanent originals to make a mix.
6. Verify rapid skips and queue edits, cache promotion, current-stream priority under load, audible beat alignment, clipping/headroom and fallback behavior, and native phone background/lock-screen playback. Rendered synthetic mixtures alone do not establish those app behaviors.

Routing blocker at this check: Paddock reports both configured Antigravity accounts signed out with unknown/stale allowance, while setup marks the integration installed. No Antigravity worker was started and no app/service changes were made. The coordinator requested owner choice between connecting Antigravity and authorizing another account; no route substitution was inferred.
