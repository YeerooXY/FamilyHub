const fs = require("node:fs");
const { constants, setPriority } = require("node:os");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]
}));

const root = path.resolve(__dirname, "..");
const homeOutput = path.join(root, ".local/movies-home-2026-11-24");
const playerOutput = path.join(root, ".local/movie-player-2026-11-24");
const output = path.resolve(process.argv[2] || playerOutput);
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
const movieFixtureHeader = `<header class="app-header">
    <div class="header-start">
        <button id="open-hub" type="button" class="brand hub-launcher" aria-label="Switch apps" title="Switch apps">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/>
            </svg>
        </button>
        <nav class="view-history" aria-label="View history"><button id="header-back" type="button">Go back</button></nav>
    </div>
    <div class="header-search"><form id="search-form"><input id="q" type="search" aria-label="Search songs"></form></div>
    <div class="sidebar-account"><button id="profile-toggle" aria-label="Profile menu">P</button></div>
</header>`;

function movieAssetPath(name) {
    // Match the linked content paths in FamilyHub.App.csproj.
    const shared = name.startsWith("vendor/") || ["shell.css", "notices.css", "notices.js"].includes(name);
    return path.join(root, shared ? "music_web/static" : "clients/FamilyHub.App/wwwroot", name);
}

function stubMovieHls(page, {metadata = false} = {}) {
    return page.addInitScript(({metadata}) => {
        globalThis.Hls = class {
            static isSupported() { return Boolean(globalThis.MediaSource || globalThis.ManagedMediaSource); }
            static Events = {ERROR: "error", MANIFEST_PARSED: "manifestParsed"};
            on() {}
            once(_event, callback) { this.manifestParsed = callback; }
            loadSource(url) { this.manifestUrl = url; }
            attachMedia(media) {
                media.fixtureManifest = this.manifestUrl;
                this.manifestParsed?.();
                if (metadata) setTimeout(() => media.dispatchEvent(new Event("loadedmetadata")), 0);
            }
            destroy() {}
        };
    }, {metadata});
}

async function useMovieBridge(page) {
    await page.addInitScript(() => {
        window.openMovieFixture = (openMovies, host, session, app, viewer = {}) => {
            const base = session.url.replace(/\/$/, "") + "/";
            const {origin, hostname} = new URL(base);
            if (!hostname.endsWith(".test") && !["localhost", "127.0.0.1", "[::1]"].includes(hostname))
                throw Error("Use a local movie fixture");
            const headers = {Authorization: `MediaBrowser Token="${session.token}"`, "Content-Type": "application/json"};
            const send = (resource, query, payload) => {
                const url = new URL(resource, base);
                if (url.origin !== origin) throw Error("Movie fixture request escaped its local stub");
                url.search = query;
                return fetch(url, {method: payload === null ? "GET" : "POST", headers,
                    body: payload === null ? undefined : JSON.stringify(payload)});
            };
            const movie = openMovies(host, {...session, media_url: base}, {
                async invokeMethodAsync(method, ...args) {
                    if (method !== "MovieLibrary") return app.invokeMethodAsync(method, ...args);
                    const response = await send(...args);
                    if (!response.ok) return "{}";
                    const body = await response.text();
                    return JSON.stringify({result: body ? JSON.parse(body) : null});
                }
            }, {...viewer, server: base});
            return {restoreNavigation: movie.restoreNavigation, async close() {
                await movie.close();
                try { await send("Sessions/Logout", "", {}); } catch {}
            }};
        };
    });
}

