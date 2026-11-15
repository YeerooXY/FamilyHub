# Music screens and playback repair

11 November 2026. Screen proposal and implementation specification; no production fixes are claimed. Read with `ASTRA_PLAN.md` for the source-level investigation.

## What the current app does

The crossfade path is wired, but the owner's real-session failures remain unresolved. The earlier browser overlap check injected a plan and mocked job/transition responses. It did not validate the actual scheduler-to-browser handoff. It was premature to call the live transitions ready.

Source findings explain several reported symptoms:

| Symptom | Evidence | Required change |
| --- | --- | --- |
| Repeated Fight Back rows | Bulk Library addition and other handlers append directly to the queue. | One queue mutation path with unique stable track keys. Remove bulk-add from ordinary playback. |
| Can't see next | Queue head, prepared job and current UI are separate; no persistent next-track display. | Next tile and queue head reference exactly the same track and readiness. |
| Library stays stale | `loadLibrary` runs at startup or manual Refresh, not after commit or entry. | Refresh on view entry, after publication, and periodically while visible. Preserve focused row keys. |
| Crossfade does nothing | `checkBlend` requires Autoplay; `preload` waits for the next job to be done. Transition requests also depend on the staged current item. | Ordinary fade depends on playable media, buffered overlap and cue times, not import completion or beat analysis. |
| Saved songs still wait | Saved originals are reused, but a missing/expired HLS rendition can be encoded completely before its URL appears. | Reuse prepared media and publish saved-file playback incrementally. Show Preparing audio rather than Downloading. |
| Playback waits for a full song | Progressive acquisition exists, but saved-file and nonsequential-source paths can remain complete-first. | Exercise the connected browser path with upstream EOF withheld; surface complete-first fallback honestly. |
| “Other” everywhere | `KIND.other` is source classification, not genre. | Remove source badges from ordinary results. Use sourced genre metadata; unknown stays unknown. |
| Persistent debug popup | The player renders completed-import actions inside a positioned details panel. | Remove the popup and completed-job actions. Put an inline Retry beside a real failure; technical detail goes in settings. |
| No covers | Search/library projections contain no album-art provenance or lookup. | Add verified catalog matching and same-origin, bounded cover caching with a neutral fallback. |

The read-only live manifest snapshot found one retained imported Bad Romance source (`TTOPBQhrvtQ`) with both staged audio and library file present. This proves an existing saved original, not whether an earlier selection fetched it again. Same-source validation already precedes `cmd_fetch`. Different source IDs, invalid manifests, expired playback renditions and actual provider downloads must be logged separately before assigning a cause.

## Screens

**Player** answers four questions: what is playing, what plays next, is the next audio ready, and is Autoplay on? One transport controls the current song. The next tile includes the actual cover, title, artist and readiness. Following tracks are a continuation of that list, never another queue. The current cover shrinks into a horizontal summary on short phones to retain visible next readiness.

**Library** lists saved recordings with album covers and clean artist/title metadata. A row or its keyboard activation plays that recording directly. The current row is marked. Saved state is information, not a redundant download button. Genre filters and Shuffle play operate on the same records. There is no routine Refresh or Add all button. An error offers Retry without clearing the collection.

**Search** uses the header field and whole result rows. Clicking a saved result resolves its local original; clicking an available result starts that exact selected recording and saves it to the shared library. There is no radio-selection step, second Listen button, “Other” label or upload tab. A short consequence statement explains that new selections are saved. Automatic acquisition of unrequested recommendations keeps its separate permission setting.

**Settings** holds fade duration, optional beat matching, edge-silence cues and acquisition preferences. Play/Pause, seeking and next remain available without opening settings. Import-file UI is removed; existing administration/CLI intake need not be deleted.

New states are explicit: Preparing audio, Ready to play, Crossfading, Preparation failed with Retry, Stop after this song, and Genre not identified. A green Ready state must ultimately come from browser-buffer readiness, not a server job saying done. The design snapshots depict these states; they do not measure readiness.

The proposals remove redundant wording found in `music_web/templates/index.html`: “Saved music” repeats Library, and “Private server” occupies the header without affecting the immediate music task. Preserve storage consequences and actionable failures.

## One track and queue model

Keep manifests as the saved-original authority. Project search and Library into one `TrackRecord` map, keyed by stable source/local-manifest identity. Keep source ID, optional verified recording identity, title/artist/album, cover reference, genre provenance, saved state, playback readiness and cue markers distinct.

The session owns only current key, pending selection, ordered upcoming keys, bounded history and preferences. A single command path handles play, next, previous, remove, reorder and refill. UI views read this state; they do not push into separate queues. Preserve server ownership checks and monotonic selection revisions.

