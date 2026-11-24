const { useMovieBridge, reviewMovieProfiles } = require("./movies_fixture.cjs");
// Renders the Movies & TV library from a dense mocked Jellyfin and saves screenshots for review.
// Usage: node tests/movies_visual.cjs [output-dir]   (emulated engines and device profiles, not real devices)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.resolve(process.argv[2] || path.join(__dirname, "../docs/verification/movies-ui-2026-11-22"));
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const titles = ["Harbour Lights", "The Long Way Home", "Paper Moons", "Northern Rail", "Quiet Orchard", "Glass Season",
    "Summer of Wires", "Low Tide", "The Last Ferry", "Copper Hills", "Night Market", "A Small Revolution",
    "Winter Garden", "Salt and Iron", "Midnight Bakery", "River Street", "Open Fields", "Golden Hour"];
const movies = titles.map((Name, i) => ({ Id: "m" + i, Name, Type: "Movie", ProductionYear: 2008 + i, OfficialRating: i % 3 ? "PG-13" : "PG",
    RunTimeTicks: (80 + i * 4) * 6e8, Genres: i === 0 ? ["Drama", "Comedy"] : [["Drama", "Comedy", "Thriller"][i % 3]],
    Overview: "A quiet town gets a visitor with a map nobody has seen, and one evening decides what everyone does next.",
    BackdropImageTags: i < 2 ? ["b"] : undefined, ImageTags: i < 6 ? { Primary: "p" } : undefined,
    UserData: i === 1 ? { PlaybackPositionTicks: 40 * 6e8, PlayedPercentage: 42 } : {} }));
const episodes = ["Pilot", "The Move", "Visitors", "Snow Day", "Finale", "Reunion"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ParentIndexNumber: 1, IndexNumber: i + 1,
    UserData: i === 0 ? {Played: true} : i === 1 ? {PlayedPercentage: 40} : {}, ImageTags: { Thumb: "t" } }));
const series = {Id: "s", Name: "Harbour Town", Type: "Series", ProviderIds: {Tmdb: "42"}};

async function verifyRazorShell(browser, url) {
    const page = await browser.newPage();
    try {
        page.setDefaultTimeout(8000);
        assert.ok((await page.request.post(new URL("/fixture/startup/movies-polish", url).href)).ok());
        await page.goto(url);
        await page.getByRole("button", {name: "Switch apps"}).click();
        await page.getByRole("button", {name: /Movies & TV/}).click();
        await page.getByRole("button", {name: /^Harbour Town/}).press("Enter");
        await page.getByText("Downloading 30% · about 3 min left", {exact: true}).waitFor();
        await page.getByLabel("Episodes for season 1").press("Space");
        const still = page.locator('[data-season="1"] img');
        await still.waitFor();
        await page.waitForFunction(image => image.naturalWidth > 0, await still.elementHandle());
        assert.equal(await page.getByRole("heading", {name: "Movies & TV", exact: true}).count(), 1);
    } finally {
        await page.close();
    }
}

