const { useMovieBridge, reviewMovieProfiles, dismissPlayerTracks, homeOutput, playerOutput } = require("./movies_fixture.cjs");
// Renders the Movies & TV library from a dense mocked Jellyfin and saves screenshots for review.
// Usage: node tests/movies_visual.cjs [output-dir]   (emulated engines and device profiles, not real devices)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.resolve(process.argv[2] || homeOutput);
const playerCaptures = path.resolve(process.argv[2] || playerOutput);
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const titles = ["Harbour Lights", "The Long Way Home", "Paper Moons", "Northern Rail", "Quiet Orchard", "Glass Season",
    "Summer of Wires", "Low Tide", "The Last Ferry", "Copper Hills", "Night Market", "A Small Revolution",
    "Winter Garden", "Salt and Iron", "Midnight Bakery", "River Street", "Open Fields",
    "The Golden Hour on the Last Day of the Year Before the River Froze"];
const movies = titles.map((Name, i) => ({ Id: "m" + i, Name, Type: "Movie", ProductionYear: 2008 + i, OfficialRating: i % 3 ? "PG-13" : "PG",
    RunTimeTicks: (80 + i * 4) * 6e8, Genres: i === 0 ? ["Drama", "Comedy"] : [["Drama", "Comedy", "Thriller"][i % 3]],
    Overview: "A quiet town gets a visitor with a map nobody has seen, and one evening decides what everyone does next.",
    BackdropImageTags: i < 2 ? ["b"] : undefined, ImageTags: i < 6 ? { Primary: "p" } : undefined,
    UserData: i === 1 ? { PlaybackPositionTicks: 40 * 6e8, PlayedPercentage: 42 } : {} }));
const episodes = ["Pilot", "The Move", "Visitors", "Snow Day", "Finale", "Reunion"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ParentIndexNumber: i < 4 ? 1 : 2,
    IndexNumber: i < 4 ? i + 1 : i - 3, RunTimeTicks: (36 + i) * 6e8,
    UserData: i === 0 ? {Played: true} : i === 1 ? {PlayedPercentage: 40} : {}, ImageTags: { Thumb: "t" } }));
const series = {Id: "s", Name: "Harbour Town", Type: "Series", ProviderIds: {Tmdb: "42"}};