async function moviePage(page, {shell = false, nested = false} = {}) {
    await useMovieBridge(page);
    await page.route("**/*", route => {
        const {hostname} = new URL(route.request().url());
        return hostname.endsWith(".test") || ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
            ? route.fallback() : route.abort();
    });
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name) return route.fulfill({path: movieAssetPath(name)});
        return route.fulfill({contentType: "text/html", body: `
            ${nested ? '<!doctype html>' : ''}
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><link rel="stylesheet" href="/service-status.css">
            ${nested ? '' : '<style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style>'}
            ${shell ? '<link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/hub.css">' + movieFixtureHeader : ''}
            ${shell
                // The app hosts Movies inside the workspace that names the current app; hub.css keys on it.
                ? '<div class="workspace" data-app-view="Movies &amp; TV">' + (nested
                    ? '<main><div class="service-status-stage"><div class="movie-library"></div></div></main>'
                    : '<main class="movie-library"></main>') + '</div>'
                : '<main class="movie-library"></main>'}`});
    });
    await page.goto(app);
}

async function movieHomeFixture(page, {preview = false, matches = [], resumeItems, nextUp = [], played = [], downloads = false} = {}) {
    await moviePage(page, {shell: true});
    const library = await page.evaluate(async () => (await import("/movies.js")).moviePreviewLibrary());
    const favoriteWrites = [], hiddenResume = new Set(), hiddenNext = new Map();
    await page.route(jellyfin + "/**", route => {
        const url = new URL(route.request().url()), params = url.searchParams;
        const headers = cors;
        if (route.request().method() === "OPTIONS") return route.fulfill({status: 204, headers});
        if (url.pathname.includes("/Images/")) {
            const pathName = url.pathname.endsWith("/Logo") ? "movie-alt.jpg" : "movie.jpg";
            return route.fulfill({headers, path: path.join(root, "clients/FamilyHub.App/wwwroot/movie-art", pathName)});
        }
        if (url.pathname.startsWith("/UserFavoriteItems/")) {
            const item = library.find(item => url.pathname.endsWith("/" + item.Id));
            const {favorite} = route.request().postDataJSON();
            favoriteWrites.push({item: item.Id, favorite});
            item.UserData.IsFavorite = favorite;
            return route.fulfill({status: 204, headers});
        }
        if (url.pathname === "/Genres") {
            const Items = [...new Set(library.flatMap(item => item.Genres))].map(Name => ({Name}));
            return route.fulfill({headers, json: {Items, TotalRecordCount: Items.length}});
        }
        const resumeId = /^\/UserItems\/([^/]+)\/HideFromResume$/.exec(url.pathname)?.[1];
        if (resumeId && route.request().method() === "POST") {
            hiddenResume.add(resumeId);
            return route.fulfill({headers, status: 204});
        }
        if (url.pathname === "/Shows/NextUp") {
            if (route.request().method() === "POST") {
                const {seriesId, episodeId} = route.request().postDataJSON();
                hiddenNext.set(seriesId, episodeId);
                return route.fulfill({headers, status: 204});
            }
            const Items = nextUp.filter(item => hiddenNext.get(item.SeriesId) !== item.Id);
            return route.fulfill({headers, json: {Items, TotalRecordCount: Items.length}});
        }
        if (url.pathname === "/Items" || url.pathname === "/UserItems/Resume") {
            if (params.get("filters") === "IsPlayed") {
                const Items = played.filter(item => item.SeriesId === params.get("parentId"));
                return route.fulfill({headers, json: {Items, TotalRecordCount: Items.length}});
            }
            if (resumeItems && url.pathname === "/UserItems/Resume") {
                const Items = resumeItems.filter(item => item.Type === "Movie" && !hiddenResume.has(item.Id));
                return route.fulfill({headers, json: {Items, TotalRecordCount: Items.length}});
            }
            if (resumeItems && params.get("includeItemTypes") === "Episode" && params.get("filters") === "IsResumable") {
                const Items = resumeItems.filter(item => item.Type === "Episode" && !hiddenResume.has(item.Id));
                return route.fulfill({headers, json: {Items, TotalRecordCount: Items.length}});
            }
            const group = library.find(item => item.Id === params.get("parentId"))?.ChildIds;
            const types = params.get("includeItemTypes")?.split(",");
            const term = params.get("searchTerm")?.toLowerCase();
            const genre = params.get("genres");
            const items = library.filter(item => (!types || types.includes(item.Type)) && (!group || group.includes(item.Id)) &&
                (!term || item.Name.toLowerCase().includes(term)) && (!genre || item.Genres.includes(genre)) &&
                (!params.has("isFavorite") || item.UserData.IsFavorite) &&
                (url.pathname !== "/UserItems/Resume" || item.UserData.PlayedPercentage));
            if (params.get("sortBy") === "DateCreated") items.sort((a, b) => b.DateCreated.localeCompare(a.DateCreated));
            const start = Number(params.get("startIndex") ?? 0), limit = Number(params.get("limit") ?? items.length);
            return route.fulfill({headers, json: {Items: items.slice(start, start + limit), TotalRecordCount: items.length}});
        }
        const playable = [...(resumeItems ?? []), ...nextUp];
        const item = playable.find(item => url.pathname === "/Items/" + item.Id);
        if (item) return route.fulfill({headers, json: item});
        if (playable.some(item => url.pathname === `/Items/${item.Id}/PlaybackInfo`)) {
            return route.fulfill({headers, json: {PlaySessionId: "resume-session",
                MediaSources: [{Id: "source", Container: "mp4", SupportsDirectPlay: true, MediaStreams: []}]}});
        }
        if (resumeItems && /^\/(?:Videos\/|Sessions\/)/.test(url.pathname)) return route.fulfill({headers, status: 204});
        return route.fulfill({headers, status: 404});
    });
    library[0].ImageTags.Logo = "logo";
    library[0].OfficialRating = "PG-13";
    library[0].MediaStreams = [{Type: "Video", Height: 1080, Width: 1920}];
    library.slice(0, 18).forEach((item, i) => { item.UserData.PlayedPercentage = 10 + i; });
    await page.evaluate(async ({preview, jellyfin, matches, downloads}) => {
        const {openMovies} = await import("/movies.js");
        const host = document.querySelector(".movie-library");
        const viewer = {server: jellyfin, profile: "fixture"};
        window.movieCalls = [];
        if (downloads) window.queue = [];
        const bridge = {invokeMethodAsync: async (method, ...args) => {
            window.movieCalls.push([method, ...args]);
            if (method === "MovieDownloads") return JSON.stringify({available: true, items: window.queue});
            return JSON.stringify(method === "MovieMatches" ? {matches} : {results: []});
        }};
        window.movies = preview ? openMovies(host, null, bridge, viewer) :
            window.openMovieFixture(openMovies, host, {url: jellyfin, user: "u", token: "t",
                downloads_enabled: downloads, release_search_enabled: matches.length > 0}, bridge, viewer);
    }, {preview, jellyfin, matches, downloads});
    await page.locator(".app-header .movie-search input:enabled").waitFor();
    return {library, favoriteWrites};
}

