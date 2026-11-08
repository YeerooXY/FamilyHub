# Acquisition foundation verification

Date: 8 November 2026. Scope: private torrent search and download foundation. The owner selected public sources without existing tracker accounts and rejected per-title purchases.

## Verified deployment

The existing Debian VM runs pinned qBittorrent-nox 5.3.0-2 and Prowlarr 2.7.0.5723. Application processes use UID 2000; container init helpers run as root. Each container has a 1 GiB memory limit; CPU limits are 2 and 1 respectively. A snapshot showed about 46 MiB and 164 MiB usage; these are idle/light-use observations, not concurrent family-load measurements.

Only guest loopback WebUI ports 8080 and 9696 are published. Dedicated appdata children are 2000:2000 mode 0700 beneath root-owned mode 0700 appdata. qBittorrent mounts only its config and downloads; Prowlarr mounts only its config. Neither mounts family files, photos or media libraries. Native authentication remains enabled; unauthenticated API probes returned 403 and 401. Prowlarr analytics is disabled. Logs rotate at 10 MiB with three files retained per container.

Bash syntax and Compose validation passed in Debian. Repeated bootstrap execution preserved state. An isolated negative check rejected a symlink in the second service directory before changing the first directory's ownership; non-root invocation was rejected. Prowlarr's native download-client test reached qBittorrent successfully.

A public Debian installer torrent completed through real peers. Its 792,723,456-byte output matched the HTTPS mirror's SHA-512 checksum. The completed file is owned by 2000:2000, mode 0660, in `/srv/familyhub/data/downloads/complete`. This was a transport test, not media content for the players. qBittorrent authentication and save-path settings survived a container restart. Jellyfin and Navidrome health endpoints remained HTTP 200.

New acquisition password copies are Windows DPAPI-encrypted in the restricted, ignored `.local/playback` directory. Native application configuration/database secrets remain protected by appdata permissions and will require encrypted backups. Existing plaintext playback test-credential files were not converted by this milestone.

## Source research and live results

Prowlarr supplies the shared indexer layer; it does not host the content. Its upstream list includes public, semi-private and private sources. The private VM has two public sources configured after successful native tests. A third source failed validation and was not enabled. Source settings and credentials are absent from Git and the Compose defaults. [Prowlarr supported sources](https://github.com/Servarr/Wiki/blob/master/prowlarr/supported-indexers.md).

The public catalog search returned a different Maduk release named **Not Alone**, which was rejected as a title mismatch. **Alone** and **Transformations** did not yield a suitable lossless result from the connected sources. No replacement song, lossy fallback, purchase or discography download was started.

The Hungarian film title returned a 1970 candidate and its 1971 sequel. Only the 1970 candidate was queued. A separate 1080p release advertised Italian/English audio and Italian/English subtitles and was queued for inspection. At the last check, both had no media bytes downloaded: the Hungarian candidate awaited torrent metadata and the English/Italian candidate had metadata but no connected seeds. Advertised indexer seed counts did not establish usable peers. Actual audio, resolution and Hungarian subtitles remain unverified. Neither candidate was imported into Jellyfin.

The requested song and complete movie language/subtitle combination are therefore **unfilled**. Queued candidates are not a successful acquisition. Keep them outside the player libraries until identity, file integrity and actual streams are verified. The download client and VM must stay running for pending transfers to progress.

## Remaining workflow

The intended path is request, source search, release matching, torrent transfer, media verification, library import and player scan. This milestone verifies source search, downloader connectivity and transport. It does not implement automatic quality selection, monitored requests, hardlink imports, subtitle matching or player scans.

Lidarr is the planned music release manager and Radarr the movie manager; Bazarr remains a subtitle candidate. Lidarr works with release groups (albums and singles), rather than arbitrary isolated tracks. Configure lossless-only music profiles and enable single release groups where needed. MusicBrainz supplies identity metadata, not audio files. [Lidarr concepts](https://github.com/Servarr/Wiki/blob/master/lidarr/concepts.md), [Lidarr download/import setup](https://github.com/Servarr/Wiki/blob/master/lidarr/quick-start-guide.md).

No claim is made that public sources can supply every title, language or quality. Highest sample rate alone does not prove the best master or a genuinely lossless source. A paid catalog entry is not itself a downloadable torrent.

## Implementation record

Local Strata was offline. The free Pi/North Mini Code worker at medium effort (`0874d23b-c35a-4330-b563-f0588c60e18d`) failed at its tool-call limit without changes. After explicit owner continuation, included Codex GPT-6-Luna at medium effort completed the qBittorrent foundation (`bd0fb8f6-a3ed-466b-992d-0d76a64ba9ec`) and the separate Prowlarr addition (`489e4cef-27ec-47ab-9111-6159f119ffe2`). Builders used the supplied ponytail guidance; the coordinator used pstack for sequencing and performed direct runtime checks and small integration corrections.

The qBittorrent task's external check runner failed because the coordinator supplied prose in an executable check field. Its implementation completed; the actual Bash, Compose and behavior checks were then run successfully in Debian. The Prowlarr task's executable check passed. No metered fallback or model-savings claim is made.
