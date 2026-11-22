// Episodes and Next Episode exist only for a title that belongs to a series. A film shows neither.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const episodes = ["Pilot", "The Move", "Visitors"].map((Name, i) => ({
    Id: "e" + i, Name, Type: "Episode", SeriesName: "Harbour Town", SeriesId: "s", ParentIndexNumber: 1, IndexNumber: i + 1,
    ImageTags: {}, UserData: i === 0 ? { PlayedPercentage: 40 } : {} }));
const film = { Id: "f", Name: "Harbour Lights", Type: "Movie", ImageTags: {} };

async function check(browser) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(6000);
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = () => Promise.resolve();
        HTMLMediaElement.prototype.canPlayType = () => "probably";
    });
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        return name ? route.fulfill({ path: path.join(wwwroot, name) })
            : route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/movies.css"><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", route => {
        const url = new URL(route.request().url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        const list = Items => route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
        if (url.pathname.endsWith("/PlaybackInfo"))
            return route.fulfill({ headers, json: { PlaySessionId: "p", MediaSources: [{ Id: "src", SupportsDirectPlay: true,
                DefaultAudioStreamIndex: 1, DefaultSubtitleStreamIndex: -1, MediaStreams: [{ Type: "Audio", Index: 1, Language: "eng" }] }] } });
        if (url.pathname === "/Shows/s/Episodes") return list(episodes);
        if (url.pathname === "/Items") return list(url.searchParams.get("includeItemTypes") === "Episode" ? episodes : [film]);
        if (url.pathname === "/UserItems/Resume") return list([]);
        if (url.pathname.startsWith("/Items/")) return route.fulfill({ headers, json: {} });
        if (url.pathname.includes("/Sessions/Playing")) return route.fulfill({ headers, status: 204 });
        return route.fulfill({ headers, status: 404 });
    });
    await page.goto(app + "/");
    await page.evaluate(async jellyfin => {
        const { openMovies } = await import("/movies.js");
        window.movies = openMovies(document.querySelector("main"), { url: jellyfin, user: "u", token: "t", device: "0123456789abcdef0123456789abcdef" },
            { invokeMethodAsync: () => Promise.resolve() }, { server: location.origin, profile: "viewer" });
    }, jellyfin);
    const shelf = page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: "TV episodes" }) });
    const back = page.getByRole("button", { name: "Back to movies" });

    // A film: no series buttons.
    await page.locator(".movie-shelf").filter({ has: page.getByRole("heading", { name: "Movies", exact: true }) }).getByRole("button", { name: "Harbour Lights" }).click();
    await back.waitFor();
    assert.equal(await page.getByRole("button", { name: "Episodes" }).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).isVisible(), false);
    await back.click();
    await back.waitFor({ state: "hidden" });

    // An episode: title shows season and episode, the sheet lists the season, Next plays the following episode.
    await shelf.getByRole("button", { name: "Harbour Town · The Move" }).click();
    await page.getByRole("heading", { name: "S1:E2 “The Move”" }).waitFor();
    const episodesButton = page.getByRole("button", { name: "Episodes", exact: true });
    await episodesButton.waitFor();
    const next = page.getByRole("button", { name: "Next episode: Visitors" });
    await next.waitFor();
    await episodesButton.click();
    const rows = page.locator(".movie-episode");
    assert.equal(await rows.count(), 3);
    assert.equal(await page.locator(".movie-episode[aria-current='true']").innerText(), "2. The Move");
    await page.getByRole("button", { name: "Close episodes" }).click();
    await page.getByRole("button", { name: "Close episodes" }).waitFor({ state: "hidden" });
    await next.click();
    await page.getByRole("heading", { name: "S1:E3 “Visitors”" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).isVisible(), false, "the last episode has no Next Episode");
    await page.evaluate(() => window.movies.close());
    await page.close();
}

(async () => {
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch();
        try { await check(browser); } finally { await browser.close(); }
    }
    console.log("Episodes and Next Episode verified for a series and absent for a film in Chromium and WebKit.");
})().catch(error => { console.error(error); process.exit(1); });
