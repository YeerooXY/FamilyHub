# Music UI integration — 12 November 2026

The selected Library/Player composition is connected to the existing authenticated API and stable audio decks. The installed Windows WinForms/WebView2 app uses this interface, with its own executable, taskbar icon, shortcuts, saved sign-in and remembered window bounds. It still depends on the private server connection.

Changes: solid monochrome icons, FamilyHub mark, glass navigation and larger transport, current/next song views, up to ten queue entries, direct song playback, source artwork, periodic library refresh, one search field, explicit crossfade toggle and removal of the file-import/selection flow and persistent playback popup. Six upcoming recordings remain the backend preparation bound. Source thumbnails are not verified album covers. The existing recommendation ranking remains; reliable genre matching and automatic edge-silence cues are not introduced by this UI change. Automatic failed-song substitution remains deferred.

Verification:

- Windows build: zero warnings/errors; installed under `%LOCALAPPDATA%/Programs/FamilyHub Music`.
- Backend: 74 tests passed, four platform/network-dependent skips. Artwork auth, input validation, content validation and cache reuse covered.
- Browser: Windows Chromium plus emulated Mac WebKit, Android Chromium and iPhone WebKit; Library, Player, Search, Settings, login, overflow, Tab/Shift+Tab/Enter/Space, queue removal and failure focus checked. Screenshots inspected. Physical Mac/iPhone behavior and iOS audio remain unverified; Windows WebKit lacks audio support.
- Synthetic two-deck test: running-preview transition, failed next retained, unique sources, stale settings, seek overlap with measured signal from both decks and uninterrupted handoff passed.
- Connected private-server check: eleven saved songs, artwork loaded, Fight Back played; seeking into its final two seconds handed off to the prepared Christina Vidal recording with audible decoded signal (RMS approximately 0.10), no JavaScript errors. New acquisition disabled in this check.
- Installed Windows executable: automatic sign-in, library rendering and real audio playback passed. Host objects/web messages remain disabled.

Evidence is under `.local/music-browser/` and `.local/music/ui-*.json`. Server backup: `/usr/local/lib/familyhub/mobile/music_web-before-ui-1794478943`. Only the music service restarted. The absent SSH forwards on ports 18765 and 14533 were restored in a hidden process; Tailscale remained Running and Paddock was not restarted.
