# Handoff: finish and release FamilyHub 1.4.0

State on 24 Nov 2026. Branch `claude/files-wordle-1.2.4` (pushed through `v1.3.0`; `d9e2fef` is local, not pushed). Worktree: `C:\Users\7yeer\Projects\FamilyHub-claude-1.2.4`. The old checkout `C:\Users\7yeer\Projects\FamilyHub` is stale; do not build from it.

## Already live
- **1.3.0** released on GitHub (YeerooXY/FamilyHub) for Windows, Android and iPhone (SideStore). Server deployed and mirror updated.
- Server config: `REQUIRE_PROFILE_PASSWORDS` is **true** (backup `/etc/familyhub-music-web/config.json.before-require-passwords-1.3.0`). Yeeroo has a password; other profiles set one on next sign-in.
- Server `192.168.31.16`: SSH `familyhub@192.168.31.16`, key and known_hosts in `.local/vm/` (copied into this worktree, git-ignored), passwordless sudo. Tailscale machine `yeeroo` (Linux server) is shared by invite to 4 users; address `https://yeeroo.taile0034e.ts.net:8444`.
- qBittorrent runs inside the gluetun VPN container (ProtonVPN, forwarded port, kill switch). Peaky Blinders S02 was downloading (99%), S01 seeding.

## In commit d9e2fef (written, NOT browser-tested, NOT released)
1. Movies: "On the server" panel renamed "Downloading" and shows only running work; "Matching titles" row hidden (`movies.js`, `release?.setMatches` still feeds posters); sort chips hidden; quality guide is a collapsed table; larger release posters; size colouring (`movie-releases.js`, `movies.css`); seeding ratio removed from title cards.
2. Series seasons: state chip first on each row (Available green, Downloading amber with % and time left, Missing red); "Find season N" only when missing (`updateSeasonState`, `seasonRow`).
3. Episode pictures: `music_web/tmdb_stills.py` (disk cache `STATE_DIR/.tmdb-stills/<series>/<season>-<ep>.jpg`), route `POST /api/movies/season-episodes` in `music_web/movies.py` (returns data URLs), client `MovieSeasonEpisodes` in `MoviesView.razor`, `episodeStills` in `movies.js`. `series_id` added to the seasons reply.
4. Admin web page: `GET /admin` and `/admin/<name>` (`music_web/admin_page.py`, `music_web/admin_static/*`), signs in through `/api/profile/select`, reads `/api/server/seeding` (now includes `total_uploaded`, `total_downloaded`, `global_ratio`). View only. Guard exemptions in `music_web/__init__.py`. Note: the guard returns 410 for non-API pages when `BROWSER_PLAYER` is off; the admin endpoints are exempt.
5. Deploy list updated (`scripts/deploy-native-updates.py`: `tmdb_stills.py`, `admin_page.py`, `admin_static/*`). Security route inventory updated. Python `test_movies` and `test_security_review` pass (run from `tests/` with `PYTHONPATH=..`, scratch venv under the session scratchpad has Flask).

## To do before release
1. **Fix the browser tests** that name the old UI: `tests/movies_downloads.cjs`, `movies_audio_tracks.cjs`, `movies_releases.cjs`, `movies_web.cjs`, `movies_youtube.cjs` (region "On the server" is now "Downloading" and hidden when empty; sort chips hidden; quality guide is `details`/table; seeding badge gone). Add checks for season state chips, `season-episodes` stills (fixture `tests/fixtures/music-popup-host/Program.cs`), and a Python test for `tmdb_stills.StillCache` (second read hits disk, bad paths rejected).
2. **Look at the new screens** at 360/768/1280/2000 px on the four profiles (Windows Chromium, WebKit, Pixel 7, iPhone 13, say they are emulated); screenshots into `docs/verification/movies-polish-2026-11-24/`. Check the release cards, season rows, episode list and `/admin` page. Items from the user not yet addressed: "double info in the top right" of the Movies header (duplicate "Movies & TV" and "Movies"), the odd "Details" button on cards (it holds Play and Add audio track), a neater series page header.
3. **Admin page**: verify sign-in, the global meter and per-file meters against a stub; add `tests/admin_page.cjs` and a Python test (admin gets data; signed-out and non-admin get 401/403). Document `/admin` in `docs/SERVER_HEALTH.md`.
4. **Music question (Nemo)**: Codex found (code only, SSH was blocked in its sandbox): the player lists completed *imports* from `/srv/familyhub/data/quarantine/music/intake`, so files copied straight to the drive have no import record and a refresh will not add them; identical uploads reuse the staged SHA-256 record, and if playback preparation fails the upload counts as saved while the library omits it. Needs a live check: journal lines `failed at stage|import|prepare`, and whether Nemo's files sit under `/srv/familyhub/data/media/music` with import records. Safe retry: Library, Add songs, one missing original.
5. **Release 1.4.0**: bump `ApplicationDisplayVersion` 1.4.0 and `ApplicationVersion` 109 in `clients/FamilyHub.App/FamilyHub.App.csproj`; `scripts/build-native-app.ps1 -Platform Windows -Configuration Release` then `-Platform Android -Configuration Debug` (low priority, background); write notes (direct affirmative wording, no "not just X, it's Y"); tag and push `v1.4.0`; `scripts/publish-native-release.ps1 -NotesFile ... -WindowsDirectory .local/artifacts/native/windows -AndroidPackage .local/artifacts/native/android/FamilyHub-Music.apk` (uploads the draft, deploys the server, publishes); iPhone: `gh workflow run native-ios.yml --ref v1.4.0 -f allowance_checked=true`, then `scripts/publish-ios-release.ps1 -RunId <run>`.
6. After deploy: restart is automatic through the deploy script; check `systemctl is-active familyhub-music-web`, open `https://yeeroo.taile0034e.ts.net:8444/admin`.

## Open decisions for the user
- TV-remote arrow navigation in the player was replaced by seeking; restore?
- Movie import (torrent to Movies) is off until configured (`MOVIE_DOWNLOADS.import`, dry run first).
- Fullscreen over the Windows taskbar, the Reconnect button and live TMDB/Jellyfin subtitles are untested in the real app.
- Paddock workers: Gemini 4 Neon and Hydrogen on StudentAnti and Copilot all failed immediately; Codex (gpt-6.2-sol) works through credits.

## House rules
AGENTS.md interface lessons apply (focus never falls to body, scoped class names, four-profile checks stated as emulated, no baked-in text in artwork). Background jobs at low priority with one CPU free; no test windows on the user's screen.
