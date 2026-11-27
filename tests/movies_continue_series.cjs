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
        const writes = [];
        page.on("request", request => {
            const url = new URL(request.url());
            requests.push(url);
            if (request.method() === "POST" && /HideFromResume$|\/Shows\/NextUp$/.test(url.pathname))
                writes.push([url.pathname, url.search, request.postDataJSON()]);
        });
        await stubMovieHls(page);
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            Object.defineProperty(HTMLMediaElement.prototype, "duration", {get: () => 6000});
            Object.defineProperty(HTMLMediaElement.prototype, "src", {set() {}});
        });
        await movieHomeFixture(page, {resumeItems: [
            {Id: "film-resume", Type: "Movie", Name: "First Orbit", UserData: userData(25, 35, 4354)},
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
        for (const [id, key, seconds] of [["night-3", "Enter", 1200], ["film-resume", "Space", 4354], ["harbour-4", null, 0]]) {
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
        const details = shelf.getByRole("button", {name: "More options for First Orbit"});
        const filmCard = cards.and(page.locator('[data-item-id="film-resume"]'));
        const menu = shelf.getByRole("menu");
        const remove = menu.getByRole("menuitem", {name: "Remove from Continue watching"});
        const info = menu.getByRole("menuitem", {name: "More info"});
        const focused = node => node.evaluate(element => element === document.activeElement);
        for (const [width, target, outline] of [[1280, 44, "2px"], [1920, 60, "4px"], [2000, 60, "4px"], [390, 44, "2px"]]) {
            await page.setViewportSize({width, height: 1080});
            await filmCard.scrollIntoViewIfNeeded();
            await filmCard.press("ArrowUp");
            assert.deepEqual(await details.evaluate(node =>
                [node === document.activeElement, node.offsetWidth, node.offsetHeight, getComputedStyle(node).outlineWidth]),
            [true, target, target, outline]);
            assert.equal(await details.getAttribute("title"), null);
            await page.waitForFunction(node => getComputedStyle(node).transform === "none", await filmCard.elementHandle());
            assert.equal(await details.evaluate(node => {
                const dots = node.getBoundingClientRect();
                const art = node.previousElementSibling.querySelector(".movie-art").getBoundingClientRect();
                return dots.right <= art.right + 1 && art.right - dots.right < 12 &&
                    dots.top >= art.top - 1 && dots.top - art.top < 12 && dots.bottom <= art.bottom + 1;
            }), true, width + " menu trigger is inside the top right of the image");
            await details.press("Enter");
            assert.equal(await focused(remove), true);
            assert.equal(await remove.evaluate(node => document.elementFromPoint(
                node.getBoundingClientRect().left + 16, node.getBoundingClientRect().top + 10)?.closest("[role=menuitem]") === node),
            true, width + " menu is in front of the shelf");
            await page.keyboard.press("ArrowDown");
            assert.equal(await focused(info), true);
            await page.keyboard.press("ArrowUp");
            assert.equal(await focused(remove), true);
            await page.keyboard.press("Escape");
            await menu.waitFor({state: "hidden"});
            assert.equal(await focused(details), true);
            await details.press("Space");
            await page.keyboard.press("Tab");
            await menu.waitFor({state: "hidden"});
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, width);
            await details.focus();
            await page.keyboard.press("Shift+Tab");
            assert.equal(await focused(filmCard), true);
            await page.keyboard.press("Tab");
            assert.equal(await focused(details), true);
        }
        await details.press("Enter");
        await shelf.getByRole("heading", {name: "Continue watching"}).click();
        await menu.waitFor({state: "hidden"});
        const night = shelf.getByRole("button", {name: "More options for Night Signal"});
        await night.press("Enter");
        await info.press("Enter");
        const series = page.getByRole("region", {name: "Night Signal", exact: true});
        await series.getByRole("button", {name: "Continue S1 E3 from 20:00", exact: true}).waitFor();
        await series.getByRole("button", {name: "Back to titles"}).press("Enter");
        assert.equal(await focused(night), true);
        await details.press("Enter");
        await info.press("Enter");
        const film = page.getByRole("region", {name: "First Orbit"});
        await film.getByRole("button", {name: "Continue from 1:12:34", exact: true}).waitFor();
        const removeFromFilm = film.getByRole("button", {name: "Remove from Continue watching"});
        assert.equal(await removeFromFilm.getAttribute("title"), null);
        await removeFromFilm.press("Enter");
        await removeFromFilm.waitFor({state: "hidden"});
        const play = film.getByRole("button", {name: "Play", exact: true});
        assert.equal(await focused(play), true);
        assert.deepEqual(writes.at(-1), ["/UserItems/film-resume/HideFromResume", "?hide=true", {positionTicks: 4354 * 1e7}]);
        await play.press("Enter");
        await back.waitFor();
        assert.equal(await page.locator(".movie-player video").evaluate(video => {
            video.dispatchEvent(new Event("loadedmetadata"));
            return video.currentTime;
        }), 0);
        await back.press("Enter");
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");
        await filmCard.waitFor({state: "detached"});

        const harbour = shelf.getByRole("button", {name: "More options for Harbour Town"});
        const fail = route => route.request().method() === "POST"
            ? route.fulfill({status: 502, headers: {"Access-Control-Allow-Origin": "*"}}) : route.fallback();
        await page.route("**/Shows/NextUp", fail);
        await harbour.press("Enter");
        await remove.press("Enter");
        await shelf.getByRole("status").filter({hasText: "Could not remove this title. Try again."}).waitFor();
        assert.equal(await focused(harbour), true);
        await page.unroute("**/Shows/NextUp", fail);
        await page.evaluate(() => {
            window.removalAnnouncements = [];
            new MutationObserver(records => {
                for (const record of records)
                    for (const node of record.addedNodes)
                        if (record.target.parentElement?.matches('[role="status"]') || record.target.matches?.('[role="status"]'))
                            if (node.textContent.startsWith("Removed Harbour Town")) removalAnnouncements.push(node.textContent);
            }).observe(document.querySelector(".movie-library"), {subtree: true, childList: true});
        });
        await harbour.press("Space");
        await remove.press("Enter");
        await harbour.waitFor({state: "detached"});
        assert.equal(await focused(cards.first()), true);
        assert.deepEqual(await page.evaluate(() => window.removalAnnouncements), ["Removed Harbour Town from Continue watching"]);
        assert.deepEqual(writes.at(-1), ["/Shows/NextUp", "", {seriesId: "harbour", episodeId: "harbour-4"}]);
    } finally {
        await browser.close();
    }
    console.log("Continue watching groups episodes by series, orders films and series by last played, and resumes the selected episode.");
})().catch(error => { console.error(error); process.exitCode = 1; });
