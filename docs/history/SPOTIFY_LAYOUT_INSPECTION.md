# Spotify interface inspection — 12 November 2026

Read-only inspection of the installed Spotify desktop build 1.3.8.620 under `%APPDATA%/Spotify`. No client patching, account inspection or media decryption was performed.

| Component | Measured size |
|---|---:|
| Installation directory, 113 files | 426.83 MiB |
| Chromium runtime, libcef.dll | 272.17 MiB |
| Main interface, Apps/xpui.spa | 11.71 MiB compressed |
| Interface archive contents | 42.42 MiB uncompressed |

REA `open_binary` identified xpui.spa as a ZIP archive, SHA-256 `df55f5231758411a3ea6d9b47dfa8e47d3b1dbfd9d50e5d75c2b601218c71824`. Its bulk extraction rejected an absolute `/` entry. No unsafe entry was extracted. Python's ZIP reader inspected the entry inventory and CSS text in memory. The REA session was closed afterwards.

The archive contains 627 entries: 197 JavaScript files, 96 CSS files, 124 SVGs, 46 WOFF2 font files, 52 WebP images, six PNGs, four HTML files and supporting resources. This is shipped bundled code, not the original development repository.

Observed layout facts in `xpui-snapshot.css` (520,945 bytes):

- Default left sidebar width: 232 CSS pixels.
- Content spacing token: 16 pixels; maximum content width token: 1,955 pixels.
- Main shell uses a grid with global navigation above left sidebar / main view / right sidebar, and a full-width now-playing bar below.
- Sidebar corner radius: eight pixels.
- Global navigation height is expressed as 48 pixels plus twice the configurable panel gap.
- Layout and panel sizes depend on runtime variables, window size and active feature state. Static CSS alone does not establish the exact current client composition.

These measurements and the original client screenshots can guide FamilyHub's independently maintained shell. Replacing a 197-file JavaScript application would still require adapting its service and native-client interfaces; the archive's small compressed size is not an estimate of that integration effort. Fonts and images were counted, not copied into FamilyHub's production assets. No screenshot fallback was needed to establish access to the formatting; rendered comparison is still needed for a faithful recreation.

## First layout integration

Applied the measured 232-pixel desktop sidebar and eight-pixel panel corners to FamilyHub's own markup. The shell now uses global navigation above separate sidebar, content and persistent now-playing panels, with a full-width bottom transport. The 144-pixel transport height preserves the owner's earlier request for a larger player. Eight-pixel panel gaps and a 300-pixel right panel are implementation choices, not confirmed fixed Spotify defaults. Existing FamilyHub icons, mark, system fonts and playback controller remain in use.

`index.html` now loads one app stylesheet, `shell.css`; the earlier accumulated `app.css` remains only for the existing sign-in page. The only controller edits reset the new scroll containers and preserve focus when changing views. Playback, search acquisition, accounts and recommendation behavior were not changed in this layout pass.

Verification: Library, Player, Search and Settings rendered and inspected on Windows Chromium plus emulated Mac WebKit, Android Chromium and iPhone WebKit. Single search field, measured sidebar width, panel separation, footer bounds, 320-pixel reflow and keyboard focus at the bottom of Settings passed. Crossfade/autoplay regression passed. The connected server showed 13 saved songs and real source artwork; playback and crossfade passed with no JavaScript errors. The installed Windows executable loaded the new layout and played audio. Physical Mac/iPhone font rendering and audio remain unverified.

Evidence: `.local/music-browser/spotify-layout-review.png`, profile screenshots, `live-player.png`, `live-ui-result.json`, `.local/music/layout-desktop-smoke.json` and `layout-deployment.json`. Security review scope: template escaping, CSRF token preservation, no new scripts/dependencies or external hosts, unchanged authentication and audio ownership boundaries. No full infrastructure or dependency audit was repeated for this layout-only change. Backup: `/usr/local/lib/familyhub/before-layout-1794481284`. Only the music service restarted; Paddock and Tailscale were left running.
