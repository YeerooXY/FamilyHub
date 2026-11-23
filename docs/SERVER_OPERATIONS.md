# Server operations and priority

Scope covers one `python -m music_web` process. Paths below are relative to
`music_web/` unless otherwise indicated. Server admission limits account for
client download concurrency and polling.

## Decided order

1. **Connect control and listener playback:** device activity, handoff, takeover,
   commands, queue state, room state, playback metadata, signed audio and HLS.
   Reserve HTTP capacity independently of downloads, watches and provider reads.
2. **Interactive reads:** library, playlists, search, similar songs, radio seed,
   discovery, lyrics and administration. Operational snapshots have their own
   bounded capacity. External service latency belongs to this class, not Connect.
3. **User-requested downloads:** phone delivery copies, explicit playlist
   preparation and library additions. Serve already published files immediately.
4. **Background acquisition:** playlist auto-download, next-song/search prefetch,
   background matching and idle library expansion.
5. **Optional analysis and housekeeping:** tagging, source review, BPM/key,
   automatic replacement, phone-copy warming, history pruning and retired files.

Preemption means priority at admission and at the next subprocess/stage boundary.
It does not mean killing an arbitrary encoder or interrupting an atomic file
publication. Superseded searches and obsolete listener jobs retain their existing
cancellation paths. Active background subprocesses run with lower OS CPU/IO
priority on Linux. An active decode finishes its bounded stage; waiting foreground
work gets the next permit. Separate listener encoder lanes avoid waiting for an
unrelated bulk render. Two callers needing the **same unfinished output** share
its completion. Streaming can use the verified original while an optional phone
copy is absent.

HTTP isolation reserves request threads. Filesystem stalls, memory pressure,
proxy connection limits and provider availability can still affect response
times. The acceptance target is p95 below 300 ms for Connect and snapshots
during the load described below.

## Small state on the system disk

Set these keys in the JSON file named by `FAMILYHUB_MUSIC_CONFIG` on the Debian
server. Keep the existing `WORKSPACE` and `LIBRARY` settings.

```json
{
  "STATE_DIR": "/var/lib/familyhub-music/state",
  "STATE_BACKUP_DIR": "/srv/familyhub/backups/music-state",
  "WAITRESS_THREADS": 16
}
```

`STATE_DIR` defaults to the workspace. The files share database defaults to
`FILES_ROOT` as before. `STATE_BACKUP_DIR` defaults to disabled. Provision both
directories for the service user. Add both writable paths to the service's
systemd override alongside the existing entries.

```ini
[Service]
ReadWritePaths=/var/lib/familyhub-music/state /srv/familyhub/backups/music-state
```

Stop the service and any maintenance scripts that write the workspace before
changing the config. Reload the systemd unit and start the service. Startup
copies and verifies each legacy entry whose destination is missing, then
archives its original under the same name with a `.moved-to-state` suffix.
The service journal records the copy, verification, archive and publication.
SQLite copies use the backup API and `PRAGMA integrity_check`. Other copies
check byte counts and parse JSON or complete JSONL records. Keep the archives
for rollback. To roll back after serving traffic on the new layout, stop the
service and restore the latest state to the original locations before removing
`STATE_DIR`.

| State | Entries |
|---|---|
| Profiles and Wordle | `.family-profiles.json`, `.playback-state/`, `.word-puzzles.sqlite3` |
| Listening | `.listening-statistics.json`, `.listening-statistics.jsonl`, `.listening-history/`, `.deezer-chart.json`, `.listening-versions.json` |
| Catalogue | `.catalogue-review.json`, `.artist-genres.json`, `.source-quality.json`, `.song-analysis.json`, `.replacements.json`, `.metadata-votes.json`, `.library-additions.json` |
| Playlists and discovery | `.playlists/`, `.discovery/` including `discovery.sqlite3`, `.lyrics/` |
| Verification, files and feedback | `.verified-audio.sqlite3`, `.familyhub-files.db`, `.feedback.sqlite3`, `.feedback-server.log`, `.activity.log` and rotated logs |

Audio, staged item manifests, `.finished-audio/`, `.listening-versions/`, Deno
and compiler caches, image assets and app update packages stay with their
workspace or library. Shared file contents stay under `FILES_ROOT`.

The backup worker checks once a minute for a new local date and catches up at
startup. It publishes `state-YYYY-MM-DD` directories after validation and keeps
the latest 14. Each database has a consistent SQLite snapshot. JSON files use
the published file at copy time, and listening statistics copy the journal
before the checkpoint for safe replay. The backup is assembled over time across
stores. Restore a dated copy while the service is stopped.

