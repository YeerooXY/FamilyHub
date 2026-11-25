const assert = require("node:assert/strict");
const path = require("node:path");
const { jellyfin, cors, homeOutput, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");

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
        await page.route(jellyfin + "/**", route => route.request().method() === "OPTIONS"
            ? route.fulfill({status: 204, headers: cors})
            : route.fulfill({headers: cors, json: {Items: [], TotalRecordCount: 0}}));
        await page.route("https://i.ytimg.com/**", route => route.fulfill({
            path: path.join(__dirname, "../clients/FamilyHub.App/wwwroot/movie-art", new URL(route.request().url()).pathname.slice(1))
        }));
        await moviePage(page);
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
        await page.getByRole("heading", {name: "YouTube", exact: true}).waitFor();
        const list = page.getByRole("list", {name: "YouTube videos"});
        const cards = list.getByRole("listitem");
        const card = cards.first();
        await card.getByRole("heading", {name: title, exact: true}).waitFor();
        await page.getByText("A Train Through the Alps: 1 h 30 min", {exact:true}).waitFor();
        await cards.nth(2).getByRole("heading", {name:"Rail & Snow's Trailer"}).waitFor();
        assert.equal(await cards.count(), 5);
        assert.equal(await list.locator("details").count(), 0);
        assert.equal(await focused(page.getByRole("button", {name: "Search", exact: true})), true);
        await page.getByRole("status").filter({hasText: "5 videos found."}).waitFor();
        const watch = card.getByRole("link", {name: "Watch on YouTube"});
        const download = card.getByRole("button", {name: `Download ${title}`});
        await watch.focus();
        await page.evaluate(results => window.sendMetadata(results), metadata);
        await card.getByText("Alpine Film Archive, 1 h 29 min, 34,182 views", {exact: true}).waitFor();
        await card.getByText("Same length", {exact:true}).waitFor();
        await cards.nth(1).getByText("Longer than the film", {exact:true}).waitFor();
        await cards.nth(2).getByText("Shorter than the film", {exact:true}).waitFor();
        await cards.nth(4).getByText("Shorter than the film", {exact:true}).waitFor();
        assert.equal(await card.locator(".movie-youtube-match").getAttribute("data-level"), "same");
        assert.equal(await cards.nth(2).locator(".movie-youtube-match").getAttribute("data-level"), "different");
        assert.equal(await focused(watch), true);
        assert.deepEqual(await cards.locator(".movie-release-quality").evaluateAll(nodes => nodes.map(node =>
            [node.textContent, node.dataset.level])), [
            ["4K", "4k-web"], ["1440p", "web"], ["1080p", "web"], ["720p", "hd"], ["480p", "tv"]
        ]);
        await page.waitForFunction(() => [...document.querySelectorAll(".movie-youtube-art img")].every(
            img => img.complete && img.naturalWidth > 0));
        assert.equal(await card.evaluate((node, phone) => {
            const art = node.querySelector(".movie-youtube-art").getBoundingClientRect();
            const body = node.querySelector(".movie-youtube-content").getBoundingClientRect();
            return phone ? art.bottom <= body.top : art.right <= body.left;
        }, options.viewport.width <= 600), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.equal(await card.locator("svg").count(), 1);
        assert.equal(await watch.getAttribute("href"), url(videos[0][0]));
        assert.equal(await watch.getAttribute("target"), "_blank");
        await list.scrollIntoViewIfNeeded();
        await page.screenshot({path: path.join(process.argv[2] || homeOutput, profile + "-youtube.png"), fullPage: true, scale: "css"});

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
        const sent = card.getByText("Sent to the server");
        await sent.waitFor();
        await page.clock.fastForward(3200);
        const panel = page.getByRole("region", {name: "Downloading"});
        await panel.getByRole("listitem").getByText("Downloading", {exact: true}).waitFor();
        assert.equal(await panel.getByRole("progressbar", {name: title}).getAttribute("aria-valuenow"), "45");
        assert.equal(await focused(sent), true);
        assert.deepEqual(await page.evaluate(() => calls.filter(([method]) => method === "MovieYouTubeDownload")),
            [1, 2].map(() => ["MovieYouTubeDownload", url(videos[0][0]), title]));
    } finally {
        await page.close();
    }
}

verifyMovieProfiles(verify).then(() => console.log("YouTube cards passed in eight browser profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
