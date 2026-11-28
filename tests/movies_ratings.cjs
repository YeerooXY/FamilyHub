// Ratings chips on a title page: shown only when the server has values, named in full, and off when the profile switches them off.
const assert = require("node:assert/strict");
const {movieDetailFixture, reviewMovieProfiles} = require("./movies_fixture.cjs");

const ratings = [
    {source: "imdb", name: "IMDb", value: "7.8"},
    {source: "tomatoes", name: "Rotten Tomatoes", value: "91%"},
    {source: "metacritic", name: "Metacritic", value: "74"}
];

async function check(browser, profile, options) {
    const context = await browser.newContext(options);
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(7000);
        await movieDetailFixture(page);
        const home = page.getByRole("region", {name: "Movie library"});
        const film = page.getByRole("region", {name: "First Orbit", exact: true});
        const open = () => home.locator('.movie-card[data-item-id="film-a"]').press("Enter");
        const back = () => film.getByRole("button", {name: "Back to titles"}).press("Enter");
        const chips = film.locator(".movie-title-facts .movie-rating-chip");

        await page.evaluate(ratingRows => { window.movieRatings = ratingRows; }, ratings);
        await open();
        await chips.first().waitFor();
        assert.deepEqual(await chips.allTextContents(), ["7.8", "91%", "74"], profile);
        for (const name of ["IMDb 7.8", "Rotten Tomatoes 91%", "Metacritic 74"])
            assert.equal(await film.getByRole("img", {name, exact: true}).count(), 1, `${profile}: ${name}`);
        assert.deepEqual(await chips.evaluateAll(nodes => nodes.map(node => node.querySelectorAll("svg").length)), [1, 1, 1]);
        assert.equal(await chips.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${profile}: no overflow`);
        const shots = require("node:path").join(__dirname, "../.local/movies-ratings");
        require("node:fs").mkdirSync(shots, {recursive: true});
        await film.locator(".movie-title-facts").screenshot({path: require("node:path").join(shots, profile + "-chips.png")});
        await page.screenshot({path: require("node:path").join(shots, profile + "-title.png")});
        await back();

        // A title with no known scores shows no chip.
        await page.evaluate(() => window.openDetailFixture("auto"));
        await page.evaluate(() => { window.movieRatings = []; });
        await open();
        await film.getByRole("heading", {name: "First Orbit", exact: true}).waitFor();
        await page.waitForFunction(() => window.detailCalls.filter(call => call[0] === "MovieRatings").length === 2);
        assert.equal(await chips.count(), 0, `${profile}: no values, no chips`);
        await back();

        // The profile switch stops the lookup altogether.
        await page.evaluate(rows => { window.movieRatings = rows; }, ratings);
        await page.evaluate(() => window.openDetailFixture("auto", {ratings: false}));
        const before = await page.evaluate(() => window.detailCalls.filter(call => call[0] === "MovieRatings").length);
        await open();
        await film.getByRole("heading", {name: "First Orbit", exact: true}).waitFor();
        await film.getByRole("list", {name: "Cast", exact: true}).waitFor();
        assert.equal(await chips.count(), 0, `${profile}: switched off`);
        assert.equal(await page.evaluate(() => window.detailCalls.filter(call => call[0] === "MovieRatings").length), before);
    } finally {
        await context.close();
    }
}

reviewMovieProfiles(check).catch(error => { console.error(error); process.exitCode = 1; });