async function movieDetailFixture(page, {denseSeries = false, extras = false} = {}) {
    await moviePage(page, {shell: true, nested: true});
    const film = (Id, Name, Tmdb, extra = {}) => ({
        Id, Name, Type: "Movie", ProviderIds: {Tmdb}, Genres: ["Science Fiction"], ImageTags: {},
        UserData: {IsFavorite: false}, ...extra
    });
    const filmA = film("film-a", "First Orbit", "101", {Overview: "A pilot finds an abandoned station.",
        ImageTags: {Primary: "poster", Logo: "logo"}, BackdropImageTags: ["backdrop"],
        RunTimeTicks: 110 * 6e8, ProductionYear: 2026, OfficialRating: "PG",
        People: Array.from({length: 6}, (_, i) => ({Type: "Actor", Name: `Film Actor ${i + 1}`, Role: "Crew member",
            ...(extras && i === 0 ? {Id: "a".repeat(32), ProviderIds: {Tmdb: "555"}} : {})})),
        MediaStreams: [{Type: "Video", Width: 3840, Height: 1600},
            {Type: "Audio", IsDefault: true, Channels: 6, Codec: "eac3"}]});
    const filmB = film("film-b", "Second Orbit", "102", {ImageTags: {Logo: "missing"}, Genres: ["Comedy"],
        Overview: "The crew follows conflicting signals through a network of abandoned stations. ".repeat(12).trim()});
    const show = {Id: "show-a", Name: "Night Signal", Type: "Series", ProviderIds: {Tmdb: "201"},
        Overview: "A radio operator listens for a missing crew.", Genres: ["Mystery"], OfficialRating: "TV-14",
        ImageTags: {Primary: "poster"}, BackdropImageTags: ["backdrop"], UserData: {IsFavorite: false},
        People: [{Type: "Director", Name: "Skipped Director"}, {Id: "actor-a", Type: "Actor", Name: "Avery Vale", Role: "Sam", PrimaryImageTag: "actor"},
            {Type: "Actor", Name: "Morgan Lee", Role: "Jo"}, ...Array.from({length: 11}, (_, i) => ({Type: "Actor", Name: `Actor ${i + 3}`}))]};
    const emptyShow = {...show, Id: "show-b", Name: "Quiet Port", ProviderIds: {Tmdb: "202"}, BackdropImageTags: [], People: []};
    const library = [filmA, filmB, show, emptyShow], favoriteWrites = [];
    const matches = Array.from({length: 8}, (_, i) => ({id: 103 + i, title: `Outer Station ${i + 1}`}));
    const libraryMatches = [{id: 102, title: filmB.Name}, {id: 200, title: "Untitled Home Alone Film"}];
    await page.route(jellyfin + "/**", route => {
        const {pathname, searchParams} = new URL(route.request().url());
        if (route.request().method() === "OPTIONS") return route.fulfill({status: 204, headers: cors});
        const json = value => route.fulfill({headers: cors, json: value});
        const items = Items => json({Items, TotalRecordCount: Items.length});
        if (pathname.includes("/Images/") && pathname !== "/Items/film-b/Images/Logo")
            return route.fulfill({headers: cors, path: path.join(root, "clients/FamilyHub.App/wwwroot/movie-art/movie.jpg")});
        if (pathname.startsWith("/UserFavoriteItems/")) {
            const item = library.find(item => pathname.endsWith("/" + item.Id));
            const {favorite} = route.request().postDataJSON();
            item.UserData.IsFavorite = favorite;
            favoriteWrites.push([item.Id, favorite]);
            return route.fulfill({status: 204, headers: cors});
        }
        if (pathname === "/Items") {
            if (searchParams.get("personIds") === "a".repeat(32)) return items([filmA, filmB]);
            const id = searchParams.get("ids");
            if (id) return items(library.filter(item => item.Id === id));
            const types = searchParams.get("includeItemTypes")?.split(",") ?? [];
            return items(library.filter(item => types.includes(item.Type) &&
                (!searchParams.has("isFavorite") || item.UserData.IsFavorite))
                .map(({MediaStreams, People, ...item}) => searchParams.get("fields")?.includes("MediaStreams")
                    ? {...item, MediaStreams} : item));
        }
        const item = library.find(item => pathname === "/Items/" + item.Id);
        if (item) return json(item);
        if (denseSeries && pathname === "/Items/show-a-extra-0")
            return json({Id: "show-a-extra-0", Name: "Signal 2", Type: "Episode"});
        const episodes = /^\/Shows\/(show-[ab])\/Episodes$/.exec(pathname);
        if (episodes) return items([...([1, 2].map(ParentIndexNumber => ({
            Type: "Episode", Id: episodes[1] + "-episode-" + ParentIndexNumber, SeriesId: episodes[1],
            Name: ParentIndexNumber === 1 ? "Pilot" : "Return", ParentIndexNumber, IndexNumber: 1,
            ...(extras && ParentIndexNumber === 1 ? {ProviderIds: {Imdb: "tt1234"}} : {}),
            MediaStreams: ParentIndexNumber === 1 ? [{Type: "Video", Height: 1080}] : [],
            RunTimeTicks: 46 * 6e8, Overview: "The crew receives a radio signal.",
            ImageTags: {Primary: "still"}, UserData: ParentIndexNumber === 1 ? {PlayedPercentage: 30} : {}
        }))), ...(denseSeries && episodes[1] === "show-a" ? Array.from({length: 18}, (_, i) => ({
            Type: "Episode", Id: `show-a-extra-${i}`, SeriesId: "show-a", ParentIndexNumber: 1,
            IndexNumber: i + 2, Name: `Signal ${i + 2}`, Overview: "The crew searches the coastline.",
            MediaStreams: [{Type: "Video", Height: [720, 2160, 2160, 2160][i % 4],
                VideoRangeType: ["SDR", "SDR", "HDR10", "DOVI"][i % 4]}], ImageTags: {Primary: "still"}
        })) : [])]);
        if (pathname === "/UserItems/Resume" || pathname === "/Genres") return items([]);
        if (pathname === "/Sessions/Logout") return route.fulfill({status: 204, headers: cors});
        return route.fulfill({status: 404, headers: cors});
    });
    await page.evaluate(async ({jellyfin, matches, libraryMatches, denseSeries, extras}) => {
        const {openMovies, saveMoviePreferences} = await import("/movies.js");
        const host = document.querySelector(".movie-library");
        const viewer = {server: jellyfin + "/", profile: "fixture"};
        window.detailCalls = [];
        const bridge = {async invokeMethodAsync(method, ...args) {
            window.detailCalls.push([method, ...args]);
            if (method === "MovieRelated") {
                if (window.failNextRelated) {
                    window.failNextRelated = false;
                    return JSON.stringify({error: "Related films are unavailable."});
                }
                if (args[1] === "tv" && args[0] === "201") return JSON.stringify({matches: [
                    {id: 202, title: "Quiet Port"}, {id: 203, title: "Distant Signal"}
                ]});
                return JSON.stringify(args[0] === "101" ? {matches, library_matches: libraryMatches} : {matches: []});
            }
            if (method === "MovieMatches") return JSON.stringify({series_id: 201, seasons: [
                {number: 1, episode_count: 1}, {number: 2, episode_count: 1}
            ]});
            if (method === "MovieSeasonEpisodes") {
                if (args[1] === window.slowDetailSeason)
                    await new Promise(resolve => { window.finishDetailSeason = resolve; });
                return JSON.stringify({episodes: extras ? [{number: 1, rating: 7.2}] : []});
            }
            if (method === "MoviePerson") return JSON.stringify({name: "Film Actor 1", born: "1974",
                known_for: "Acting", biography: "Avery began acting in 1995. ".repeat(25),
                films: [{kind: "movie", id: 102, title: "Second Orbit"}, {kind: "movie", id: 213, title: "Open Road", year: 2018}]});
            if (method === "MovieTrailer") return JSON.stringify({youtube: extras ? "abcdefghijk" : null});
            if (method === "MovieRequest") return JSON.stringify({state: "requested"});
            if (method === "MovieRatings" && args[0] === "episode") return JSON.stringify({ratings: [{name: "IMDb", value: "8.5"}]});
            if (method === "MovieAudioSources") return JSON.stringify({sources: [], next: null});
            if (method === "MovieRatings") return JSON.stringify({ratings: window.movieRatings ?? []});
            if (method === "MovieDownloads" && denseSeries) return JSON.stringify({available: true, items: [{
                id: "failed-audio", item: "show-a-extra-0", name: "Adding Hungarian audio to Signal 2", state: "Failed",
                progress: 1, results: [{title: "Signal 2", state: "Failed", error: "Choose a different source from the library video."}]
            }, {
                id: "running-audio", item: "show-a-extra-1", name: "Adding Hungarian audio to Signal 3",
                state: "Matching audio", progress: .4, results: []
            }]});
            return JSON.stringify({results: []});
        }};
        window.openDetailFixture = async (style, preferences = {}) => {
            if (window.movies) await window.movies.close();
            saveMoviePreferences(viewer, {backgroundStyle: style, screen: "1080", ...preferences});
            window.movies = window.openMovieFixture(openMovies, host,
                {url: jellyfin, user: "u", token: "t", release_search_enabled: true, downloads_enabled: denseSeries,
                    requests_enabled: extras}, bridge, viewer);
        };
        await window.openDetailFixture("auto");
    }, {jellyfin, matches, libraryMatches, denseSeries, extras});
    await page.getByRole("searchbox").waitFor();
    return favoriteWrites;
}

