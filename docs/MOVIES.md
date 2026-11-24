# Movies & TV

FamilyHub provides the profile picker, catalogue and player controls. Jellyfin owns the media library, playback negotiation, watched state and resume position. The apps request movie data and streaming media through FamilyHub. A Jellyfin outage can affect Movies independently of music.

## Add audio track

Administrators on the movie downloads allowlist can open **Add audio track** from a title’s details or the player’s **Audio** menu. Select an audio stream from a completed download or a file in `/srv/familyhub/data/imports`. Hungarian is selected by default. For a season, choose a folder with files named using `SxxEyy`. **On the server** shows the batch and each episode’s result.

The matcher samples the English tracks at five points and reports the timing adjustment, speed and confidence. For a source without English audio, it compares changes in volume and reports lower confidence. The worker uses NumPy FFT when available and a standard-library FFT otherwise. It requires FFmpeg and FFprobe on the server.

The worker writes an audio-only Matroska sidecar in the movie or TV folder with a name such as `In Time.hu.mka` and the language tag `hun`. Jellyfin 12 detected the sidecar as an external stream after a single-item refresh in the owner’s 23 November test. FamilyHub requests that refresh through the active Jellyfin viewer session. If the request is refused or the session ends, the job shows that the track was saved and needs a refresh in Jellyfin.

The player lists external tracks as **Hungarian, added** and applies the saved audio language preference. **Sync** changes the timing of an active external track by 100 ms and remembers the adjustment for the title on this device. The adjustment uses a second media clock and may use additional bandwidth. Listen to the result before choosing **Delete source file**. FamilyHub probes the sidecar again before deleting the original source.

The web service needs `STATE_DIR` and writer access to the movie and TV folders. Use the media writer UID and group so the web service can create sidecars with the same owner and group as the video. Source deletion requires write access to the source folder. For systemd units running with `ProtectSystem=strict`, allow writes to those specific folders through `ReadWritePaths=`. Jellyfin uses its existing read-only library mounts.

## Release scope (22 November 2026)

This release ships **playback only**: browsing, playback, resume, audio and subtitle switching, and a separate Jellyfin account per profile. Titles come from files the administrator places in the movie and TV libraries. Requests, automatic acquisition, scheduling, subtitle downloads, recommendations, statistics and comments are not part of it.

| Verified (development VM, Chromium) | Not yet verified |
| --- | --- |
| 1080p sample plays and advances. Audio switches with the position kept. Two Hungarian WebVTT cues load. | Phone and projector playback on physical devices. |
| A 90-minute fixture resumes at 20:00 from two sessions, and a second profile starts at the beginning. | Real 4K and HDR material. The 4K fixture runs at 5 fps. |
| Regular accounts connect. Admin accounts and unlinked profiles are rejected. | Hungarian and English audio and subtitles on real files. |
| Library search finds a film and an episode. Keyboard focus returns to the selected title. | Hardware transcoding. The Jellyfin container has no GPU device mapping. |
| | Network recovery, screen-reader output, enlarged text and the installed app's visuals. |

Resource limits are also not enforced. The priority rules in [New server](NEW_SERVER.md) are a proposal, so a large upload or import can compete with a movie for the disk. Run that document's acceptance run before opening Movies to simultaneous viewers.

**Two languages (23 November 2026, live on the development VM, Chromium).** "Tears of Steel (2012)", a Blender Foundation film under CC BY 3.0, sits in the movie library as an MKV with an English audio track, a second audio track tagged Hungarian, an embedded English subtitle and a Hungarian sidecar `.hu.srt`. The second audio track uses the film's music-and-effects mix to test audio switching. Both audio tracks list with their titles. Switching at 2:00 keeps the position. Each subtitle language shows its own 78 or 76 cues. Turning subtitles off clears the cues. The Hungarian cues show decoded characters. Real Hungarian dubs, image subtitles and phone playback remained unverified in that test. The VM had 15 GB free.

The next release-gating checks are one real feature film on a phone and on the projector, with Direct Play first and Quick Sync second.

## iPhone and television (22 November 2026 review)

**iPhone.** The movie UI is plain web code inside the MAUI web view, so the iOS app will show it once an IPA exists. The player is a page layout and does not use the Fullscreen API, which iPhone Safari does not offer for ordinary elements. The video is inline (`playsinline`), so iOS does not take it into its own player, and the page uses the safe-area insets. WebKit passes the movie tests on an emulated iPhone 13, but that is not iOS. Unverified on a real iPhone: subtitle cues drawn on a video without native controls, HLS from Jellyfin through the web view, and touch scrubbing. No IPA is built yet; see [Private iPhone installation](IOS_PRIVATE_INSTALL.md).

**LG television (webOS).** The MAUI app does not run on webOS. A webOS app is a packaged or hosted web page installed through Developer Mode and the `ares` tools; apps installed this way are removed when the Developer Mode session expires and need renewing in the TV's Developer Mode app (LG's current guide gives 1000 hours; older reports say 50). The movie client is already web code, but it needs a standalone page with a profile picker and the FamilyHub session, which does not exist yet. The Jellyfin address must be HTTPS and reachable from the TV's network.