With Autoplay on, refill toward six unique compatible candidates when available. The visible next item is always the queue head. With Autoplay off, stop after the current track and cancel speculative work. A small library cannot produce six distinct candidates; show what exists without padding repeats. Unknown genre is not a matching genre. Use an explicit selection or honestly labelled fallback rather than claiming a same-genre mix.

Keep current/next originals and useful playback media protected from cache eviction. Prepare the next track first, then a small bounded amount of later work. Display the broader recommendation list without treating every visible row as a full speculative download. The requested three-to-five short skip buffers need a validated range/resume or reusable rendition strategy; the present whole-track cache does not provide that. Searching alone should not silently acquire several complete songs.

## Delivery sequence

1. **Prove original reuse.** Add sanitized events for selected source identity, saved validation result, acquisition start/received bytes, local rendition preparation, first published segment, first playable buffer, import commit and transition. Intact same-ID replay must receive zero new source audio bytes. Distinguish metadata requests and FFmpeg preparation from provider acquisition. Invalid saved data gets a repair error and explicit recovery. Title similarity never silently replaces a selected recording.
2. **Consolidate queue and playback state.** Remove direct queue append paths, overlapping track copies, radio selection, file-mode listeners and player side effects in `showJob`. Retain authentication, path/hash guards, generation checks, immutable media publication, cancellation, stable decks and focus restoration. Keep the existing Windows host.
3. **Make playable readiness independent.** Preserve current audio while a new selection prepares. Attach the incoming deck when a decodable published prefix and browser buffer exist, then commit the selected current key after play succeeds. Stale responses cannot switch tracks. Extend saved-file preparation through the existing publishing mechanism and reuse valid cached renditions across ordinary replay. Saving and analysis complete independently.
4. **Connect ordinary crossfade first.** Calculate overlap from effective end/start cues and buffered media. It must work with beat analysis disabled, failed or pending. Beat matching is optional and uses normal-fade fallback for uncertain grids. If the next buffer is late, show Preparing rather than falsely advertising an armed fade. Exercise pause, seek, skip, late arrival and queue advancement in the actual connected flow.
5. **Add non-destructive empty-edge cues.** Detect only confidently empty/near-zero material at the beginning or end; leave internal pauses and quiet musical intros intact. Store start/end playback cues alongside analysis, retaining original bytes and a small protective margin. Plan the outgoing fade before the trailing empty region and start the incoming recording after its empty prefix. An analysis failure leaves original timing. Never block first playback on this detector. Validate digital silence, encoder noise, quiet fades, quiet intros, all-silent input and long tracks before choosing thresholds.
6. **Connect Library and metadata to the selected screens.** Refresh after publication and on view entry, with a bounded visible-view refresh for other family members' additions. Include all validated intake originals, including local imports even though the upload UI is hidden. Existing Navidrome-only files require a bounded identity adapter; do not reacquire their music to populate the new UI. Add cover/genre provenance without introducing a parallel catalogue or extra service.

The UI design harness in this folder is not the production controller. Its illustrative saved flags and readiness must not become real app facts.

## Acceptance gates

- Repeated current/queue/library actions leave zero duplicate source keys. Next advances once and refills automatically when eligible tracks remain.
- Intact saved-track replay, expired-rendition repair and queue promotion cause zero provider source-audio downloads. Different source IDs remain distinct until explicitly matched; original hashes/packets remain preserved.
- A connected test withholds source EOF and observes advancing browser playback plus nonzero decoded signal before release. Complete-first fallback is explicit when early decode is unavailable.
- Without any beat analysis, a controlled five-second crossfade produces both outgoing and incoming signals across the configured overlap, no empty gap and one queue consumption. Do not inject the plan for this gate.
- Known current and next covers, preparation failure and waiting states are legible on desktop and physical phones. A new library publication appears within the next successful refresh cycle. Row selection, Tab/Shift+Tab/Enter/Space and removed-row focus work through updates.
- Edge cues skip genuine empty starts/ends while preserving quiet music, internal silence and the original file. No analysis work delays saved-song startup.
- Repeat the owner's Bad Romance, Fight Back and Scared to Be Lonely scenarios in the installed Windows client, recording source-byte counts and actual audible transition observations. Synthetic and design checks do not supersede those failures.

Source references: [FFmpeg silence detection](https://www.ffmpeg.org/ffmpeg-filters.html#silencedetect) supplies timing observations; [Apple catalog result fields](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/UnderstandingSearchResults.html) supply example artwork and genre metadata. Neither establishes the identity of a saved source or the quality of a live transition. Provider usage conditions and exact recording/edition matching remain integration checks.
