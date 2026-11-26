# Release search and download flow: locked decisions (26 Nov 2026)

Concepts: `docs/design/1-6-2-concepts/` (`search-results-d-rail.png`, `download-choice-dialog.png`, `film-downloading.png`, `series-downloading.png`). The images are text-free layout ideas; their artwork is filler.

## Release search results (concept D, simplified by the owner)

- The search field stays in the top bar with the query filled in. No second search input on the page. Back and Escape return.
- Left rail: the poster once, title and year, the quality legend with a count per tier (display only, colours from the existing quality tiers), and no other filters, toggles or sort control.
- No status line such as "79 releases found" or "1 source did not answer": log it on the server only. Counts live in the legend.
- One fixed order: best for your screen first (tiers up to the My screen setting), then best quality, then the smaller and faster file; unavailable releases last. No "N x the smallest".
- Release row, in this order: quality block (tier and source), title with the sound chip (series: kind label), size in GB, download time, availability dot with a word, one Download button. The raw file name sits behind a small expander. Hover and focus show the white outline (4 px on TV).

## After pressing Download

1. A larger glass dialog scales in with a small spring ("wobble": about 92 percent to 100 percent with overshoot, about 450 ms; instant under reduced motion and effects off).
2. It shows a summary of the chosen row (quality block, cleaned title, sound chip, size in GB, download time, availability) and two switches: Hungarian audio (off) and Hungarian subtitles (on; remembered as the new defaults), plus the line "English subtitles are added automatically".
3. Buttons: Cancel on the left, Download on the right. Focus starts on Download; the white outline marks focus.
4. Download starts the job, then the film or series page is prepared in the background: backdrop and poster at the right size, logo, cast photos, related films, season data (from TMDB; the title is not in the library yet).
5. Only when everything the page shows has loaded (or after about 4 s at most) the release search cross-fades into the finished page, with a gentle spring on the title block. The page never builds up on screen.

## Where the progress shows

- Film page: the Play button is the progress pill: a ring around the download arrow on the left, a violet fill from the left, a large clean percentage in the middle. When the film is ready it turns into the normal Play button.
- Series page: the season pill that is downloading shows a ring running around its border and a rising fill; its episode rows show a skeleton shimmer on the thumbnail and a small ring instead of the play arrow; ready episodes show a check; unwatched episodes show a violet dot and watched episodes are dimmed.
- Movies Home: a Downloading card (next to Continue watching) with a smooth circular spinner and the percentage in the middle in a rounded font; it opens the film or series page. The Movies tile in the Hub gets a small ring.
- Hungarian audio and subtitles are fetched after the main download; a quiet line under the actions says what is still being fetched.

## Rules for all of it

Keyboard path and focus (Download keeps focus until the page takes over, then focus goes to the page's main action), reduced motion and effects-off paths, announcements once via a polite live region, 44 px targets (60 px on TV), nothing shown twice.

## Confirm dialog slots (owner, 26 Nov; wireframe `1-6-2-concepts/confirm-dialog-slots-v2.png`, source `confirm-dialog-slots.html`)

Summary card, left: a poster thumbnail (no colour block). Right, three lines: (1) title, then the year at a readable size (about 70 percent of the title size), then the round age symbol straight after the year; (2) the audio style pill (only when known) and the quality pill, which is the only place the tier appears, in its tier colour; (3) size, download time, availability (dot plus word). Preview with sample data: `1-6-2-concepts/avatar3-confirm-dialog.png` (source `avatar3-confirm-dialog.html`). Below: option 1 Hungarian audio (off), option 2 Hungarian subtitles (on), option 3 English subtitles (always on, locked, "Added automatically"). Buttons: Cancel left, Download right, the same width and height; focus starts on Download whenever the dialog opens (TV remote).

## Age rating symbol

A round badge (about 40 px, 4 px coloured ring, dark centre, bold number): green for no limit or 6, yellow for 12, orange for 16, red for 18. Source: TMDB certification, preferring the Hungarian (HU) value, then US and GB mapped to the nearest of 6, 12, 16, 18. Drawn in CSS or inline SVG, accessible name 'Rated 12'; shown next to the title on Home hero, film page, series page, release search rail and this dialog. Never copy official artwork.

## Confirm dialog look (owner, 26 Nov)

The poster fills the whole left edge of the summary card (flush to the left, top and bottom edges; the card's rounded corners clip it, no margin around it). The rest of the screen behind the dialog is softly blurred and dimmed. The dialog frame emits a soft light: a glow taken from the title's own backdrop colours (a dominant cool and a warm colour; fall back to violet). Reduced motion and effects off keep the glow static. Preview: `1-6-2-concepts/avatar3-confirm-dialog-v2.png`.

## Summary card refinements (owner, 26 Nov)

The title block sits at the top of the summary card (title, year, age symbol); the audio and quality pills follow; the data line sits at the bottom. Size and time take a colour from their value, text stays readable without it: size green up to 5 GB, amber up to 15 GB, orange up to 30 GB, red above; time green up to 10 min, amber up to 30 min, orange up to 60 min, red above. Use the same colours on the release rows. Preview: `1-6-2-concepts/avatar3-confirm-dialog-v3.png`, small file: `avatar3-confirm-dialog-v3-small.png`.
