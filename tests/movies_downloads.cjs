const assert = require("node:assert/strict");
const path = require("node:path");
const { jellyfin, cors, homeOutput, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(5000);
    try {
        await page.route(jellyfin + "/**", route => route.request().method() === "OPTIONS"
            ? route.fulfill({status: 204, headers: cors})
            : route.fulfill({headers: cors, json: {Items: [], TotalRecordCount: 0}}));
        await moviePage(page);
        await page.clock.install();
        await page.evaluate(async jellyfin => {
            const { openMovies } = await import("/movies.js");
            window.queueReads = 0;
            window.queueResponse = {available: true, items: [
                {name: "Trinity restored edition", progress: .64, size: 12345, state: "Downloading", eta: 125, speed: 9143},
                {name: "The General", progress: 1, size: 54321, state: "Finished", eta: null, speed: 0},
                {name: "Paused release", progress: .5, state: "Paused"},
                {name: "Failed release", progress: .2, state: "Problem"}
            ]};
            window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
                {url: jellyfin, user: "fixture", token: "fixture", device: "fixture", downloads_enabled: true},
                {invokeMethodAsync: async method => {
                    if (method === "MovieDownloads") {
                        window.queueReads++;
                        return JSON.stringify(window.queueResponse);
                    }
                    return JSON.stringify({results: []});
                }});
        }, jellyfin);
        const tray = page.getByRole("button", {name: "Downloads, 1 active"});
        await tray.press("Enter");
        const panel = page.getByRole("dialog", {name: "Downloads"});
        await panel.getByText("about 3 min left", {exact: true}).waitFor();
        assert.equal(await panel.getByText("The General").count(), 0);
        assert.equal(await panel.getByText(/Paused release|Failed release/).count(), 0);
        assert.equal(await panel.getByRole("progressbar").first().getAttribute("aria-valuenow"), "64");
        assert.equal(await panel.getByRole("progressbar").first().locator("span").evaluate(el => el.style.transform), "scaleX(0.64)");
        assert.doesNotMatch(await panel.innerText(), /seeder|bytes|9143/);
        assert.equal(await page.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect();
            const panel = box(".movie-downloads"), toggle = box(".movie-download-toggle");
            return panel.right === toggle.right && panel.bottom < toggle.top &&
                getComputedStyle(document.querySelector(".movie-download-tray")).position === "fixed";
        }), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({path: path.join(process.argv[2] || homeOutput, profile + "-downloads.png")});

        const row = panel.getByRole("button", {name: "Trinity restored edition"});
        await row.focus();
        await page.evaluate(() => {
            window.queueResponse.items[0] = {...window.queueResponse.items[0], progress: .97, state: "Almost done", eta: 18};
        });
        await page.clock.fastForward(5000);
        await panel.getByText("about 1 min left", {exact: true}).waitFor();
        assert.equal(await row.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.evaluate(() => queueReads), 2);

        const setLibraryHidden = hidden => page.locator(".movie-catalogue").evaluate((node, hidden) => {
            node.parentElement.hidden = hidden;
        }, hidden);
        await setLibraryHidden(true);
        await page.clock.fastForward(15000);
        assert.equal(await page.evaluate(() => queueReads), 2);
        await setLibraryHidden(false);
        await page.waitForFunction(() => queueReads === 3);

        const setHidden = hidden => page.evaluate(hidden => {
            Object.defineProperty(document, "hidden", {configurable: true, value: hidden});
            document.dispatchEvent(new Event("visibilitychange"));
        }, hidden);
        await setHidden(true);
        await page.clock.fastForward(15000);
        assert.equal(await page.evaluate(() => queueReads), 3);
        await page.evaluate(() => { window.queueResponse.items = []; });
        await setHidden(false);
        await tray.waitFor({state: "hidden"});
        await page.clock.fastForward(15000);
        assert.equal(await page.evaluate(() => queueReads), 4);

        await page.evaluate(() => { window.queueResponse = {available: false, reason: "Server downloads are not set up."}; });
        await setHidden(true);
        await setHidden(false);
        await page.waitForFunction(() => queueReads === 5);
        assert.equal(await panel.isVisible(), false);
        await page.evaluate(() => window.movies.close());
        await page.clock.fastForward(10000);
        assert.equal(await page.evaluate(() => queueReads), 5);
    } finally {
        await page.close();
    }
}

verifyMovieProfiles(verify).then(() => console.log("Server downloads passed in eight browser profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
