# Music verification

Verified on 10 November 2026 in the existing Debian development VM and on the Windows workstation. The administrator music intake commands work, Lidarr is deployed and connected, and Navidrome serves the imported generated fixture. A real MusicBrainz-matched album through Lidarr remains pending.

## Runtime

| Component | Verified state |
| --- | --- |
| VM access | Existing SSH host `familyhub-dev.mshome.net`, resolved to `172.19.229.214`; saved host key verified using alias `familyhub-dev` |
| Lidarr | 3.1.6.5079; image digest `sha256:d5707cfe084da21a3864c7ef0edd9c0543b5e26c79c551f84dad5ef8683af8c7` |
| Lidarr boundary | `127.0.0.1:8686`, application UID 2000, 1 GiB memory, 1 CPU; container init helpers retain root |
| Script | `/usr/local/lib/familyhub/music-intake.py`, root-owned; executed as `familyhub-writer` |
| Debian tools | FFmpeg/ffprobe 7.1.5-0+deb13u1; yt-dlp 2026.10.26; yt-dlp-ejs 0.8.0; Deno 2.9.8 |
| Windows test tools | Python 3.13; FFmpeg/ffprobe 9.0.2; yt-dlp 2026.10.26; yt-dlp-ejs 0.8.0; Deno 2.9.8, installed under ignored `.local/` |

The canonical acquisition Compose file and scripts were copied to `/home/familyhub/playback`. The previous Compose file is retained there as `compose.acquisition.before-music-20261110.yaml`. Lidarr was recreated from the canonical file and its settings persisted. No public admin endpoint or torrent peer port was opened.

## Service connections and storage

- Compose validation passed on Windows and Debian. Bootstrap shell syntax passed; the VM bootstrap created Lidarr appdata with owner 2000:2000 and mode 0700. The existing validate-before-mutation logic was reused; its negative cases were not rerun for this addition.
- Forms authentication is required for all addresses; analytics is disabled. Unauthenticated Lidarr and Prowlarr API requests returned 401, and qBittorrent returned 403. Jellyfin health and Navidrome ping returned 200.
- Native connection tests passed for Lidarr's qBittorrent client, Prowlarr's Lidarr application and one compatible synced music indexer. qBittorrent uses category `lidarr-music`. Prowlarr uses Add and Remove Only sync; the resulting Lidarr indexer allows interactive search, with RSS and automatic search disabled. No artists are monitored.
- Lidarr accepted `/data/media/music/Managed` as its only root. Its default quality profile is Lossless; default monitoring is None. Hardlinks are enabled, tagging is Never and Linux permission rewriting is disabled.
- A throwaway file in downloads was hardlinked into `Managed` from inside Lidarr as UID 2000. Device and inode matched, with link count 2. Only these created test files were removed. This tests the mount layout; it does not prove Lidarr's import of a matched release.
- qBittorrent's downloads mount and Prowlarr's config-only mount stayed unchanged. Private family folders remain outside the shared `/data` tree. Lidarr can access all of `/data`, as documented in [Music import](MUSIC_IMPORT.md).
- Lidarr's development administrator credential is stored in root-only `/srv/familyhub/appdata/music-check/lidarr-credentials.json`, mode 0600. Native configuration contains service keys. Credentials were not written to Git or test reports.

## Automated checks

| Run | Result |
| --- | --- |
| Windows `python -m unittest discover -s tests -v` | 19 tests: 15 passed, 4 skipped (three symlink cases lacked Windows permission; optional network test disabled) |
| Debian same suite | 19 tests: 18 passed, optional network test skipped |
| Debian optional network test with `FAMILYHUB_NETWORK_TESTS=1` | Passed separately with installed yt-dlp; all 19 tests covered across the two Debian runs |
| Existing playback regression | All 21 checks passed, including fixture playback bytes and separate user state |

The intake suite checks generated audio, full decode failures, tags, encoded audio preservation, trim duration, unchanged originals, repeated imports, collisions, unsafe paths and malformed manifests. Fetching audio is covered by the manual network exercise below, rather than by a downloader mock. The playback checker now selects its named fixture albums from the first 50 albums, so the additional imported album does not fail the fixture count.

## Writer-role import and playback