The TV's browser engine decides what the current code supports: `:is()` and `aspect-ratio` need Chromium 88, and `AbortSignal.timeout` (now replaced) needed 103. By LG's published table webOS 22 ships Chromium 87, webOS 23 ships 94 and webOS 24 ships 108. A webOS 22 or older set needs some CSS rewritten; webOS 23 and newer should work. Check the TV's webOS version in Settings first.

**Decision (23 November 2026).** The owner's television is an LG UM7610PLB (2018, webOS 4.x, an old Chromium), which cannot run the current movie client. The television plan is an Android TV or Fire TV stick running the Android app. Unverified until the stick is on hand: remote navigation, Back, and the player at 1920 px. Android Back closes an open sheet first, then the player. On Android the player turns the screen to landscape (both directions, following the sensor) and hides the system bars; this is unverified on a real phone until 0.1.89 is installed.

Subtitles are drawn by the player, not the browser: just above the picture's bottom edge (so upright phones show them under the picture, not at the screen bottom), lifted above the seek bar while the controls show, with YouTube's ">>" speaker marks removed. The player has a back arrow at the top left next to the close button. On iPhone the status bar hides while a film plays (unverified on a device).

The remote works through the arrow keys: they move between cards, shelves, the billboard and the player controls, Enter selects, and the Back key (key code 461) closes the player. The pointer ("magic") remote also works. Not yet tested on a television.

## Search and watch

