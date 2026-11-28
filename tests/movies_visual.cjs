const { useMovieBridge, reviewMovieProfiles, dismissPlayerTracks, movieFixtureHeader, movieAssetPath } = require("./movies_fixture.cjs");
// Renders the Movies & TV library from a dense mocked Jellyfin and saves screenshots for review.
// Usage: node tests/movies_visual.cjs [output-dir]   (emulated engines and device profiles, not real devices)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {constants, setPriority} = require("node:os");
const path = require("node:path");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.resolve(process.argv[2] || path.join(__dirname, "../.local/movies-1-6-0-visual"));
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const titles = ["Harbour Lights", "The Long Way Home", "Paper Moons", "Northern Rail", "Quiet Orchard", "Glass Season",
    "Summer of Wires", "Low Tide", "The Last Ferry", "Copper Hills", "Night Market", "A Small Revolution",
    "Winter Garden", "Salt and Iron", "Midnight Bakery", "River Street", "Open Fields",
    "The Golden Hour on the Last Day of the Year Before the River Froze"];
const movies = titles.map((Name, i) => ({ Id: "m" + i, Name, Type: "Movie", ProductionYear: 2008 + i, OfficialRating: i % 3 ? "PG-13" : "PG",
    RunTimeTicks: (80 + i * 4) * 6e8, Genres: i === 0 ? ["Drama", "Comedy"] : [["Drama", "Comedy", "Thriller"][i % 3]],
    Overview: "A quiet town gets a visitor with a map nobody has seen, and one evening decides what everyone does next.",
    BackdropImageTags: i < 2 ? ["b"] : undefined, ImageTags: i < 6 ? { Primary: "p" } : undefined,
    DateCreated: i === 6 ? new Date().toISOString() : undefined,
    UserData: i === 1 ? { PlaybackPositionTicks: 40 * 6e8, PlayedPercentage: 42 } : i === 2 ? {IsFavorite: true} : {} }));
const episodes = ["Episode 1", "The Move", "Visitors", "Episode 4", "Finale", "Reunion"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ParentIndexNumber: i < 4 ? 1 : 2,
    IndexNumber: i < 4 ? i + 1 : i - 3, RunTimeTicks: (36 + i) * 6e8,
    UserData: i === 0 ? {Played: true} : i === 1 ? {PlayedPercentage: 40} : {}, ImageTags: { Thumb: "t" } }));
const series = {Id: "s", Name: "Harbour Town", Type: "Series", ProviderIds: {Tmdb: "42"}};
const cast = ["Avery Vale", "Morgan Lee", "Ellis Shaw", "Riley Chen", "Robin Ellis", "Drew Bell",
    "Jamie Shah", "Alex Reed", "Cameron Fox", "Quinn Holt", "Blair Park", "Skyler Cole"]
    .map((Name, i) => ({Name, Type: "Actor", Role: i === 0 ? "Sam" : undefined}));
const filmDetail = {...movies[1], ProviderIds: {Tmdb: "101"}, People: cast.slice(0, 6)};
const seriesDetail = {...series, ImageTags: {Primary: "p"}, Genres: ["Drama", "Mystery"], OfficialRating: "TV-14",
    Overview: "A ferry vanishes on its final crossing, and the harbour crew searches for its passengers.", People: cast};

