# Files screen verification, 23 November 2026

Run `node tests/files_view.cjs` to reproduce the captures. The harness loads the Files workspace and production styles with fixture data and a simulated .NET bridge.

| Profile | CSS viewport | Captures |
| --- | --- | --- |
| Desktop Chromium | 1280 × 800 | [Tiles](desktop-1280-tiles.png) · [Empty folder](desktop-1280-empty.png) · [New folder](desktop-1280-new-folder.png) |
| Television-width Chromium | 2000 × 1000 | [Tiles](desktop-2000-tiles.png) · [Empty folder](desktop-2000-empty.png) · [New folder](desktop-2000-new-folder.png) |
| Pixel 7 Chromium emulation | 412 × 915 | [Tiles](pixel-7-tiles.png) · [Empty folder](pixel-7-empty.png) · [New folder](pixel-7-new-folder.png) |
| iPhone 13 WebKit emulation | 390 × 844 | [Tiles](iphone-13-tiles.png) · [Empty folder](iphone-13-empty.png) · [New folder](iphone-13-new-folder.png) · [Share link](iphone-13-share-link.png) · [Your links](iphone-13-your-links.png) |

The suite also runs desktop WebKit at 1280 × 800. It checks the two phone columns, tile width, keyboard and touch menus, focus moves, dialog validation, stale listings, upload progress, reduced motion, and horizontal overflow in the page and Files workspace. The 2000 px profile checks 60 px targets and a 4 px focus ring.

Physical devices, the operating system’s picker and share sheet, screen readers, and enlarged text remain unverified.
