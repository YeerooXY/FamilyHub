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
        page.on("request", request => requests.push(new URL(request.url()).pathname));
        await stubMovieHls(page);
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            Object.defineProperty(HTMLMediaElement.prototype, "duration", {get: () => 3000});
            Object.defineProperty(HTMLMediaElement.prototype, "src", {set() {}});
        });
        await movieHomeFixture(page, {resumeItems: [
            {Id: "film-resume", Type: "Movie", Name: "First Orbit", UserData: userData(25, 35)},
            episode("night", "Night Signal", 2, 23, 30),
            episode("quiet", "Quiet Port", 1, 24, 10),
            episode("night", "Night Signal", 3, 26, 40),
            {...episode("quiet", "Quiet Port", 2, 27, 100), UserData: {...userData(27, 100), Played: true}}
        ]});
        const shelf = page.getByRole("region", {name: "Movie library"}).locator('.movie-shelf[data-format="resume"]');
        const cards = shelf.locator(".movie-card");
        await cards.nth(2).waitFor();
        assert.deepEqual(await cards.locator(".movie-card-name").allTextContents(), ["Night Signal", "First Orbit", "Quiet Port"]);
        assert.deepEqual(await cards.locator("small").allTextContents(), ["Season 1, episode 3", "Season 1, episode 1"]);
        assert.deepEqual(await cards.locator(".movie-progress > span").evaluateAll(nodes => nodes.map(node => node.style.width)),
            ["40%", "35%", "10%"]);
        assert.equal(await cards.first().locator(".movie-art").evaluate(node => {
            const {width, height} = node.getBoundingClientRect();
            return Math.abs(width / height - 16 / 9) < .02;
        }), true);

        await cards.first().press("Enter");
        await page.getByRole("button", {name: "Back to movies"}).waitFor();
        assert.ok(requests.includes("/Items/night-3/PlaybackInfo"));
        assert.equal(requests.some(pathname => pathname.includes("NextUp") || pathname.includes("night-2/PlaybackInfo")), false);
        const time = await page.locator(".movie-player video").evaluate(video => {
            video.dispatchEvent(new Event("loadedmetadata"));
            return video.currentTime;
        });
        assert.equal(time, 1200);
        await page.getByRole("button", {name: "Back to movies"}).press("Enter");
        await page.waitForFunction(() => document.activeElement?.dataset.itemId === "night-3");
    } finally {
        await browser.close();
    }
    console.log("Continue watching groups episodes by series, orders films and series by last played, and resumes the selected episode.");
})().catch(error => { console.error(error); process.exitCode = 1; });
