# Sample playback verification

Date: 8 November 2026. Scope: isolated development playback with synthetic media. Acquisition services remain undeployed; shopping remains deferred.

## Environment

Debian 13.7 Hyper-V VM, 6 vCPUs, 12 GiB RAM, expandable 200 GiB disk. Docker 29.9.3 and Compose 5.7.0. Jellyfin 12.4 and Navidrome 0.64.2 use image digests pinned in `compose.playback.yaml`. This is a development configuration; it does not establish production performance on the planned 16 GiB server.

Both players run as reader UID/GID 2001 with read-only media mounts, dropped capabilities and no-new-privileges. Application state is writable only in dedicated mounts. Published ports bind to guest loopback. Attempts to write through the media mounts failed with a read-only filesystem error. Jellyfin reported healthy; Navidrome returned HTTP 200 from `/ping`.

## Completed checks

| Check | Evidence |
| --- | --- |
| Fixture generation | ffprobe confirmed 1080p H.264 with English/Hungarian AAC and subtitle tracks; 2160p HEVC; native 16-bit/44.1 kHz and 24-bit/96 kHz FLAC. Rerunning preserved existing nonempty fixtures. |
| Video library | Two distinct synthetic movies and one episode indexed. Episode uses a hardlink to the 1080p fixture. Catalogue matching is disabled for the test libraries; fixture metadata is explicitly labelled. |
| Video decoding | Headless Linux Chromium decoded the 1080p sample: 1920×1080, advancing playback beyond 2.5 seconds, 65 decoded frames, no media error. Hungarian audio was selected; Hungarian subtitle text with accented characters rendered. Synthetic tones do not verify spoken language. |
| Music decoding | Chromium played both FLAC albums with advancing audio time, readyState 4 and no media error. |
| Original music delivery | All four raw OpenSubsonic streams had SHA256 hashes identical to their local FLAC originals. This verifies original delivery; output-device bit-perfect audio remains untested. |
| User separation | Separate administrator and two regular accounts per service. Jellyfin A had played/favourite state while B did not; Navidrome A had a starred song while B did not. |
| Administrative boundary | Jellyfin regular user received HTTP 403 from `/System/Configuration/MetadataOptions/Default`, administrator HTTP 200. Navidrome regular user received HTTP 403 from `/api/user`. |
| Static video delivery | Jellyfin HTTP 206 Range response matched the first 4096 bytes of the original 1080p file. |
| Restart persistence | After restarting both Compose services, every `verify-playback.py --verify-only` check passed, including users, libraries, per-user state and original music streams. |
| Configuration checks | Bash syntax, Python compilation and Compose configuration validation passed. |

Browser checks used Playwright 1.64.1 in a temporary container inside the Debian guest, with no published ports. The test container was removed afterward; both players remain running. Screenshots were inspected and retained under the Git-ignored workstation `.local/vm/screenshots/` directory. This is Linux Chromium evidence, not Windows, macOS, Android or iOS device evidence.

## Access blocker and pending checks

The owner approved protecting a local credentials folder and creating SSH forwards bound to workstation `127.0.0.1:18096` and `127.0.0.1:14533`. The execution tool rejected the combined setup before execution with **blocked by policy**, including the single retry after approval. No workstation forwards were created. Credentials remain in the guest root-only state directory; no password or token was copied into Git or this report.

Pending: workstation access; actual LG webOS, Android and iPhone playback; offline music; 4K decoding and production Intel Quick Sync; real speech/audio selection; sustained concurrent family workloads; end-to-end independent backup and restore of player state. Container restart persistence does not establish backup recovery. The short 4K fixture is indexed but does not establish HDR, realistic bitrate or transcoding capacity. No acquisition or lossy music fallback policy was enabled.

## Delivery and routing

Two bounded implementation jobs completed through the included `claude:default` account using Sonnet at medium effort: sample Compose/fixtures (`62443266-9b26-4bad-91e7-4f7a386b78b4`) and native API verification (`7609f9f2-6a5b-45e7-ae9e-b1bd02e37747`). Workers used ponytail. The coordinator applied pstack and performed integration fixes and runtime checks. Local Strata was offline; the included Sonnet route followed a prior free-worker tool-limit failure and explicit owner continuation. No metered fallback or token-savings claim is made.

See [the playback guide](PLAYBACK.md) and [API checker instructions](API_PLAYBACK_CHECK.md) for reproduction. Sample accounts are development-only. The remaining client and recovery gates keep this milestone short of production acceptance.
