# Current revision

Owner selected **A Library + C Player**. Open `index.html` for revised screens, including desktop/phone Settings. See `REVISION_NOTES.md` for scope and checks. Live application remains unchanged; playback fixes are local.

The remainder records the original design pass.

# FamilyHub Music replacement screens

Open **index.html** for the screen gallery and **screens.html** for interactive layout examples. The numbered PNGs are individual full-screen designs. They can be opened directly.

This delivery contains designs and a repair plan. It does not modify or deploy the installed application. There is no audio playback or song downloading in the HTML examples. Catalog tracks, saved flags, playback time, readiness and crossfade progress are illustrative UI states. They are not live-server observations or completed features.

## Layouts

- **A, focused player:** recommended. Current cover and transport lead; next song, readiness and following songs stay together. Phone layout keeps next readiness above navigation and becomes compact on short screens.
- **B, paired decks:** current and next covers have equal prominence, emphasizing the handoff.
- **C, library workspace:** downloaded music stays central with current and next beside the list.

The owner has not selected a layout yet. Images 01–09 and 12–14 develop A; 10 and 11 show B and C. `SCREEN_SPEC.md` describes interactions and the implementation sequence. `ASTRA_PLAN.md` is the requested GPT-6-Astra medium planning output, produced in one included-account attempt.

## Files

- `01`–`03`: desktop Player, Library and Search.
- `04`–`06`: phone Player, Library and Search.
- `07`–`09`: crossfading, preparing the next track and Autoplay off.
- `10`–`11`: alternate desktop layouts.
- `12`: inline preparation error and Retry.
- `13`: unmatched artwork and unknown genre.
- `14`: compact phone layout.
- `assets/`: real catalog artwork, neutral unmatched cover and generated text-free background.
- `COVERS.md`, `catalog.json`, `PROMPTS.md`: image sources and generation provenance.
- `verification/`: routine browser evidence, kept outside Results.

The interactive examples support navigation, one-click row selection, filters, Play/Pause state, seek display, Autoplay, and a playback-settings dialog. They intentionally demonstrate presentation rather than the production audio pipeline. They are not a controller to copy into the live app.

## Checked

Rendered with Windows Chromium, emulated macOS WebKit, Android Chromium and iPhone WebKit. Player, Library and Search loaded their local images without JavaScript errors or horizontal overflow. Tab, Shift+Tab, Enter and Space checks cover genre filtering, direct track activation and preserved Autoplay focus. The next song’s readiness stays visible above navigation in both emulated phone profiles. Genre changes and exhausted same-genre candidates have explicit states.

These are design checks, not proof of audio overlap, download reuse or phone background playback. Actual Mac/iPhone/Android fonts and physical-device behavior remain unverified. The live playback problems are recorded as unresolved in the repair plan.

Image generation supplied one ambient backdrop. All cover images with album names come from the catalog links in COVERS.md; the original screenshots were not edited. No live service, Tailscale, Paddock, account or SSH tunnel was changed.
