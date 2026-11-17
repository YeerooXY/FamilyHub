# Recommend similar

Implemented locally, 13 November 2026. Not deployed to the running server.

The music-note button beside Shuffle opens the queue's Recommended section. It lists saved and unsaved recordings with Play and Add to queue actions. Opening recommendations requests metadata only. Selecting an unsaved recording for playback or queueing uses the existing server acquisition flow; this is separate from future device downloads for offline listening.

Recommended mix now retains the initial song as its seed across automatic advances. Explicitly choosing a different song outside the recommendations starts a new seed; pressing Recommend similar uses the current song. Manually queued songs and explicit playlists retain their order and can include other genres.

Candidates must have the same known genre group as the seed, or be by the same artist when genre information is absent. Known conflicting genre groups are excluded even for the same artist. Unsorted never counts as a matching genre. Automatic mixing stops filling when candidates run out instead of using unrelated search results. Ranking and listening history apply only after this filter.

Genre groups come from the existing cached MusicBrainz artist lookup. They are broad artist labels, not acoustic or song-level classification. Search discovery currently queries the starting artist; other artists enter through matching labelled library tracks or matching labelled search candidates. This is not a dedicated similar-artists provider. Missing labels may require another request after the background lookup finishes.

Verification: 28 server tests passed, recommendation identity/history and fixed-seed tests passed, including 40 generated batches excluding Aqua's Pop-labelled Barbie Girl from a Rock seed. Desktop Chromium and iPhone-sized WebKit verified visible unsaved suggestions, manual queueing, metadata-only browsing, failure messages, focus and Tab/Shift+Tab/Enter/Space. The search/playback regression passed with an explicit Queue order preference and a viewport smaller than the result list. Screenshots were inspected; physical iPhone audio and live recommendation quality remain untested.
