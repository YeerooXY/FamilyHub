const assert = require("node:assert/strict");
const {reviewMovieProfiles} = require("./movies_fixture.cjs");
const {openReleaseFixture, fixture, pack, title} = require("./movies_releases.cjs");

const episode = "The Gentlemen S02E04 1080p BluRay DTS-HD MA 7.1";
const sources = [...fixture,
    {title: episode, size: 6e9, seeders: 3},
    {title: "The Gentlemen S02 4320p WEB-DL", size: 1e9, seeders: 1}
];
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
        const rail = results.getByRole("complementary", {name: "Release filters"});
        const list = results.getByRole("list", {name: "Release results"});
        const rows = list.getByRole("listitem");
        const summary = page.getByText("11 releases found. 1 source did not answer.", {exact: true});
        await summary.waitFor();
        assert.equal(await summary.count(), 1, profile);
        assert.equal(await summary.getAttribute("role"), "status");
        assert.equal(await rail.getByRole("heading", {name: "The Gentlemen (2024)"}).count(), 1);
        assert.equal(await results.locator(".movie-release-poster").count(), 1);
        assert.equal(await results.locator("img").count(), 1);
        await page.waitForFunction(img => img.naturalWidth > 0, await rail.locator("img").elementHandle());
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.locator(".app-header").getByRole("searchbox").count(), 1);
        assert.equal(await query.inputValue(), title);
        assert.equal(await rows.count(), 11);
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
            assert.equal(geometry.legendScroll, true, profile);
            const menu = rail.getByRole("button", {name: "Sort and filters"});
            assert.equal(await rail.getByRole("radio", {name: "Smallest"}).isVisible(), false);
            await menu.press("Enter");
            assert.equal(await focused(menu), true);
            assert.equal(await menu.getAttribute("aria-expanded"), "true");
        } else {
            assert.equal(geometry.sticky, true, profile);
            assert.equal(geometry.railRight, geometry.contentLeft, profile);
            assert.ok(geometry.fraction >= .22 && geometry.fraction <= .26, profile);
        }
        const legend = rail.getByRole("group", {name: "Quality"});
        for (const button of await legend.getByRole("button").all()) {
            const tier = await button.getAttribute("data-level");
            assert.equal(Number(await button.locator(".movie-release-tier-count").textContent()),
                await list.locator(`[data-tier="${tier}"]`).count(), profile);
        }
        assert.deepEqual(await results.locator("button, .movie-release-controls label").evaluateAll((nodes, target) =>
            nodes.filter(node => {
                const {width, height} = node.getBoundingClientRect();
                return width && height && (width < target || height < target);
            }).map(node => node.textContent), target), [], profile);

        const tier1080 = legend.getByRole("button", {name: /^1080p /});
        const tier4k = legend.getByRole("button", {name: /^4K \d/});
        await tier1080.press("Space");
        assert.equal(await focused(tier1080), true);
        assert.equal(await tier1080.getAttribute("aria-pressed"), "true");
        assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.tier)), ["web", "web", "web", "web"]);
        await tier4k.press("Enter");
        assert.equal(await rows.count(), 6);
        await tier1080.press("Space");
        await tier4k.press("Space");
        assert.equal(await rows.count(), 11);

        const best = rail.getByRole("radio", {name: "Best for your screen"});
        assert.equal(await best.isChecked(), true);
        assert.equal(await rows.first().getAttribute("data-tier"), "hd");
        const smallest = rail.getByRole("radio", {name: "Smallest"});
        await smallest.focus();
        await page.keyboard.press("Space");
        assert.equal(await focused(smallest), true);
        assert.equal(await rows.first().getAttribute("data-tier"), "8k");
        await page.keyboard.press("ArrowDown");
        assert.equal(await rail.getByRole("radio", {name: "Fastest download"}).isChecked(), true);
        assert.equal(await rows.first().getAttribute("data-tier"), "hd");
        await page.keyboard.press("ArrowDown");
        assert.equal(await rail.getByRole("radio", {name: "Best sound"}).isChecked(), true);
        const first = rows.first();
        assert.equal(await first.getByRole("img", {name: "Sound: Dolby Atmos"}).count(), 1);

        const available = rail.getByRole("checkbox", {name: "Available now"});
        await available.press("Space");
        assert.equal(await rows.count(), 2);
        const surround = rail.getByRole("checkbox", {name: "Surround sound (5.1 or better)"});
        await surround.press("Space");
        assert.equal(await rows.count(), 1);
        const packs = rail.getByRole("checkbox", {name: "Hide complete seasons"});
        await packs.press("Space");
        await results.getByText("No releases match these filters.").waitFor();
        assert.equal(await focused(packs), true);
        await available.press("Space");
        assert.equal(await rows.count(), 1);
        assert.equal(await rows.first().getByText("One episode, S02E04", {exact: true}).count(), 1);
        await packs.press("Space");
        await surround.press("Space");

        const file = first.getByRole("button", {name: /^File name for /});
        const raw = first.locator(".movie-release-name");
        assert.equal(await file.getAttribute("title"), pack);
        assert.equal(await raw.isVisible(), false);
        await file.press("Enter");
        assert.equal(await file.getAttribute("aria-expanded"), "true");
        assert.equal(await raw.innerText(), pack);
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
        await summary.waitFor();
        assert.equal(await focused(query), true, profile);
        assert.equal(await page.evaluate(() => calls.filter(([method]) => method === "MovieReleaseSearch").length), 2);
        await rows.first().getByRole("button", {name: /^Download /}).press("Escape");
        assert.equal(await list.isVisible(), false);
        assert.equal(await focused(query), true);
        await query.fill(title);
        await query.press("Enter");
        await summary.waitFor();
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