Wordle, profile preferences, saved playback queues and listening totals serve
warm reads from memory. A worker commits queued changes in order and retries
storage failures. Write requests wait up to two seconds, then return the current
in-memory result while persistence continues. JSON cache refreshes detect
external file replacements in the background. Run one service instance per
state directory and stop it before changing state files during maintenance.
Graceful shutdown flushes queued writes. A forced stop or power loss can discard
writes that are still in memory.

## Audio verification across disk moves

Verified audio rows use the path, byte size, nanosecond modification time and a
SHA-256 fingerprint of the first, middle and last 64 KiB. Preserve paths and
modification times when copying the library, and carry the verification database
with the other state. When a legacy row is accessed, matching path, size and
modification time let it keep its digest and record the new fingerprint.
Legacy rows have no fingerprint to compare before that conversion. After
conversion, same-size edits with a restored modification time are detected when
they change a sampled region. Edits entirely between samples can evade the
cache check. To force full verification, archive the verification database
while the service is stopped and restart.

Linux background verification and analysis threads use idle I/O priority and
a higher nice value. Workers yield between files when interactive requests
are queued.

## HTTP lanes

The dispatcher defaults to **24 request threads** across dedicated lanes.
`WAITRESS_THREADS` controls the ordinary lane and defaults to 4. A value of 16
gives 36 total threads. Waitress logs queue depth at most once per minute across
all lanes.

| Lane | Threads | Admission |
|---|---:|---|
| control | 4 | `/api/playback/*`, `/api/profile/playback`, `/api/listening/rooms*`, including background heartbeats |
| listener | 2 | Immediate foreground `/api/jobs` requests, job status/cancel, `transition`, immediate foreground `playback-info` |
| media | 4 | Foreground signed library audio and job HLS media |
| snapshot | 2 | GET `/api/server/stats` and `/api/catalogue/*` |
| ordinary | 4 by default | Interactive reads, provider search and remaining short mutations |
| download | 2 | Background/lead-time `playback-info`, unsigned downloads, background audio delivery; POST uploads, library additions and playlist download/prepare/import admission |
| watch | 4 | `watch=1` streams; never the control endpoints |
| artwork | 2 | YouTube images, discovery covers, playlist artwork and profile-image reads |

The old dispatcher had 18 threads: ordinary 6, listener 2, control 2, media 4,
watch 4. Its "control" class held admin snapshots, while Connect used ordinary
threads alongside phone-copy requests. Adding more ordinary threads alone would
have retained the shared-lock problem.

## Operation inventory

Cost: L = small in-memory work; M = bounded file/JSON operations; H = full audio,
library traversal or subprocess work. Network is named where applicable. Timing
is trigger/cadence, not a promise about provider response time.

