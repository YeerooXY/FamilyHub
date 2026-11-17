# Music import

Lidarr joins the optional acquisition project as the music release manager. It asks Prowlarr's indexers for album releases, sends the chosen torrent to qBittorrent, and imports the completed files into the music library that Navidrome already reads.

## Status

| Item | State |
| --- | --- |
| Bootstrap creates `appdata/lidarr` | Run in the development VM; owner 2000:2000 and mode 0700 verified |
| Lidarr service | Deployed version 3.1.6.5079, pinned to registry digest `sha256:d5707cfe084da21a3864c7ef0edd9c0543b5e26c79c551f84dad5ef8683af8c7` |
| `Managed` root directory | Created as the writer role and accepted by Lidarr; separate from `Local Imports` |
| Connections and permissions | Native qBittorrent and Prowlarr application tests passed; one compatible music indexer synced and passed its test; writer hardlink check passed |
| Matched-album workflow | Pending a suitable real album. No real album was acquired or imported by Lidarr in this milestone |

Verified 10 November 2026. See [the verification record](MUSIC_VERIFICATION.md). Forms authentication is required for all addresses, analytics is disabled, artists remain unmonitored, and synced music indexers allow interactive search only. These settings survived container recreation.

## Service design

The service follows the qBittorrent and Prowlarr conventions in `compose.acquisition.yaml`: pinned image, `restart: unless-stopped`, `no-new-privileges`, JSON logs capped at 10 MiB with three files, `mem_limit: 1g`, `cpus: 1.0`, `PUID`/`PGID` from `FAMILYHUB_WRITER_ID` (2000) and `HOME: /config`.

| Setting | Value |
| --- | --- |
| WebUI | `127.0.0.1:8686:8686/tcp`, guest loopback only |
| Config | `${FAMILYHUB_APPDATA}/lidarr:/config`, owner 2000:2000, mode 0700 |
| Data | `${FAMILYHUB_DATA}:/data`, one mount |
| Lidarr root folder | `/data/media/music/Managed` |
| Navidrome library | `/data/media/music`, which holds `Managed` and `Local Imports` |
| Completed downloads | `/data/downloads/complete` |

The repository holds no Lidarr credential, API key or indexer setting. Lidarr reaches qBittorrent and Prowlarr over the Compose project's private network. Reach the WebUI from the workstation with `ssh -L 8686:127.0.0.1:8686 guest-host`.

### Why one `/data` mount

A hardlink needs both names inside one mount. Two bind mounts of `downloads` and `media/music` sit on the same disk, yet the kernel rejects a link between them with `EXDEV`, and Lidarr then copies the album. A copy doubles the disk use for every seeded album.

`downloads/complete` and `media/music/Managed` have `FAMILYHUB_DATA` as their only common parent, so that directory is the smallest mount that allows hardlinks. qBittorrent sees the same files at the same `/data/downloads` path, so Lidarr needs no remote path mapping.

Tradeoff: Lidarr runs as writer 2000 and can read and write everything under `FAMILYHUB_DATA`. Today that covers `downloads`, `media/movies`, `media/tv`, `media/music` and `quarantine`. Controls:

- Configure exactly one Lidarr root folder, `/data/media/music/Managed`. Lidarr writes library files only under a root folder, so `Local Imports` and the rest of `media/music` sit outside it.
- Private family folders already live outside `FAMILYHUB_DATA`, in their own root that the writer role cannot access, as `appdata` and `databases` do. Keep family files and photos there. Anything later placed under `FAMILYHUB_DATA` is visible to Lidarr.
- qBittorrent keeps its `downloads` mount and Prowlarr keeps only `/config`. Neither mount changes.
- Masking sibling directories with empty overlays was rejected. It lists what to hide, so a new directory is exposed until someone adds it.

Appdata stays a separate mount outside `/data`.

### Permissions and tags on hardlinked files

A hardlink is a second name for one inode. Owner, mode, ACL and bytes are shared between `downloads/complete` and `media/music`.

- **Reader access.** The file keeps the ACL it inherited when qBittorrent created it in `downloads/complete`. Storage bootstrap gives every data directory the same default ACL, so the reader role (2001) can read the imported file. Album and artist directories that Lidarr creates inherit the default ACL of `media/music`. Leave **Settings > Media Management > Set Permissions** off; a `chmod` from Lidarr rewrites the ACL mask.
- **Tags.** Keep **Settings > Metadata > Tag Audio Files with Metadata** at **Never**. A tag write to a hardlinked file changes the torrent's copy too. The torrent then fails its piece check and the original bytes are gone. If a tagging tool instead writes a new file and renames it over the old one, the link is broken and the album occupies the disk twice. Which of the two Lidarr does is unverified here; both are avoided by **Never**.
- **Renames.** Renaming or moving the library name leaves the download name and the bytes untouched.

## Deploy

After storage bootstrap, and once the service block carries a verified digest:

```sh
sudo ./scripts/bootstrap-acquisition.sh
sudo runuser -u familyhub-writer -- mkdir -p /srv/familyhub/data/media/music/Managed
docker compose -f compose.acquisition.yaml --env-file .env up -d
```

The bootstrap validates the appdata path and all three service directories (`qbittorrent`, `prowlarr`, `lidarr`) before it changes any of them.

## Configure

