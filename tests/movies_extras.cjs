const assert = require("node:assert/strict");
const {movieDetailFixture, reviewMovieProfiles} = require("./movies_fixture.cjs");

reviewMovieProfiles(async (browser, profile, options) => {
    const page = await browser.newPage({...options, reducedMotion: "reduce"});
    try {
        await movieDetailFixture(page, {extras: true});
        const library = page.getByRole("region", {name: "Movie library"});
        await library.getByRole("button", {name: "First Orbit", exact: true}).press("Enter");
        const film = page.getByRole("region", {name: "First Orbit", exact: true});
        const trailer = film.getByRole("link", {name: "Trailer on YouTube"});
        await trailer.waitFor();
        assert.equal(await trailer.getAttribute("href"), "https://www.youtube.com/watch?v=abcdefghijk");
        const credit = film.getByRole("button", {name: "Film Actor 1 Crew member", exact: true});
        await credit.press("Space");
        const person = page.getByRole("region", {name: "Film Actor 1", exact: true});
        await person.getByText("1974", {exact: true}).waitFor();
        assert.equal(await person.getByText("Acting", {exact: true}).isVisible(), true);
        assert.equal(await person.getByRole("heading", {level: 2}).evaluate(node => document.activeElement === node), true);
        assert.equal(await person.getByRole("button", {name: "Second Orbit", exact: false}).count(), 1);
        const biography = person.getByRole("button", {name: "Read full biography"});
        await biography.press("Enter");
        assert.equal(await person.getByRole("button", {name: "Show less biography"}).getAttribute("aria-expanded"), "true");
        const more = person.locator(".movie-person-films");
        const request = more.getByRole("button", {name: "Request download: Open Road (2018)"});
        assert.equal(await more.locator(".movie-art").getAttribute("data-initial"), "O");
        assert.equal(await more.locator(".movie-art img").getAttribute("src"), null);
        assert.equal(await more.getByText("Second Orbit").count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, profile);
        {
            const shots = require("node:path").join(__dirname, "../.local/round6");
            require("node:fs").mkdirSync(shots, {recursive: true});
            await page.screenshot({path: require("node:path").join(shots, profile + "-actor.png"), fullPage: true});
        }
        await request.press("Enter");
        const receipt = more.getByRole("status");
        await receipt.filter({hasText: "Request received"}).waitFor();
        assert.equal(await receipt.evaluate(node => document.activeElement === node), true);
        // A film that is not in the library opens its own page with TMDB details and a Find action.
        const openRoad = more.getByRole("button", {name: "Open Road (2018)", exact: true});
        await openRoad.press("Enter");
        const preview = page.getByRole("region", {name: "Open Road", exact: true});
        await preview.getByText("Two friends drive across the country.").waitFor();
        const find = preview.getByRole("button", {name: "Find Open Road", exact: true});
        await find.waitFor();
        assert.equal(await preview.getByRole("button", {name: /^(Play|Resume)/}).count(), 0);
        await page.keyboard.press("Escape");
        await preview.waitFor({state: "hidden"});
        await person.waitFor();
        assert.equal(await openRoad.evaluate(node => document.activeElement === node), true);
        await page.keyboard.press("Escape");
        await person.waitFor({state: "hidden"});
        assert.equal(await credit.evaluate(node => document.activeElement === node), true);
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");

        await library.getByRole("button", {name: "Night Signal", exact: true}).press("Enter");
        const series = page.getByRole("region", {name: "Night Signal", exact: true});
        await series.getByRole("button", {name: "Shuffle episodes"}).waitFor();
        await series.locator('[data-episode-id="show-a-episode-1"]').scrollIntoViewIfNeeded();
        await series.getByText("IMDb 8.5", {exact: true}).waitFor();
        await series.getByRole("button", {name: "Season 2", exact: true}).press("Enter");
        await series.getByText("TMDB 7.2", {exact: true}).waitFor();
        assert.deepEqual(await page.evaluate(async () => {
            const {shuffledEpisodes} = await import("/movies.js");
            const entries = [{Id: "w1", UserData: {Played: true}}, {Id: "u1"},
                {Id: "u2", UserData: {Played: false}}, {Id: "w2", UserData: {Played: true}}];
            return shuffledEpisodes(entries, () => 0).map(item => item.Id);
        }), ["u2", "u1", "w2", "w1"]);
    } finally {
        await page.close();
    }
}).catch(error => { console.error(error); process.exitCode = 1; });
