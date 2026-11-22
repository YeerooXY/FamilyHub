# Acquisition

> **17 November 2026:** Lidarr has been removed. qBittorrent and Prowlarr remain as candidates for the planned movie downloads; FamilyHub Music does not use them. Passages about Lidarr and Navidrome describe the earlier setup.

This optional Compose project runs Prowlarr for torrent search, qBittorrent-nox for downloads and Lidarr for music release management. They communicate over Compose's private network. Downloads stay under `/srv/familyhub/data/downloads`, mapped as `/data/downloads`. Lidarr imports to the music library's `Managed` directory through one `/data` mount; see [Music import](history/MUSIC_IMPORT.md) for its permissions, connections and pending real-album acceptance check. No torrent peer ports are published.

The only host ports are loopback WebUIs: qBittorrent on TCP 8080, Prowlarr on TCP 9696 and Lidarr on TCP 8686. For remote administration, use SSH tunnels such as `ssh -L 8080:127.0.0.1:8080 -L 9696:127.0.0.1:9696 -L 8686:127.0.0.1:8686 guest-host`, then open the corresponding `http://127.0.0.1` URLs locally.

Each service stores configuration in its own directory under `/srv/familyhub/appdata` (`qbittorrent`, `prowlarr` and `lidarr`). The appdata parent stays `root:root 0700`; each child is owned by writer UID/GID 2000 and mode 0700. The bootstrap validates all three children before changing any and never changes their contents recursively. qBittorrent keeps its existing `/data/downloads` mount. Prowlarr has only its `/config` mount. All three services use pinned images, `unless-stopped`, `no-new-privileges`, bounded JSON logs, and resource limits.

## Start

After storage bootstrap has created the standard paths and writer account, copy `.env.example` to `.env` if needed, then run as the guest administrator:

```sh
sudo ./scripts/bootstrap-acquisition.sh
sudo runuser -u familyhub-writer -- mkdir -p /srv/familyhub/data/media/music/Managed
docker compose -f compose.acquisition.yaml --env-file .env up -d
```

The bootstrap requires root and validates the appdata path and all three service directories before making changes. It creates or adjusts only those three directories. It does not create the downloads directory; storage bootstrap owns that path. The command above creates the separate music root as the writer role; adjust that path if `FAMILYHUB_DATA` differs from the default.

## First use

Open `http://127.0.0.1:9696` from the guest, or through an SSH tunnel. Complete Prowlarr's first-use setup and keep its native authentication enabled. Choose a unique administrator credential; do not put it in environment files or logs. No indexers are preconfigured. The owner will review and configure public-source catalogues in Prowlarr after this foundation is reviewed.

Open qBittorrent at `http://127.0.0.1:8080`. Its upstream image prints the temporary first-use WebUI password to its container log. Read it locally with `docker compose -f compose.acquisition.yaml --env-file .env logs qbittorrent`, sign in as `admin`, and immediately set a unique password in **Tools > Options > WebUI > Authentication**. Do not copy the temporary password into environment files or publish logs. qBittorrent keeps its native authentication enabled.

In qBittorrent settings, set the default save path to `/data/downloads/complete` and the incomplete path to `/data/downloads/incomplete` before adding torrents. Configure **Settings > Download Clients** in Prowlarr using host `qbittorrent` and internal port `8080`. Verify downloaded files appear under the host downloads directory. This setup does not involve purchases or existing tracker accounts.

**Owner decision, 22 November 2026:** movie and TV acquisition will use public torrent sources, and the owner accepts the legal and ISP risk of downloading content the household may not hold rights to. The sourcing method is scheduled after the Movies interface work. Before any movie or TV download starts, qBittorrent's traffic must go through a paid, P2P-permitting VPN (for example Gluetun with `network_mode: service:gluetun`), with the kill switch confirmed by a test in which the VPN is stopped and qBittorrent has no connectivity. The music intake tool is unaffected.

## Scope and limits

This foundation provides manual public-source search and download. Prowlarr manages and searches indexers; the indexers determine catalogue coverage and availability. Lidarr is connected for music, with interactive search enabled and automatic search and RSS disabled. Its complete matched-album import flow still needs a real-album test. Downloads outside that workflow need a separate import step. Radarr, Bazarr, movie/TV import automation and a family request interface remain unimplemented. Inbound peer connectivity is unavailable until a separately reviewed network change.

For YouTube audio, local files and trimming, use the administrator [music intake tool](MUSIC_INTAKE.md). Its tagged imports go into `Local Imports`, alongside Lidarr's `Managed` directory, and Navidrome scans both.

## Upstream references

- [LinuxServer Prowlarr container documentation](https://docs.linuxserver.io/images/docker-prowlarr/)
- [qBittorrent-nox container documentation](https://github.com/qbittorrent/docker-qbittorrent-nox)
- [qBittorrent image package and published digests](https://github.com/qbittorrent/docker-qbittorrent-nox/pkgs/container/docker-qbittorrent-nox)

## Development verification

Both pinned services were deployed in the Debian VM on 8 November 2026. Application processes run as writer UID 2000; their container init helpers retain root. Bootstrap syntax, Compose rendering, repeated bootstrap runs, symlink rejection before sibling changes, and rejection of non-root invocation passed. Unauthenticated API requests returned HTTP 403 for qBittorrent and HTTP 401 for Prowlarr. Prowlarr forms authentication is required and its analytics setting is disabled. No public admin endpoint was configured.

The temporary qBittorrent password was replaced. New Windows copies of the two acquisition passwords use DPAPI encryption in the ignored, restricted `.local/playback/` directory. Native app configuration and database secrets still need appdata protection and encrypted backups; DPAPI does not encrypt the applications' Linux data. Existing playback test credential JSON remains a separate development limitation.

Prowlarr's native qBittorrent connection test passed. Public indexer configuration lives only in this private VM, not in Compose templates or Git. A 792,723,456-byte Debian installer torrent completed from real peers; SHA-512 matched the HTTPS mirror checksum. File ownership was 2000:2000, mode 0660, under the completed-download path. Credentials and save-path configuration survived a qBittorrent restart; Jellyfin and Navidrome health checks remained HTTP 200. These checks establish the search/download foundation, not automated media selection and library import.

The workstation qBittorrent SSH tunnel uses `127.0.0.1:8080`, matching the guest port. A different forwarded port triggered its Host-header check. Keep native authentication and Host-header checks enabled. Current SSH tunnels are development processes and do not automatically recover after a workstation reboot. Tailscale private app access does not change the torrent client's outbound route or hide it from torrent peers.

On 10 November 2026, Lidarr was added and its native connections and hardlink permissions passed. The music intake tool passed generated-track import and Navidrome original-byte playback, plus a Creative Commons YouTube audio download. See [Music verification](history/MUSIC_VERIFICATION.md) for evidence and limits.

Next acceptance check: a real MusicBrainz-matched album through Lidarr, including identity, track list, unchanged source bytes and player scan. Automatic lossy fallback remains an owner decision; the intake tool accepts a specifically selected YouTube URL and records its lossy origin. Larger bit depth or sample rate alone does not establish better source quality. Movie matching must check the actual Hungarian/English streams and Hungarian subtitle track; the presence of the film title in search is insufficient.
