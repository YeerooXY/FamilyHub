# Playback startup and autoplay — 12 November 2026

Saved audio now publishes complete HLS segments during preview encoding. The initial status polling interval is 300 ms until playback becomes available, then returns to two seconds. Optional beat analysis runs after pending audio preparation.

Supported MSE clients use the existing HLS.js player for growing EVENT playlists; native HLS remains the fallback for clients without MSE support. A preloaded next deck is reused when advancing without crossfade. Crossfade completion promotes the incoming server job before reconciling the remaining queue, preventing that reconciliation from cancelling the incoming recording.

Automatic replacement of failed songs remains deferred. Original recordings and source-validation checks remain intact.

## Verification

- Python suite: 75 tests passed, four platform/network-dependent skips. The new saved-file test decodes a complete first segment before the encoder finishes.
- Browser regression: a playlist initially exposes one segment, then grows to the full track. Playlist refresh, two-deck crossfade signal, seek overlap, failure retention, latest settings and two successive natural autoplay handoffs all passed. The handoffs reuse the preloaded deck. No transition plan is injected.
- Four-profile browser suite: Windows Chromium, emulated Mac WebKit, Android Chromium and iPhone WebKit passed UI/keyboard checks. Chromium profiles decoded real HLS through MSE. Physical iPhone/macOS audio remains unverified.
- Live server after restarting only the music service: saved Fight Back began advancing at **544 ms** after the click, while its preparation job was still running. This measures media-element playback progress, not time to perceptible sound within a recording's intro.
- Two consecutive natural-end handoffs reached more than 0.1 seconds of incoming playback in **399 ms** and **400 ms** after seeking to the previous song's final 0.3 seconds. Both reused their preloaded deck. Autoplay off stopped at the end. No JavaScript errors.
- These live checks used saved recordings with new downloads disabled. New-source network acquisition latency is not represented by these measurements.

Evidence: `.local/music/playback-latency-live.json`, `.local/music/playback-latency-tests.log`, `.local/music/playback-deployment.json`; browser harnesses under `tests/`. Server backup: `/usr/local/lib/familyhub/before-playback-1794480356`. No Tailscale/Paddock restart or configuration change.
