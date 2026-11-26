const assert = require("node:assert/strict");
const {reviewMovieProfiles} = require("./movies_fixture.cjs");
const {openReleaseFixture, fixture, pack, title} = require("./movies_releases.cjs");

const episode = "The Gentlemen S02E04 1080p BluRay DTS-HD MA 7.1";
const faster = "The Gentlemen S02E05 1080p WEB-DL AAC";
const equallyFast = "The Gentlemen S02E06 1080p WEB-DL AAC";
const highest = "The Gentlemen S02 4320p WEB-DL";
const higher = "The Gentlemen S02 2160p WEB-DL AAC";
const sources = [...fixture,
    {title: episode, size: 6e9, seeders: 3},
    {title: equallyFast, size: 6e9, seeders: 50},
    {title: faster, size: 6e9, seeders: 50},
    {title: highest, size: 1e9, seeders: 1},
    {title: higher, size: 4e9, seeders: 20}
];
const expectedOrder = [faster, equallyFast, episode, pack, fixture[2].title, highest, higher,
    ...[7, 6, 9, 8, 3, 5, 4].map(index => fixture[index].title)];
const desktop = [
    ["desktop-1280", {width: 1280, height: 720}],
    ["desktop-1920", {width: 1920, height: 1080}],
    ["desktop-2560", {width: 2560, height: 1440}],
    ["tv-1920", {width: 1920, height: 1080}, {deviceScaleFactor: 1, screen: {width: 1920, height: 1080}}]
];
const focused = locator => locator.evaluate(node => node === document.activeElement);

