# Movies & TV redesign: locked decisions (25 Nov 2026)

Concept images: `docs/design/1-6-0-concepts/` (settings, icons, switcher), `movies/` (round 1), `round2/` (locked picks). Images are text-free concepts; build with live text and the app's own icon family.

## Locked picks

| Screen | Pick | Image |
| --- | --- | --- |
| Movies home | Style B, rows plan 1 | `round2/home-b-rows-1.png` |
| Series overview | Two columns | `round2/series-2-two-column.png` |
| Film full screen | Full screen, one bottom row | `round2/film-full-screen-locked.png` |
| Backgrounds | Preset sheet, to be tried on a large screen | `round2/background-presets.png` |
| Settings (1.6.0 shell) | Discord style | `settings-a-discord-style.png` |
| App icon | Owner likes all three; pick one before vector work | `icon-a/b/c-*.png` |

## Data

- Background: the title's Jellyfin `Backdrop` (4K for *In Time*, Full HD for the others). Request it scaled to the window (`maxWidth` 1920, 3840 only on large screens). Use the `Logo` image (transparent) as the title and fall back to live text. Titles without a backdrop use a static preset chosen from the first genre, overridable in Settings.
- Cast: Jellyfin `People` (`Type` Actor, name, `Role`, `PrimaryImageTag`). No cast is possible for some titles, so the cast block is optional: show up to 12; a person without a photo gets the colour-and-initial circle; with zero people the block is removed and the column keeps its balance (poster, Play, heart, description, then genres and rating chips).
- Related row (film only): collection parts first (TMDB `belongs_to_collection`, sequels and prequels), then TMDB recommendations. Maximum one row. A film in the library shows a check; a film that needs downloading shows a search icon (outline icon from the app family, not an emoji) that opens the search with the title filled in.
- Favourite: heart button toggles the Jellyfin favourite for the viewer; "My list" row on Home. No download or plus button on the film or series screen.

## Home rows

Hero, then Continue watching (landscape, progress), My list (hearts), Recently added (landscape, "new" for 14 days), Series (portrait), Movies (portrait), Collections (stacked posters), then up to 3 genre rows (genres with at least 4 titles, ranked by what the family watches). A title appears once per screen, except in Continue watching. Rows with nothing to show are not rendered.

## Row geometry (every screen the same)

- Five full cards per row, plus a slice of the next card (peek) on the right. After scrolling right at least once, a slice of the previous card also shows on the left whenever cards remain on that side. Owner (25 Nov): the peek is about half of the first concept, on both sides, because the left edge has no margin.
- Card width is derived from the row width, never fixed: `card = (row − 6·gap) / (5 + 2·peekFraction)` with `peekFraction` about 0.15 and the same card width in every scroll state. Rows with five or fewer cards show no peek and no arrows.
- One press of a side button scrolls exactly one page: five cards plus five gaps (±1 px), with a smooth slide. No repeated taps needed. Keyboard: arrow keys move between cards; Page keys or the side buttons move a page.
- Side buttons: round, overlaid on the row edge, shown for pointer hover and keyboard focus, hidden on touch (AGENTS.md 18 Nov and 22 Nov lessons). Touch scrolls by swipe with snap to cards.
- Height: roughly two rows fit in the window at most. Portrait rows cap their card height so two rows never need more than the window.
- Verify at 1280, 1440, 1920, 2560 and 3840 px wide: five full cards, peek between 10% and 20% of a card, page scroll equals five cards plus gaps, no page-level horizontal scroll.

## Hover, focus and motion

- Hover or keyboard focus on a card: scale up smoothly (about 1.12 for posters, 1.08 for landscape cards), white 2 px outline, soft glow, the card rises above its neighbours.
- The enlarged card never overlaps its neighbours: neighbours slide apart by half the growth, or the gap is large enough; the first visible card grows from its left edge and the last from its right edge so nothing is clipped by the row. The row has vertical padding so the scaled card is never cut off.
- The same enlarge-and-outline treatment is used for series episode rows (smaller scale) and for the season pills when switching seasons; switching seasons slides the active outline from pill to pill.
- Timing: 180–240 ms ease-out for the grow, 120 ms for the outline; page scroll 380–450 ms ease-in-out. Everything stops under `prefers-reduced-motion` and effects off: no scale, outline only, instant scroll.
- Touch has no hover state; a tap opens the title. Focus never falls to the body after a scroll or a screen change; the focused card stays focused when the row scrolls.
- Animations get their own verification: measured geometry (no overlap, no clipping), reduced-motion path, keyboard path, four-profile screenshots.

## Search (Home only)

- The search field lives in the top bar, centred, where the profile sits: a black field, visible all the time (Owner, 25 Nov, replaces the icon-and-expand idea). No "Movies & TV" title text in the bar, since the user is already there. The profile icon stays at the right.
- Search is on the Movies home screen only. Focus moves into the field with `/` or a click; the field spans a comfortable centre width at every window size.
- While the field is open it replaces the Home rows: empty field shows browse tiles (genres and collections), typing shows results as a grid of the same cards (five per row with the peek), with the same hover rules. Library results come first; titles that need downloading show the search icon and open the release search.
- Close button, Escape or clearing and pressing Back returns to Home with the previous scroll position; focus goes back to the search icon. Search exists only on the Home screen, not on the series or film screens.
- Reduced motion: the field appears without the slide. The result count is announced once.

Concept: `docs/design/1-6-0-concepts/round2/home-search-open.png`.