async function verifyRazorShell(browser, url) {
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Use a local Razor stub");
    const page = await browser.newPage();
    try {
        page.setDefaultTimeout(8000);
        assert.ok((await page.request.post(new URL("/fixture/startup/movies-polish", url).href)).ok());
        await page.goto(url);
        await page.getByRole("button", {name: "Switch apps"}).click();
        await page.getByRole("button", {name: /Movies & TV/}).click();
        await page.getByRole("button", {name: /^Harbour Town/}).press("Enter");
        await page.getByLabel("Season", {exact: true}).selectOption("1");
        const still = page.locator('[data-season="1"] img').first();
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
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.canPlayType = () => "probably";
    });
    let empty = false, failEpisodes = true, failResume = false, holdResume, imported = false;
    const gate = new Promise(resolve => { holdResume = resolve; });
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({path: path.join(wwwroot, "../../../music_web/static/shell.css")});
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", async route => {
        const req = route.request(), url = new URL(req.url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        const list = (Items, TotalRecordCount = Items.length) => route.fulfill({ headers, json: { Items, TotalRecordCount } });
        if (url.pathname.endsWith("/PlaybackInfo"))
            return route.fulfill({headers, json:{PlaySessionId:"movie-session", MediaSources:[{Id:"src", SupportsDirectPlay:true,
                DefaultAudioStreamIndex:1, DefaultSubtitleStreamIndex:-1, MediaStreams:[{Type:"Audio", Index:1, Language:"eng"}]}]}});
        if (/^\/Videos\/[^/]+\/stream$/i.test(url.pathname))
            return route.fulfill({headers, path:path.join(__dirname, "fixtures/movie-subtitles.mp4"), contentType:"video/mp4"});
        if (url.pathname.startsWith("/Sessions/")) return route.fulfill({headers, status:204});
        if (url.pathname.includes("/Images/")) {
            const art = url.pathname.endsWith("/Backdrop") ? "movie.jpg" : url.pathname.includes("/Items/e") ? "episode.jpg" : "movie-alt.jpg";
            return route.fulfill({ headers, path: path.join(wwwroot, "movie-art", art) });
        }
        if (url.pathname === "/Genres") return list(empty ? [] : [{ Name: "Drama" }, { Name: "Comedy" }, { Name: "Thriller" }]);
        if (url.pathname === "/UserItems/Resume") {
            await gate;
            if (failResume) return route.fulfill({headers, status: 502});
            return list(empty ? [] : [movies[1], episodes[1], episodes[2]]);
        }
        if (url.pathname === "/Shows/s/Episodes") {
            assert.equal(url.searchParams.has("fields"), false, "default DTO includes runtime");
            if (failEpisodes) return route.fulfill({headers, status: 502});
            return list(imported ? [...episodes, {...episodes[4], Id: "new", Name: "Return to port", ParentIndexNumber: 3}] : episodes);
        }
        if (url.pathname === "/Items/s") return route.fulfill({headers, json: series});
        if (url.pathname === "/Items/m1") return route.fulfill({headers, json: movies[1]});
        if (url.pathname === "/Items") {
            if (empty) return list([]);
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
    await page.evaluate(async ({jellyfin, still, native}) => {
        const { openMovies } = await import("/movies.js");
        const host = document.querySelector("main");
        if (native) host.dataset.nativeFullscreen = "true";
        window.openMovieHome = () => window.openMovieFixture(openMovies, host,
            { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef", downloads_enabled: true, release_search_enabled: true },
            { invokeMethodAsync: async (method, query, season) => {
                if (method === "MovieConnectionKind") return "wifi";
                if (method === "MovieWindowFullscreen") {
                    (window.fullscreenCalls ??= []).push(query);
                    return true;
                }
                if (method === "MovieMatches" && query === "tmdb:tv:42") {
                    return JSON.stringify({series_id: 42, seasons: Array.from({length: 6}, (_, i) => ({number: i + 1, episode_count: 4}))});
                }
                if (method === "MovieMatches") return JSON.stringify({
                    matches: [{title:"Harbour Town", kind:"tv", poster:"/movie-art/movie-alt.jpg"}]
                });
                if (method === "MovieSeasonEpisodes") {
                    (window.stillCalls ??= []).push([query, season]);
                    return JSON.stringify({episodes: [{number: 1, name: season === 1 ? "Pilot" : season === 3 ? "Return to port" : "Across the Bay", still, runtime: 42},
                        {number: 2, name: "Episode without a picture", still: null}]});
                }
                if (method === "MovieDownloads") return JSON.stringify({available:true, items:[
                    {name:"Harbour.Town.S02.1080p", progress:.3, state:"Downloading", eta:125},
                    {name:"Harbour Lights 2008", progress:1, state:"Seeding", ratio:1.25},
                    {name:"Paper Moons 2008", progress:1, state:"Finished"},
                    {id:"running", item:"m6", name:"Winter Garden", state:"Matching audio", progress:.4, results:[]},
                    ...["job1", "job2"].map(id => ({id, item:"m1", name:"Adding Hungarian audio to The Long Way Home",
                        state:"Added", progress:1, results:[{id, title:"The Long Way Home", state:"Added", can_delete:true}]}))
                ]});
                if (method === "MovieReleaseSearch") {
                    window.releaseQuery = query;
                    return JSON.stringify({results: [{title:"Harbour Town S04 1080p", size:1e9, seeders:30}],
                        title_details: {title:"Harbour Town", kind:"tv", season:4, poster:"/movie-art/movie-alt.jpg"}});
                }
                return JSON.stringify({results: []});
            } }, { server: location.origin, profile: "viewer" });
        window.movies = window.openMovieHome();
    }, {jellyfin, still, native: label.startsWith("windows-")});
    const capture = async state => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label + " " + state);
        const folder = state.startsWith("player") ? playerCaptures : out;
        await page.screenshot({path: path.join(folder, label + "-" + state + ".png"), animations: "disabled", fullPage: true});
    };
    await page.locator(".movie-home-skeleton").waitFor();
    assert.equal(await page.getByRole("heading", {name:"Movies", exact:true}).isVisible(), false);
    await capture("loading");
    holdResume();
    await page.locator(".movie-hero-play").waitFor();
    await page.locator(".movie-card").first().waitFor();
    assert.equal(await page.locator("body").evaluate(node => node.scrollWidth <= innerWidth), true, label + " overflows horizontally");
    assert.equal(await page.locator(".movie-hero-play").innerText(), "Resume");
    assert.ok(await page.locator(".movie-progress").count() >= 2, label + " shows progress");
    const shelves = page.locator(".movie-shelf:not([hidden])");
    const movieShelf = shelves.filter({has:page.getByRole("heading", {name:"Movies", exact:true})});
    const moviesCards = movieShelf.locator(".movie-card");
    await moviesCards.last().waitFor();
    assert.equal(await shelves.locator('[data-item-id="s"]').count(), 1, label + " has one card for the series");
    await shelves.filter({has:page.getByRole("heading", {name:"TV series", exact:true})}).locator('[data-item-id="s"]').waitFor();
    const overflow = await shelves.evaluateAll(nodes => nodes.flatMap(node => {
        const row = node.querySelector(".movie-cards");
        return node.scrollWidth > node.clientWidth || row.scrollWidth > row.clientWidth
            ? [{shelf: node.querySelector("h2").textContent, section: [node.scrollWidth, node.clientWidth],
                row: [row.scrollWidth, row.clientWidth]}] : [];
    }));
    assert.deepEqual(overflow, [], label + " shelves fit outside their dedicated scroll viewport");
    const art = await shelves.locator(".movie-card .movie-art").evaluateAll(nodes =>
        nodes.map(node => [node.offsetWidth, node.offsetHeight, node.style.getPropertyValue("--art-hue")]));
    assert.equal(new Set(art.map(([width, height]) => [width, height].join(","))).size, 1);
    assert.ok(new Set(art.map(([, , hue]) => hue)).size > 1);
    assert.equal(await shelves.getByRole("button", {name:/Add audio track/}).count(), 0);
    const audioJobs = page.getByRole("region", {name:"Audio tracks"});
    await audioJobs.getByText("Matching audio").waitFor();
    assert.equal(await audioJobs.getByRole("button", {name:"Delete source file"}).count(), 1);
    await capture("home");
    const focus = locator => locator.evaluate(node => node === document.activeElement);
    const hero = page.locator(".movie-hero-play");
    await hero.focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("movie-card")), true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.closest(".movie-hero-actions") !== null), true);
    const shelfNext = movieShelf.getByRole("button", {name:"Next movies"});
    await shelfNext.focus();
    const minTarget = options.viewport.width >= 1600 ? 60 : 44;
    assert.ok((await shelfNext.boundingBox()).height >= minTarget);
    const viewport = movieShelf.locator(".movie-shelf-scroll");
    await viewport.evaluate(node => { node.scrollLeft = 0; });
    await shelfNext.press("Enter");
    await page.waitForFunction(node => node.scrollLeft > 0, await viewport.elementHandle());

    const film = moviesCards.filter({hasText:"The Long Way Home"});
    await film.press("Enter");
    const details = page.getByRole("region", {name:"The Long Way Home", exact:true});
    const resume = details.getByRole("button", {name:"Resume", exact:true});
    await resume.waitFor();
    await details.getByRole("button", {name:"Add audio track for The Long Way Home"}).waitFor();
    await capture("detail");
    await resume.press("Enter");
    const player = page.getByRole("region", {name:"Movie player"});
    const playerBack = player.getByRole("button", {name:"Back to movies"});
    await playerBack.waitFor();
    await player.locator("video").evaluate(video => { video.poster = "/movie-art/movie.jpg"; });
    await capture("player");
    const tracks = player.getByRole("button", {name:"Audio & Subtitles"});
    await tracks.press("Enter");
    await player.getByRole("button", {name:"Close audio and subtitles"}).waitFor();
    await capture("player-tracks");
    await dismissPlayerTracks(page);
    const fullscreen = player.getByRole("button", {name:"Full screen", exact:true});
    if (label.startsWith("windows-") && await fullscreen.isVisible()) {
        await fullscreen.press("Enter");
        await player.getByRole("button", {name:"Exit full screen", exact:true}).waitFor();
    }
    await playerBack.press("Enter");
    await playerBack.waitFor({state:"hidden"});
    if (label.startsWith("windows-")) assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), [true, false]);
    assert.equal(await focus(resume), true);
    await details.getByRole("button", {name:"Back to titles"}).press("Enter");
    assert.equal(await focus(film), true);

    const show = shelves.locator('[data-item-id="s"]');
    await show.press("Space");
    const seriesView = page.getByRole("region", {name:"Harbour Town", exact:true});
    const retry = seriesView.getByRole("button", {name:"Retry library check"});
    await retry.waitFor();
    assert.equal(await focus(seriesView.getByRole("heading", {name:"Harbour Town", exact:true})), true);
    assert.equal(await seriesView.getByText("Not in library", {exact:true}).count(), 0);
    await capture("library-check-error");
    failEpisodes = false;
    await retry.press("Enter");
    const selector = seriesView.getByLabel("Season", {exact:true});
    await seriesView.getByText("6 seasons", {exact:true}).waitFor();
    assert.equal(await selector.locator("option").count(), 6);
    assert.equal(await focus(selector), true);
    const state = seriesView.locator(".movie-season-state");
    assert.equal(await state.textContent(), "Available");
    await seriesView.getByText("40% watched", {exact:true}).waitFor();
    await seriesView.getByText("36 min", {exact:true}).waitFor();
    const image = seriesView.locator(".movie-episode-still img").first();
    await image.waitFor();
    await page.waitForFunction(img => img.naturalWidth > 0, await image.elementHandle());
    await seriesView.getByRole("button", {name:"Resume", exact:true}).waitFor();
    await capture("series");
    await selector.selectOption("2");
    await seriesView.locator('[data-season="2"]').waitFor();
    await seriesView.getByRole("button", {name:"Play", exact:true}).waitFor();
    await selector.selectOption("3");
    const find3 = seriesView.getByRole("button", {name:"Find season 3", exact:true});
    await find3.waitFor();
    imported = true;
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await seriesView.getByRole("button", {name:"Play", exact:true}).waitFor();
    assert.equal(await selector.inputValue(), "3");
    await selector.selectOption("4");
    const find = seriesView.getByRole("button", {name:"Find season 4", exact:true});
    await find.waitFor();
    assert.ok((await find.boundingBox()).height >= minTarget);
    await capture("missing-season");
    await find.focus();
    await page.keyboard.press("Escape");
    assert.equal(await focus(show), true);
    await show.press("Space");
    await selector.selectOption("4");
    if (options.hasTouch) await find.tap();
    else await find.press("Enter");
    assert.equal(await page.getByRole("searchbox").inputValue(), "Harbour Town S04");
    assert.equal(await focus(page.getByRole("button", {name:"Search", exact:true})), true);
    await page.getByRole("list", {name:"Release results"}).getByText("Full season 4").waitFor();
    assert.equal(await page.evaluate(() => window.releaseQuery), "Harbour Town S04");
    await capture("search");

    empty = true;
    failResume = true;
    await page.evaluate(async () => { await window.movies.close(); window.movies = window.openMovieHome(); });
    const resumeRetry = page.getByRole("button", {name:"Retry continue watching", exact:true});
    await resumeRetry.waitFor();
    await capture("home-error");
    failResume = false;
    await resumeRetry.press("Enter");
    await page.getByRole("heading", {name:"Your library is empty", exact:true}).waitFor();
    await capture("empty");
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(playerCaptures, { recursive: true });
    await reviewMovieProfiles(async (browser, label, options) => {
        if (label === "windows-chromium-1280") {
            await render(browser, "chromium-320", {viewport:{width:320, height:750}});
            await render(browser, "tv-chromium-1920", {viewport:{width:1920, height:1080}});
        }
        if (label === "android-pixel7-360")
            return render(browser, "android-pixel7-390", {...options, viewport:{...options.viewport, width:390}});
        await render(browser, label, options);
    });
    console.log("Movies fixture captures: " + out);
})().catch(error => { console.error(error); process.exit(1); });