async function check(browser, profile, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(7000);
    try {
        await openReleaseFixture(page, {shell: true, sources});
        const phone = options.viewport.width <= 700;
        const target = options.viewport.width >= 1600 ? 60 : 44;
        const query = page.getByRole("searchbox", {name: "Search movies and TV"});
        await query.fill(title);
        await query.press("Enter");
        const results = page.locator(".movie-release-results");
        const rail = results.getByRole("complementary", {name: "Release details"});
        const list = results.getByRole("list", {name: "Release results"});
        const rows = list.getByRole("listitem");
        await list.waitFor();
        assert.equal(await results.getByText(/\d+ releases found|source did not answer|the smallest/).count(), 0, profile);
        assert.equal(await results.locator(".movie-release-size .movie-download-progress").count(), 0);
        assert.equal(await rail.getByRole("heading", {name: "The Gentlemen (2024)"}).count(), 1);
        assert.equal(await results.locator(".movie-release-poster").count(), 1);
        assert.equal(await results.locator("img").count(), 1);
        await page.waitForFunction(img => img.naturalWidth > 0, await rail.locator("img").elementHandle());
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.locator(".app-header").getByRole("searchbox").count(), 1);
        assert.equal(await query.inputValue(), title);
        const filenames = rows.locator(".movie-release-name");
        assert.deepEqual(await filenames.allTextContents(), expectedOrder, profile);
        assert.deepEqual(await rows.first().evaluate(row => [...row.children].filter(child => !child.hidden)
            .map(child => child.className)), [
            "movie-release-quality movie-release-block", "movie-release-head", "movie-release-stat movie-release-size",
            "movie-release-stat movie-release-time", "movie-release-stat movie-release-health", "movie-release-actions"
        ]);
        const geometry = await results.evaluate(node => {
            const rail = node.querySelector(".movie-release-rail"), content = node.querySelector(".movie-release-content");
            const left = rail.getBoundingClientRect(), right = content.getBoundingClientRect();
            const host = node.closest(".workspace > main");
            const legend = rail.querySelector(".movie-release-legend");
            return {left: left.left, railBottom: left.bottom, railRight: left.right, contentTop: right.top,
                contentLeft: right.left, right: right.right, width: innerWidth, fraction: left.width / node.clientWidth,
                sticky: getComputedStyle(rail).position === "sticky", legendScroll: legend.scrollWidth > legend.clientWidth,
                scroll: Math.max(document.documentElement.scrollWidth - innerWidth, host.scrollWidth - host.clientWidth)};
        });
        assert.equal(geometry.left, 0, profile);
        assert.ok(Math.abs(geometry.right - geometry.width) <= 1, profile);
        assert.ok(geometry.scroll <= 1, profile);
        if (phone) {
            assert.equal(geometry.railBottom, geometry.contentTop, profile);
            assert.equal(geometry.legendScroll, false, profile);
        } else {
            assert.equal(geometry.sticky, true, profile);
            assert.equal(geometry.railRight, geometry.contentLeft, profile);
            assert.ok(geometry.fraction >= .22 && geometry.fraction <= .26, profile);
        }
        const legend = rail.getByRole("group", {name: "Quality"});
        const entries = legend.locator(".movie-release-tier");
        assert.equal(await entries.count(), 5);
        assert.equal(await legend.locator("button, [role=button], [tabindex], [aria-pressed]").count(), 0);
        assert.equal(await rail.locator("button").count(), 1);
        assert.equal(await rail.locator("input").count(), 0);
        let total = 0;
        for (const entry of await entries.all()) {
            const tier = await entry.getAttribute("data-level");
            const count = Number(await entry.locator(".movie-release-tier-count").textContent());
            assert.equal(count,
                await list.locator(`[data-tier="${tier}"]`).count(), profile);
            total += count;
        }
        assert.equal(total, expectedOrder.length);
        assert.deepEqual(await results.locator("button").evaluateAll((nodes, target) =>
            nodes.filter(node => {
                const {width, height} = node.getBoundingClientRect();
                return width && height && (width < target || height < target);
            }).map(node => node.textContent), target), [], profile);

        const guide = rail.getByRole("button", {name: "Quality guide"});
        await guide.press("Enter");
        assert.equal(await guide.getAttribute("aria-expanded"), "true");
        assert.equal(await rail.getByRole("table").isVisible(), true);
        assert.equal(await focused(guide), true);
        await guide.press("Space");
        assert.equal(await rail.getByRole("table").isVisible(), false);
        const first = rows.first();
        assert.equal(await rows.nth(3).getByRole("img", {name: "Sound: Dolby Atmos"}).count(), 1);

        const file = first.getByRole("button", {name: /^File name for /});
        const raw = first.locator(".movie-release-name");
        assert.equal(await file.getAttribute("title"), null);
        assert.equal(await raw.isVisible(), false);
        await file.press("Enter");
        assert.equal(await file.getAttribute("aria-expanded"), "true");
        assert.equal(await raw.innerText(), faster);
        await file.press("Space");
        assert.equal(await raw.isVisible(), false);
        const action = first.getByRole("button", {name: /^Download /});
        const nextAction = rows.nth(1).getByRole("button", {name: /^Download /});
        await action.press("ArrowDown");
        assert.equal(await focused(nextAction), true);
        await page.keyboard.press("ArrowUp");
        assert.equal(await focused(action), true);

        const outline = async () => {
            await page.waitForFunction(({row, target}) => {
                const css = getComputedStyle(row);
                return css.outlineWidth === (target === 60 ? "4px" : "2px") &&
                    css.outlineColor === "rgb(255, 255, 255)" && css.transform === "none";
            }, {row: await first.elementHandle(), target});
        };
        await outline();
        await query.focus();
        if (!options.hasTouch) {
            const before = await first.boundingBox();
            await first.hover();
            await outline();
            assert.equal((await first.boundingBox()).width, before.width);
        }
        const duration = () => first.evaluate(node => getComputedStyle(node).transitionDuration);
        await page.emulateMedia({reducedMotion: "reduce"});
        assert.equal(await duration(), "0s");
        await page.emulateMedia({reducedMotion: "no-preference"});
        await page.evaluate(() => { document.body.dataset.effects = "off"; });
        assert.equal(await duration(), "0s");

        await query.press("Enter");
        await list.waitFor();
        assert.deepEqual(await filenames.allTextContents(), expectedOrder, profile);
        assert.equal(await focused(query), true, profile);
        assert.equal(await page.evaluate(() => calls.filter(([method]) => method === "MovieReleaseSearch").length), 2);
        await rows.first().getByRole("button", {name: /^Download /}).press("Escape");
        assert.equal(await list.isVisible(), false);
        assert.equal(await focused(query), true);
        await page.evaluate(async () => {
            const {saveMoviePreferences} = await import("/movies.js");
            saveMoviePreferences({server: movieSession.url.replace(/\/$/, "") + "/"}, {screen: "2160"});
        });
        await query.fill(title);
        await query.press("Enter");
        await list.waitFor();
        assert.deepEqual((await filenames.allTextContents()).slice(0, 7),
            [higher, faster, equallyFast, episode, pack, fixture[2].title, highest], profile);
        await page.locator("#header-back").press("Enter");
        assert.equal(await list.isVisible(), false);
        assert.equal(await query.inputValue(), "");
        assert.equal(await focused(query), true);
    } finally {
        await page.close();
    }
}

reviewMovieProfiles(async (browser, profile, options) => {
    if (profile === "windows-chromium-1280") {
        for (const [name, viewport, extra] of desktop) await check(browser, name, {...options, viewport, ...extra});
    } else if (profile !== "windows-chromium-2000") {
        await check(browser, profile, options);
    }
}).then(() => console.log("Release rail and rows passed in desktop, TV, tablet and phone profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
