# Movies & TV

FamilyHub provides the profile picker, catalogue and player controls. Jellyfin owns the media library, playback negotiation, watched state and resume position. The phone and desktop contact Jellyfin directly for movie bytes. A Jellyfin outage can affect Movies independently of music.

## Connect a profile

1. Start the existing Jellyfin service on the Debian guest. Give each viewer a separate ordinary Jellyfin account with access to the movie and TV libraries. The projector should use the same viewer account as the phone.
2. Make Jellyfin available at a private HTTPS address reachable from the family devices. Forward the complete Jellyfin URL space, including video segments and subtitle requests. Check cross-origin access from the app WebView. Exclude credentials and query strings from request logs.
3. Configure the following keys in the private FamilyHub server configuration. Keep this file readable only by the administrator and service account. The mapping key is the stable FamilyHub profile ID. The example values below are placeholders.

   ```json
   {
     "JELLYFIN_INTERNAL_URL": "http://127.0.0.1:8096",
     "JELLYFIN_PUBLIC_URL": "https://movies.example.test",
     "JELLYFIN_PROFILES": {
       "family-profile-id": {"username": "movie-viewer", "password": "<Jellyfin account password>"}
     }
   }
   ```

4. Restart FamilyHub and reconnect the updated app. Linked profiles get **Movies & TV** in the desktop sidebar or phone navigation bar. FamilyHub uses the selected profile to open a regular Jellyfin session. The password stays on the server. The client keeps its playback token in memory and signs out when the screen closes.
5. Play a feature-length title, pause, and resume on another device. Switch profiles and verify separate progress. Try Hungarian and English audio and subtitles, real 4K material on the projector, and music playback on a second device. The development library has short fixtures which may fall below Jellyfin's resume threshold.

## Expansion order

| Stage | Ownership and acceptance |
| --- | --- |
| Playback and languages | Ship browsing, playback and resume first. Use embedded tracks immediately. Save interface language, preferred audio and preferred subtitles separately per viewer. Fall back to the original audio when a dub is missing. Test text and image subtitles on the projector because burning subtitles into a video can require transcoding. |
| Title requests | Place a **Request** action on titles absent from the library. Integrate Seerr as the request system. Two profiles requesting the same movie or episode should see one request and both receive availability updates. Identify a film by provider and ID, an episode by series ID, season and episode. Keep recommendations separate from consent to download. |
| Automatic acquisition | Add Radarr as the movie importer and Sonarr as the TV importer. Prowlarr supplies configured indexers and qBittorrent transfers files. Use separate movie and TV categories. Give the importers one filesystem mount containing downloads and the final libraries, so completed files can be hardlinked or atomically moved. Jellyfin keeps read-only media mounts. Start with one film and one episode from an approved source, then verify retry after a service restart and one visible copy after import. |
| Scheduling | Accept requests at any hour. Start with one background transfer, a disk-space reserve, and heavier imports and scans overnight in Europe/Budapest. Measure playback start, seeking, rebuffering, disk latency and free space under load before increasing concurrency. Playback and music controls must stay responsive when acquisition is stopped or unavailable. |
| Subtitle acquisition | If the embedded tracks leave gaps, add Bazarr. Configure Hungarian and English subtitle profiles, retain existing tracks, and test timing against the actual edition. |
| Discovery, statistics and comments | Start recommendations with unwatched titles already available and explicit genre preferences. Track deduplicated watch sessions per profile for family statistics. Store comments in FamilyHub keyed to a stable title or episode ID, with author, timestamp and spoiler visibility. A media rescan or file upgrade should preserve comments and statistics. |

The existing acquisition Compose file also defines the historical Lidarr service. When testing movie downloads, select only the intended services explicitly. Keep download configuration, queues and credentials outside the music intake worker.

Sources: [Jellyfin codec and subtitle support](https://jellyfin.org/docs/general/clients/codec-support/), [Seerr](https://docs.seerr.dev/), [Radarr](https://radarr.video/), [Sonarr](https://sonarr.tv/) and [Bazarr](https://www.bazarr.media/).