| Operation; file / route / worker | Lane or worker; priority | CPU / disk / network cost | Locks and publication | Frequency; what can wait |
|---|---|---|---|---|
| Session/CSRF/presence guard; `__init__.current`, `request_presence` | Every HTTP lane; follows caller | L; profile-file stat only on remembered-session restoration | Dedicated session RLock; governor condition; no jobs/catalogue mutex on normal authenticated requests | Every request. A session update only contends with session state |
| Listener job creation/promotion/status; `__init__.new_job`, `create_fetch`, `get_job`, `/api/jobs*` | listener; 1 | L/M; enqueue, cache lookup in worker | Jobs RLock/condition, per-job publication lock; terminal-file cleanup delegated | Play/skip and status polls. Same job publication/admission can serialize; no playlist transaction lock |
| Transition plan and prefetch admission; `/api/transition`, `/api/queue` | listener for transition; ordinary for prefetch admission; 1/4 | L/M transition math and current manifest; cold source checks for prefetch | Short jobs-state lookup; manifest IO outside jobs lock | Near a track boundary or search/prefetch update. Transition requests have reserved listener HTTP capacity; prefetch submits background acquisition |
| HLS preview and streaming; `work`, `publish_assets`, `/api/jobs/*/media/*`; intake `cmd_preview` | acquisition for creation, media for delivery; 1 | H encode/read during creation; file IO during delivery; stream bandwidth | Jobs lock only for asset list; immutable segment files, bounded manifest reads | Per play/segment. A preview waits for its own acquisition/encoder, not a download HTTP thread |
| Saved playback; `library_record`, `saved_source`, `playback_info`, `/api/library/*/playback/*`, `/download` | listener/media or download; 1/3 | Cached: M file stats; cold: H checksums; optional encode | Saved-cache lock covers lookup/publication only; checksums outside it. Reviewed overrides are whole-entry snapshots; observation skips a busy review lock | Every start/range. Cold verification costs belong to that recording; unrelated cache entries remain usable |
| Finished listening audio; `finished_audio.prepare_record`, `FinishedAudio.prepare`; `audio_profile` | One listener render and one bulk render; 1/3/4 | H FFmpeg loudness, trim, encode, verify and hashing | Separate priority lanes; per-digest completion event; atomic audio/metadata publication. No DB/catalogue transaction during render | Once per source digest/edition. Same-output callers coalesce; cached output bypasses render lanes |
| Device handoff / Connect; `playback_devices.py`, `/api/playback/{devices,transfer,takeover,handoff,control}` | control; 1 | L, no provider or audio IO | Device lock; room lock only for membership checks; source pauses after destination confirmation | On control action and device polls; only bounded device/room state work |
| Heartbeat/presence, `__init__.playback_activity`, `resources`, `PlaybackDevices.report` | control, priority 1 | Device state and listening counter updates | Device/governor locks. Connect updates before statistics. Queued statistics writes have a two-second wait limit | Native check-ins approximately every 5 seconds. Online expiry 15 seconds |
| Queue sync/resume; `profiles.ProfileStore.playback`, `/api/profile/playback` | control; 1 | M, at most 1,000 IDs | Dedicated playback-state lock and per-profile `.playback-state/*.json`; atomic replace. Reads migrate lazily from legacy profile JSON | Queue/position updates. Playback saves no longer rewrite or contend with the shared profile/preferences file |
| Listen Together/pokes; `listening_rooms.py` | rooms: control; pokes: ordinary; 1/2 | L bounded in-memory queues | Room RLock then governor condition; no network under room lock | Room actions/check-ins, 30-second room expiry. Room operations serialize with each other |
| Operational snapshots; `snapshots.py`, server stats, catalogue review/source quality/reports | snapshot; 1/2 | L cached, M/H refresh depending on library | Per-view cache lock; at most two refreshes per view; no request waits more than 200 ms for an initial snapshot | Reuse for 1 second; retain snapshots while refreshing, expose age. Slow refreshes consume refresh slots, not Connect threads |
| Library reads; `library_tracks`, `/api/library`, history metadata | ordinary; 2 | M/H directory scan, manifests and cold hashes; no network wait for genre lookup | Short saved-cache lock, genre cache, analysis publication; optional review observation is nonblocking | On open/refresh (native typically 3 minutes). Shares ordinary capacity with other reads; avoids encoder/cache-wide locks |
| Playlist reads/mutations/import admission; `playlists.py`, `__init__./api/playlists*`, coauthors and artwork metadata | ordinary reads/edits; download for bulk admission; 2/3 | M/H JSON lists, library resolution and atomic saves | Separate catalogue RLock; playlist revision checks; job admission takes jobs lock briefly | User actions/refresh. Serializes playlist transactions, not normal authentication/Connect/streaming |
| Public/provider playlist reads; `public_playlists.py`, `link_playlists.py`, `playlists.fetch_*` | ordinary for explicit reads; playlist workers for imports; 2/3/4 | Network: Spotify/YouTube/Deezer/SoundCloud; parsing, bounded pagination, browser extraction for Spotify | Provider gates; playlist lock only for saved state; network outside transaction | On import, discovery play or shared-playlist action. Provider waits occupy the requesting read/import lane |
| Search and search enrichment; `__init__.search`, intake `cmd_search` | ordinary + enrichment worker; 2 then 4 | YouTube yt-dlp subprocess/network; retries at 1.5/4 seconds | Short search/jobs state lock; intake per-query cache lock and YouTube provider admission | On query/page; newer foreground query cancels older. Positive cache 5 minutes, 32 entries; empty recommendations are not cached |
| Similar songs / radio; `radio.py`, `/api/recommendations`, `/api/radio`, `read_imported_playlist` | ordinary for lookup, preparation workers after creation; 2 then 3 | Deezer lookup/radio/top/related; bounded YouTube fallback searches; library fallback | Provider pacing; short cache/playlist publication locks, no provider call under jobs lock | User action. Failures remain distinct from valid empties; no listener/control request slots are used |
| Discovery; `discovery.Discovery`, `/api/discovery*`, `/api/admin/discovery` | ordinary reads; one `release-discovery` worker; 2/5 | SQLite/JSON + Deezer release metadata/artwork; no audio acquisition unless selected | SQLite WAL, short transactions; refresh mutex only for the worker; revision checks for admin corrections | Worker wakes every 60 s, per-artist success interval 24 h, exponential failure backoff. DB writers serialize; cached readers use WAL |
| Phone downloads / mobile copies; `mobile_audio.prepare`, `_encode`, `mobile_record` | download HTTP 2; one requested-copy encoder, one background encoder, one listener encoder; 3/5/1 | H FFmpeg Opus encode, loudness/length verification, hashing; disk + client bandwidth | Separate requested/listener/background lanes; per-output event; two phone and two listener admission slots; CPU governor includes post-encode measurement | Once per digest/tier. Up to four encode/measurement attempts; cached files bypass encoding. Bulk work cannot consume listener encode admissions |
| Manual playlist preparation; `playlist_preparation._PlaylistOperation`, `PlaylistPreparation._execute` | Up to 8 active operations; matching workers 3 per operation, download workers configured; 3 | Provider matching + library scans; hands acquisition to shared scheduler | Catalogue lock for status/JSON; fair shared 3/6 operation permits; releases match permit while waiting for acquisition; progress callbacks outside jobs condition | User start/resume. Waiters are bounded by active-operation count and per-operation worker count; no request thread waits for the whole playlist |
| Playlist auto-download; `automatic_playlists`, `PlaylistPreparation.sweep` | One idle-queue coordinator + acquisition pool; 4 | M/H playlist scans/matching/download | Catalogue transaction lock; global match admission; no device lock | Wake on job/presence changes; full scan every 300 s; retry/backoff persisted per entry. Lower priority than explicit download jobs |
| Acquisition / import / next-song prefetch; `__init__.drain`, `work`; `scripts/music-intake.py` | Dynamic acquisition pool, see limits below; 1/3/4 | H network spool, scratch, preview, import and finished render | Jobs condition, per-job publication, transfer/scratch admission, import lock; **render happens after import lock release** | Per requested song. Priority changes can promote a shared acquisition; current listener has extra reserved slot |
| Library additions persistence; `/api/library/additions`, `save_bulk_queue` | download for user admission; acquisition completion; 3/4 | M bounded JSON journal replacement | Catalogue lock for addition transaction; short jobs snapshot then dedicated file-write lock with monotonic revision. New additions stay undispatchable until persisted | Up to 200 queued additions per profile; writes on admission/cancel/retry/terminal transition. Bulk file serialization belongs to queue writers |
| Local uploads; `/api/uploads`, `create_upload` | download intake, acquisition worker; 3 | H upload spool, local tag probe and audio preparation | Catalogue permission check, brief job admission, private upload file; file copying outside jobs lock | User-selected files; byte limits enforced. Upload preparation shares requested-download priority and cannot take listener acquisition priority |
| Tagging / metadata review; `catalogue_review.py`, `catalog_search.py`, `musicbrainz.py`, `tag_songs` | One tagger, ordinary manual review; 5/2 | MusicBrainz/Deezer/iTunes network; JSON rewrite | Review RLock for mutation; providers outside review lock; immutable override reads; optional playback observation skips busy lock | Background 30-second idle checks, rolling auto-resolution budget. Review saves can delay other review writes, not playback metadata reads |
| Genre labels; `genres.GenreLabels` | One lazy drain worker; 5 | MusicBrainz network, small JSON cache | Genre lock for memory update; JSON file write outside it | Missing artist triggers queue; roughly 1.1-second spacing plus provider limits; cached lookup returns immediately |
| Source quality / replacement / trimming; `source_quality.py`, `listening_versions.py`, external review import | One scanner and one serialized replacement worker; 5 | H bounded spectral decode; optional YouTube replacement; archive/rollback IO | Scan/FFmpeg locks, replacement lock; catalogue/review/stats transaction for archive and repoint; processing outside DB transactions | Idle scans and explicit review requests. Interrupted scans retry; replacement transactions remain atomic and block catalogue writers only |
| BPM/key and beat analysis; `song_analysis.py`, `analysis.py`, `analyze_job` | One library scanner plus lowest-priority acquisition analysis; 5 | H FFmpeg decode and NumPy/librosa CPU | Scan/decoder locks and CPU permits; file write outside metadata read lock; short publication | Once per digest; idle gate, cancellable scan windows. CPU slots are reserved before subprocess start |
| Lyrics; `lyrics.py`, `/api/library/*/lyrics` | ordinary; 2 | LRCLIB network, small cache files | Per-recording single-flight lock and provider pacing lock; no jobs/device mutex during lookup | On lyrics open; persisted results/absence. Same-song lookup coalesces; rate-limit retries can delay only lyrics/read capacity |
| Statistics/history/wrapped, `listening_stats.py`, `listening_history.py`, `wrapped.py` | State writer, ordinary history requests and snapshot reads | Append counters, JSON checkpoints, event batches, yearly aggregates, chart lookup | Stats/history locks and catalogue privacy/clear transaction. The state writer persists accepted counters in order | Heartbeats every 5 s, statistics checkpoints every 300 s, legacy checkpoints every 30 s, daily history pruning |
| Artwork; `__init__.artwork`, `discovery.cover_jpeg`, `playlist_artwork.py`, `profile_artwork.py` | artwork reads; ordinary edit; 2/5 | Image network <=5 s, byte/dimension caps; FFmpeg <=10 s | Cache locks only around publication. Playlist/profile image encoding outside catalogue transaction; revision rechecked before metadata save | On image miss/edit; YouTube cache 64 entries; provider pacing wait bounded. Image conversion has nonblocking CPU admission |
| Housekeeping / quotas / updates; `retire`, `budget`, `app_updates.py` | One retired-file worker; acquisition quota checks; ordinary package requests; 5 | Directory scan/delete, disk usage, package reads | Budget lock before jobs lock for progress; retired temp directory atomically detached after reference recheck, then deleted outside jobs lock | Eviction on job TTL/count; quota scan cached 0.5 s; app updates on client check. Cleanup no longer runs inside listener admission |

