# FamilyHub sequencing review — Opus medium

8 November 2026. Input: `SEQUENCING_REVIEW_BRIEF.md` only. No browsing was available, so upstream product facts are marked **[Unverified]**. **[Brief]** = stated in the brief. **[Proposal]** = my recommendation. **[Assumption]** = untested.

## 1. Recommended sequence

**[Proposal] Library-contract-first, playback before acquisition:**

1. **Dev host and storage contract.** One Debian VM on Hyper-V running Compose. It has one `/data` tree (`/data/downloads`, `/data/media/{movies,tv,music}`), one service UID/GID and persistent config volumes.
2. **Playback on the contract.** Jellyfin and Navidrome, with synthetic samples placed by hand. Two family accounts. Client checks on LAN.
3. **Acquisition into the contract.** qBittorrent, Prowlarr, then Radarr, Sonarr and Lidarr one at a time. Each writes to the paths the players already read.
4. **Requests.** A request portal on top of the working *arr services.
5. **Remote access and backups** to a physically separate destination, with a tested restore.
6. **Files and photos.** Nextcloud and Immich are heavy. Samba only if a real need remains after Nextcloud.
7. **Production move.** Same Compose files on the i5-12500, then the Intel QSV check.

**Alternatives rejected:**

- **Acquisition-first.** The downloader chain ends in an import step, and import targets the library layout. Building it before any player reads that layout risks redoing paths, naming and permissions. Without owner-authorized sources, it also only proves plumbing with synthetic torrents, so it produces nothing the family can use yet.
- **Platform-first** (identity, remote access and backup before any app). There is nothing worth protecting or reaching remotely yet. It delays the first verifiable outcome. Backup design depends on knowing which volumes hold state.
- **Files/photos-first.** Nextcloud and Immich are the most resource-hungry candidates for 16 GB **[Assumption]**. They are independent of the media chain, so starting with them teaches little about the riskiest integration.
- **Single SSO first.** It adds a service and an integration to every app before the family has an app to sign in to. Per-app accounts are enough for 4–6 users at first. Revisit before the public FOSS release.

**Why playback first:** it gives the quickest visible result (the family can play media). It tests the riskiest client facts: webOS, iOS, Hungarian audio and subtitle selection, and music quality behaviour. It also fixes the contract that acquisition must satisfy. Rework risk falls because the contract is checked by its consumer before any producer is built.

## 2. First milestone: "M1 — library contract plus LAN playback"

**Inputs**
- Approval to create one Hyper-V Debian VM on the workstation. No changes to the Windows host beyond that VM.
- Synthetic media generated with ffmpeg (no copyrighted content):
  - 1080p H.264/AAC MKV with Hungarian and English audio tracks and HU/EN SRT subtitles.
  - One 4K HEVC clip.
  - FLAC 16/44.1 and 24/96 test albums with MusicBrainz-style tags.
  - One deliberately mislabeled FLAC that was made by upconverting a 128 kbps MP3.
- Pinned image tags for Jellyfin and Navidrome.

**Outputs**
- `compose.yaml` and `.env.example` with no secrets.
- A written path and UID contract.
- A short verification record listing each client tested and whether it was real or emulated.

**Pass/fail checks** (all must pass)
1. `docker compose up` from a clean VM reaches healthy state, using pinned images only.
2. Jellyfin plays the 1080p sample by direct play on the LG webOS app, Android, iOS and a desktop browser. Each client can switch HU/EN audio and subtitles. Record transcode versus direct play from the server dashboard.
3. On the 4K clip, record the outcome per client. Software transcoding on the Ryzen VM **does not** prove Intel QSV.
4. Navidrome streams the FLAC originals unaltered on LAN, checked by the reported format and bitrate. A per-user or per-player transcode to Opus works on a mobile client.
5. Two users each have their own playback state and see only their own data. An admin account is separate from the family accounts.
6. After VM reboot and `compose down`/`up`, accounts, watch state and libraries persist.
7. Deleting the config volumes and restoring them from a copy brings back the same state. This is a backup rehearsal only, not independent protection.
8. Works with the workstation's internet disconnected after the images are pulled. Metadata gaps are expected and recorded.

**What M1 does not prove:** production hardware acceleration, real-device font rendering on untested clients, acquisition correctness, remote access, or backup independence.

**Rollback boundary:** everything lives inside one VM, which gets a checkpoint before M1. Rollback = delete the VM. No host Docker, no WSL changes, no router or DNS changes.

## 3. Dependencies

`selection → acquisition → organization → metadata → playback`

- **Selection** (Prowlarr indexers + *arr quality profiles) depends on owner-authorized sources and the quality policy (§4).
- **Acquisition** (qBittorrent) writes to `/data/downloads`. It depends only on selection and the path contract.
- **Organization** (the *arr import: rename plus hardlink or move) requires downloads and media on **the same filesystem, mounted at identical container paths**. Otherwise imports copy files, doubling SSD use, or fail **[Unverified, standard *arr guidance]**. This hidden cross-service assumption is the main structural risk. M1 fixes it.
- **Metadata:** the *arr services name files by TMDB/TVDB/MusicBrainz IDs. Jellyfin and Navidrome read the names and tags again. Navidrome relies on embedded tags, not folder names **[Unverified]**. Lidarr's tagging must therefore be on, or a tagger must run.
- **Playback** depends only on the organized tree. It does **not** depend on acquisition, which is why it can come first.
- **Requests** depend on working *arr services. Music requests are the weak point. Seerr-family portals have historically lacked music support, while Ombi has offered Lidarr requests **[Unverified, recheck current releases]**. Decide the music request route before step 4, not before M1.

## 4. Proposed music quality policy (needs owner approval)

**Library originals**
- **Preferred:** lossless (FLAC, or ALAC converted losslessly to FLAC), at the released bit depth and sample rate. 16/44.1 is the baseline. Hi-res is accepted when genuinely released, never upsampled, and not preferred over a verified CD-quality release.
- **Fallback when no lossless release exists:** lossy at or above MP3 V0/320 CBR, AAC 256 kbps or Opus 192 kbps. Tag it as lossy and keep it eligible for an upgrade. Below that threshold, reject.
- **Authenticity:** a `.flac` extension proves nothing. Before import, check the frequency cutoff with a spectral check (e.g. a lossless-audio-checker tool; **[Unverified]** which tool runs headless in a container). Match the release to MusicBrainz, including track count and durations.
- **Suspect files** (lossy-origin "FLAC", wrong release match): send them to `/data/quarantine/music`, never to the library. Keep any genuine lossy copy as the fallback tier. Notify the admin, with no automatic deletion.
- **Unavailable releases:** leave them monitored in Lidarr with no download. Do not substitute a different edition automatically.

**Derived mobile streams**
- Generated on the fly, not stored.
- Original on LAN/Wi-Fi.
- Opus about 160 kbps on cellular or remote.
- Offline downloads: user choice between Opus and original.

## 5. Owner decisions blocking M1

Only one: **authorizing creation of the Hyper-V Debian VM** as a runtime change on the workstation. The music policy, download sources, request portal and remote-access method block later steps, not M1, because M1 uses synthetic media. Access to the LG webOS TV and to an iPhone is needed for checks 2–4. If either is missing, record that check as not run instead of passing it.

## 6. Start now?

**Yes, start M1 as soon as the owner authorizes the VM.** No technical blocker is known. Remaining risks:
- Hyper-V Debian VM networking for LAN client access, possibly needing an external virtual switch **[Assumption]**.
- Intel QSV stays unverified until the production host arrives.
