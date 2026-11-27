const assert = require("node:assert/strict");
const path = require("node:path");
const {constants, setPriority} = require("node:os");
const {chromium} = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
const {movieHomeFixture, stubMovieHls} = require("./movies_fixture.cjs");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const userData = (day, percent, seconds = 0) => ({
    LastPlayedDate: `2026-11-${day}T12:00:00Z`, PlayedPercentage: percent, PlaybackPositionTicks: seconds * 1e7
});
const episode = (series, SeriesName, IndexNumber, day, percent) => ({
    Id: `${series}-${IndexNumber}`, SeriesId: series, SeriesName, Type: "Episode", Name: `Part ${IndexNumber}`,
    IndexNumber, ParentIndexNumber: 1, SeriesThumbImageTag: "thumb", RunTimeTicks: 3000 * 1e7,
    UserData: userData(day, percent, 3000 * percent / 100)
});

(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 1280, height: 850}});
        const requests = [];
        page.on("request", request => requests.push(new URL(request.url())));
        await stubMovieHls(page);
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            Object.defineProperty(HTMLMediaElement.prototype, "duration", {get: () => 3000});
            Object.defineProperty(HTMLMediaElement.prototype, "src", {set() {}});
        });
        await movieHomeFixture(page, {resumeItems: [
            {Id: "film-resume", Type: "Movie", Name: "First Orbit", UserData: userData(25, 35, 350)},
            episode("night", "Night Signal", 2, 23, 30),
            episode("quiet", "Quiet Port", 1, 24, 10),
            episode("night", "Night Signal", 3, 26, 40),
            {...episode("quiet", "Quiet Port", 2, 27, 100), UserData: {...userData(27, 100), Played: true}}
        ], nextUp: [
            {...episode("night", "Night Signal", 4, 28, 0)},
            {...episode("harbour", "Harbour Town", 4, 22, 0), Name: "The Move", ParentIndexNumber: 2}
        ], played: [
            {...episode("harbour", "Harbour Town", 3, 27, 100), UserData: {...userData(27, 100), Played: true}}
        ]});
        const shelf = page.getByRole("region", {name: "Movie library"}).locator('.movie-shelf[data-format="resume"]');
        const cards = shelf.locator(".movie-card");
        await cards.nth(3).waitFor();
        assert.deepEqual(await cards.locator(".movie-card-name").allTextContents(), ["Harbour Town", "Night Signal", "First Orbit", "Quiet Port"]);
        assert.deepEqual(await cards.locator("small").allTextContents(), ["S2 E4, The Move", "S1 E3, Part 3", "S1 E1, Part 1"]);
        assert.deepEqual(await cards.locator(".movie-progress > span").evaluateAll(nodes => nodes.map(node => node.style.width)),
            ["40%", "35%", "10%"]);
        assert.equal(await cards.first().locator(".movie-art").evaluate(node => {
            const {width, height} = node.getBoundingClientRect();
            return Math.abs(width / height - 16 / 9) < .02;
        }), true);

        const next = requests.find(url => url.pathname === "/Shows/NextUp");
        assert.equal(next.searchParams.get("enableResumable"), "false");
        assert.equal(next.searchParams.get("disableFirstEpisode"), "true");
        for (const key of ["userId", "fields", "limit"]) assert.ok(next.searchParams.get(key), key);
        assert.ok(requests.some(url => url.pathname === "/Items" && url.searchParams.get("parentId") === "harbour" &&
            url.searchParams.get("filters") === "IsPlayed" && url.searchParams.get("sortBy") === "DatePlayed"));
        const back = page.getByRole("button", {name: "Back to movies"});
        for (const [id, key, seconds] of [["night-3", "Enter", 1200], ["film-resume", "Space", 350], ["harbour-4", null, 0]]) {
            const card = cards.and(page.locator(`[data-item-id="${id}"]`));
            if (key) await card.press(key);
            else await card.click();
            await back.waitFor();
            assert.ok(requests.some(url => url.pathname === `/Items/${id}/PlaybackInfo`));
            const time = await page.locator(".movie-player video").evaluate(video => {
                video.dispatchEvent(new Event("loadedmetadata"));
                return video.currentTime;
            });
            assert.equal(time, seconds, id);
            await back.press("Enter");
            await page.waitForFunction(id => document.activeElement?.dataset.itemId === id, id);
        }
        assert.equal(requests.some(url => /night-[24]\/PlaybackInfo/.test(url.pathname)), false);
        const details = shelf.getByRole("button", {name: "Details for First Orbit"});
        const filmCard = cards.and(page.locator('[data-item-id="film-resume"]'));
        for (const [width, target, outline] of [[1280, 44, "2px"], [1920, 60, "4px"]]) {
            await page.setViewportSize({width, height: 1080});
            await filmCard.press("ArrowUp");
            assert.deepEqual(await details.evaluate(node =>
                [node === document.activeElement, node.offsetWidth, node.offsetHeight, getComputedStyle(node).outlineWidth]),
            [true, target, target, outline]);
            await page.keyboard.press("Shift+Tab");
            assert.equal(await filmCard.evaluate(node => node === document.activeElement), true);
            await page.keyboard.press("Tab");
            assert.equal(await details.evaluate(node => node === document.activeElement), true);
        }
        await details.press("Enter");
        const film = page.getByRole("region", {name: "First Orbit"});
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");
        assert.equal(await details.evaluate(node => node === document.activeElement), true);
    } finally {
        await browser.close();
    }
    console.log("Continue watching groups episodes by series, orders films and series by last played, and resumes the selected episode.");
})().catch(error => { console.error(error); process.exitCode = 1; });