1. Staged the existing generated `Sample CD 16-44.1/01 - Tone 1.flac` as `familyhub-writer`.
2. Kept intervals `0.5:2` and `3:5`, producing a separate 3.5-second FLAC. The staged original remained unchanged.
3. Imported with artist `FamilyHub Samples`, album `Intake Verification`, title `Trimmed Tone`, track 1. Embedded tags and audio packet preservation passed. Repeating the import reported `existing: true` and created no duplicate.
4. Reader UID 2001 could read the file; `nobody` could not.
5. A Navidrome scan found exactly one matching track with the intended artist, album and title. Its `format=raw` stream matched the library file byte for byte.

Library file:

```text
/srv/familyhub/data/media/music/Local Imports/FamilyHub Samples/Intake Verification/01 - Trimmed Tone.flac
SHA-256 ce14f844ed902a595a6c14c38dde5d42171da61865c09dbc6e54483e4331ea89
```

This proves native library indexing and delivery of the imported file. It does not establish audible playback or hardware output on a phone, TV or DAC.

## Public YouTube exercise

Used [Big Buck Bunny 60fps 4K, official Blender upload](https://www.youtube.com/watch?v=aqz-KE-bpKQ). Before downloading, yt-dlp's metadata reported channel `Blender` and `Creative Commons Attribution license (reuse allowed)`. Attribution for the test source: Blender Foundation, Big Buck Bunny, linked above. The source attribution and license were checked from YouTube metadata; external Blender pages were unavailable during this run.

- Public search passed. A specifically selected URL downloaded and fully decoded on both Windows and Debian, using no cookies or account session.
- Selected format 258 contained AAC at 48 kHz with six channels, approximately 386 kbit/s, lasting 634.624 seconds. This is a multichannel test film; its bitrate is not a promise about music uploads.
- The source AAC codec was retained. The file stayed in the VM quarantine workspace and was not imported into the family's music library.
- On Windows, a separate four-second `10:14` excerpt was trimmed to FLAC and imported into an isolated test library with tags. The original AAC was also imported there with tags through audio stream copy. Both imports passed tag, packet-hash and decode checks. The derivative manifest retained `source.lossy: true`.

| Staged test file | SHA-256 |
| --- | --- |
| Windows AAC | `912df40bc985070c29f8c14825a920c5484e64c40e11a3b2c02a21132cec30d1` |
| Debian AAC | `ad8591dc586a3f8b266d37b07013538abb4a047e902633bd5378821f27ffd358` |
| Windows tagged four-second FLAC excerpt | `dcf8c3e12fdf19d1f928e051c025ea4fc3a757c9f18de8a36bd1629d489748fb` |

Different remuxed container hashes across the two environments are expected; no claim of cross-platform file-byte identity is made. YouTube audio remains lossy. FLAC editing avoids another lossy codec encode and preserves the origin record; it cannot restore information missing from the source.

## Remaining checks and scope

- Run one suitable real MusicBrainz-matched album through Lidarr and verify identity, track count, hardlinks, unchanged download bytes, torrent recheck, repeated import behavior and Navidrome scan/playback. Synthetic files cannot satisfy that acceptance check.
- The current search, intake and trimming interface is an administrator CLI. A family-facing search/import/trimming interface is a later feature. No website visual change was made in this milestone.
- Original source audio is the current download default. Automatic lossy fallback and always-MP3 conversion were not approved. Search results require explicit selection before fetching.
- No actual macOS, Android or iPhone playback was verified here. The detailed CLI limits, including direct-child timeouts, interrupted publication and administrator directory assumptions, are in [Music intake](MUSIC_INTAKE.md).
- No Spotify cache conversion was performed. Earlier Spotify research files were preserved.

## Implementation and review

Local Strata was offline; the included Codex worker allowance was exhausted. The discovered Claude Pro allowance was available. All worker jobs used the included `claude:default` account, medium reasoning and one round, with no metered fallback or automatic worker retry.

| Worker job | Model | Ownership and result |
| --- | --- | --- |
| `07550866-e13b-4da0-a17f-34d72616b6b5` — Lidarr music-import foundation | Claude Fable | Bootstrap directory addition, service template and import guide; completed |
| `b04fb704-f8c3-49fd-9b51-1fdd54d3b61f` — Source-audio intake and trimming | Claude Fable | CLI, tests and usage guide; completed |
| `06f7c25b-d936-4ec9-95c9-da42bb1fc671` — Review and finalize intake | Claude Sonnet | One combined review and bounded completion: native tags with encoded-audio verification, FIFO guard, trim timestamp normalization and corrected limits; completed |

The review used Sonnet to assess the filesystem, media preservation and cross-service boundaries together. There was no high-effort or Astra escalation. Workers lacked shell tools; the lead ran deployment and verification. Direct work was limited to deterministic runtime setup, verified image-digest integration, the small fixture-selection correction, ignored Python cache configuration and documentation of actual results. No commit was created.

Reused the existing writer/reader roles, default ACLs, appdata bootstrap, acquisition network, downloader/indexer APIs and Navidrome library. The new intake tool uses yt-dlp and FFmpeg for their existing extraction and media operations. Managed releases and manually tagged imports use sibling directories; no custom metadata database, player or transcoder service was added.

## Topic-first search update: deployed, review waived by owner

On 10 November, the owner approved Claude implementation with a separate Pi review. The repository CLI now retrieves at most 30 metadata-only search candidates in one yt-dlp invocation, validates and deduplicates video IDs, ranks Topic channels and explicit audio titles ahead of other uploads and music videos, and applies the requested limit afterward. Each result carries its heuristic `kind`. Existing fetch, stage, trim and import behavior was reused.

- Claude Sonnet, medium effort, included account `claude:default`, job `387630df-b687-4007-bf08-5c2570dcffd8`, completed the three-file implementation. Its automated check found one new test expected six results with the default limit of five. The lead made a one-line test correction to request ten results explicitly. No builder retry was launched.
- Windows then passed 20 of 24 tests with FFmpeg available. Three symlink tests were skipped for insufficient Windows privileges, and the opt-in network test was skipped.
- The script and tests were copied into `/home/familyhub/playback/.music-search-check/`, separately from the installed CLI. All 24 tests passed in Debian with `FAMILYHUB_NETWORK_TESTS=1`, including live public metadata search and the existing audio preservation, import, trim and filesystem checks. This run downloaded no recording.
- The planned independent review ran once through `pi:default`, model `openrouter/cohere/north-mini-code:free`, medium effort, job `f8ddf7bb-03c0-4cd9-9156-6b0ba6297227`. Pi reached its bounded worker response/tool-call limit and returned no verdict. It made no file changes. The builder task's automatic reviewer had been skipped because of the earlier failed test; the separate Pi job was the sole review attempt.
- Local Strata was offline; the included Codex allowance was exhausted. Existing Claude and Pi discovery readings were reused. There was no paid fallback, model escalation or automatic review retry. Both jobs stopped.

The lead corrected the usage example to use a writable relative folder, distinguished source codecs from file containers, and recorded actual test and review status. These were small test/documentation edits. `git diff --check` passed. No commit was created, and unrelated work was preserved.

After these checks, the owner explicitly chose to skip Pi's review. The lead installed the exact tested script as `/usr/local/lib/familyhub/music-intake.py`, root-owned mode 0644, and updated the runtime repository copy and tests. The previous installed script is retained as `/usr/local/lib/familyhub/music-intake.py.before-topic-20261110`. Installed SHA-256 matches the repository and staged copy: `1d42496f40b8ca3fbc666cacf9c2fe379e35580da1a05092828346bfa7418dea`.

A live search as `familyhub-writer` for `Scott Joplin Maple Leaf Rag`, limit five, returned five Topic-class results first. This also demonstrated why manual selection remains necessary: results included several recordings and performers. No recording was downloaded during this check. Search returns candidates; fetching the selected URL and importing its staged audio remain explicit separate commands. No mobile UI or automatic first-match downloading was added. This was deterministic deployment of already tested code, completed directly without another worker or review retry.

The later [mobile music interface](MOBILE_MUSIC.md) wraps these commands with the owner's selected search-list layout. Its private connection was activated on 11 November after the owner explicitly requested it; real HTTPS sign-in, search, generated-audio import and player delivery passed. See the separate [mobile verification record](MOBILE_MUSIC_VERIFICATION.md).