async function verifyRazorShell(browser, url) {
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Use a local Razor stub");
    const page = await browser.newPage();
    try {
        page.setDefaultTimeout(8000);
        await page.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin
            ? route.continue() : route.abort());
        assert.ok((await page.request.post(new URL("/fixture/startup/movies-polish", url).href)).ok());
        await page.goto(url);
        await page.getByRole("button", {name: "Switch apps"}).click();
        await page.locator("#app-switcher").getByRole("button", {name: "Movies & TV", exact: true}).click();
        await page.locator(".app-header .movie-search").waitFor();
        await page.getByRole("button", {name: /^Harbour Town/}).press("Enter");
        await page.getByRole("button", {name: "Season 1", exact: true}).press("Enter");
        const still = page.locator('[data-season="1"] img').first();
        await still.waitFor();
        await page.waitForFunction(image => image.naturalWidth > 0, await still.elementHandle());
        assert.equal(await page.getByRole("heading", {name: "Movies & TV", exact: true}).count(), 1);
        const back = page.getByRole("button", {name:"Go back", exact:true});
        const forward = page.getByRole("button", {name:"Go forward", exact:true});
        const series = page.getByRole("region", {name:"Harbour Town", exact:true});
        assert.equal(await back.getAttribute("aria-disabled"), "false");
        assert.equal(await forward.getAttribute("aria-disabled"), "true");
        await back.press("Enter");
        await series.waitFor({state:"hidden"});
        await page.getByRole("button", {name:"Harbour Town", exact:true}).waitFor();
        await back.press("Enter");
        await page.waitForFunction(() => document.activeElement?.id === "header-back" &&
            document.activeElement.getAttribute("aria-disabled") === "true");
        await forward.press("Enter");
        await page.getByRole("button", {name:"Harbour Town", exact:true}).waitFor();
        await forward.press("Enter");
        await series.waitFor();
        await page.waitForFunction(() => document.activeElement?.id === "header-forward" &&
            document.activeElement.getAttribute("aria-disabled") === "true");
        await forward.press("Space");
        assert.equal(await series.isVisible(), true);
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
        // The fixture clip may not decode in every engine; these checks cover the player screens, not stream recovery (movies_player does).
        document.addEventListener("error", event => { if (event.target instanceof HTMLMediaElement) event.stopImmediatePropagation(); }, true);
        // WebKit rejects play() with NotSupportedError for the fixture clip, which would start the stream recovery.
        const nativePlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () { return Promise.resolve(nativePlay.call(this)).catch(() => {}); };
    });
    let empty = false, failEpisodes = true, failResume = false, holdResume, imported = false;
    let holdEpisodes, holdFilm;
    const gate = new Promise(resolve => { holdResume = resolve; });
    const filmGate = new Promise(resolve => { holdFilm = resolve; });
    const episodesGate = new Promise(resolve => { holdEpisodes = resolve; });
    await page.route("**/*", route => [app, jellyfin].includes(new URL(route.request().url()).origin)
        ? route.fallback() : route.abort());
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        return name ? route.fulfill({ path: movieAssetPath(name) })
            : route.fulfill({ contentType: "text/html", body: `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/movies.css"><link rel="stylesheet" href="/service-status.css"><link rel="stylesheet" href="/notices.css"><style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style>${movieFixtureHeader}<main id="content"><div class="shell-status"><div id="feedback" hidden></div></div><div class="movie-library"></div></main><script src="/notices.js"></script>` });
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
            if (url.pathname === "/Items/m0/Images/Backdrop" && Number(url.searchParams.get("maxWidth")) > 480)
                await filmGate;
            const art = url.pathname.endsWith("/Backdrop") ? "movie.jpg" :
                /^\/Items\/(?:e\d+|s)\//.test(url.pathname) ? "episode.jpg" : "movie-alt.jpg";
            return route.fulfill({ headers, path: path.join(wwwroot, "movie-art", art) });
        }
        if (url.pathname === "/Genres") return list(empty ? [] : [{ Name: "Drama" }, { Name: "Comedy" }, { Name: "Thriller" }]);
        if (url.pathname === "/UserItems/Resume") {
            await gate;
            if (failResume) return route.fulfill({headers, status: 502});
            return list(empty ? [] : [movies[1], episodes[1], episodes[2]]);
        }
        if (url.pathname === "/Shows/s/Episodes") {
            await episodesGate;
            assert.deepEqual(url.searchParams.get("fields")?.split(",").sort(), ["MediaStreams", "Overview", "ProviderIds"],
                "episode details request the quality, overview and rating id fields");
            if (failEpisodes) return route.fulfill({headers, status: 502});
            return list(imported ? [...episodes, {...episodes[4], Id: "new", Name: "Return to port", ParentIndexNumber: 3}] : episodes);
        }
        if (url.pathname === "/Items/s") return route.fulfill({headers, json: seriesDetail});
        if (url.pathname === "/Items/m1") return route.fulfill({headers, json: filmDetail});
        if (url.pathname === "/Items") {
            if (empty) return list([]);
            if (url.searchParams.get("ids") === "m1") return list([filmDetail]);
            if (url.searchParams.get("ids") === "s") return list([seriesDetail]);
            const types = url.searchParams.get("includeItemTypes");
            const genre = url.searchParams.get("genres");
            if (genre) return list([]);
            if (types === "Series") return list([series]);
            if (types === "BoxSet") return list([{Id: "c1", Name: "Harbour Collection", Type: "BoxSet"}]);
            if (url.searchParams.has("isFavorite")) return list([movies[2]]);
            if (url.searchParams.get("sortBy") === "DateCreated") return list([movies[6]]);
            return list(movies);
        }
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    const still = "data:image/jpeg;base64," + fs.readFileSync(path.join(wwwroot, "movie-art", "episode.jpg")).toString("base64");
    const relatedFilms = [...movies.slice(2, 5).map(({Name, ProductionYear}, i) => ({id: 102 + i, title: Name, year: ProductionYear})),
        ...["Across the Bay", "After the Ferry", "Last Train North"].map((title, i) => ({id: 105 + i, title, year: 2014,
            backdrop: "/movie-art/" + ["movie.jpg", "episode.jpg", "movie-alt.jpg"][i]}))];
    await page.evaluate(async ({jellyfin, still, native, relatedFilms}) => {
        const { openMovies } = await import("/movies.js");
        const host = document.querySelector(".movie-library");
        if (native) host.dataset.nativeFullscreen = "true";
        window.openMovieHome = () => window.openMovieFixture(openMovies, host,
            { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef", downloads_enabled: true, release_search_enabled: true },
            { invokeMethodAsync: async (method, query, season) => {
                if (method === "MovieNavigationChanged") (window.movieRoutes ??= []).push([query, season]);
                if (method === "MovieConnectionKind") return "wifi";
                if (method === "MovieWindowFullscreen") {
                    (window.fullscreenCalls ??= []).push(query);
                    return query;
                }
                if (method === "MovieTrailer") return JSON.stringify({youtube: null});
                if (method === "MovieRelated" && query === "101") return JSON.stringify({matches: relatedFilms});
                if (method === "MovieRelated" && query === "42")
                    return JSON.stringify(window.failSeriesRelated ? {error:"Related series are unavailable."} :
                        {matches: relatedFilms.slice(3)});
                if (method === "MovieMatches" && query === "tmdb:tv:42") {
                    return JSON.stringify({series_id: 42, seasons: Array.from({length: 6}, (_, i) => ({number: i + 1, episode_count: 4}))});
                }
                if (method === "MovieMatches") return JSON.stringify({
                    matches: [{title:"Harbour Town", kind:"tv", poster:"/movie-art/movie-alt.jpg"}]
                });
                if (method === "MovieSeasonEpisodes") {
                    (window.stillCalls ??= []).push([query, season]);
                    return JSON.stringify({episodes: [{number: 1, name: season === 1 ? "Pilot" : season === 3 ? "Return to port" : "Across the Bay", still, runtime: 42},
                        {number: 2, name: "Episode 2", still: null}]});
                }
                if (method === "MovieDownloads") return JSON.stringify({available:true, items:window.emptyDownloads ? [] : [
                    {name:"Harbour.Town.S06.1080p", progress:.3, state:"Downloading", eta:125},
                    {name:"The Golden Hour on the Last Day of the Year Before the River Froze", progress:.4, state:"Downloading"},
                    {name:"Harbour Lights 2008", progress:1, state:"Seeding", ratio:1.25},
                    {name:"Paper Moons 2008", progress:1, state:"Finished"},
                    {id:"running", item:"m6", name:"Adding Hungarian audio", state:"Matching audio", progress:.4, results:[]},
                    {id:"episode-job", item:"e1", name:"Adding Hungarian audio to The Move", state:"Added", progress:1,
                        results:[{id:"ep-result", title:"The Move", state:"Added", can_delete:true}]},
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
    }, {jellyfin, still, native: label.startsWith("windows-"), relatedFilms});
    const capture = async (state, fullPage = true) => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label + " " + state);
        await page.screenshot({path: path.join(out, label + "-" + state + ".png"), animations: "disabled", fullPage});
    };
    const loading = page.locator(".movie-home-skeleton");
    await loading.waitFor();
    const geometry = node => {
        const {width, height} = node.getBoundingClientRect();
        return [width, height];
    };
    const desktop = options.viewport.width >= 1280;
    const checkCastNames = async detail => {
        const splitWords = await detail.locator(".movie-cast-action > strong").evaluateAll(names => names.flatMap(name => {
            const node = name.firstChild;
            const range = document.createRange();
            return [...node.textContent.matchAll(/\S+/g)].filter(word => {
                range.setStart(node, word.index);
                range.setEnd(node, word.index + word[0].length);
                return new Set([...range.getClientRects()].map(rect => rect.top)).size > 1;
            }).map(word => word[0]);
        }));
        assert.deepEqual(splitWords, [], label + " cast words split across lines");
    };
    const checkDetailFrame = async detail => {
        const layout = await detail.evaluate(node => {
            const fits = target => {
                const {top, right, bottom, left} = target.getBoundingClientRect();
                return top >= 0 && left >= 0 && bottom <= innerHeight && right <= innerWidth;
            };
            const root = document.scrollingElement ?? document.documentElement;
            const host = node.closest("main") ?? root;
            const scrolled = [];
            for (let parent = node.querySelector(".movie-title-text h2"); parent; parent = parent.parentElement)
                if (parent.scrollTop !== 0) scrolled.push(parent.className || parent.tagName);
            const headerIcon = document.querySelector("#open-hub svg").getBoundingClientRect();
            const back = node.querySelector(".movie-title-back");
            return {
                headerVisible: fits(document.querySelector(".app-header")),
                backVisible: fits(back),
                iconOffset: back.querySelector("svg").getBoundingClientRect().left - headerIcon.left,
                scrolled, hostOverflow: host.scrollHeight - host.clientHeight,
                documentOverflow: root.scrollHeight - root.clientHeight
            };
        });
        assert.ok(layout.headerVisible && layout.backVisible && layout.hostOverflow <= 1 && layout.documentOverflow <= 1,
            label + " detail frame " + JSON.stringify(layout));
        assert.deepEqual(layout.scrolled, [], label + " ancestors scrolled");
        if (await detail.evaluate(node => node.classList.contains("movie-film-detail")))
            assert.ok(Math.abs(layout.iconOffset) <= 1, label + " Back icon alignment");
    };
    const billboardSize = await loading.locator(".movie-hero").evaluate(geometry);
    assert.equal(await loading.locator(".movie-loading-landscape .movie-art").count(), 6);
    assert.equal(await loading.locator(".movie-loading-portrait .movie-art").count(), 6);
    const pulse = loading.locator(".movie-loading-heading");
    assert.equal(await pulse.evaluate(node => getComputedStyle(node).animationName),
        options.reducedMotion === "reduce" ? "none" : "service-status-pulse");
    await page.evaluate(() => { document.body.dataset.effects = "off"; });
    assert.equal(await pulse.evaluate(node => getComputedStyle(node).animationName), "none");
    await page.evaluate(() => { delete document.body.dataset.effects; });
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
    assert.equal(await shelves.locator('.movie-card[data-item-id="s"]').count(), 1, label + " has one card for the series");
    await shelves.filter({has:page.getByRole("heading", {name:"Series", exact:true})}).locator('.movie-card[data-item-id="s"]').waitFor();
    assert.deepEqual(await shelves.locator("h2").allTextContents(), ["Continue watching", "My list", "Recently added", "Series", "Movies", "Collections"]);
    const regularIds = await shelves.locator(".movie-card").evaluateAll(cards => cards
        .filter(card => card.closest("section").querySelector("h2").textContent !== "Continue watching")
        .map(card => card.dataset.titleKey));
    assert.equal(new Set(regularIds).size, regularIds.length);
    assert.equal(await shelves.locator('.movie-card[data-item-id="m1"]').count(), 2, "a title can also appear in Continue watching");
    const overflow = await shelves.evaluateAll(nodes => nodes.flatMap(node => {
        const row = node.querySelector(".movie-cards");
        return node.scrollWidth > node.clientWidth || row.scrollWidth > row.clientWidth
            ? [{shelf: node.querySelector("h2").textContent, section: [node.scrollWidth, node.clientWidth],
                row: [row.scrollWidth, row.clientWidth]}] : [];
    }));
    assert.deepEqual(overflow, [], label + " shelves fit outside their dedicated scroll viewport");
    if (options.viewport.width <= 600) {
        const visible = await movieShelf.locator(".movie-shelf-scroll").evaluate(node => {
            const frame = node.getBoundingClientRect();
            return [...node.querySelectorAll(".movie-card")].map(card => {
                const rect = card.getBoundingClientRect();
                return (Math.min(rect.right, frame.right) - Math.max(rect.left, frame.left)) / rect.width;
            }).filter(fraction => fraction > 0);
        });
        assert.equal(visible.filter(fraction => fraction >= .99).length, 2);
        assert.ok(visible[2] >= .10 && visible[2] <= .20, "phone shows a peek of the third card");
    }
    const art = await shelves.locator(".movie-card .movie-art").evaluateAll(nodes =>
        nodes.map(node => [node.offsetWidth, node.offsetHeight, node.style.getPropertyValue("--art-hue")]));
    assert.ok(new Set(art.map(([width, height]) => [width, height].join(","))).size > 1);
    assert.ok(new Set(art.map(([, , hue]) => hue)).size > 1);
    assert.equal(await shelves.getByRole("button", {name:/Add audio track/}).count(), 0);
    assert.equal(await page.getByRole("region", {name:"Audio tracks"}).count(), 0);
    assert.equal(await page.getByRole("button", {name:"Delete source file"}).count(), 0);
    await page.getByRole("button", {name: "Downloads, 2 active"}).waitFor();
    assert.equal(await page.evaluate(() => {
        const width = selector => document.querySelector(selector).getBoundingClientRect().width;
        const toolbar = document.querySelector(".app-header .movie-toolbar");
        return !document.querySelector(".movie-catalogue .movie-downloads") && width(".movie-toolbar") > 0 &&
            width(".movie-toolbar") <= width(".header-search") && getComputedStyle(toolbar).boxShadow === "none";
    }), true);
    if (options.viewport.width === 390) {
        const card = moviesCards.filter({hasText: titles.at(-1)});
        await card.scrollIntoViewIfNeeded();
        assert.equal(await card.evaluate(node => {
            const caption = node.querySelector(".movie-card-name");
            const badge = node.querySelector(".movie-download-badge");
            const art = node.querySelector(".movie-art");
            const line = parseFloat(getComputedStyle(caption).lineHeight);
            return caption.clientHeight <= 2 * line + 1 && art.contains(badge) &&
                badge.getBoundingClientRect().height > 0 && badge.getBoundingClientRect().bottom <= art.getBoundingClientRect().bottom;
        }), true);
        await card.screenshot({path: path.join(out, label + "-long-card.png"), animations: "disabled"});
        await page.evaluate(() => document.querySelector(".movie-shelf-scroll:has([data-item-id=m17])").scrollLeft = 0);
    }
    const banner = page.locator("#feedback");
    await page.getByRole("searchbox").focus();
    await page.evaluate(() => FamilyHubNotices.set("feedback", "Radio: 4 of 50 songs ready."));
    assert.equal(await banner.locator('[role="status"][aria-atomic="true"]').textContent(), "Radio: 4 of 50 songs ready.");
    assert.equal(await banner.evaluate(node => Math.abs(node.clientWidth + 2 - node.parentElement.clientWidth) <= 1), true);
    assert.equal(await page.getByRole("searchbox").evaluate(node => node === document.activeElement), true);
    await capture("status-banner");
    await page.evaluate(() => FamilyHubNotices.set("feedback", ""));
    await capture("home");
    const focus = locator => locator.evaluate(node => node === document.activeElement);
    const hero = page.locator(".movie-hero-play");
    assert.equal((await page.locator(".movie-hero").evaluate(geometry))[0], billboardSize[0]);
    await hero.focus();
    await page.keyboard.press("ArrowDown");
    const continueCards = shelves.filter({has:page.getByRole("heading", {name:"Continue watching", exact:true})});
    assert.equal(await continueCards.locator(".movie-card:focus").count(), 1);
    await page.keyboard.press("ArrowRight");
    const selected = continueCards.locator(".movie-card:focus");
    const selectedId = await selected.getAttribute("data-item-id");
    await page.keyboard.press("ArrowUp");
    assert.equal(await continueCards.locator(".movie-continue-menu-button:focus").evaluate(button =>
        button.previousElementSibling.dataset.itemId), selectedId);
    if (!options.hasTouch) {
        // The options button shows only on hover, and hovering it keeps the tile (card and button) raised.
        const tile = continueCards.locator(".movie-resume-card").first();
        const tileButton = tile.locator(".movie-continue-menu-button");
        await page.mouse.move(0, 0);
        await hero.focus();
        assert.equal(await tileButton.evaluate(node => getComputedStyle(node).opacity), "0");
        await tile.locator(".movie-card").hover();
        assert.equal(await tileButton.evaluate(node => getComputedStyle(node).opacity), "1");
        await tileButton.hover();
        const raised = await tile.evaluate(node => getComputedStyle(node).transform);
        if (options.reducedMotion === "reduce") assert.equal(raised, "none");
        else assert.notEqual(raised, "none");
        await capture("continue-hover");
        await page.mouse.move(0, 0);
        await continueCards.locator(`.movie-card[data-item-id="${selectedId}"]`).focus();
        await page.keyboard.press("ArrowUp");
    } else {
        const circle = await continueCards.locator(".movie-continue-menu-button").first().evaluate(node => getComputedStyle(node).backgroundImage);
        assert.match(circle, /radial-gradient/);
        await capture("continue-touch");
    }
    if (options.hasTouch) {
        await continueCards.locator(".movie-continue-menu-button:focus").tap();
        await continueCards.getByRole("menuitem", {name: "More info"}).waitFor();
        await page.keyboard.press("Escape");
    }
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.closest(".movie-hero-actions") !== null), true);
    const shelfNext = movieShelf.getByRole("button", {name:"Next movies"});
    const minTarget = options.viewport.width >= 1600 ? 60 : 44;
    const viewport = movieShelf.locator(".movie-shelf-scroll");
    await viewport.evaluate(node => { node.scrollLeft = 0; });
    if (options.hasTouch || options.viewport.width <= 600) assert.equal(await shelfNext.count(), 0);
    else {
        await shelfNext.focus();
        assert.ok((await shelfNext.boundingBox()).height >= minTarget);
        await shelfNext.press("Enter");
        await page.waitForFunction(node => node.scrollLeft > 0, await viewport.elementHandle());
    }

    const filmLoading = moviesCards.filter({hasText:"Harbour Lights"});
    await filmLoading.press("Enter");
    const loadingDetail = page.getByRole("region", {name:"Harbour Lights", exact:true});
    const loadingHero = loadingDetail.locator(".movie-series-header");
    await loadingDetail.locator(".movie-hero-art[data-loading]").waitFor({state:"attached"});
    if (desktop) await checkDetailFrame(loadingDetail);
    const loadingDetailSize = await loadingHero.evaluate(geometry);
    assert.equal(await loadingDetail.evaluate(node => getComputedStyle(node, "::before").animationName),
        options.reducedMotion === "reduce" ? "none" : "service-status-pulse");
    await capture("film-loading");
    holdFilm();
    await loadingDetail.locator(".movie-hero-art[data-loading]").waitFor({state:"detached"});
    assert.deepEqual(await loadingHero.evaluate(geometry), loadingDetailSize);
    await loadingDetail.getByRole("button", {name:"Back to titles"}).press("Enter");

    const film = moviesCards.filter({hasText:"The Long Way Home"});
    await film.click();
    const details = page.getByRole("region", {name:"The Long Way Home", exact:true});
    const resume = details.getByRole("button", {name: "Resume from 40:00", exact:true});
    await resume.waitFor();
    assert.equal(await details.getByRole("button", {name:"Add audio track for The Long Way Home"}).count(), 0);
    await details.getByRole("button", {name:"Delete source file"}).waitFor();
    assert.equal(await details.getByRole("button", {name:"Delete source file"}).count(), 1);
    const backdrop = details.locator(".movie-hero-art");
    const related = details.locator('.movie-shelf[data-format="related"]');
    const relatedArt = related.locator(".movie-art img").first();
    await details.getByRole("list", {name:"Cast", exact:true}).waitFor();
    assert.equal(await details.locator(".movie-cast li").count(), 6);
    await relatedArt.waitFor();
    assert.equal(await related.count(), 1);
    assert.equal(await related.locator(".movie-card").count(), relatedFilms.length);
    await page.waitForFunction(image => image.naturalWidth > 0, await relatedArt.elementHandle());
    await page.waitForFunction(image => image.naturalWidth > 0, await backdrop.elementHandle());
    assert.equal(await backdrop.evaluate(image => {
        const art = image.getBoundingClientRect(), film = image.parentElement.getBoundingClientRect();
        const catalogue = image.parentElement.parentElement.getBoundingClientRect();
        return getComputedStyle(image).objectFit === "cover" && art.left === film.left && art.right === film.right &&
            art.left === catalogue.left && art.right === catalogue.right;
    }), true);
    if (desktop) {
        await checkDetailFrame(details);
        await details.getByRole("heading", {name:"The Long Way Home", exact:true}).focus();
        await checkDetailFrame(details);
        await checkCastNames(details);
        assert.ok(await related.evaluate(node => Math.abs(node.getBoundingClientRect().bottom - innerHeight) <= 1));
    }
    await capture("detail", !desktop);
    await resume.press("Enter");
    const player = page.getByRole("region", {name:"Movie player"});
    const playerBack = player.getByRole("button", {name:"Back to movies"});
    await playerBack.waitFor();
    await player.locator("video").evaluate(video => { video.poster = "/movie-art/movie.jpg"; });
    await capture("player");
    const tracks = player.getByRole("button", {name:"Audio & Subtitles"});
    // Controls hide after a few idle seconds (the capture above takes longer in WebKit); wake them like a viewer would.
    await player.locator(".movie-ui").dispatchEvent("pointermove");
    await player.hover({position:{x:80,y:80}}).catch(() => {});
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
    const [detailEntry, playerEntry] = await page.evaluate(() => {
        return window.movieRoutes.filter(([route, action]) => action === "open" && JSON.parse(route).detail?.Id === "m1")
            .map(([route]) => route);
    });
    await page.evaluate(route => window.movies.restoreNavigation(route), detailEntry);
    await details.waitFor();
    await page.evaluate(route => window.movies.restoreNavigation(route), playerEntry);
    await playerBack.waitFor();
    await page.evaluate(route => window.movies.restoreNavigation(route), detailEntry);
    await details.waitFor();
    assert.equal(await focus(resume), true);
    await page.evaluate(() => window.movies.restoreNavigation(null));
    assert.equal(await page.locator(".movie-series").count(), 0);

    const show = shelves.locator('.movie-card[data-item-id="s"]');
    await show.press("Space");
    const seriesView = page.getByRole("region", {name:"Harbour Town", exact:true});
    await seriesView.locator(".movie-loading-pill").first().waitFor();
    const placeholderStill = seriesView.locator(".movie-loading .movie-episode-still").first();
    const stillSize = await placeholderStill.evaluate(geometry);
    await capture("series-loading");
    holdEpisodes();
    const retry = seriesView.getByRole("button", {name:"Retry library check"});
    await retry.waitFor();
    assert.equal(await seriesView.evaluate(node => getComputedStyle(node).animationName), "none",
        `${label}: full-bleed series details open without a page transition`);
    assert.equal(await focus(seriesView.getByRole("heading", {name:"Harbour Town", exact:true})), true);
    assert.equal(await seriesView.getByText("Not in library", {exact:true}).count(), 0);
    await capture("library-check-error");
    failEpisodes = false;
    await retry.press("Enter");
    await retry.waitFor({state:"hidden"});
    const seasons = seriesView.getByRole("group", {name:"Seasons"});
    const season = number => seasons.getByRole("button", {name:`Season ${number}`, exact:true});
    await season(6).waitFor();
    assert.equal(await seriesView.getByText("6 seasons", {exact:true}).count(), 0);
    assert.equal(await seasons.getByRole("button").count(), 6);
    assert.equal(await focus(season(1)), true);
    assert.equal(await page.getByRole("searchbox").count(), 0);
    assert.equal(await season(1).getAttribute("aria-pressed"), "true");
    assert.equal(await seriesView.locator(".movie-season-state, .movie-season-counts").count(), 0);
    assert.doesNotMatch(await seriesView.locator(".movie-season").innerText(), /\bwatched\b/i);
    for (const [name, expected] of [["Pilot, watched", 100], ["The Move, 40% watched", 40]]) {
        const episode = seriesView.getByRole("button", {name, exact: true});
        await episode.waitFor();
        assert.deepEqual(await episode.locator("progress").evaluate(node =>
            [node.value, node.getAttribute("aria-hidden"), getComputedStyle(node).color]),
        [expected, "true", "rgb(70, 196, 110)"]);
    }
    await seriesView.getByText("36 min", {exact:true}).waitFor();
    assert.equal(await seriesView.locator('[data-episode="1"] .movie-episode-number').textContent(), "1. ");
    assert.match(await seriesView.locator('[data-episode="1"] button strong').textContent(), /Pilot$/);
    assert.match(await seriesView.locator('[data-episode="2"] button strong').textContent(), /The Move$/);
    assert.equal(await seriesView.locator('[data-episode="4"] button strong').textContent(), "Episode 4");
    await seriesView.locator('[data-episode="2"]').getByRole("button", {name:"Delete source file"}).waitFor();
    const image = seriesView.locator(".movie-episode-still img").first();
    await image.waitFor();
    (await seriesView.locator(".movie-episode-still").first().evaluate(geometry)).forEach((size, axis) =>
        assert.ok(Math.abs(size - stillSize[axis]) <= .5, label + " loading and loaded episode stills differ"));
    await page.waitForFunction(img => img.naturalWidth > 0, await image.elementHandle());
    const continueEpisode = seriesView.getByRole("button", {name: "Resume S1 E2 from 14:48", exact:true});
    await continueEpisode.waitFor();
    await seriesView.getByRole("list", {name:"Cast", exact:true}).waitFor();
    const seriesPoster = seriesView.locator(".movie-title-intro .movie-art img");
    await page.waitForFunction(image => image.naturalWidth > 0, await seriesPoster.elementHandle());
    assert.ok(await seriesView.locator(".movie-cast li:not([hidden])").count() >= 2);
    const addEpisodeAudio = seriesView.locator('[data-episode="2"]').getByRole("button", {name:"Add audio track for The Move"});
    assert.equal(await addEpisodeAudio.count(), 0);
    const relatedSeries = seriesView.locator('.movie-shelf[data-format="related"]');
    await relatedSeries.locator(".movie-card").first().waitFor();
    if (desktop) {
        await checkDetailFrame(seriesView);
        await checkCastNames(seriesView);
        assert.equal(await relatedSeries.evaluate(node => node.closest(".movie-show-episodes") !== null), true);
    }
    await capture("series");
    const nextSeasons = seriesView.getByRole("button", {name:"Next seasons"});
    if (await nextSeasons.isVisible()) {
        await nextSeasons.press("Enter");
        await page.waitForFunction(node => node.scrollLeft > 0, await seasons.elementHandle());
    }
    await season(2).focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focus(season(1)), true);
    await page.keyboard.press("Tab");
    assert.equal(await focus(season(2)), true);
    await page.keyboard.press("Space");
    await seriesView.locator('[data-season="2"]').waitFor();
    assert.equal(await season(2).getAttribute("data-downloading"), null);
    assert.equal(await season(6).getAttribute("data-downloading"), "");
    await continueEpisode.waitFor();
    await season(3).press("Enter");
    const find3 = seriesView.getByRole("button", {name:"Find season 3", exact:true});
    await find3.waitFor();
    imported = true;
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await seriesView.getByRole("button", {name: "1. Return to port", exact: true}).waitFor();
    await continueEpisode.waitFor();
    assert.equal(await season(3).getAttribute("aria-pressed"), "true");
    await season(4).press("Enter");
    const find = seriesView.getByRole("button", {name:"Find season 4", exact:true});
    await find.waitFor();
    assert.ok((await find.boundingBox()).height >= minTarget);
    await capture("missing-season");
    await find.focus();
    await page.keyboard.press("Escape");
    assert.equal(await focus(show), true);
    await page.evaluate(() => { document.body.dataset.effects = "off"; window.failSeriesRelated = true; });
    await show.press("Space");
    assert.equal(await seriesView.evaluate(node => getComputedStyle(node).animationName), "none");
    const relatedRetry = relatedSeries.getByRole("button", {name:"Related series are unavailable. Retry"});
    await relatedRetry.waitFor();
    assert.equal(await relatedRetry.textContent(), "");
    assert.equal(await relatedRetry.locator("svg").count(), 1);
    assert.equal(await relatedSeries.locator(".movie-shelf-lane").count(), 0);
    assert.ok((await relatedSeries.boundingBox()).height <= (await relatedRetry.boundingBox()).height + 1,
        label + " failed related shelf reserves only the retry row");
    await page.evaluate(() => { delete document.body.dataset.effects; });
    await season(4).press("Enter");
    if (options.hasTouch) await find.tap();
    else await find.press("Enter");
    assert.equal(await page.getByRole("searchbox").inputValue(), "Harbour Town S04");
    assert.equal(await focus(page.getByRole("button", {name:"Search", exact:true})), true);
    await page.getByRole("list", {name:"Release results"}).getByText("Season 4", {exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.releaseQuery), "Harbour Town S04");
    await capture("search");

    empty = true;
    failResume = true;
    await page.evaluate(async () => {
        await window.movies.close();
        window.emptyDownloads = true;
        window.movies = window.openMovieHome();
    });
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
