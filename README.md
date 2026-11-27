# FamilyHub

A self-hosted server for one family: music today, movies and file sharing next.

## What runs today: FamilyHub Music

A private music service for the family, with apps for Windows, Android and iPhone.

- **Server** (`music_web/`): a Flask app on the family's Debian server, reached over a private Tailscale connection. It stores the library, finds and downloads songs (YouTube search, uploads, playlist links from Spotify, YouTube, Deezer and SoundCloud), cleans and levels the audio, measures BPM and key, and serves playback and downloads.
- **Apps** (`clients/`): one .NET MAUI Blazor app for Windows, Android and iPhone. Family profiles without passwords, playlists with collaborators, offline downloads, crossfade, song radio, remote control between devices, Listen Together, stats and a song review for the administrator.

Guides:

- [Native apps](docs/NATIVE_APPS.md): building, installing and updating the apps.
- [Private iPhone installation](docs/IOS_PRIVATE_INSTALL.md): the unsigned build and how to install it.
- [Music server](docs/MOBILE_MUSIC.md): configuration and the server API.
- [Music intake](docs/MUSIC_INTAKE.md): the administrator's command line for downloads, local files and trimming.
- [Windows app](docs/DESKTOP_MUSIC.md) and the [shared effects package](docs/SHARED_EFFECTS.md).

Releases are on the [GitHub releases page](https://github.com/YeerooXY/FamilyHub/releases). `scripts/publish-native-release.ps1` packages the apps, publishes the release and updates the server; `scripts/deploy-native-updates.py` installs the server code.

## Planned

- **Movies and TV for the whole family.** Jellyfin (`compose.playback.yaml`) is the watching platform and already runs. The download source and method are still open; qBittorrent and Prowlarr (`compose.acquisition.yaml`) are configured as candidates, and a VPN would be needed for torrenting. Setup: [playback](docs/PLAYBACK.md) and [acquisition](docs/ACQUISITION.md).
- **File storage and sharing** (the family's own Nextcloud-style drive): the server side exists and is tested; the app screen comes next. See [Files](docs/FILES.md).

## Server foundation

The [storage guide](docs/STORAGE.md) covers the disk layout, permissions and the development VM helper that everything above runs on.

The family server machine runs Debian 13. [New server: first steps](docs/NEW_SERVER.md) prepares it for remote setup.

## Development

- Server tests: `python -m unittest discover -s tests`
- App checks: `dotnet run --project clients/FamilyHub.Client.Core.Tests` and `dotnet run --project clients/FamilyHub.Player.Tests`
- Windows build: `dotnet build clients/FamilyHub.App -f net10.0-windows10.0.19041.0`

## Attribution

**TMDB**. Film data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.

## History

Earlier planning reviews, dated verification records and research notes are in [docs/history](docs/history/). They describe the setup at the time they were written: Navidrome and Lidarr were part of it then and have since been removed.

The project license is not yet selected.
