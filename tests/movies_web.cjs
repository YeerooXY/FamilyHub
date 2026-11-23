// A search with no library match offers a web search; results are links with a label, nothing downloads.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const answer = { ranking: "model", results: [
    { id: "aaaaaaaaaaa", title: "Az ördög jobb és bal keze 2 | Teljes Film", channel: "Film", seconds: 6600, label: "full film", reason: "Complete film", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
    { id: "bbbbbbbbbbb", title: "Előzetes", channel: "Film", seconds: 100, label: "trailer", reason: "", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }] };

async function check(browser, outcome) {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); page.on("pageerror", e => console.log("PAGEERROR", e.message));
    page.setDefaultTimeout(6000);
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/movies.css"><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", route => {
        const url = new URL(route.request().url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/Items" || url.pathname === "/UserItems/Resume") return route.fulfill({ headers, json: { Items: [], TotalRecordCount: 0 } });
        return route.fulfill({ headers, status: 404 });
    });
    await page.goto(app + "/");
    await page.evaluate(async ({ jellyfin, outcome, answer }) => {
        window.calls = [];
        const { openMovies } = await import("/movies.js");
        window.movies = openMovies(document.querySelector("main"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef" },
            { invokeMethodAsync: (name, ...args) => {
                window.calls.push([name, ...args]);
                if (name === "MovieFind") return Promise.resolve(JSON.stringify(outcome === "ok" ? answer : { error: "Searching the web is not set up on this server." }));
                return Promise.resolve();
            } }, { server: location.origin, profile: "viewer" });
    }, { jellyfin, outcome, answer });
    await page.getByRole("searchbox").fill("Az ördög jobb és bal keze 2");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const offer = page.getByRole("button", { name: "Search the web" });
    await offer.waitFor();
    await page.getByText("“Az ördög jobb és bal keze 2” is not in the library.").waitFor();
    await offer.click();
    if (outcome === "ok") {
        const links = page.locator(".movie-web-list a");
        await links.first().waitFor();
        assert.equal(await links.count(), 2);
        assert.equal(await links.first().evaluate(a => a === document.activeElement), true, "focus moves to the first result");
        assert.match(await page.locator(".movie-web-list li").first().innerText(), /Full film · 110 min · Film — Complete film/);
        assert.match(await page.getByRole("status").filter({ hasText: "ranked with AI help" }).innerText(), /nothing is downloaded/);
        await links.nth(1).click();
        assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ["MovieOpenLink", "https://www.youtube.com/watch?v=bbbbbbbbbbb"]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways scroll");
    } else {
        await page.getByText("Searching the web is not set up on this server.").waitFor();
        assert.equal(await page.locator(".movie-web button").innerText(), "Try again");
    }
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch();
        try { await check(browser, "ok"); await check(browser, "unavailable"); } finally { await browser.close(); }
    }
    console.log("Web search offer, results, link opening and the unavailable message verified in Chromium and WebKit.");
})().catch(error => { console.error(error); process.exit(1); });
