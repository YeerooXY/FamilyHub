# FamilyHub client core

Portable .NET 10 library for the Windows, Android and iPhone hosts. It uses the existing FamilyHub cookie login and CSRF protection. It contains no UI, player, passwords on disk or platform dependencies.

```csharp
using var api = new FamilyHubApi(new Uri("https://your-server:8444/"));
await api.LoginAsync(username, password, cancellationToken);
var offline = new OfflineLibrary(appDataDirectory, api.ServerOrigin, username);
var songs = await api.GetLibraryAsync(cancellationToken);
await offline.SaveLibraryAsync(songs, cancellationToken);
var file = await offline.DownloadAsync(songs[0], api, cancellationToken, progress);
// On a later launch without a server connection:
var cached = await offline.GetLibraryAsync(cancellationToken);
var localFile = offline.GetDownloadedPath(cached[0].Id);
```

The host stores credentials in platform secure storage and supplies them again after a server session expires. `CreateMediaRequest(path)` supplies the configured-server URI and session cookie for a saved recording. The native player must keep those headers on that origin; the server download endpoint does not redirect. `FamilyHubApi` follows its own redirects only after origin validation. An injected test handler must disable automatic redirects and cookie handling.

`MusicPlaylist` and `PlaylistTrack` retain server order and duplicates. Create/update/delete use server revisions; a 409 raises `FamilyHubApiException`. Offline playlist snapshots can be read without authentication. This layer does not queue offline playlist edits.

Downloads are isolated by normalized server origin and case-sensitive username. Source identifiers and content hashes determine filenames, so case-sensitive song IDs remain distinct on Windows. Metadata and full audio publish atomically; incomplete files never appear in `ListDownloadsAsync`. Interrupted downloads retain hash-specific partial bytes, use Range and If-Range to resume, and verify full size and SHA-256 before publication. Allowed audio extensions are m4a, mp3, flac, wav, ogg, opus, webm, aac and mp4. The maximum recording size is 2 GiB. Native codec support is the host's responsibility.

`GetDownloadedPath` checks the persisted metadata and file size without contacting the server. `DownloadAsync` rechecks a completed file's full hash before reusing it. Removing a recording clears its complete files, metadata and partials. Cached metadata uses atomic replacement; malformed or missing cache JSON returns an empty collection.

Run `dotnet run --project clients/FamilyHub.Client.Core.Tests` from the repository root. The assertion harness covers session cookies, CSRF, HTTPS/origin boundaries, metadata requests, exact resume ranges, hash rejection, cancellation, offline reconstruction, duplicate playlist entries, account/server isolation, case-sensitive identifiers and genre filtering. It uses fixture transports and audio bytes, not a live server or a native decoder.
