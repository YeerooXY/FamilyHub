# FamilyHub

Planning a modular, self-hosted family server for 4–6 users, with a later public FOSS release.

The project integrates existing applications for movies, television, music, files and photos. Optional automatic downloads are included in the proposed architecture.

Read [the architecture review](ARCHITECTURE_REVIEW.md) for the service map, tradeoffs, storage and security boundaries, resource estimates, recovery design and decisions awaiting approval.

The independent [Astra](REVIEW_ASTRA.md) and [Opus](REVIEW_OPUS.md) reviews are complete. Read [their comparison](REVIEW_COMPARISON.md) for agreements, differing recommendations and the proposed simplifications.

Status: the first storage foundation is implemented and verified in the Debian development VM. Jellyfin and Navidrome pass sample playback checks inside the VM and through private localhost access on Windows; TV, phone and recovery checks remain pending. The project license is not yet selected.

See the [storage guide](docs/STORAGE.md) for the storage scripts and development VM helper.

Sample playback (Jellyfin and Navidrome with synthetic fixtures): see [the playback guide](docs/PLAYBACK.md).

Read the [verification record](docs/STORAGE_VERIFICATION.md) for completed checks and remaining limits. Shopping is deferred.

Read the [sample playback verification record](docs/PLAYBACK_VERIFICATION.md) for evidence and remaining checks.

The optional [acquisition guide](docs/ACQUISITION.md) covers the private qBittorrent/Prowlarr foundation and its current automation limits.

The [music import guide](docs/MUSIC_IMPORT.md) covers the deployed Lidarr connections and the remaining matched-album check. The [music intake guide](docs/MUSIC_INTAKE.md) covers YouTube search, source-audio downloads, local files, tagged imports and trimming. Read the [music verification record](docs/MUSIC_VERIFICATION.md) for tested behavior and limits.

The [mobile music interface](docs/MOBILE_MUSIC.md) adds the selected search-list layout and local-file uploads. Its private Tailscale connection is active; HTTPS sign-in, search, generated-audio import and delivery through the music player passed on 11 November 2026. Actual phone and offline playback remain owner checks.

The [native music clients](docs/NATIVE_APPS.md) provide Windows and Android builds with configured-server access, device downloads, playlists and a visible queue. Windows offline playback has been checked after restart. The [private iPhone build and signing guide](docs/IOS_PRIVATE_INSTALL.md) records the remaining macOS build and device checks.

The [Spotify offline audio research](docs/SPOTIFY_OFFLINE_RESEARCH.md) records decryption and license-expiry findings, remaining unknowns and a proposed download-comparison experiment.
