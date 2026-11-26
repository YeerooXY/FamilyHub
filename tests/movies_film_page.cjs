const assert = require("node:assert/strict");
const {constants, setPriority} = require("node:os");
const {movieDetailFixture, reviewMovieProfiles} = require("./movies_fixture.cjs");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

async function check(browser, profile, options) {
    const context = await browser.newContext(options);
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(7000);
        const writes = await movieDetailFixture(page);
        const home = page.getByRole("region", {name: "Movie library"});
        const film = page.getByRole("region", {name: "First Orbit", exact: true});
        const heading = film.getByRole("heading", {name: "First Orbit", exact: true});
        const artwork = film.locator(".movie-hero-art");
        const firstOrbit = () => home.locator('.movie-card[data-item-id="film-a"]');
        const focused = target => target.evaluate(node => node === document.activeElement);
        await page.evaluate(() => { window.failNextRelated = true; });
        await firstOrbit().press("Enter");
        await heading.waitFor();
        assert.equal(await focused(heading), true);
        await heading.locator("img").waitFor();
        const expectedFacts = ["2026", "PG", "1 h 50 min", "4K", "DDP 5.1"];
        await film.getByRole("img", {name: "Sound: Dolby Digital Plus 5.1"}).waitFor();
        assert.deepEqual(await film.locator(".movie-title-facts .movie-chip").allTextContents(), expectedFacts);
        assert.equal(await film.getByText("A pilot finds an abandoned station.").isVisible(), true);
        assert.equal(await film.getByRole("button", {name: /^(?:Download|Add to library)$/}).count(), 0);

        const favorite = film.getByRole("button", {name: "My list: First Orbit"});
        const play = film.getByRole("button", {name: "Play", exact: true});
        await page.keyboard.press("Tab");
        assert.equal(await focused(play), true, profile);
        await page.keyboard.press("Tab");
        assert.equal(await focused(favorite), true, profile);
        await page.keyboard.press("Space");
        await page.waitForFunction(node => node.getAttribute("aria-pressed") === "true", await favorite.elementHandle());
        assert.equal(await focused(favorite), true);
        assert.deepEqual(writes, [["film-a", true]]);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(play), true);
        const more = film.getByRole("heading", {name: "More like this", exact: true});
        await film.getByRole("button", {name: "Retry related films", exact: true}).press("Enter");
        await more.waitFor();
        await page.waitForFunction(node => node === document.activeElement, await more.elementHandle());
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");
        const myList = home.locator('.movie-shelf[data-format="favorites"]');
        assert.equal(await myList.getByRole("button", {name: "First Orbit"}).isVisible(), true);
        assert.equal(await focused(firstOrbit()), true);
        await firstOrbit().press("Enter");

        const related = film.locator('.movie-shelf[data-format="related"]');
        const owned = related.getByRole("button", {name: "Second Orbit, in your library", exact: true});
        const missing = related.getByRole("button", {name: "Find releases for Outer Station 1", exact: true});
        await owned.waitFor();
        assert.equal(await more.count(), 1);
        assert.equal(await owned.locator(".movie-card-owned svg").count(), 1);
        assert.equal(await owned.evaluate(node => node.parentElement.firstElementChild === node), true);
        const desktop = options.viewport.width >= 1280;
        for (const width of desktop ? [1280, 1920, 2560, 3840] : [options.viewport.width]) {
            if (desktop) await page.setViewportSize({width, height: 850});
            const expectedWidth = width > 1920 ? "3840" : "1920";
            await page.waitForFunction(expectedWidth => {
                const art = document.querySelector(".movie-film-detail:not([hidden]) .movie-hero-art");
                return art?.src && new URL(art.src).searchParams.get("maxWidth") === expectedWidth;
            }, expectedWidth);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${profile} ${width}`);
            if (desktop) {
                const cards = await related.locator(".movie-shelf-scroll").evaluate(node => {
                    const frame = node.getBoundingClientRect();
                    const boxes = [...node.querySelectorAll(".movie-card")].map(card => card.getBoundingClientRect());
                    return {full: boxes.filter(box => box.left >= frame.left - 1 && box.right <= frame.right + 1).length,
                        peek: (frame.right - boxes[5].left) / boxes[5].width};
                });
                assert.equal(cards.full, 5);
                assert.ok(cards.peek >= .1 && cards.peek <= .2, `peek is ${cards.peek}`);
            }
        }
        await owned.focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await focused(missing), true);
        await page.keyboard.press("ArrowLeft");
        assert.equal(await focused(owned), true);
        await owned.press("Enter");
        const sequel = page.getByRole("region", {name: "Second Orbit", exact: true});
        const plainTitle = sequel.getByRole("heading", {name: "Second Orbit"});
        await plainTitle.waitFor();
        assert.equal(await focused(plainTitle), true);
        assert.equal(await plainTitle.locator("span:not(.movie-visually-hidden)").isVisible(), true);
        assert.equal(await sequel.locator(".movie-hero-art").getAttribute("src"), null);
        const automatic = await sequel.evaluate(node => node.style.getPropertyValue("--movie-hero-start"));
        assert.equal(automatic, "#603b26");
        await sequel.getByRole("button", {name: "Back to titles"}).press("Enter");
        assert.equal(await focused(owned), true);

        assert.equal(await missing.locator(".movie-card-find svg").count(), 1);
        await missing.press("Space");
        await page.waitForFunction(() => window.detailCalls.some(([method, name]) =>
            method === "MovieReleaseSearch" && name === "Outer Station 1"));
        assert.equal(await page.getByRole("searchbox").inputValue(), "Outer Station 1");
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);

        if (desktop) {
            await page.evaluate(() => window.openDetailFixture("preset"));
            await firstOrbit().press("Enter");
            await artwork.waitFor({state: "attached"});
            assert.equal(await artwork.getAttribute("src"), null);
            await page.evaluate(() => window.openDetailFixture("backdrop"));
            await firstOrbit().press("Enter");
            assert.ok(await artwork.getAttribute("src"));
            await film.getByRole("button", {name: "Back to titles"}).press("Enter");
            await home.locator('.movie-card[data-item-id="film-b"]').press("Enter");
            assert.equal(await sequel.evaluate(node => node.style.getPropertyValue("--movie-hero-start")), "#34374d");
        }
    } finally {
        await context.close();
    }
}

reviewMovieProfiles(check).catch(error => { console.error(error); process.exitCode = 1; });