async function playMovieDetails(page, card, title) {
    await card.press("Enter");
    const details = page.getByRole("region", {name: title, exact: true});
    const play = details.getByRole("button", {name: /^(Play$|Continue\b)/});
    await play.press("Enter");
    return play;
}

async function dismissPlayerTracks(page) {
    const close = page.getByRole("button", {name: "Close audio and subtitles"});
    const opener = page.getByRole("button", {name: "Audio & Subtitles", exact: true});
    const fullscreen = await page.evaluate(() => Boolean(document.fullscreenElement ?? document.webkitFullscreenElement));
    await page.keyboard.press("Escape");
    if (fullscreen) {
        await page.waitForFunction(button => button.getAttribute("aria-expanded") === "false" ||
            !(document.fullscreenElement ?? document.webkitFullscreenElement), await opener.elementHandle());
        // The browser can consume Escape before the player receives it.
        if (await close.isVisible()) await page.keyboard.press("Escape");
    }
    await close.waitFor({state: "hidden"});
    await page.waitForFunction(button => button === document.activeElement, await opener.elementHandle());
}

async function verifyMovieProfiles(verify) {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
    fs.mkdirSync(output, {recursive: true});
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch({headless: true});
        try {
            for (const [profile, options] of [
                ["1280", {viewport: {width: 1280, height: 850}}],
                ["2000", {viewport: {width: 2000, height: 1000}}],
                ["pixel7", devices["Pixel 7"]],
                ["iphone13", devices["iPhone 13"]]
            ]) {
                const { defaultBrowserType, ...context } = options;
                await verify(browser, engine.name() + "-" + profile, {...context, reducedMotion: "reduce"});
            }
        } finally {
            await browser.close();
        }
    }
}

const reviewProfiles = [
    [chromium, "windows-chromium-1280", {viewport: {width: 1280, height: 850}}],
    [chromium, "windows-chromium-2000", {viewport: {width: 2000, height: 1000}}],
    [chromium, "chromium-tablet-768", {viewport: {width: 768, height: 1024}, hasTouch: true}],
    [chromium, "android-pixel7-360", {...devices["Pixel 7"], viewport: {width: 360, height: 800}}],
    [webkit, "mac-webkit-1280", {viewport: {width: 1280, height: 850}}],
    [webkit, "iphone13", {...devices["iPhone 13"], reducedMotion: "reduce"}]
];

async function reviewMovieProfiles(verify) {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch({headless: true});
        try {
            for (const [browserType, name, {defaultBrowserType, ...options}] of reviewProfiles) {
                if (engine === browserType) await verify(browser, name, options);
            }
        } finally {
            await browser.close();
        }
    }
}

module.exports = { app, jellyfin, cors, output, homeOutput, playerOutput, moviePage, playMovieDetails,
    dismissPlayerTracks, useMovieBridge, verifyMovieProfiles, reviewMovieProfiles, movieFixtureHeader, movieHomeFixture,
    movieDetailFixture, movieAssetPath, stubMovieHls };
