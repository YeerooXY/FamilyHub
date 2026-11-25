const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]
}));

const root = path.resolve(__dirname, "..");
const homeOutput = path.join(root, "docs/verification/movies-home-2026-11-24");
const playerOutput = path.join(root, "docs/verification/movie-player-2026-11-24");
const output = path.resolve(process.argv[2] || playerOutput);
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
const movieFixtureHeader = `<header class="app-header">
    <div class="header-start"><button id="open-hub">Switch apps</button><button id="header-back">Go back</button></div>
    <div class="header-search"><form id="search-form"><input id="q" type="search" aria-label="Search songs"></form></div>
    <div class="sidebar-account"><button id="profile-toggle" aria-label="Profile menu">P</button></div>
</header>`;

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

async function moviePage(page, {shell = false} = {}) {
    await useMovieBridge(page);
    await page.route("**/*", route => {
        const {hostname} = new URL(route.request().url());
        return hostname.endsWith(".test") || ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
            ? route.fallback() : route.abort();
    });
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({path: path.join(root, "music_web/static/shell.css")});
        if (name) return route.fulfill({path: path.join(root, "clients/FamilyHub.App/wwwroot", name)});
        return route.fulfill({contentType: "text/html", body: `
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><link rel="stylesheet" href="/service-status.css">
            <style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style>
            ${shell ? '<link rel="stylesheet" href="/app-native.css">' + movieFixtureHeader : ''}
            <main class="movie-library"></main>`});
    });
    await page.goto(app);
}

async function movieHomeFixture(page, {preview = false, matches = []} = {}) {
    await moviePage(page, {shell: true});
    const library = await page.evaluate(async () => (await import("/movies.js")).moviePreviewLibrary());
    const favoriteWrites = [];
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
        if (url.pathname === "/Items" || url.pathname === "/UserItems/Resume") {
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
        return route.fulfill({headers, status: 404});
    });
    library[0].ImageTags.Logo = "logo";
    library.slice(0, 18).forEach((item, i) => { item.UserData.PlayedPercentage = 10 + i; });
    await page.evaluate(async ({preview, jellyfin, matches}) => {
        const {openMovies} = await import("/movies.js");
        const host = document.querySelector(".movie-library");
        const viewer = {server: jellyfin, profile: "fixture"};
        window.movieCalls = [];
        const bridge = {invokeMethodAsync: async (method, ...args) => {
            window.movieCalls.push([method, ...args]);
            return JSON.stringify(method === "MovieMatches" ? {matches} : {results: []});
        }};
        window.movies = preview ? openMovies(host, null, bridge, viewer) :
            window.openMovieFixture(openMovies, host, {url: jellyfin, user: "u", token: "t", release_search_enabled: matches.length > 0}, bridge, viewer);
    }, {preview, jellyfin, matches});
    await page.locator(".app-header .movie-search input:enabled").waitFor();
    return {library, favoriteWrites};
}

async function playMovieDetails(page, card, title) {
    await card.press("Enter");
    const details = page.getByRole("region", {name: title, exact: true});
    const play = details.getByRole("button", {name: /^(Play|Resume)$/});
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
    dismissPlayerTracks, useMovieBridge, verifyMovieProfiles, reviewMovieProfiles, movieFixtureHeader, movieHomeFixture };
