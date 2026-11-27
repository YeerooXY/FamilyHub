const { useMovieBridge, reviewMovieProfiles, playerOutput, movieAssetPath } = require("./movies_fixture.cjs");
// Episodes and Next Episode exist only for a title that belongs to a series. A film shows neither.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const ticks = 1e7;
const episodes = ["Pilot", "The Move", "Visitors"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ParentIndexNumber: 1, IndexNumber: i + 1,
    RunTimeTicks: 1800 * ticks, Overview: "A visitor arrives in the harbour.",
    ImageTags: {}, UserData: i === 0 ? { PlayedPercentage: 40, PlaybackPositionTicks: 720 * ticks } : {} }));
episodes.push({...episodes[0], Id: "s2e1", Name: "Return to Port", ParentIndexNumber: 2, UserData: {}});
const film = { Id: "f", Name: "Harbour Lights", Type: "Movie", OfficialRating: "PG-13", RunTimeTicks: 3600 * ticks,
    ImageTags: {}, UserData: {PlaybackPositionTicks: 600 * ticks} };
const series = { Id: "s", Name: "Harbour Town", Type: "Series", ProviderIds: { Tmdb: "42" } };
const clip = (Type, start, end) => ({Type, StartTicks: start * ticks, EndTicks: end * ticks});

