# FamilyHub 1.6.0: planned changes (26 Nov 2026)

## Already built on the branch (not yet released)
- Movies & TV Home redesign (hero, five-card rows with peek, hover, top-bar search, Layout preview demo library).
- hls.js now loads with a script element (Windows and Android transcodes failed with media error 4 because it never loaded); Android WebView prefers hls.js.
- Jellyfin API key stored; the server sends it in the Authorization header (Jellyfin 12 ignores X-Emby-Token) so imports can refresh Jellyfin.
- 8K release tier. OpenSubtitles fallback (key only, anonymous downloads).

## In progress
- Home round 2: rotating hero, sleek hero controls, calm row arrows.
- Friendly error screen with a working Reload, server restart notice, "Reconnecting" state.

## Planned
1. Subtitles and audio pipeline (automatic, per film and per episode)
   - Languages: English and Hungarian only, plus the original audio language as an optional third.
   - Download dialog tick boxes: Hungarian audio, Hungarian subtitles. English subtitles are always automatic.
   - Order: text subtitles inside the release or its Subs folder, then image subtitles by OCR (VobSub/PGS to SRT), then OpenSubtitles fallback.
   - Timing check against the audio (voice detection); automatic shift or stretch when the offset or frame rate is wrong.
   - Optional wording clean-up of OCR text (local Qwen, else a free API of about 50 requests a day, else keep the OCR text).
   - Remove the unused Jellyfin-downloaded wrong-timing subtitles once the new ones are confirmed.
2. Player Audio & Subtitles panel (concept `round3/player-tracks-sheet.png`)
   - Smaller centred panel; two audio languages plus the original; two subtitle languages.
   - No language picker and no Find subtitles button. Fixed rows, same every time (Owner 26 Nov): Off, English, Hungarian. A row whose subtitle is missing shows its own small download icon that searches for that language only; rows are never added or removed, so the panel looks the same on every title. The same rule applies to the audio rows (English, Hungarian, original).
   - Subtitle shift (any amount, in steps) and speed/frame-rate stretch, saved per title.
   - No random pills.
3. Film full screen, series two-column with optional cast, genre background presets, heart favourites and My list, related row (collection parts first, then recommendations; check mark if in the library, search icon if not).
4. Release search in the new theme; sound format chip (5.1, 7.1, Atmos); "above your screen" flag and a My screen setting (resolution, HDR); optional pre-buffer for very large files.
5. Settings shell in the Discord style; top-left per-app icon with the four-squares switcher; app icon choice and vector build.
6. Android: next song after the screen turns off (adb session), exit-reason diagnostics already shipped in 1.5.3.
7. Housekeeping: stale tests (music_popup_unification, music_native_similar), Linux-only subtitle and audio sidecar tests run on the server.
