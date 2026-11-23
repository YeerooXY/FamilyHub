const { useMovieBridge } = require("./movies_fixture.cjs");
// Renders the Movies & TV library from a dense mocked Jellyfin and saves screenshots for review.
// Usage: node tests/movies_visual.cjs [output-dir]   (emulated engines and device profiles, not real devices)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]
}));

const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.resolve(process.argv[2] || path.join(__dirname, "../docs/verification/movies-ui-2026-11-22"));
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const titles = ["Harbour Lights", "The Long Way Home", "Paper Moons", "Northern Rail", "Quiet Orchard", "Glass Season",
    "Summer of Wires", "Low Tide", "The Last Ferry", "Copper Hills", "Night Market", "A Small Revolution",
    "Winter Garden", "Salt and Iron", "Midnight Bakery", "River Street", "Open Fields", "Golden Hour"];
const movies = titles.map((Name, i) => ({ Id: "m" + i, Name, Type: "Movie", ProductionYear: 2008 + i, OfficialRating: i % 3 ? "PG-13" : "PG",
    RunTimeTicks: (80 + i * 4) * 6e8, Genres: [["Drama", "Comedy", "Thriller"][i % 3]],
    Overview: "A quiet town gets a visitor with a map nobody has seen, and one evening decides what everyone does next.",
    BackdropImageTags: i < 2 ? ["b"] : undefined, ImageTags: i < 6 ? { Primary: "p" } : undefined,
    UserData: i === 1 ? { PlaybackPositionTicks: 40 * 6e8, PlayedPercentage: 42 } : {} }));
const episodes = ["Pilot", "The Move", "Visitors", "Snow Day", "Finale", "Reunion"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ImageTags: { Thumb: "t" } }));

async function render(browser, label, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(8000);
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:1rem;background:#0b0d12;color:#fff;font:16px system-ui,sans-serif}button,input{font:inherit}</style><link rel="stylesheet" href="/movies.css"><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", route => {
        const req = route.request(), url = new URL(req.url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        const list = Items => route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
        if (url.pathname.includes("/Images/")) {
            const art = url.pathname.endsWith("/Backdrop") ? "movie.jpg" : url.pathname.includes("/Items/e") ? "episode.jpg" : "movie-alt.jpg";
            return route.fulfill({ headers, path: path.join(wwwroot, "movie-art", art) });
        }
        if (url.pathname === "/Genres") return route.fulfill({ headers, json: { Items: [{ Name: "Drama" }, { Name: "Comedy" }, { Name: "Thriller" }] } });
        if (url.pathname === "/UserItems/Resume") return list([movies[1], episodes[1]]);
        if (url.pathname === "/Items") {
            const types = url.searchParams.get("includeItemTypes");
            const genre = url.searchParams.get("genres");
            if (types === "Episode") return list(episodes);
            return list(genre ? movies.filter(m => m.Genres[0] === genre) : movies);
        }
        return route.fulfill({ headers, status: 404 });
    });
    await useMovieBridge(page);
    await page.goto(app + "/");
    await page.evaluate(async jellyfin => {
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
            { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef" },
            { invokeMethodAsync: () => Promise.resolve() }, { server: location.origin, profile: "viewer" });
    }, jellyfin);
    await page.locator(".movie-hero-play").waitFor();
    await page.locator(".movie-card").first().waitFor();
    assert.equal(await page.locator("body").evaluate(node => node.scrollWidth <= innerWidth), true, label + " overflows horizontally");
    assert.equal(await page.locator(".movie-hero-play").innerText(), "Resume");
    assert.ok(await page.locator(".movie-progress").count() >= 2, label + " shows progress");
    await page.screenshot({ path: path.join(out, label + ".png") });
    // Scroll so the lazy genre shelves load, then capture the whole page.
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } scrollTo(0, 0); });
    await page.waitForTimeout(500);
    assert.ok(await page.locator(".movie-shelf:not([hidden])").count() >= 5, label + " shows the library shelves");
    await page.screenshot({ path: path.join(out, label + "-full.png"), fullPage: true });
    // Keyboard: Play, Down into the first shelf, Right along a row, Up back to the billboard.
    await page.locator(".movie-hero-play").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("movie-card")), true, label + " ArrowDown reaches a card");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("movie-hero-play")), true, label + " ArrowUp returns to Play");
    // The next-chevron scrolls a row when a pointer is present.
    if (options.hasTouch !== true) {
        const row = page.locator(".movie-row").nth(1);
        await row.hover();
        const before = await row.evaluate(node => node.scrollLeft);
        await row.locator("xpath=..").locator(".movie-chev-right").click();
        await page.waitForFunction(([i, start]) => document.querySelectorAll(".movie-row")[i].scrollLeft > start, [1, before]);
    }
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    fs.mkdirSync(out, { recursive: true });
    const profiles = [
        [chromium, "windows-chromium-1280", { viewport: { width: 1280, height: 800 } }],
        [chromium, "tv-1920x1080", { viewport: { width: 1920, height: 1080 } }],
        [chromium, "wide-2560", { viewport: { width: 2560, height: 1200 } }],
        [chromium, "android-pixel7", devices["Pixel 7"]],
        [webkit, "mac-safari-engine-1280", { viewport: { width: 1280, height: 800 } }],
        [webkit, "iphone13", devices["iPhone 13"]]
    ];
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch();
        try {
            for (const [owner, label, options] of profiles) if (owner === engine) await render(browser, label, options);
        } finally { await browser.close(); }
    }
    console.log("Movies UI rendered in " + profiles.length + " emulated profiles: " + out);
})().catch(error => { console.error(error); process.exit(1); });