async function check(browser, profile, options) {
    const { tv, ...contextOptions } = options;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.clock.install();
    const captures = process.argv[2] || playerOutput;
    const capture = state => page.screenshot({path: path.join(captures, `${profile}-${state}.png`), animations: "disabled", scale: "css"});
    let guideReads = 0;
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = () => Promise.resolve();
        HTMLMediaElement.prototype.canPlayType = () => "probably";
        // The fixture clip may not decode in every engine; these checks cover the player screens, not stream recovery (movies_player does).
        document.addEventListener("error", event => { if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation(); }, true);
        Element.prototype.requestFullscreen = undefined;
        Element.prototype.webkitRequestFullscreen = undefined;
    });
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        return name ? route.fulfill({ path: movieAssetPath(name) })
            : route.fulfill({ contentType: "text/html", body: `
                <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
                <link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/app-native.css">
                <link rel="stylesheet" href="/movies.css"><link rel="stylesheet" href="/hub.css">
                <a href="#content" class="skip">Skip to content</a>
                <header class="app-header"><button type="button">Switch apps</button></header>
                <div class="workspace" data-app-view="Movies &amp; TV">
                  <main id="content"><div class="movie-library"></div></main>
                </div>` });
    });
    await page.route(jellyfin + "/**", route => {
        const url = new URL(route.request().url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (/^\/Videos\/[^/]+\/stream$/i.test(url.pathname))
            return route.fulfill({headers, path: path.join(__dirname, "fixtures/movie-subtitles.mp4"), contentType: "video/mp4"});
        const list = Items => route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
        if (url.pathname.endsWith("/PlaybackInfo"))
            return route.fulfill({ headers, json: { PlaySessionId: "p", MediaSources: [{ Id: "src", SupportsDirectPlay: true,
                DefaultAudioStreamIndex: 1, DefaultSubtitleStreamIndex: -1, MediaStreams: [{ Type: "Audio", Index: 1, Language: "eng" }] }] } });
        if (url.pathname === "/Shows/s/Episodes") return list(episodes);
        if (url.pathname.startsWith("/MediaSegments/")) {
            const rows = url.pathname.endsWith("/f") ? [clip("Intro", 10, 30), clip("Outro", 3510, 3550)] :
                url.pathname.endsWith("/e1") ? [clip("Recap", 5, 20), clip("Outro", 1750, 1800)] : [];
            return route.fulfill({headers, json: rows});
        }
        if (url.pathname.startsWith("/ParentalGuide/")) {
            guideReads++;
            return route.fulfill({headers, json: {Rating: "PG", Categories: {violence: "moderate", language: "mild"}}});
        }
        if (url.pathname === "/Items") return list(url.searchParams.get("includeItemTypes") === "Series" ? [series] : [film]);
        if (url.pathname === "/UserItems/Resume") return list([]);
        if (url.pathname === "/Items/f") return route.fulfill({headers, json: film});
        if (url.pathname.startsWith("/Items/")) return route.fulfill({ headers, json: {} });
        if (url.pathname.includes("/Sessions/Playing")) return route.fulfill({ headers, status: 204 });
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    const touch = options.hasTouch && await page.evaluate(() => !matchMedia("(hover: hover) and (pointer: fine)").matches);
    await page.evaluate(async jellyfin => {
        const {openMovies, readMoviePreferences, saveMoviePreferences} = await import("/movies.js");
        const viewer = {server: jellyfin + "/", profile: "viewer"};
        window.fixturePreferences = changes => saveMoviePreferences(viewer, {...readMoviePreferences(viewer), ...changes});
        window.movies = window.openMovieFixture(openMovies, document.querySelector(".movie-library"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef" },
            { invokeMethodAsync: async method => method === "MovieMatches" ? JSON.stringify({
                seasons: [{number:1, episode_count:3}, {number:2, episode_count:1}, {number:3, episode_count:8}]
            }) : undefined }, { server: location.origin, profile: "viewer" });
    }, jellyfin);
    const shelf = page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: "Series", exact: true }) });
    const back = page.getByRole("button", { name: "Back to movies" });
    const shell = page.locator(".app-header");
    const filmCard = page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: "Movies", exact: true }) })
        .getByRole("button", { name: "Harbour Lights" });
    assert.equal(await shell.isVisible(), true);

    // A film: no series buttons.
    await filmCard.click();
    const filmDetails = page.getByRole("region", {name:"Harbour Lights", exact:true});
    const filmPlay = filmDetails.getByRole("button", {name:"Continue from 10:00", exact:true});
    // "Continue from 10:00" already names the position, so it resumes without asking again.
    const prompt = page.getByRole("dialog", {name: "Welcome back"});
    await filmPlay.click();
    await back.waitFor();
    assert.equal(await prompt.count(), 0, "the title page Continue button resumes directly");
    const media = page.locator(".movie-video");
    const setMedia = (values, ...events) => media.evaluate((video, {values, events}) => {
        for (const [key, value] of Object.entries(values))
            Object.defineProperty(video, key, {value, configurable: true, writable: true});
        for (const type of events) video.dispatchEvent(new Event(type));
    }, {values, events});
    await setMedia({currentTime: 0, duration: 3600}, "loadedmetadata");
    // The resume seek itself is covered by movies_player; start the segment checks from 0.
    await setMedia({currentTime: 0}, "timeupdate");
    assert.equal(await shell.isVisible(), false);
    assert.equal(await page.getByRole("link", {name:"Skip to content"}).isVisible(), false);
    await page.locator(".movie-video").evaluate(video => { video.poster = "/movie-art/movie.jpg"; });
    const fullscreen = await page.locator(".movie-video").evaluate(video => {
        const edges = node => {
            const {left, top, right, bottom} = node.getBoundingClientRect();
            return [left, top, right, bottom];
        };
        return {video: edges(video), player: edges(video.closest(".movie-player")), viewport: [0, 0, innerWidth, innerHeight]};
    });
    assert.deepEqual(fullscreen.video, fullscreen.player, `${profile}: video covers the player`);
    // Mobile emulation can round viewport and fixed element bounds differently.
    assert.ok(fullscreen.player.every((edge, index) => Math.abs(edge - fullscreen.viewport[index]) <= 1.5),
        `${profile}: player covers the viewport ${JSON.stringify(fullscreen)}`);
    assert.equal(await page.getByRole("button", { name: "Episodes" }).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).isVisible(), false);
    // Controls hide a few seconds after the last touch, also when paused and also with reduced motion (many phones set it).
    const idle = () => page.evaluate(() => document.querySelector(".movie-ui").classList.contains("movie-idle"));
    // The fixture clip may not decode in every engine; a failed start keeps the controls up on purpose, so mark playback as started.
    await page.locator(".movie-video").evaluate(video => video.dispatchEvent(new Event("playing")));
    // A TV remote keeps the controls up while its focus ring shows; everywhere else they hide.
    if (!tv) await page.waitForFunction(() => document.querySelector(".movie-ui")?.classList.contains("movie-idle"), null, { timeout: 6000 });
    assert.equal(guideReads, 0, "parental guide defaults to off");
    assert.equal(await shell.isVisible(), false);
    if (!tv) await capture("idle");
    await setMedia({currentTime: 12}, "timeupdate");
    const skipIntro = page.getByRole("button", {name: "Skip intro", exact: true});
    await skipIntro.waitFor();
    // TV: a wide screen with no volume slider (the player's own TV rule). Desktop monitors keep arrow seeking.
    if (tv) {
        assert.equal(await skipIntro.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("ArrowDown");
        assert.equal(await page.locator(".movie-seek").evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("ArrowUp");
        assert.equal(await skipIntro.evaluate(node => node === document.activeElement), true);
    } else assert.equal(await idle(), true, "skip remains visible with idle controls");
    await capture("skip-intro");
    await (touch ? skipIntro.tap() : skipIntro.press("Enter"));
    assert.equal(await media.evaluate(video => video.currentTime), 30);
    if (options.reducedMotion === "reduce")
        assert.equal(await page.locator(".movie-segment-skip").evaluate(node => getComputedStyle(node).transitionDuration), "0s");
    await skipIntro.waitFor({state: "hidden"});
    await setMedia({currentTime: 3520}, "timeupdate");
    const skipCredits = page.getByRole("button", {name: "Skip credits", exact: true});
    await (touch ? skipCredits.tap() : skipCredits.click());
    assert.equal(await media.evaluate(video => video.currentTime), 3550, "credits skip preserves the post-credits scene");
    await page.clock.runFor(3100);
    if (touch) {
        const tapPicture = () => page.locator(".movie-ui-surface").tap({position: {x: 20, y: 200}});
        // A tap wakes hidden controls; the next tap hides them at once, like YouTube.
        await tapPicture();
        assert.equal(await idle(), false, "tap shows hidden controls");
        await tapPicture();
        assert.equal(await idle(), true, "tap hides visible controls immediately");
        await tapPicture();
    } else {
        await page.mouse.move(300, 300);
        await page.waitForFunction(() => !document.querySelector(".movie-ui").classList.contains("movie-idle"));
    }
    assert.equal(await shell.isVisible(), false);
    await capture("controls");
    if (touch) await back.tap();
    else {
        await back.focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest(".movie-ui"))), true);
        const focused = page.locator(":focus");
        const label = await focused.getAttribute("aria-label");
        await page.keyboard.press("Space");
        assert.equal(await focused.getAttribute("aria-label"), label);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await back.evaluate(node => document.activeElement === node), true);
        await back.press("Enter");
    }
    await back.waitFor({ state: "hidden" });
    assert.equal(await shell.isVisible(), true);
    assert.equal(await filmPlay.evaluate(node => document.activeElement === node), true);
    await filmDetails.getByRole("button", {name:"Back to titles"}).press("Enter");
    assert.equal(await filmCard.evaluate(node => document.activeElement === node), true);
    await page.evaluate(() => window.fixturePreferences({parentalGuide: true, autoSkipRecap: true}));

    // An episode: title shows season and episode, the sheet lists the season, Next plays the following episode.
    await shelf.getByRole("button", { name: "Harbour Town" }).click();
    const seasons = page.getByRole("group", {name: "Seasons"});
    await seasons.getByRole("button", {name: "Season 3", exact: true}).press("Space");
    await page.getByRole("button", { name: "Find season 3" }).waitFor();
    assert.equal(await page.getByText("3 seasons", {exact: true}).count(), 0);
    await seasons.getByRole("button", {name: "Season 1", exact: true}).press("Enter");
    // An episode row with a saved position asks once, in friendly words, with no percentages or timestamps.
    const pilot = page.locator("button.movie-episode-body").filter({hasText: "Pilot"});
    await pilot.click();
    const resume = prompt.getByRole("button", {name: "Resume", exact: true});
    await resume.waitFor();
    assert.equal(await resume.evaluate(node => node === document.activeElement), true);
    assert.match(await prompt.innerText(), /Pick up where you left off\?[\s\S]*About \d+ minutes left/);
    assert.doesNotMatch(await prompt.innerText(), /%|\d:\d\d/);
    await capture("resume");
    await page.keyboard.press("Escape");
    await prompt.waitFor({state: "hidden"});
    assert.equal(await pilot.evaluate(node => node === document.activeElement), true, "Escape returns focus to the episode");
    const episodeOpener = page.getByRole("button", { name: "2. The Move" });
    await episodeOpener.click();
    await page.getByRole("heading", { name: "S1:E2 “The Move”" }).waitFor();
    await setMedia({currentTime: 8, duration: 1800, paused: false}, "playing", "timeupdate");
    const guide = page.getByRole("region", {name: "Parental guide"});
    await guide.getByRole("img", {name: "Age rating 6"}).waitFor();
    assert.deepEqual(await guide.getByRole("listitem").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))),
        ["Violence: moderate", "Language: mild"]);
    await page.getByRole("status").filter({hasText: "Skipped recap"}).waitFor();
    assert.equal(await media.evaluate(video => video.currentTime), 20);
    await capture("parental-guide");
    await page.clock.runFor(6100);
    await guide.waitFor({state: "hidden"});
    const episodesButton = page.getByRole("button", { name: "Episodes", exact: true });
    await episodesButton.waitFor();
    const next = page.getByRole("button", { name: "Next episode: Visitors" });
    await next.waitFor();
    // The controls have auto-hidden by now; keyboard focus brings them back.
    await episodesButton.focus();
    await episodesButton.press("Enter");
    const rows = page.locator(".movie-episode");
    assert.equal(await rows.count(), 3);
    assert.equal(await page.locator(".movie-episode[aria-current='true']").innerText(), "2. The Move");
    // Android Back (familyhub.closeTopLayer) sends movie-back: it closes the sheet first, then the player.
    await page.locator(".movie-ui").dispatchEvent("movie-back");
    await page.getByRole("button", { name: "Close episodes" }).waitFor({ state: "hidden" });
    assert.equal(await back.isVisible(), true, "Back closes the sheet before the player");
    await page.mouse.move(4, 4); // Playwright clicks are mouse input even on touch profiles; park the pointer off the card.
    await setMedia({currentTime: 1751}, "timeupdate");
    const nextCard = page.getByRole("region", {name: "Next episode"});
    await nextCard.getByRole("heading", {name: "Visitors"}).waitFor();
    assert.equal(await page.getByRole("button", {name: "Skip credits", exact: true}).isVisible(), false,
        "the next-episode card replaces the Skip credits pill");
    assert.match(await nextCard.innerText(), /S1 E3[\s\S]*A visitor arrives in the harbour\./);
    const count = nextCard.locator(".movie-next-count");
    const playNow = nextCard.getByRole("button", {name: "Play now"});
    await playNow.focus();
    await capture("next-episode");
    const pausedAt = await count.innerText();
    await page.clock.runFor(2200);
    assert.equal(await count.innerText(), pausedAt, "focus pauses the countdown");
    await back.focus();
    if (!touch) {
        await nextCard.hover();
        const hoveredAt = await count.innerText();
        await page.clock.runFor(2200);
        assert.equal(await count.innerText(), hoveredAt, "hover pauses the countdown");
        await page.mouse.move(4, 4);
    }
    await page.evaluate(() => window.fixturePreferences({autoNext: false}));
    await page.clock.runFor(10200);
    await page.getByRole("heading", { name: "S1:E3 “Visitors”" }).waitFor();
    await setMedia({currentTime: 1780, duration: 1800, paused: false}, "playing", "timeupdate");
    await nextCard.getByRole("heading", {name: "Return to Port"}).waitFor();
    assert.equal(await count.isVisible(), false, "autoplay off keeps the card and removes the countdown");
    await page.clock.runFor(10200);
    assert.equal(await nextCard.isVisible(), true);
    assert.equal(guideReads, 1, "the guide only loads for the first episode of the session");
    await nextCard.getByRole("button", {name: "Watch credits"}).click();
    assert.equal(await nextCard.isVisible(), false);
    await page.getByRole("button", { name: "Next episode: Return to Port" }).click();
    await page.getByRole("heading", { name: "S2:E1 “Return to Port”" }).waitFor();
    await episodesButton.waitFor();
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).isVisible(), false, "the last episode has no Next Episode");
    await episodesButton.click();
    assert.deepEqual(await rows.allInnerTexts(), ["1. Return to Port"], "Episodes shows only the current season");
    await page.locator(".movie-ui").dispatchEvent("movie-back");
    await page.getByRole("button", { name: "Close episodes" }).waitFor({ state: "hidden" });
    await page.locator(".movie-ui").dispatchEvent("movie-back");
    await back.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".movie-player.movie-expanded").count(), 0, "Back closes the player");
    assert.equal(await episodeOpener.evaluate(node => document.activeElement === node), true);
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    fs.mkdirSync(process.argv[2] || playerOutput, {recursive: true});
    await reviewMovieProfiles(check);
    const { chromium } = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
    const tvBrowser = await chromium.launch({headless: true});
    try {
        await check(tvBrowser, "android-tv-1920", {viewport: {width: 1920, height: 1080}, tv: true,
            userAgent: "Mozilla/5.0 (Linux; Android 12; SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"});
    } finally {
        await tvBrowser.close();
    }
    console.log("Episodes, fullscreen header, idle controls and focus passed in seven browser profiles, including TV.");
})().catch(error => { console.error(error); process.exit(1); });