Search once in **Movies & TV**. Exact library matches offer **Play** or **Resume**. If there is no exact match, Movies checks YouTube, the configured release indexers, and Seerr for profiles with access. When Seerr supplies a distinct Hungarian title, Movies searches both names. The search results show the film or season length when available. YouTube cards compare video duration with the catalog length. Release cards show file size, length, and estimated download time, with an always-visible **Quality guide** above the list. [Release search setup](ACQUISITION.md#release-search)

- **Ranking.** With `GEMINI_API_KEY` in the server configuration (a free Google AI Studio key; the model is `MOVIE_SEARCH_MODEL`, default `gemini-flash-latest`), one Gemini call ranks the candidates and gives a short reason. The call carries the film title plus each candidate's title, channel and length; no profile name or other personal data. Without a key, or when the call fails, a fixed rule ranks them (title words, film-length video, trailer and clip words).
- **Safety.** The model only picks from the returned candidates: a link or label it invents is dropped, reasons are stripped of URLs, and the app opens only `https://www.youtube.com/watch?v=<id>` links. Web text is passed as data, with an instruction to ignore commands inside it.
- **Limits and logs.** Six searches a minute and forty an hour per profile. The activity log records the count and the ranking method, never the search text.
- **Needs** `yt-dlp` on the server's PATH. If YouTube lookup fails, the search offers a source-specific retry.
## Request a movie or series

Match the title and year in **Download options**, then choose **Request download**, **Request all seasons**, or **Request season 2** for a numbered season search. An all-seasons request covers seasons listed in Seerr at the time of the request, excluding specials. Run the same search later to check availability. Completed imports appear in the Jellyfin library after it scans the files.

FamilyHub passes the selected title's TMDB ID and season scope to Seerr. After approval, Radarr or Sonarr selects a release using the configured sources and quality profiles. Release details in FamilyHub help compare options and do not select the download. [Set up media requests](ACQUISITION.md#enable-movie-and-tv-requests).

## Next release — downloads and seeding

The release scope includes the read-only search panel. Enable downloads for the test profiles after the VPN kill switch and the full import flow pass. The download, progress, notification and cleanup behavior below is proposed for that release.

1. **Find the title.** Match movies by provider ID and year. For TV, choose a season or specific episodes. Verify the match before opening the release list, so a similarly named series or a season pack cannot silently broaden the request.
2. **Choose a release.** Show resolution, source format, size, indexer, seeders, leechers, audio and subtitle signals, and the upload needed for a 2.0 share ratio. Keep source labels separate from tracks verified after import. Rank eligible releases by language preference and quality within the estimated upload-time budget. Prefer seeded native 1080p or higher, then a smaller eligible version if the higher quality exceeds the budget. Collapse duplicates when the torrent identity matches, and keep a manual choice available. The time estimate assumes the specified sustained upload rate and can increase when few peers request pieces.
3. **Download.** The server checks VPN health, free disk space and available transfer slots before queueing, then rechecks before starting. Radarr or Sonarr owns the title or episode match and import. qBittorrent owns the transfer and actual share ratio. Keep the request visible across restarts and reuse the same job when an authorized user retries.
4. **Show progress and availability.** The requesting profile sees Queued, Downloading (bytes, percentage, speed and ETA when available), Importing, Ready, and Seeding (uploaded bytes and ratio), with a reason and retry where appropriate. Jellyfin playback can start after import while seeding continues. Notify the requester in FamilyHub once Jellyfin confirms the title can play. Show verified audio and subtitle tracks and allow Bazarr to fill missing Hungarian and English subtitles when configured.
5. **Protect playback and storage.** Keep interactive playback and family actions ahead of background media acquisition. Start with one active acquisition, throttle acquisition and seeding when playback needs bandwidth, and reserve free disk space before accepting more work. Verify those limits on the host before enabling automatic downloads.
6. **Finish seeding and retain the library.** Pause the torrent at a 2.0 upload-to-download ratio. The upload-time budget helps choose a release and does not end the transfer early. For the initial release, leave cleanup to an administrator after both the library import and seed goal are confirmed. A hardlinked file remains playable when the download-side link is removed. Library removal is a separate action. [Radarr import and cleanup](https://wiki.servarr.com/en/radarr/faq) · [Sonarr import and cleanup](https://wiki.servarr.com/sonarr/quick-start-guide)

Release checks cover a movie, two episodes without the rest of the season, VPN failure, insufficient disk space, an interrupted download and restart, track detection, a single Ready notification, and playback after torrent cleanup. Use authorized media for the transfer tests. The development server still needs a WireGuard profile and a live kill-switch test.

## Connect a profile

1. Start the existing Jellyfin service on the Debian guest. Give each viewer a separate ordinary Jellyfin account with access to the movie and TV libraries. The projector should use the same viewer account as the phone.
2. Set a private HTTPS address for Jellyfin artwork. FamilyHub contacts the internal Jellyfin address for authenticated library requests, video, and subtitles. Exclude request paths and query strings for FamilyHub's ticket-bearing routes from proxy logs.
3. Configure the following keys in the private FamilyHub server configuration. Keep this file readable only by the administrator and service account. Use the stable FamilyHub profile ID as the mapping key and configure a [profile password](SECURITY_REVIEW.md#profile-password-setup).

   ```json
   {
     "JELLYFIN_INTERNAL_URL": "http://127.0.0.1:8096",
     "JELLYFIN_PUBLIC_URL": "https://movies.example.test",
     "JELLYFIN_PROFILES": {
       "family-profile-id": {"username": "movie-viewer", "password": "<Jellyfin account password>"}
     }
   }
   ```

4. Restart FamilyHub and reconnect the updated app. Linked profiles get **Movies & TV** in the desktop sidebar or phone navigation bar. FamilyHub holds the regular Jellyfin session on the server and issues an expiring URL for media. Closing Movies ends that session.
5. Play a feature-length title, pause, and resume on another device. Switch profiles and verify separate progress. Try Hungarian and English audio and subtitles, real 4K material on the projector, and music playback on a second device. The development library has short fixtures which may fall below Jellyfin's resume threshold.

## Expansion order

| Stage | Ownership and acceptance |
| --- | --- |
| Playback and languages | Ship browsing, playback and resume first. Use embedded tracks immediately. Save interface language, preferred audio and preferred subtitles separately per viewer. Fall back to the original audio when a dub is missing. Test text and image subtitles on the projector because burning subtitles into a video can require transcoding. |
| Title requests | FamilyHub uses Seerr for movie and series requests and displays status on repeated title searches. Seerr handles approval, duplicate requests and notifications. Verify the complete workflow against the configured server before enabling it for the family. |
| Automatic acquisition | Add Radarr as the movie importer and Sonarr as the TV importer. Prowlarr supplies configured indexers and qBittorrent transfers files. Use separate movie and TV categories. Give the importers one filesystem mount containing downloads and the final libraries, so completed files can be hardlinked or atomically moved. Jellyfin keeps read-only media mounts. Start with one film and one episode from an approved source, then verify retry after a service restart and one visible copy after import. |
| Scheduling | Accept requests at any hour. Start with one background transfer, a disk-space reserve, and heavier imports and scans overnight in Europe/Budapest. Measure playback start, seeking, rebuffering, disk latency and free space under load before increasing concurrency. Playback and music controls must stay responsive when acquisition is stopped or unavailable. |
| Subtitle acquisition | If the embedded tracks leave gaps, add Bazarr. Configure Hungarian and English subtitle profiles, retain existing tracks, and test timing against the actual edition. |
| Discovery, statistics and comments | Start recommendations with unwatched titles already available and explicit genre preferences. Track deduplicated watch sessions per profile for family statistics. Store comments in FamilyHub keyed to a stable title or episode ID, with author, timestamp and spoiler visibility. A media rescan or file upgrade should preserve comments and statistics. |

The existing acquisition Compose file also defines the historical Lidarr service. When testing movie downloads, select only the intended services explicitly. Keep download configuration, queues and credentials outside the music intake worker.

Sources: [Jellyfin codec and subtitle support](https://jellyfin.org/docs/general/clients/codec-support/), [Seerr](https://docs.seerr.dev/), [Radarr](https://radarr.video/), [Sonarr](https://sonarr.tv/) and [Bazarr](https://www.bazarr.media/).
