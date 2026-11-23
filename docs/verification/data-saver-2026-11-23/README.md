# Data saver verification

Task dated 23 November 2026. Checked on 24 November 2026 on `codex-state`.

| Movie choice | Maximum height | Requested bitrate ceiling | Estimated data |
| --- | --- | --- | --- |
| Auto | Follows Full quality on Wi-Fi or Ethernet and Saver on cellular | Follows the selected level | Follows the selected level |
| Full quality | Source | Existing playback choice | Varies by movie. About 4.8 GB an hour for the 10.7 Mbit/s *In Time* example |
| Good | 720p | 2.5 Mbit/s | About 1.1 GB an hour |
| Saver | 480p | 1.0 Mbit/s | About 0.45 GB an hour |
| Lowest | 360p | 0.5 Mbit/s | About 0.25 GB an hour |

Actual data use depends on the source and stream overhead. Saver and Lowest request AAC at up to 96 kbit/s and downmix multichannel audio to stereo. On cellular, the Music switch uses the existing Low Opus tier at 48 kbit/s for new streams and blocks network preloading. Wi-Fi and offline tracks follow their existing settings.

Movie Auto uses MAUI’s connection profiles first, so a tailnet connection over Wi-Fi keeps Full quality. When MAUI has no known type, Auto uses browser-reported cellular or Save-Data. It assumes Wi-Fi when neither signal is available.

Netflix lists hourly estimates for its video quality tiers. Its separate mobile Save Data mode estimates about six hours per GB. FamilyHub Auto chooses by connection type because the goal is to save cellular data even when the connection is fast. [Netflix data usage](https://help.netflix.com/en/node/87)

Spotify’s Data Saver lowers audio quality and loads fewer images. Spotify lists Low at about 24 kbit/s on desktop, mobile and tablet. FamilyHub Music keeps its existing 48 kbit/s Low tier and skips loading the next stream on cellular. [Spotify Data Saver](https://support.spotify.com/ls/article/internet-and-data-usage/) · [Spotify audio quality](https://support.spotify.com/ws/article/audio-quality/)

## Browser and C# checks

Headless Playwright ran at BelowNormal priority in Windows Chromium and WebKit. Both engines used a 1280 × 850 desktop viewport and the Pixel 7 and iPhone 13 device profiles. The profiles emulate viewport, device scale, touch configuration and user agent. The tests used reduced motion.

- The playback fixture substitutes Jellyfin responses, media timing, fullscreen and connection changes. It checks that Full omits the ceiling and uses direct play for the compatible source. It checks all three capped requests and Auto’s Wi-Fi-to-cellular change, one-time hint and native interop precedence. It preserves a paused position, a selected external audio stream index and a text subtitle across quality changes. It checks that focus stays in the player during the request, lands on the selected setting afterward and returns to the Settings button on Escape.
- The app shell fixture uses the actual Razor settings screens and a local mock server. It checks that Movies settings saves across a reload and that the Music switch responds to the keyboard. The C# tests cover MAUI connection profile mapping, the cellular Low and preload policies, and per-profile persistence.
- The screenshots use four suffixes for each profile. `-auto` and `-lowest` show the player before and after choosing a lower tier on the mock stream. `-movies-settings` and `-music-settings` show the app settings screens.

The older popup audit stopped at its Hub and Server work navigation selectors before reaching settings. The dedicated settings checks passed across the six profiles.

Run the playback checks from the repository root with Playwright Chromium and WebKit installed.

```powershell
$process = Get-Process -Id $PID
$process.PriorityClass = 'BelowNormal'
node tests/movies_data_saver.cjs docs/verification/data-saver-2026-11-23
dotnet run --project clients/FamilyHub.Client.Core.Tests
```

To include the app settings checks, start the existing app shell fixture and set `DATA_SAVER_SHELL_URL` to its loopback URL before running the browser command. [App shell fixture setup](../server-dashboard-2026-11-23/README.md#repeat-the-browser-checks)

## Jellyfin hardware transcoding

The capped choices use Jellyfin’s normal PlaybackInfo and transcoding URL. The request supplies output limits and disables stream copy. Saver and Lowest disable variable audio bitrate so Jellyfin uses the requested AAC bitrate. Jellyfin selects the encoder from its server settings. The fixture confirmed the request and the use of the returned HLS URL. The sample Compose file has no GPU device mapping, and the live Intel host was unavailable from this checkout. To complete the production check, select Saver on a 1080p film and inspect Jellyfin’s FFmpeg log for `h264_qsv` or `h264_vaapi`, the scale limit and the AAC bitrate. [Jellyfin transcoding](https://jellyfin.org/docs/general/post-install/transcoding/) · [Jellyfin encoder selection](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs) · [Jellyfin hardware acceleration](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/)

## HEVC in WebViews

H.264 stays the default. HEVC can reduce bitrate at comparable quality, but this probe measured decoding only. It used locally generated 320 × 180 SDR test clips with AAC stereo in HLS fMP4, with separate H.264 and HEVC manifests, and the app’s bundled hls.js 1.6.15. The HEVC manifest advertised `hvc1.1.6.L60.90`.

| WebView | HEVC fMP4 HLS result |
| --- | --- |
| Windows WebView2 | Played in a standalone WebView2 157.0.4341.60 probe on this workstation with the HEVC Video Extensions package installed. The HEVC clip passed two seconds of playback and decoded 54 frames. The H.264 control also played. Microsoft documents that Edge’s HEVC path depends on the Windows codec and decoder. [Microsoft codec guidance](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues) |
| Android WebView | Device and WebView build dependent. Android lists an HEVC MP4 decoder and Chromium has a platform HEVC path. Playback through hls.js also needs HEVC support in the WebView’s Media Source Extensions. Physical WebView playback remains unverified. [Android media formats](https://developer.android.com/media/platform/supported-formats) · [Chromium HEVC build options](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/media_options.gni) |
| iOS WKWebView | Expected to play on supported iOS hardware through native HLS when the playlist and `hvc1` fMP4 segments meet Apple’s requirements. Physical WKWebView playback remains unverified. [Apple HLS requirements](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/) |

Live Jellyfin output, native network handoffs, real-device settings layout, screen-reader speech and normal-motion behavior remain unverified. Playback resume with a capped profile was tested on the HLS path. The existing progressive fallback requires HLS support to resume a transcode.
