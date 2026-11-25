// Each film sits on one genre shelf only: the first shelf, in the order shown, that lists one of its genres.
const assert = require("node:assert/strict");
const path = require("node:path");
const { useMovieBridge } = require("./movies_fixture.cjs");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const film = (id, name, genres) => ({ Id: id, Name: name, Type: "Movie", ProductionYear: 2011, Genres: genres, ImageTags: {}, UserData: {} });
const library = [film("a1", "In Time", ["Science Fiction", "Thriller"]), film("a2", "Heat", ["Thriller", "Crime"]), film("a3", "Alien", ["Science Fiction"]),
    ...["Arrival", "Contact"].map((name, i) => film(`science${i}`, name, ["Science Fiction"])),
    ...["Vertigo", "Rear Window", "North by Northwest"].map((name, i) => film(`thriller${i}`, name, ["Thriller"]))];

async function check(browser, label, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(6000);
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({ path: path.join(__dirname, "../music_web/static/shell.css") });
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><style>html,body{min-height:100%}</style><main></main>' });
    });
    await page.route(jellyfin + "/**", route => {
        const url = new URL(route.request().url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/Genres") return route.fulfill({ headers, json: { Items: ["Science Fiction", "Thriller", "Crime"].map(Name => ({ Name })), TotalRecordCount: 3 } });
        if (url.pathname === "/Items") {
            const genre = url.searchParams.get("genres");
            const Items = genre ? library.filter(item => item.Genres.includes(genre)) : [];
            return route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
        }
        if (url.pathname === "/UserItems/Resume") return route.fulfill({ headers, json: { Items: [], TotalRecordCount: 0 } });
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    await page.evaluate(async ({ jellyfin }) => {
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef" }, { invokeMethodAsync: async () => "{}" });
    }, { jellyfin });
    const shelf = (title) => page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await page.getByRole("heading", { name: "Science Fiction", exact: true }).waitFor();
    await shelf("Science Fiction").locator("[data-item-id=a1]").waitFor();
    await shelf("Science Fiction").locator("[data-item-id=a3]").waitFor();
    for (const name of ["Thriller", "Crime"]) await shelf(name).scrollIntoViewIfNeeded().catch(() => {});
    await shelf("Thriller").locator("[data-item-id=a2]").waitFor();
    assert.equal(await shelf("Thriller").locator("[data-item-id=a1]").count(), 0, `${label}: In Time stays off the Thriller shelf`);
    // Crime has fewer than four titles after the preceding genres claim their cards.
    await page.waitForFunction(() => [...document.querySelectorAll(".movie-shelf")].find(s => s.querySelector("h2")?.textContent === "Crime")?.hidden !== false);
    const total = await page.locator(".movie-shelf").evaluateAll(shelves => shelves.filter(s => !s.hidden && ["Science Fiction", "Thriller", "Crime"].includes(s.querySelector("h2")?.textContent))
        .flatMap(s => [...s.querySelectorAll(".movie-card, [data-item-id]")].map(card => card.dataset.itemId)));
    assert.equal(new Set(total).size, total.length, `${label}: no film is repeated across genre shelves`);
    await page.close();
}

(async () => {
    for (const [engine, profiles] of [
        [chromium, [["desktop", { viewport: { width: 1280, height: 900 } }], ["pixel-7", { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } }]]],
        [webkit, [["iphone-13", { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }]]],
    ]) {
        const browser = await engine.launch();
        try { for (const [label, options] of profiles) await check(browser, label, options); } finally { await browser.close(); }
    }
    console.log("Genre shelves list each film once, on the first matching shelf, in Chromium and WebKit.");
})().catch(error => { console.error(error); process.exit(1); });