async function render(browser, label, options) {
    if (label === "windows-chromium-1280" && process.env.MOVIES_FIXTURE_URL)
        await verifyRazorShell(browser, process.env.MOVIES_FIXTURE_URL);
    const page = await browser.newPage(options);
    page.setDefaultTimeout(8000);
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({path: path.join(wwwroot, "../../../music_web/static/shell.css")});
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", route => {
        const req = route.request(), url = new URL(req.url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        const list = (Items, TotalRecordCount = Items.length) => route.fulfill({ headers, json: { Items, TotalRecordCount } });
        if (url.pathname.includes("/Images/")) {
            const art = url.pathname.endsWith("/Backdrop") ? "movie.jpg" : url.pathname.includes("/Items/e") ? "episode.jpg" : "movie-alt.jpg";
            return route.fulfill({ headers, path: path.join(wwwroot, "movie-art", art) });
        }
        if (url.pathname === "/Genres") return route.fulfill({ headers, json: { Items: [{ Name: "Drama" }, { Name: "Comedy" }, { Name: "Thriller" }] } });
        if (url.pathname === "/UserItems/Resume") return list([movies[1], episodes[1], episodes[2]]);
        if (url.pathname === "/Shows/s/Episodes") return list(episodes);
        if (url.pathname === "/Items/s") return route.fulfill({headers, json: series});
        if (url.pathname === "/Items") {
            const types = url.searchParams.get("includeItemTypes");
            const genre = url.searchParams.get("genres");
            if (types === "Series") return list([series]);
            if (types === "Movie,Series") return list([movies[1], movies[6], series], 19);
            return list(genre ? movies.filter(m => m.Genres.includes(genre)) : movies);
        }
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    const still = "data:image/jpeg;base64," + fs.readFileSync(path.join(wwwroot, "movie-art", "episode.jpg")).toString("base64");
    await page.evaluate(async ({jellyfin, still}) => {
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
            { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef", downloads_enabled: true, release_search_enabled: true },
            { invokeMethodAsync: async (method, query, season) => {
                if (method === "MovieMatches" && query === "tmdb:tv:42") {
                    if (!window.seasonLookup) { window.seasonLookup = true; return JSON.stringify({error:"Try again"}); }
                    return JSON.stringify({series_id: 42, seasons: [
                        {number: 1, episode_count: 6}, {number: 2, episode_count: 8}, {number: 3, episode_count: 3}
                    ]});
                }
                if (method === "MovieMatches") return JSON.stringify({
                    matches: [{title:"Harbour Town", kind:"tv", poster:"/movie-art/movie-alt.jpg"}]
                });
                if (method === "MovieSeasonEpisodes") {
                    (window.stillCalls ??= []).push([query, season]);
                    return JSON.stringify({episodes: [{number: 1, name: season === 1 ? "Pilot" : "Across the Bay", still},
                        {number: 2, name: "Episode without a picture", still: null}]});
                }
                if (method === "MovieDownloads") return JSON.stringify({available:true, items:[
                    {name:"Harbour.Town.S02.1080p", progress:.3, state:"Downloading", eta:125},
                    {name:"Harbour Lights 2008", progress:1, state:"Seeding", ratio:1.25},
                    {name:"Paper Moons 2008", progress:1, state:"Finished"}
                ]});
                if (method === "MovieReleaseSearch") {
                    window.releaseQuery = query;
                    return JSON.stringify({results: [{title:"Harbour Town S03 1080p", size:1e9, seeders:30}],
                        title_details: {title:"Harbour Town", kind:"tv", season:3, poster:"/movie-art/movie-alt.jpg"}});
                }
                return JSON.stringify({results: []});
            } }, { server: location.origin, profile: "viewer" });
    }, {jellyfin, still});
    await page.locator(".movie-hero-play").waitFor();
    await page.locator(".movie-card").first().waitFor();
    assert.equal(await page.locator("body").evaluate(node => node.scrollWidth <= innerWidth), true, label + " overflows horizontally");
    assert.equal(await page.locator(".movie-hero-play").innerText(), "Resume");
    assert.ok(await page.locator(".movie-progress").count() >= 2, label + " shows progress");
    const shelves = page.locator(".movie-shelf:not([hidden])");
    await shelves.locator('[data-item-id="m17"]').waitFor();
    const drama = shelves.filter({has:page.getByRole("heading", {name:"Drama", exact:true})});
    await drama.locator('[data-item-id="m0"]').waitFor();
    const ids = await shelves.locator(".movie-card").evaluateAll(cards => cards.map(card => card.dataset.itemId));
    assert.equal(ids.length, new Set(ids).size, label + " shows each title once");
    assert.equal(await shelves.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth &&
        node.querySelector(".movie-cards").scrollWidth <= node.querySelector(".movie-cards").clientWidth)), true);
    const cards = shelves.locator(".movie-card");
    const show = cards.filter({hasText:"Harbour Town"});
    await show.getByText("Downloading 30%").waitFor();
    assert.equal(await cards.filter({hasText:"Harbour Lights"}).locator(".movie-download-badge").isVisible(), false);
    assert.equal(await cards.filter({hasText:"Paper Moons"}).locator(".movie-download-badge").isVisible(), false);
    const hues = await cards.locator(".movie-art").evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue("--art-hue")));
    assert.ok(new Set(hues).size > 1);
    // Keyboard: Play, Down into the first shelf, Right along a row, Up back to the billboard.
    await page.locator(".movie-hero-play").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("movie-card")), true, label + " ArrowDown reaches a card");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("movie-hero-play")), true, label + " ArrowUp returns to Play");
    const focus = locator => locator.evaluate(node => node === document.activeElement);
    await show.press("Enter");
    const detail = page.getByRole("region", {name:"Harbour Town", exact:true});
    const retry = detail.getByRole("button", {name:"Retry season lookup"});
    await retry.waitFor();
    assert.equal(await focus(detail.getByRole("heading", {name:"Harbour Town", exact:true})), true);
    await detail.getByRole("status").getByText("The full season list is unavailable.").waitFor();
    assert.equal(await detail.getByRole("button", {name:"Find season 2"}).count(), 0);
    await retry.press("Enter");
    await detail.getByText("3 seasons in total").waitFor();
    await detail.getByText("1 of 6 watched").waitFor();
    const state = season => detail.locator(`[data-season="${season}"] .movie-season-state`);
    assert.equal(await state(1).textContent(), "Available");
    assert.equal(await state(2).textContent(), "Downloading 30% · about 3 min left");
    assert.equal(await state(3).textContent(), "Missing");
    assert.equal(await detail.getByRole("button", {name:"Find season 2"}).isVisible(), false);
    const find = detail.getByRole("button", {name:"Find season 3", exact:true});
    const minTarget = options.viewport.width >= 1600 ? 60 : 44;
    assert.ok((await find.boundingBox()).height >= minTarget);
    const disclosure = detail.getByLabel("Episodes for season 1");
    await detail.getByRole("button", {name:"Back to titles"}).focus();
    await page.keyboard.press("Tab");
    assert.equal(await focus(disclosure), true);
    await page.keyboard.press("Space");
    await detail.getByText("40% watched").waitFor();
    assert.equal(await focus(disclosure), true);
    const image = detail.locator('[data-season="1"] img').first();
    await image.waitFor();
    await page.waitForFunction(img => img.naturalWidth > 0, await image.elementHandle());
    await disclosure.press("Space");
    await disclosure.press("Enter");
    await detail.getByLabel("Episodes for season 2").press("Enter");
    await detail.getByText("Across the Bay", {exact:false}).waitFor();
    assert.equal(await detail.locator('[data-season="2"] .movie-episode-marker').first().textContent(), "Downloading");
    assert.deepEqual(await page.evaluate(() => window.stillCalls), [[42,1], [42,2]]);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path: path.join(out, label + "-episodes.png"), fullPage: true});
    await find.focus();
    await page.keyboard.press("Escape");
    assert.equal(await focus(show), true);
    await show.press("Space");
    await find.waitFor();
    await page.screenshot({path: path.join(out, label + "-seasons.png"), fullPage: true});
    if (options.hasTouch) await find.tap();
    else await find.press("Enter");
    assert.equal(await page.getByRole("searchbox").inputValue(), "Harbour Town S03");
    assert.equal(await focus(page.getByRole("button", {name:"Search", exact:true})), true);
    await page.getByRole("list", {name:"Release results"}).getByText("Full season 3").waitFor();
    const poster = page.locator(".movie-release-poster");
    await poster.scrollIntoViewIfNeeded();
    await page.waitForFunction(img => img.naturalWidth > 0, await poster.elementHandle());
    assert.equal(await page.evaluate(() => window.releaseQuery), "Harbour Town S03");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByText("Quality guide", {exact:true}).press("Enter");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path: path.join(out, label + "-releases.png"), fullPage: true, animations: "disabled"});
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    fs.mkdirSync(out, { recursive: true });
    await reviewMovieProfiles(render);
    console.log("Movies UI rendered in six browser profiles: " + out);
})().catch(error => { console.error(error); process.exit(1); });
