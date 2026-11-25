const { useMovieBridge, homeOutput } = require("./movies_fixture.cjs");
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
        window.queue = [];
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef", requests_enabled: ["requests", "trinity"].includes(outcome),
            release_search_enabled: outcome === "videa", downloads_enabled: outcome === "videa" },
            { invokeMethodAsync: (name, ...args) => {
                if (name === "MovieDownloads") return JSON.stringify({available: true, items: window.queue});
                window.calls.push([name, ...args]);
                if (outcome === "videa") {
                    const title = "Most Wanted A hajsza S02E03";
                    if (args[0] === "Most Wanted A hajsza S2") {
                        if (name === "MovieFind" || name === "MovieReleaseSearch") return JSON.stringify({results: []});
                        if (name === "MovieVideaSearch") {
                            const episodes = Array.from({length: 10}, (_, index) => ({
                                title: `Most Wanted A hajsza S02E${String(index + 1).padStart(2, "0")} HUN`,
                                url: `https://videa.hu/videok/film-animacio/fixture-${String(index + 1).padStart(16, "0")}`
                            }));
                            return JSON.stringify({results: episodes, season: {
                                title: "Most Wanted A hajsza", number: 2, height: 360, max_height: 1080, episodes
                            }});
                        }
                    }
                    if (name === "MovieVideaSeasonDownload") {
                        window.queue = [{name: args[0], progress: .2, state: "Downloading"}];
                        return JSON.stringify({state: "sent"});
                    }
                    if (name === "MovieFind") return JSON.stringify({results: [
                        {title, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", height: 1080, label: "full film", seconds: 4500}
                    ]});
                    if (name === "MovieReleaseSearch") return JSON.stringify({results: [
                        {title: title + " 1080p WEB-DL", size: 2e9, seeders: 50, guid: "fixture", indexerId: 1}
                    ]});
                    if (name === "MovieVideaSearch") return new Promise(resolve => {
                        window.finishVidea = () => resolve(JSON.stringify({results: [
                            {title: title + " HUN 1080p WEB-DL", height: 720, url: "https://videa.hu/videok/film-animacio/fixture-ry9BOkAA4SZIAYZp"}
                        ]}));
                    });
                    if (name === "MovieVideaDownload") {
                        window.queue = [{name: args[1], progress: .45, state: "Downloading"}];
                        return JSON.stringify({state: "sent"});
                    }
                }
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

async function checkVidea(browser, name, options, screenshots) {
    const page = await openSearch(browser, "videa", options);
    const query = page.getByRole("searchbox");
    const title = "Most Wanted A hajsza S02E03";
    const submit = page.getByRole("button", {name: "Search", exact: true});
    const focused = locator => locator.evaluate(node => node === document.activeElement);
    await query.fill(title);
    await query.press("Enter");
    await page.waitForFunction(() => typeof window.finishVidea === "function");
    const list = page.getByRole("list", {name: "Release results"});
    assert.equal(await list.isVisible(), false);
    await page.evaluate(() => window.finishVidea());
    const cards = list.getByRole("listitem");
    await cards.last().waitFor();
    assert.equal(await focused(submit), true);
    assert.deepEqual(await cards.locator(".movie-release-quality").allTextContents(), ["1080p Web", "1080p", "720p"]);
    const videa = cards.filter({hasText: "Hungarian audio listed"});
    assert.equal(await videa.getByText("Videa", {exact: true}).count(), 1);
    assert.equal(await videa.getByRole("link").count(), 0);
    const action = videa.getByRole("button", {name: /^Download /});
    await action.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(cards.nth(1).getByRole("button", {name: /^Download /})), true);
    await page.keyboard.press("Tab");
    assert.equal(await focused(action), true);
    if (screenshots) await page.screenshot({path: path.join(screenshots, `videa-${name}.png`), fullPage: true});
    if (options.hasTouch) await action.tap();
    else await action.press("Space");
    const sent = videa.getByRole("status").filter({hasText: "Sent to the server"});
    await sent.waitFor();
    assert.equal(await focused(sent), true);
    await page.getByRole("region", {name: "Downloading"}).getByRole("listitem").getByText("Downloading", {exact: true}).waitFor({timeout: 5000});
    assert.deepEqual(await page.evaluate(() => window.calls.find(([method]) => method === "MovieVideaDownload")), [
        "MovieVideaDownload", "https://videa.hu/videok/film-animacio/fixture-ry9BOkAA4SZIAYZp", title + " HUN 1080p WEB-DL"
    ]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.getByRole("button", {name: "Clear"}).press("Enter");
    assert.equal(await focused(query), true);
    await page.evaluate(async () => {
        const {saveMoviePreferences} = await import("/movies.js");
        saveMoviePreferences({server: "https://jellyfin.test/", profile: "viewer"}, {audio: "hu"});
        window.finishVidea = null;
    });
    await query.fill(title);
    await query.press("Enter");
    await page.waitForFunction(() => typeof window.finishVidea === "function");
    await page.evaluate(() => window.finishVidea());
    await cards.first().getByText("Hungarian audio listed").waitFor();
    assert.equal(await page.getByRole("button", {name: "Quality", exact: true}).isVisible(), false);
    assert.deepEqual((await cards.locator(".movie-release-quality").allTextContents()).sort(), ["1080p", "1080p Web", "720p"]);

    await query.fill("Most Wanted A hajsza S2");
    await query.press("Enter");
    const season = cards.filter({hasText: "10 episodes"});
    const seasonAction = season.getByRole("button", {name: /^Download Most Wanted A hajsza · Season 2, 10 episodes/});
    await season.getByText("360p–1080p", {exact: true}).waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal(await season.getByRole("link").count(), 0);
    await seasonAction.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.equal(await focused(seasonAction), true);
    if (screenshots) await page.screenshot({path: path.join(screenshots, `videa-season-${name}.png`), fullPage: true});
    if (options.hasTouch) await seasonAction.tap();
    else await seasonAction.press("Enter");
    await season.getByText("Sent to the server").waitFor();
    assert.equal(await focused(season.getByText("Sent to the server")), true);
    const queue = page.getByRole("region", {name: "Downloading"});
    await queue.getByText("Most Wanted A hajsza · Season 2", {exact: true}).waitFor({timeout: 5000});
    assert.equal(await queue.getByRole("progressbar").count(), 1);
    if (screenshots) await page.screenshot({path: path.join(screenshots, `videa-season-queued-${name}.png`), fullPage: true});
    const seasonCalls = await page.evaluate(() => window.calls.filter(([method]) => method === "MovieVideaSeasonDownload"));
    assert.equal(seasonCalls.length, 1);
    assert.equal(seasonCalls[0][2].length, 10);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.close();
}

(async () => {
    const screenshots = process.argv[2] || homeOutput;
    fs.mkdirSync(screenshots, { recursive: true });
    for (const [engine, profiles] of [
        [chromium, [["windows-chromium", { viewport: { width: 1280, height: 800 } }], ["android-chrome", devices["Pixel 7"]]]],
        [webkit, [["mac-safari", { viewport: { width: 1280, height: 800 } }], ["iphone-safari", { ...devices["iPhone 13"], reducedMotion: "reduce" }]]]
    ]) {
        const browser = await engine.launch();
        try {
            await check(browser, "ok");
            await check(browser, "unavailable");
            for (const [name, options] of profiles) {
                await checkRequests(browser, name, options, screenshots);
                await checkVidea(browser, name, options, screenshots);
            }
            await checkTrinity(browser, engine === chromium ? screenshots : null);
        } finally { await browser.close(); }
    }
    console.log("Web search and movie/series request states passed in four browser profiles.");
})().catch(error => { console.error(error); process.exit(1); });