## Worker limits and lock rules

* `cpu_capacity = max(0, effective CPU cores - 1)` after affinity/cgroup limits.
  FFmpeg uses one codec/filter thread and Linux affinity leaves a core outside
  its set. Normal background audio uses at most
  `max(1, min(capacity - 1, (capacity + 1) // 2))` active CPU permits.
  Multi-process BPM/key analysis costs two permits. Zero-capacity hosts reject
  audio processing rather than silently oversubscribe.
* On the observed 16-core server: CPU capacity 15; default background workers 8;
  ordinary acquisition slots `max(8, background_workers + 4)` = 12, plus one
  current-listener slot = **13**. These are the "12-thread dispatcher" workers,
  distinct from the HTTP dispatcher. Background admission shrinks with presence;
  default online/listening background cap is 6. Idle expansion is configurable.
* Acquisition pending order is listener/shared listener, explicit download or
  library addition, background acquisition, then analysis. CPU/transfer waiters
  use the same ordering for acquisition work. Active shared work is promoted when
  a listener requests its source. Fairness breaks ties by owner/playlist and age.
* Transfers default to 4, configurable 1–8; idle capacity defaults to 6. Listener
  transfers retain reserved capacity when idle background transfers are active.
  Scratch admission keeps listener headroom. Provider gates start foreground
  requests before background requests, while honoring upstream cooldowns.