1. **Authentication.** Open `http://127.0.0.1:8686`. Set authentication to **Forms** and required for all addresses, with a unique administrator credential. Keep it out of environment files, Git and logs. Disable analytics.
2. **Root folder.** Add `/data/media/music/Managed` as the only root folder. Set the default monitor option to **None**.
3. **Media management.** Keep **Use Hardlinks instead of Copy** on. Keep tagging at **Never** and **Set Permissions** off.
4. **Quality profile.** Create a lossless-only profile with no lossy fallback.
5. **Download client.** Add qBittorrent with host `qbittorrent`, port `8080`, and category `lidarr-music`. The category is used by nothing else, so Lidarr handles only its own downloads. Keep completed download handling on; this is Lidarr's native import path.
6. **Indexers.** In Prowlarr, open **Settings > Apps** and add Lidarr with Prowlarr server `http://prowlarr:9696`, Lidarr server `http://lidarr:8686` and Lidarr's API key. Use **Add and Remove Only** sync so Lidarr's manual-search settings remain local. Prowlarr syncs compatible indexers; verify RSS and automatic search are off after each new indexer is added. Keep keys in native configuration and private state, outside Git and logs.
7. **Start state.** Add each artist with **Monitor: None** and leave **Start search for missing albums** unticked. Leave RSS sync and automatic search disabled on the synced indexers until the acceptance checks pass. Request albums one at a time with an interactive search.

## Audio policy

Two questions stay separate, and Lidarr answers neither completely.

- **Original versus derived audio.** The library keeps the exact bytes that were downloaded. Lidarr does not transcode, and with tagging at **Never** it does not rewrite files. Any transcode, retag or edit is a derived file and needs its own decision and location.
- **Source authenticity.** A lossless container does not prove a lossless source. A FLAC made from an MP3, or an upsampled file with a higher sample rate, passes every Lidarr quality check. Lidarr reads the release name and file format; it does not analyse the audio. Authenticity needs a separate inspection step.

## Other intake

Lidarr works with MusicBrainz release groups: albums, EPs and singles. YouTube rips, single tracks without a release, local recordings and edited audio do not fit that model. They go through the separate, reviewed [music intake](../MUSIC_INTAKE.md) tool, which writes tagged copies under `/data/media/music/Local Imports`, outside Lidarr's root folder. Navidrome reads both.

## Acceptance checks

The verified connection and permission checks are recorded below. Real-album checks remain pending.

Synthetic plumbing tests use generated or placeholder files. They show that paths, permissions and connections work. They do not show that Lidarr can match a real release. Real matching tests need an actual album that exists in MusicBrainz.

| # | Check | Kind | Pass condition | Result |
| --- | --- | --- | --- | --- |
| 1 | Bootstrap | Plumbing | Syntax and private-directory ownership/mode are correct | Passed; the earlier validate-before-mutation logic is reused, and its negative cases were not rerun in this milestone |
| 2 | Compose | Plumbing | Compose validates and the pinned digest matches the registry | Passed on Windows and Debian |
| 3 | Health | Plumbing | Authenticated system status reports the running version; application UID is 2000; port 8686 is guest-loopback only | Passed; container init helpers retain root |
| 4 | Authentication | Plumbing | `GET /api/v1/system/status` without a key returns HTTP 401 | Passed |
| 5 | Downloader | Plumbing | Lidarr's qBittorrent **Test** passes with host `qbittorrent:8080` | Passed |
| 6 | Indexers | Plumbing | Prowlarr's Lidarr app and compatible synced music indexers pass native connection tests | Passed; one compatible music indexer |
| 7 | Hardlink path | Plumbing | Writer UID 2000 links a throwaway download into `Managed`; device/inode match and link count is 2 | Passed; only the generated test files were removed |
| 8 | Matched album import | Real matching | One real lossless album, requested by interactive search, downloads under category `lidarr-music` and imports to `/data/media/music/Managed/<artist>/<album>` matched to the intended MusicBrainz release and track list | Pending |
| 9 | Same inode | Real | `stat -c '%d %i %h'` matches for a downloaded track and its library name, with link count 2 | Pending |
| 10 | Original bytes | Real | SHA-256 of the library file equals the downloaded file; the torrent passes a forced recheck at 100% after import | Pending |
| 11 | No repeated import | Real | The queue item clears; a second completed-download scan and a Lidarr restart add no second copy, no duplicate track file and no new grab | Pending |
| 12 | Reader access | Real | UID 2001 reads the imported track; `nobody` cannot | Pending |
| 13 | Navidrome scan | Real | After a scan, the album appears once in Navidrome with the correct artist, title and track order | Pending |
| 14 | Original-byte playback | Real | Navidrome's raw stream of one track (`format=raw`) has the same SHA-256 as the library file | Pending |
| 15 | Existing services | Plumbing | Existing service authentication/health checks and sample playback verification pass | Passed; 21 playback verification checks passed |

Check 7 proves the mount layout only. Checks 8 to 14 need a real album; a generated sample file has no MusicBrainz release and cannot stand in for it.

## References

- [LinuxServer Lidarr container documentation](https://docs.linuxserver.io/images/docker-lidarr/)
- [Lidarr quick start guide](https://github.com/Servarr/Wiki/blob/master/lidarr/quick-start-guide.md)
- [Acquisition foundation](../ACQUISITION.md) and its [verification record](ACQUISITION_VERIFICATION.md)
- [Storage foundation](../STORAGE.md)
