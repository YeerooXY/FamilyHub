const { useMovieBridge } = require("./movies_fixture.cjs");
// Movie search offers web results and, for linked profiles, Seerr requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const answer = { ranking: "model", results: [
    { id: "aaaaaaaaaaa", title: "Az ördög jobb és bal keze 2 | Teljes Film", channel: "Film", seconds: 6600, label: "full film", reason: "Complete film", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
    { id: "bbbbbbbbbbb", title: "Előzetes", channel: "Film", seconds: 100, label: "trailer", reason: "", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }] };

async function openSearch(browser, outcome, options = { viewport: { width: 412, height: 915 } }) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(6000);
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({ path: path.join(__dirname, "../music_web/static/shell.css") });
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", route => {
        const url = new URL(route.request().url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/Items" || url.pathname === "/UserItems/Resume") return route.fulfill({ headers, json: { Items: [], TotalRecordCount: 0 } });
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    await page.evaluate(async ({ jellyfin, outcome, answer }) => {
        window.calls = [];
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef", requests_enabled: ["requests", "trinity"].includes(outcome) },
            { invokeMethodAsync: (name, ...args) => {
                if (name === "MovieDownloads") return Promise.resolve('{"available":true,"items":[]}');
                window.calls.push([name, ...args]);
                if (name === "MovieFind") return Promise.resolve(JSON.stringify(outcome === "ok" ? answer : { error: "Searching the web is not set up on this server." }));
                if (name === "MovieRequestSearch" && outcome === "trinity") return JSON.stringify({ results: [
                    { kind: "movie", id: 9394, title: "They Call Me Trinity", year: "1970" },
                    { kind: "movie", id: 11829, title: "Trinity Is Still My Name", year: "1971" }
                ] });
                if (name === "MovieRequest" && outcome === "trinity") return JSON.stringify({ state: "approved" });
                if (name === "MovieRequestSearch") return JSON.stringify({ results: [
                    { kind: "tv", id: 12, title: "The Gentlemen", year: "2024" },
                    { kind: "movie", id: 11, title: "The Gentlemen", year: "2019" },
                    { kind: "movie", id: 31, title: "The Gentlemen and the Everlasting Mystery of the Vanishing Railway Station", year: "1954", status: 5 }
                ] });
                if (name === "MovieRequest") return new Promise(resolve => setTimeout(() => resolve(JSON.stringify(
                    args[0] === "tv" ? { state: "approved" } : { error: "Could not confirm the request. Try again." }
                )), 120));
                return Promise.resolve();
            } }, { server: location.origin, profile: "viewer" });
    }, { jellyfin, outcome, answer });
    return page;
}

async function check(browser, outcome) {
    const page = await openSearch(browser, outcome);
    await page.getByRole("searchbox").fill("Az ördög jobb és bal keze 2");
    const search = page.getByRole("button", { name: "Search", exact: true });
    await search.press("Enter");
    if (outcome === "ok") {
        const watch = page.getByRole("link", {name:"Watch on YouTube"}).first();
        await watch.waitFor();
        assert.equal(await search.evaluate(a => a === document.activeElement), true, "late results preserve search focus");
        assert.equal(await page.getByRole("heading", {name:"Download options"}).count(), 0);
        await watch.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ["MovieOpenLink", "https://www.youtube.com/watch?v=aaaaaaaaaaa"]);
        await page.getByRole("heading", {name:"YouTube", exact:true}).waitFor();
        await page.getByRole("heading", {name:"Előzetes"}).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways scroll");
    } else {
        await page.getByText("Searching the web is not set up on this server.").waitFor();
        const retry = page.getByRole("button", {name:"Retry YouTube"});
        await retry.press("Enter");
        await retry.waitFor();
        assert.equal(await retry.evaluate(item => item === document.activeElement), true);
    }
    await page.evaluate(() => window.movies.close());
    await page.close();
}

async function checkRequests(browser, name, options, screenshots) {
    const page = await openSearch(browser, "requests", options);
    const query = page.getByRole("searchbox");
    const focused = locator => locator.evaluate(node => node === document.activeElement);
    await query.fill("The Gentlemen");
    await query.press("Enter");
    assert.equal(await focused(page.getByRole("button", { name: "Search", exact: true })), true);
    const series = page.getByRole("button", { name: "Request all seasons: The Gentlemen (2024)" });
    const movie = page.getByRole("button", { name: "Request download: The Gentlemen (2019)" });
    await series.waitFor();
    assert.equal(await page.getByRole("button", { name: /1954/ }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.calls), [["MovieFind", "The Gentlemen"], ["MovieRequestSearch", "The Gentlemen"]]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, name + ".png"), fullPage: true });
    await series.focus();
    await page.keyboard.press("Tab");
    assert.equal(await focused(movie), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(series), true);
    await page.keyboard.press("Space");
    await page.getByText("Sending request…").waitFor();
    assert.equal(await series.getAttribute("aria-disabled"), "true");
    await page.keyboard.press("Enter");
    const approved = page.getByText("Request approved");
    await approved.waitFor();
    assert.equal(await focused(approved), true);
    assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call[0] === "MovieRequestSearch")), [["MovieRequestSearch", "The Gentlemen"]]);
    assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call[0] === "MovieRequest")), [["MovieRequest", "tv", 12, null]]);
    await page.keyboard.press("Tab");
    assert.equal(await focused(movie), true);
    await page.keyboard.press("Enter");
    await page.getByText("Could not confirm the request. Try again.").waitFor();
    assert.equal(await focused(movie), true);
    assert.equal(await movie.getAttribute("aria-disabled"), null);
    if (options.hasTouch) {
        await movie.tap();
        await page.getByText("Could not confirm the request. Try again.").waitFor();
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
    }
    await page.evaluate(() => window.movies.close());
    await page.close();
}

async function checkTrinity(browser, screenshots) {
    const page = await openSearch(browser, "trinity", { viewport: { width: 960, height: 600 } });
    const title = "Az ördög jobb és bal keze";
    const search = page.getByRole("searchbox");
    await search.fill(title);
    await search.press("Enter");
    const original = page.getByRole("button", { name: "Request download: They Call Me Trinity (1970)" });
    await original.waitFor();
    await page.getByRole("button", { name: "Request download: Trinity Is Still My Name (1971)" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls), [["MovieFind", title], ["MovieRequestSearch", title]]);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, "trinity-fixture.png"), fullPage: true });
    await original.press("Enter");
    await page.getByText("Request approved").waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ["MovieRequest", "movie", 9394, null]);
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    const screenshots = process.argv[2];
    if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
    for (const [engine, profiles] of [
        [chromium, [["windows-chromium", { viewport: { width: 1280, height: 800 } }], ["android-chrome", devices["Pixel 7"]]]],
        [webkit, [["mac-safari", { viewport: { width: 1280, height: 800 } }], ["iphone-safari", { ...devices["iPhone 13"], reducedMotion: "reduce" }]]]
    ]) {
        const browser = await engine.launch();
        try {
            await check(browser, "ok");
            await check(browser, "unavailable");
            for (const [name, options] of profiles) await checkRequests(browser, name, options, screenshots);
            await checkTrinity(browser, engine === chromium ? screenshots : null);
        } finally { await browser.close(); }
    }
    console.log("Web search and movie/series request states passed in four browser profiles.");
})().catch(error => { console.error(error); process.exit(1); });