* Deezer/Spotify/SoundCloud starts are spaced 0.25 s; iTunes 3.2 s; YouTube uses
  intake's provider budget/cache. Deezer/catalogue gate waits are bounded at 8 s;
  artwork gate wait is 2 s. Cooldown is not bypassed by a high-priority caller.
* Catalogue/playlist/profile transactions and jobs scheduling use different
  RLocks. Catalogue code may briefly acquire jobs state; acquisition progress
  releases jobs state before invoking playlist callbacks. Authentication uses a
  third session lock. Queue resume files have their own lock and file namespace.
* Accepted counters update memory before the heartbeat response. Disk
  persistence can finish after that response. Resending the same cumulative
  counters preserves the recorded total. If a catalogue transaction holds the
  privacy lock for more than 50 ms, the client can retry the counters on its
  next check-in.
* JSON writes still serialize mutations of their own store; SQLite still has one
  writer. Neither contains audio encodes or external catalogue calls. Atomic
  rename/file syscalls are nonpreemptible. These
  filesystem effects are not hard real-time operations.

## Findings and reproduction

Read-only live journal inspection showed Waitress queue depth reaching 13 while
CPU permits were only 2–4/15, with two devices online. That supports HTTP/lock
starvation rather than CPU saturation. No live restart, configuration change,
deployment or release was performed.

