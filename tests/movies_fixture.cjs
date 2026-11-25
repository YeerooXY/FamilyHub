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
            return {async close() {
                await movie.close();
                try { await send("Sessions/Logout", "", {}); } catch {}
            }};
        };
    });
}

async function moviePage(page) {
    await useMovieBridge(page);
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({path: path.join(root, "music_web/static/shell.css")});
        if (name) return route.fulfill({path: path.join(root, "clients/FamilyHub.App/wwwroot", name)});
        return route.fulfill({contentType: "text/html", body: `
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><link rel="stylesheet" href="/service-status.css">
            <style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style>
            <main class="movie-library"></main>`});
    });
    await page.goto(app);
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
    dismissPlayerTracks, useMovieBridge, verifyMovieProfiles, reviewMovieProfiles };
