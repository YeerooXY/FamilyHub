const { useMovieBridge, reviewMovieProfiles, playerOutput } = require("./movies_fixture.cjs");
// Episodes and Next Episode exist only for a title that belongs to a series. A film shows neither.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const episodes = ["Pilot", "The Move", "Visitors"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ParentIndexNumber: 1, IndexNumber: i + 1,
    ImageTags: {}, UserData: i === 0 ? { PlayedPercentage: 40 } : {} }));
episodes.push({...episodes[0], Id: "s2e1", Name: "Return to Port", ParentIndexNumber: 2, UserData: {}});
const film = { Id: "f", Name: "Harbour Lights", Type: "Movie", ImageTags: {} };
const series = { Id: "s", Name: "Harbour Town", Type: "Series", ProviderIds: { Tmdb: "42" } };

async function check(browser, profile, options) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
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
        if (name === "shell.css") return route.fulfill({path: path.join(wwwroot, "../../../music_web/static/shell.css")});
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
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
        if (url.pathname === "/Items") return list(url.searchParams.get("includeItemTypes") === "Series" ? [series] : [film]);
        if (url.pathname === "/UserItems/Resume") return list([]);
        if (url.pathname.startsWith("/Items/")) return route.fulfill({ headers, json: {} });
        if (url.pathname.includes("/Sessions/Playing")) return route.fulfill({ headers, status: 204 });
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    const touch = options.hasTouch && await page.evaluate(() => !matchMedia("(hover: hover) and (pointer: fine)").matches);
    await page.evaluate(async jellyfin => {
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector(".movie-library"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef" },
            { invokeMethodAsync: async method => method === "MovieMatches" ? JSON.stringify({
                seasons: [{number:1, episode_count:3}, {number:2, episode_count:1}, {number:3, episode_count:8}]
            }) : undefined }, { server: location.origin, profile: "viewer" });
    }, jellyfin);
    const shelf = page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: "TV series" }) });
    const back = page.getByRole("button", { name: "Back to movies" });
    const shell = page.locator(".app-header");
    const filmCard = page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: "Movies", exact: true }) })
        .getByRole("button", { name: "Harbour Lights" });
    assert.equal(await shell.isVisible(), true);

    // A film: no series buttons.
    await filmCard.click();
    const filmDetails = page.getByRole("region", {name:"Harbour Lights", exact:true});
    const filmPlay = filmDetails.getByRole("button", {name:"Play", exact:true});
    await filmPlay.click();
    await back.waitFor();
    assert.equal(await shell.isVisible(), false);
    assert.equal(await page.getByRole("link", {name:"Skip to content"}).isVisible(), false);
    await page.locator(".movie-video").evaluate(video => { video.poster = "/movie-art/movie.jpg"; });
    assert.deepEqual(await page.locator(".movie-video").evaluate(video => {
        const bounds = video.getBoundingClientRect();
        return [bounds.left, bounds.top, bounds.width, bounds.height];
    }), [0, 0, options.viewport.width, options.viewport.height]);
    assert.equal(await page.getByRole("button", { name: "Episodes" }).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).isVisible(), false);
    // Controls hide a few seconds after the last touch, also when paused and also with reduced motion (many phones set it).
    const idle = () => page.evaluate(() => document.querySelector(".movie-ui").classList.contains("movie-idle"));
    // The fixture clip may not decode in every engine; a failed start keeps the controls up on purpose, so mark playback as started.
    await page.locator(".movie-video").evaluate(video => video.dispatchEvent(new Event("playing")));
    await page.waitForFunction(() => document.querySelector(".movie-ui")?.classList.contains("movie-idle"), null, { timeout: 6000 });
    assert.equal(await shell.isVisible(), false);
    const captures = process.argv[2] || playerOutput;
    await page.screenshot({path: path.join(captures, profile + "-idle.png"), animations: "disabled", scale: "css"});
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
    await page.screenshot({path: path.join(captures, profile + "-controls.png"), animations: "disabled", scale: "css"});
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

    // An episode: title shows season and episode, the sheet lists the season, Next plays the following episode.
    await shelf.getByRole("button", { name: "Harbour Town" }).click();
    const seasons = page.getByRole("group", {name: "Seasons"});
    await seasons.getByRole("button", {name: "Season 3", exact: true}).press("Space");
    await page.getByRole("button", { name: "Find season 3" }).waitFor();
    await page.getByText("3 seasons", {exact: true}).waitFor();
    await seasons.getByRole("button", {name: "Season 1", exact: true}).press("Enter");
    const episodeOpener = page.getByRole("button", { name: "2. The Move" });
    await episodeOpener.click();
    await page.getByRole("heading", { name: "S1:E2 “The Move”" }).waitFor();
    const episodesButton = page.getByRole("button", { name: "Episodes", exact: true });
    await episodesButton.waitFor();
    const next = page.getByRole("button", { name: "Next episode: Visitors" });
    await next.waitFor();
    await episodesButton.click();
    const rows = page.locator(".movie-episode");
    assert.equal(await rows.count(), 3);
    assert.equal(await page.locator(".movie-episode[aria-current='true']").innerText(), "2. The Move");
    // Android Back (familyhub.closeTopLayer) sends movie-back: it closes the sheet first, then the player.
    await page.locator(".movie-ui").dispatchEvent("movie-back");
    await page.getByRole("button", { name: "Close episodes" }).waitFor({ state: "hidden" });
    assert.equal(await back.isVisible(), true, "Back closes the sheet before the player");
    await next.click();
    await page.getByRole("heading", { name: "S1:E3 “Visitors”" }).waitFor();
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
    console.log("Episodes, fullscreen header, idle controls and focus passed in six browser profiles.");
})().catch(error => { console.error(error); process.exit(1); });