`tests/test_server_priority.py` runs the production Flask application under
Waitress with 48 valid saved recordings in a playlist, 12 concurrent phone
download loops and two devices. It polls state, transfers playback, delivers and
confirms the transfer, checks `handoff=ready`, pauses the sender and reverses the
direction. Each metric has 30 samples. It injects 80 ms cold checksum reads and a
350 ms encoder stage to make storage/encoding contention repeatable. Downloads
use the real metadata and audio-byte routes, admission, cache, mobile encoder lanes and response handling;
the injected encoder writes a fixture copy, not production audio.

Initial reproduction (transfer delivery without confirmation): device p95
1,765 ms, handoff p95 1,407 ms, heartbeat p95 1,388 ms. After HTTP/cache isolation:
21 ms, 19 ms and 19 ms respectively. Snapshot p95 changed from 25 ms to 15 ms;
snapshot capacity already existed, but its authentication path shared jobs state.

Completed-transfer reproduction, including audio-byte downloads (milliseconds,
p95; baseline `384a41f`, identical fixtures and injected delays):

The recorded before and after runs were sequential, with no concurrent test suite.

| Operation | Before | After |
|---|---:|---:|
| Device state | 740.2 | 20.3 |
| Transfer request | 378.9 | 19.3 |
| Destination heartbeat | 1,001.4 | 23.5 |
| Confirmation heartbeat + handoff-ready read | 764.1 | 30.4 |
| Server snapshot | 21.8 | 15.9 |

Every measured control operation meets the 300 ms target. The confirmation row
times two HTTP requests; it does not measure audio output starting on a physical
device. The baseline completed 453 download iterations and returned 123 busy
responses while control requests were delayed; the shorter after run completed
12 downloads with no busy responses. These counts are not a throughput comparison.
Real FFmpeg format/loudness/range tests run separately. These synthetic load
numbers are local Windows loopback results, not measurements of the deployed VM
or Wi-Fi handoff time.

Validation: the full Python suite and focused priority regressions passed (555
tests in the full run, 7 skipped; one additional radio fallback regression in the
focused run); 898 client-core checks and the player regression executable
passed. The Windows native app builds successfully with an existing nullable
stream warning in `MainPage.xaml.cs`. Tests ran headlessly in hidden background
processes at Idle priority. Native device handoff and native rendering on macOS,
Android and iPhone remain device checks; this change does not claim those passed.

Reproduce headlessly at idle priority, with `PYTHONPATH=tests`, using the project
Python environment:

```text
python -m unittest test_server_priority.ServerPriority test_priority_regressions
python -m unittest discover -s tests -p test_*.py
dotnet run --project clients/FamilyHub.Player.Tests
dotnet run --project clients/FamilyHub.Client.Core.Tests
```

`FAMILYHUB_PRIORITY_REPORT_ONLY=1` suppresses only the latency assertion when
running the same load test against the unmodified baseline; it does not suppress
response, handoff or download assertions. Use `Start-Process -WindowStyle Hidden`
and set `PriorityClass=Idle` on Windows. Test logs are in `.local/priority/`.

## Radio and similar-song behavior

These are two different paths. Similar songs uses `/api/recommendations` and
client artist/genre filtering; Song Radio uses `/api/radio`, Deezer and playlist
preparation. The historical provider response was not recorded, so its exact
payload cannot be reconstructed from the owner report.

Confirmed failure paths: featured-credit strings and upload suffixes reduced
Deezer matches; discovery compared uncleaned titles and credits; an empty artist
radio had no seed-artist top-track fallback; catalogue error payloads could look
empty; recommendation empties were cached for five minutes. The native Similar
songs handler already guarded empty replacement in this base, but Song Radio
called `PlayAsync(seed, [seed])` before requesting the radio, discarding the queue
even if the lookup or preparation subsequently failed.

Lookup now removes recognized upload descriptions, uses the primary artist for
featured credits, and compares accent-normalized identities. Radio falls back to
artist top tracks and saved songs by artist/known genre. Recommendations use saved
matches when search fails and bounded top-track searches when needed. Empty and
failed responses remain distinct; provider error details stay out of client text.
The native radio action preserves the current queue until a usable different song
is ready, checks that playback/profile context is still current, and performs its
preparation polling outside the page's busy action. Empty/failed Similar songs
results retain the queue and give a retry/library action. MusicSession and
handoff implementation are unchanged.
