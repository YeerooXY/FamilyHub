# FamilyHub 1.5.1 music verification

Source revision `c80d17e2c34192e2a1abe2df893c257e379fc296` with the pending 1.5.1 workspace changes.

- Similar songs queues library matches while the selected song prepares. Related-artist suggestions appear by page, carry the existing storage indicator, and use playlist matching when selected for playback or saving. The queue can keep receiving matches after navigation. A user playback action stops further queue updates. The existing toast confirms the first queue update.
- Unmatched suggestions stay in the local playback queue until they resolve. Saved playback and Listen Together continue to use recording IDs.
- Playlist playback reads preparation status and refreshes the catalogue. Newly available songs append in playlist order. The follower takes a final snapshot when preparation pauses or finishes. If playback reached the end while it waited, it resumes when the next recording arrives.
- The playlist toolbar keeps one download button as its progress ring, label and tooltip change. The Playlists switch row holds the create action on phones. Filters scroll horizontally, with search and sort in the next row.
- Playback reads the specific library record once when a terminal preparation result has no playable source. An imported recording can open in the same app session.

## Automated checks

The lead runs the checks. The fixtures use fake HTTP handlers, mocked Deezer responses and a loopback browser host.

- `FamilyHub.Client.Core.Tests` covers paging before the next response, related-artist suggestions, deferred matching, playlist order and pause, and the targeted stale-record read.
- `FamilyHub.Player.Tests` covers queue replacement during playback preparation, background appends, continuation at the end of the queue and cancellation by a newer playback action. `FamilyHub.ServerWork.Tests` covers the playlist transfer states.
- Python tests cover the Deezer radio response, bounded paging, matching through the imported-playlist matcher, library fallback and the limited preparation status response.
- `tests/music_native_similar.cjs` covers navigation during a lookup, focus on existing suggestions, Playlists layout, sort dialog focus restoration, pause and resume focus, reduced-motion progress and the follow-queue path. It saves Playlists and paused-download captures in `.local/music-1-5-1/`.

## Browser coverage pending

| Profile | CSS viewport widths |
| --- | --- |
| Windows Chromium | 1280 px |
| macOS Safari engine, emulated with WebKit | 768 and 2000 px |
| Android Chrome, Pixel 7 profile with a narrow emulated viewport | 320 px |
| iPhone Safari, iPhone 13 profile emulated with WebKit | 390 px |

The 1.5.1 Playlists collection, playlist detail and download control, Similar songs screen, queue and playback recovery still need rendered verification for layout, visuals, motion, focus and keyboard, accessibility, wording and states. Source inspection covers wording and state wiring. Screenshot inspection, physical-device behavior and screen-reader speech remain pending.
