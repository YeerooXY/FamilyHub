const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, homeOutput, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");
const output = process.argv[2] || homeOutput;

const videos = [
    ["film0000001", "A Train Through the Alps", 2160, "movie.jpg"],
    ["film0000002", "A Train Through the Alps Full Archive Cut", 1440, "episode.jpg"],
    ["film0000003", "A Train Through the Alps: Trailer", 1080, "movie-alt.jpg"],
    ["film0000004", "From the Valley to the Summit", 720, "movie.jpg"],
    ["film0000005", "Archive Footage from the Mountain Railway", 480, "episode.jpg"]
];
const thumbnail = name => `https://i.ytimg.com/${name}`;
const url = id => `https://www.youtube.com/watch?v=${id}`;
const title = videos[0][1];
const focused = locator => locator.evaluate(node => document.activeElement === node);

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(6000);
    try {
        await moviePage(page);
        await page.route(jellyfin + "/**", route => route.request().method() === "OPTIONS"
            ? route.fulfill({status: 204, headers: cors})
            : route.fulfill({headers: cors, json: {Items: [], TotalRecordCount: 0}}));
        await page.route("https://i.ytimg.com/**", route => route.fulfill({
            path: path.join(__dirname, "../clients/FamilyHub.App/wwwroot/movie-art", new URL(route.request().url()).pathname.slice(1))
        }));
        await page.clock.install();
        const candidates = videos.map(([id, title, height], index) => ({
            id, title: index === 2 ? "<b>Rail &amp; Snow&#39;s Trailer</b>" : title, url: url(id),
            ...(index === 1 ? {label: "full film", seconds: 7100} : {}),
            ...(index === 4 ? {height} : {})
        }));
        const metadata = Object.fromEntries(videos.map(([id, , height, art], index) => [id, {
            height, thumbnail: thumbnail(art), uploader: "Alpine Film Archive",
            duration: index === 0 ? 5340 : index === 1 ? 7100 : 122, view_count: index === 0 ? 34182 : index
        }]));
        await page.evaluate(async ({jellyfin, candidates}) => {
            const {openMovies} = await import("/movies.js");
            window.calls = [];
            window.queue = [];
            window.session = {url: jellyfin, user: "fixture", token: "fixture", device: "fixture", downloads_enabled: true};
            window.movies = window.openMovieFixture(openMovies, document.querySelector("main"), window.session, {invokeMethodAsync: async (method, ...args) => {
                if (method === "MovieDownloads") return JSON.stringify({available: true, items: window.queue});
                window.calls.push([method, ...args]);
                if (method === "MovieFind") return JSON.stringify({results: candidates,
                    title_details: {kind:"movie", title:candidates[0].title, runtime_minutes:90}});
                if (method === "MovieVideaSearch") return JSON.stringify({results: []});
                if (method === "MovieYouTubeMetadata") return new Promise(resolve => {
                    window.sendMetadata = results => resolve(JSON.stringify({results}));
                });
                if (method === "MovieYouTubeDownload") return new Promise(resolve => {
                    window.finishDownload = response => resolve(JSON.stringify(response));
                });
            }});
        }, {jellyfin, candidates});

        const search = page.getByRole("searchbox");
        await search.fill(title);
        await search.press("Enter");
        const searching = page.getByRole("status").filter({hasText: /^Searching…$/});
        await searching.waitFor();
        await page.waitForFunction(() => typeof window.sendMetadata === "function");
        assert.equal(await page.locator(".is-checking").count(), 1);
        await page.evaluate(results => window.sendMetadata(results), metadata);
        const list = page.getByRole("list", {name: "Release results"});
        const cards = list.getByRole("listitem");
        const video = name => cards.filter({has: page.getByRole("heading", {name, exact: true})});
        const card = video(title), trailer = video("Rail & Snow's Trailer");
        await card.getByRole("heading", {name: title, exact: true}).waitFor();
        await searching.waitFor({state: "hidden"});
        await trailer.waitFor();
        assert.equal(await cards.count(), 5);
        assert.equal(await list.locator("details").count(), 0);
        assert.equal(await focused(page.getByRole("button", {name: "Search", exact: true})), true);
        await page.getByRole("status").filter({hasText: /^5 results$/}).waitFor();
        const watch = card.getByRole("link", {name: "Watch on YouTube"});
        const download = card.getByRole("button", {name: `Download ${title}`});
        await watch.focus();
        await card.getByText("Alpine Film Archive, 1 h 29 min, 34,182 views", {exact: true}).waitFor();
        await card.getByText("Same length", {exact:true}).waitFor();
        await video(videos[1][1]).getByText("Longer than the film", {exact:true}).waitFor();
        await trailer.getByText("Shorter than the film", {exact:true}).waitFor();
        await video(videos[4][1]).getByText("Shorter than the film", {exact:true}).waitFor();
        assert.equal(await card.locator(".movie-youtube-match").getAttribute("data-level"), "same");
        assert.equal(await trailer.locator(".movie-youtube-match").getAttribute("data-level"), "different");
        assert.equal(await focused(watch), true);
        assert.deepEqual(await cards.locator(".movie-release-block").evaluateAll(nodes => nodes.map(node =>
            [node.textContent, node.dataset.level]).sort()), [
            ["1080p", "web"], ["1440p", "web"], ["480p", "tv"], ["4K", "4k-web"], ["720p", "hd"]
        ]);
        await page.waitForFunction(img => img.complete && img.naturalWidth > 0, await card.locator("img").elementHandle());
        assert.equal(await card.evaluate(node => {
            const art = node.querySelector(".movie-release-row-poster").getBoundingClientRect();
            const quality = node.querySelector(".movie-release-block").getBoundingClientRect();
            const head = node.querySelector(".movie-release-head").getBoundingClientRect();
            return art.right <= quality.left && quality.right <= head.left;
        }), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.equal(await watch.locator("svg").count(), 1);
        assert.equal(await watch.getAttribute("href"), url(videos[0][0]));
        assert.equal(await watch.getAttribute("target"), "_blank");
        await list.scrollIntoViewIfNeeded();
        await page.screenshot({path: path.join(output, profile + "-youtube.png"), fullPage: true, scale: "css"});

        const filter = page.getByRole("group", {name: "Quality"});
        const sd = filter.getByRole("button", {name: /^SD /});
        if (options.hasTouch) await sd.tap();
        else await sd.press("Enter");
        assert.equal(await focused(sd), true);
        assert.deepEqual(await cards.locator(".movie-release-block").allTextContents(), ["480p"]);
        await filter.getByRole("button", {name: /^All /}).press("Space");
        assert.equal(await cards.count(), 5);
        await watch.press("Enter");
        assert.equal(await focused(watch), true);
        assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["MovieOpenLink", url(videos[0][0])]);
        await page.keyboard.press("Tab");
        assert.equal(await focused(download), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(download), true);
        if (options.hasTouch) await download.tap();
        else await download.press("Space");
        const sending = card.getByRole("button", {name: `Sending… ${title}`});
        await sending.waitFor();
        assert.equal(await focused(sending), true);
        await sending.press("Enter");
        assert.equal(await page.evaluate(() => calls.filter(([method]) => method === "MovieYouTubeDownload").length), 1);
        await page.evaluate(() => window.finishDownload({error: "The download queue is full. Try again later."}));
        const retry = card.getByRole("button", {name: `Try again ${title}`});
        await retry.waitFor();
        assert.equal(await focused(retry), true);
        await card.getByRole("status").filter({hasText: "The download queue is full."}).waitFor();
        await retry.press("Enter");
        await sending.waitFor();
        await page.evaluate(name => {
            window.queue = [{name, progress: .45, state: "Downloading"}];
            window.finishDownload({state: "sent"});
        }, title);
        const sent = card.getByRole("button", {name: "Added " + title});
        await sent.waitFor();
        await page.clock.fastForward(3200);
        // 1.6.4: active downloads show in the floating tray instead of an inline list.
        const tray = page.locator(".movie-download-toggle");
        await tray.waitFor();
        assert.equal(await tray.getAttribute("aria-label"), "Downloads, 1 active");
        assert.equal(await tray.evaluate(node => node.style.getPropertyValue("--download-percent")), "45");
        assert.equal(await focused(sent), true);
        assert.deepEqual(await page.evaluate(() => calls.filter(([method]) => method === "MovieYouTubeDownload")),
            [1, 2].map(() => ["MovieYouTubeDownload", url(videos[0][0]), title]));
    } finally {
        await page.close();
    }
}

fs.mkdirSync(output, {recursive: true});
verifyMovieProfiles(verify).then(() => console.log("YouTube cards passed in eight browser profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
