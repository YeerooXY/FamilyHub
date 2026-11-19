# Library and playlist verification

The Windows worktree ran `python -m music_web` against a separate fixture workspace. Playwright exercised the Flask browser surface and the built native Razor shell. The shell used a test audio deck and forwarded catalogue and playlist requests to the local server. Search and radio used controlled provider responses. Test processes ran headless at idle priority.

## Scenario results

| Scenario | Result |
| --- | --- |
| Empty playlist, link, files | Created an empty playlist, reached the playlist after submitting a link, and created a playlist from a WAV file. Escape closed Create playlist and restored focus. Python fixtures covered provider parsing and import processing. |
| Add from search, player, and menus | Added songs from search results, the player picker, and the playlist menu. A duplicate showed the server's explanation. The concurrent-edit regression confirms that Done preserves an addition made on another device. |
| Remove, reorder, rename, share, co-authors, delete | Removed a song, moved it through its row menu, and verified focus followed the moved row. Renamed a playlist, toggled sharing, selected a co-author, and deleted a playlist. A client regression changes the revision between read and delete, then verifies the next delete uses the refreshed revision. |
| Playlist offline download, pause, retry, delete | Cancelled the download dialog, paused a running transfer, retried, downloaded the whole playlist, and removed one recording from Downloaded. Rendered component tests checked per-song progress and recovery from a refusal. The portable client checked interrupted and cancelled transfers. |
| Storage and quotas | Scratch quota accounting passed in the server fixture. Capacity failures returned recovery text in client tests. A physical full-device storage test remains open. |
| Album as playlist | Saved every recording on a three-song album. A rendered regression rejected the second write, then verified retry used the same playlist and added only the missing recording. |
| Search | Tested an empty result, punctuation and multilingual text, a 200-character query, a delayed provider, busy and offline errors, and retry. The browser regression checked incremental results, deduplication, focus and timeout on four profiles. |
| Genre and new Home | Selected a seeded genre with the keyboard, checked visible library songs, and cleared the filter. Home offered radio guidance when listening history was empty. |
| Radio and similar songs | Controlled empty radio and recommendations showed recovery guidance and kept the current song. Browser handoff passed between two contexts, including queue advance and return handoff. |
| Song report, review, and artist mappings | Submitted a song quality report and opened both admin sections. The rendered review timeout test recovered on Retry. |
| Uploads | Uploaded a WAV, repeated the file, skipped a text file, and submitted a two-file batch containing a corrupt WAV. The batch retained its successful file and identified the failed one. |
| Server refusal | Client regressions covered sign-in, forbidden access, stale revisions, busy, quota and timeout messages. Browser tests covered busy, offline and retry. Browser queue recovery after an expired sign-in remains open. |

## Rendered profiles

Windows Chromium used 1280 × 900. Desktop WebKit emulated Mac Safari at 1280 × 900. Chromium and WebKit used Android and iPhone touch profiles at 390 CSS pixels. The browser search regression used rendered fixtures for four-profile coverage. The live browser sign-in and search smoke checks used Chromium. Screenshots of the move menu and search timeout are in `.local/flows/`. Physical device playback, operating-system keyboard behavior and live provider completion remain open.

The playlist search toggle and field previously shared the label “Search in playlist.” The toggle now announces “Open playlist search” or “Close playlist search.” The field retains its label.

The Windows build, 194 Python tests, 906 portable client checks, and the rendered component regressions passed. Two older browser scripts failed on the base revision as well. One expected a different viewport preload count and the other used the removed `#nav-queue` selector. The standalone edge-review script requires an external local export fixture and had no result in this worktree. The app's Song review panel ran against the isolated server.
