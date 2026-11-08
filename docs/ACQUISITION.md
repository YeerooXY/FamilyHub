# Acquisition

This optional Compose project runs Prowlarr for torrent search and qBittorrent-nox for downloads. Prowlarr and qBittorrent share Compose's private network so Prowlarr can connect to qBittorrent. The project has no library mounts, media import or rename workflow, or published torrent peer ports. Downloads stay under `/srv/familyhub/data/downloads`, mapped in the container as `/data/downloads`.

The only host ports are loopback WebUIs: qBittorrent on TCP 8080 and Prowlarr on TCP 9696. For remote administration, use SSH tunnels such as `ssh -L 8080:127.0.0.1:8080 -L 9696:127.0.0.1:9696 guest-host`, then open the corresponding `http://127.0.0.1` URLs locally.

Each service stores configuration in its own directory under `/srv/familyhub/appdata` (`qbittorrent` and `prowlarr`). The appdata parent stays `root:root 0700`; each child is owned by writer UID/GID 2000 and mode 0700. The bootstrap validates both children before changing either and never changes their contents recursively. qBittorrent keeps its existing `/data/downloads` mount. Prowlarr has only its `/config` mount. Both services use pinned images, `unless-stopped`, `no-new-privileges`, bounded JSON logs, and resource limits.

## Start

After storage bootstrap has created the standard paths and writer account, copy `.env.example` to `.env` if needed, then run as the guest administrator:

```sh
sudo ./scripts/bootstrap-acquisition.sh
docker compose -f compose.acquisition.yaml --env-file .env up -d
```

The bootstrap requires root and validates the appdata path and both service directories before making changes. It creates or adjusts only those two directories. It does not create the downloads directory; storage bootstrap owns that path.

## First use

Open `http://127.0.0.1:9696` from the guest, or through an SSH tunnel. Complete Prowlarr's first-use setup and keep its native authentication enabled. Choose a unique administrator credential; do not put it in environment files or logs. No indexers are preconfigured. The owner will review and configure public-source catalogues in Prowlarr after this foundation is reviewed.

Open qBittorrent at `http://127.0.0.1:8080`. Its upstream image prints the temporary first-use WebUI password to its container log. Read it locally with `docker compose -f compose.acquisition.yaml --env-file .env logs qbittorrent`, sign in as `admin`, and immediately set a unique password in **Tools > Options > WebUI > Authentication**. Do not copy the temporary password into environment files or publish logs. qBittorrent keeps its native authentication enabled.

In qBittorrent settings, set the default save path to `/data/downloads/complete` and the incomplete path to `/data/downloads/incomplete` before adding torrents. Configure **Settings > Download Clients** in Prowlarr using host `qbittorrent` and internal port `8080`. Verify downloaded files appear under the host downloads directory. Use public sources and content you are authorized to acquire; this setup does not involve purchases or existing tracker accounts.

## Scope and limits

This foundation provides manual public-source search and download. Prowlarr is an indexer manager and search interface, not a content host. Public catalogue availability and indexing quality vary; music coverage and language availability are not guaranteed. No Radarr, Lidarr, Bazarr, automatic import, library rename workflow, or request interface is included. Downloads do not appear in Jellyfin or Navidrome libraries automatically. Inbound peer connectivity is unavailable until a separately reviewed network change.

## Upstream references

- [LinuxServer Prowlarr container documentation](https://docs.linuxserver.io/images/docker-prowlarr/)
- [qBittorrent-nox container documentation](https://github.com/qbittorrent/docker-qbittorrent-nox)
- [qBittorrent image package and published digests](https://github.com/qbittorrent/docker-qbittorrent-nox/pkgs/container/docker-qbittorrent-nox)

## Development verification

Both pinned services were deployed in the Debian VM on 8 November 2026. Application processes run as writer UID 2000; their container init helpers retain root. Bootstrap syntax, Compose rendering, repeated bootstrap runs, symlink rejection before sibling changes, and rejection of non-root invocation passed. Unauthenticated API requests returned HTTP 403 for qBittorrent and HTTP 401 for Prowlarr. Prowlarr forms authentication is required and its analytics setting is disabled. No public admin endpoint was configured.

The temporary qBittorrent password was replaced. New Windows copies of the two acquisition passwords use DPAPI encryption in the ignored, restricted `.local/playback/` directory. Native app configuration and database secrets still need appdata protection and encrypted backups; DPAPI does not encrypt the applications' Linux data. Existing playback test credential JSON remains a separate development limitation.

Prowlarr's native qBittorrent connection test passed. Public indexer configuration lives only in this private VM, not in Compose templates or Git. A 792,723,456-byte Debian installer torrent completed from real peers; SHA-512 matched the HTTPS mirror checksum. File ownership was 2000:2000, mode 0660, under the completed-download path. Credentials and save-path configuration survived a qBittorrent restart; Jellyfin and Navidrome health checks remained HTTP 200. These checks establish the search/download foundation, not automated media selection and library import.

The workstation qBittorrent SSH tunnel uses `127.0.0.1:8080`, matching the guest port. A different forwarded port triggered its Host-header check. Keep native authentication and Host-header checks enabled. Current SSH tunnels are development processes and do not automatically recover after a workstation reboot. Tailscale private app access does not change the torrent client's outbound route or hide it from torrent peers.

Next integration: release identity/quality management, media probing, library imports and player scans. Music requests should reject lossy fallback and suspicious upsampled labels. Larger bit depth or sample rate alone does not establish better source quality. Movie matching must check the actual Hungarian/English streams and Hungarian subtitle track; the presence of the film title in search is insufficient.
