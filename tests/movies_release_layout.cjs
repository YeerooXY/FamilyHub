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
    ...[7, 6, 8, 9, 3, 5, 4].map(index => fixture[index].title)];
const desktop = [
    ["desktop-1280", {width: 1280, height: 720}],
    ["desktop-1920", {width: 1920, height: 1080}],
    ["desktop-2000", {width: 2000, height: 1040}],
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
        assert.equal(await results.locator(".movie-release-row-poster img").count(), expectedOrder.length + 1);
        await page.waitForFunction(img => img.naturalWidth > 0, await rail.locator("img").elementHandle());
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.locator(".app-header").getByRole("searchbox").count(), 1);
        assert.equal(await query.inputValue(), title);
        const filenames = rows.locator(".movie-release-name");
        assert.deepEqual(await filenames.allTextContents(), expectedOrder, profile);
        assert.deepEqual(await rows.first().evaluate(row => [...row.children].filter(child => !child.hidden)
            .map(child => child.className)), [
            "movie-art movie-release-row-poster", "movie-release-quality movie-release-block", "movie-release-head", "movie-release-stat movie-release-size",
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
        assert.ok(Math.abs(geometry.right - Math.min(geometry.width, geometry.contentLeft + 1664)) <= 1, profile);
        assert.ok(geometry.scroll <= 1, profile);
        assert.deepEqual(await rows.evaluateAll(nodes => nodes.filter(row =>
            row.scrollWidth > row.clientWidth || getComputedStyle(row).overflowWrap !== "normal"
        ).map(row => row.querySelector(".movie-release-title").textContent)), [], `${profile}: release rows fit without breaking words`);
        const discs = await rows.locator(".movie-release-indexer-badge").evaluateAll(nodes => nodes.map(disc => {
            const {width, height} = disc.getBoundingClientRect();
            const rowFont = parseFloat(getComputedStyle(disc.closest(".movie-release")).fontSize);
            return {width, height, rowFont, radius: getComputedStyle(disc).borderRadius};
        }));
        assert.ok(discs.length > 0, profile);
        for (const {width, height, rowFont, radius} of discs) {
            assert.ok(width === height && radius === "50%" &&
                Math.abs(width - rowFont * (target === 60 ? 1.5 : 1.25)) < 1, `${profile}: round source badge scales with the row`);
        }
        if (phone) {
            assert.equal(geometry.railBottom, geometry.contentTop, profile);
            assert.equal(geometry.legendScroll, true, profile);
            const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            const [switcher, search] = await Promise.all([
                page.locator("#open-hub").boundingBox(), page.locator(".app-header .movie-search").boundingBox()
            ]);
            assert.ok(switcher.x + switcher.width < search.x, `${profile}: gap before movie search`);
            const rowGeometry = await rows.evaluateAll(nodes => nodes.map(row => {
                const button = row.querySelector(".movie-release-action");
                const label = button.querySelector(".movie-release-action-label");
                const range = document.createRange();
                range.selectNodeContents(label);
                const box = button.getBoundingClientRect();
                return {
                    title: row.querySelector(".movie-release-title").textContent,
                    fits: button.scrollWidth <= button.clientWidth,
                    lines: range.getClientRects().length,
                    height: box.height,
                    lineHeight: parseFloat(getComputedStyle(button).lineHeight),
                    boxes: [...row.children].filter(child => !child.hidden).map(child => child.getBoundingClientRect().toJSON())
                };
            }));
            for (const {title, fits, lines, height, lineHeight, boxes} of rowGeometry) {
                assert.ok(fits && lines === 1 && height >= 44 && height < 2 * lineHeight,
                    `${profile}: ${title} must have a single-line Download button at least 44 px tall`);
                assert.ok(boxes.every((box, index) => boxes.slice(index + 1).every(other => !overlaps(box, other))),
                    `${profile}: ${title} row elements must fit without overlap`);
            }
        } else {
            assert.equal(geometry.sticky, true, profile);
            assert.equal(geometry.railRight, geometry.contentLeft, profile);
            assert.ok(geometry.fraction >= .22 && geometry.fraction <= .26, profile);
        }
        if ([1280, 2000].includes(options.viewport.width)) {
            await query.focus();
            const clearance = await page.locator(".app-header .movie-search").evaluate(pill => {
                const {left, right, top, bottom} = pill.getBoundingClientRect();
                const overlapsRing = node => {
                    const rect = node.getBoundingClientRect();
                    return rect.width && rect.height && rect.left < right + 4 && rect.right > left - 4 &&
                        rect.top < bottom + 4 && rect.bottom > top - 4;
                };
                const header = pill.closest(".app-header");
                return {
                    overlaps: [...document.querySelectorAll("[data-release-layout], [data-release-layout] *")]
                        .filter(overlapsRing).map(node => `${node.localName}.${[...node.classList].join(".")}`),
                    headerHit: header.contains(document.elementFromPoint((left + right) / 2, bottom))
                };
            });
            assert.deepEqual(clearance, {overlaps: [], headerHit: true}, profile);
        }
        assert.equal(await rows.evaluateAll(nodes => nodes.every(row => {
            const poster = row.querySelector(".movie-release-row-poster").getBoundingClientRect();
            const quality = row.querySelector(".movie-release-block").getBoundingClientRect();
            return Math.abs(poster.height - quality.height) <= 1 && Math.abs(poster.height * 2 / 3 - poster.width) <= 1 &&
                poster.right <= quality.left;
        })), true);
        const columns = row => row.evaluate(node => [
            ".movie-release-row-poster", ".movie-release-block", ".movie-release-head", ".movie-release-actions"
        ].map(selector => {
            const {left, width} = node.querySelector(selector).getBoundingClientRect();
            return [left, width];
        }));
        const video = rows.filter({has: page.getByRole("link", {name: "Watch on YouTube"})});
        assert.deepEqual(await columns(video), await columns(rows.first()), profile);
        const legend = rail.getByRole("group", {name: "Quality"});
        const entries = legend.getByRole("button");
        assert.equal(await entries.count(), 9);
        assert.equal(await rail.locator("input").count(), 0);
        let total = 0;
        for (const entry of await entries.all()) {
            const tier = await entry.getAttribute("data-level");
            const count = Number(await entry.locator(".movie-release-tier-count").textContent());
            assert.equal(count, tier === "all" ? expectedOrder.length + 1 :
                await list.locator(`[data-tier="${tier}"]`).count(), profile);
            if (tier !== "all") total += count;
        }
        assert.equal(total, expectedOrder.length + 1);
        const all = legend.getByRole("button", {name: /^All /});
        const sd = legend.getByRole("button", {name: /^SD /});
        const count = results.getByRole("status");
        assert.equal(await all.getAttribute("aria-pressed"), "true");
        await sd.press("Space");
        assert.equal(await focused(sd), true);
        assert.equal(await sd.getAttribute("aria-pressed"), "true");
        assert.equal(await rows.count(), 1);
        assert.equal(await count.filter({hasText: /^1 result$/}).count(), 1);
        assert.equal(await sd.locator(".movie-release-tier-count").textContent(), "1");
        await sd.press("Enter");
        assert.equal(await focused(sd), true);
        assert.equal(await all.getAttribute("aria-pressed"), "true");
        assert.equal(await rows.count(), expectedOrder.length + 1);
        const hd = legend.getByRole("button", {name: /^720p /});
        await hd.press("Enter");
        await all.press("Space");
        assert.equal(await focused(all), true);
        assert.equal(await rows.count(), expectedOrder.length + 1);
        assert.deepEqual(await results.locator("button, a").evaluateAll((nodes, target) =>
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
        const back = page.locator("#header-back");
        if (await back.isVisible()) await back.press("Enter");
        else await page.locator(".app-header .movie-search").getByRole("button", {name: "Clear", exact: true}).press("Enter");
        assert.equal(await list.isVisible(), false);
        assert.equal(await query.inputValue(), "");
        assert.equal(await focused(query), true);

        await query.fill("Poster search");
        await query.press("Enter");
        await list.waitFor();
        assert.equal(await rows.count(), 10);
        await page.waitForFunction(() => typeof window.finishRowArtwork === "function" &&
            calls.filter(([method]) => method === "MovieMatches").some(([, term]) => term === "Other port 3"));
        const art = name => rows.filter({has: page.getByRole("heading", {name, exact: true})})
            .locator(".movie-release-row-poster");
        const shared = await rail.locator("img").getAttribute("src");
        assert.ok(shared);
        assert.equal(await art("Poster search").locator("img").getAttribute("src"), shared);
        assert.equal(await art("Foreign harbour").count(), 2);
        assert.equal(await art("Foreign harbour").first().locator("img").getAttribute("src"), null);
        await page.evaluate(() => window.finishRowArtwork());
        await art("Foreign Harbour").last().locator('img[src="/movie-art/movie-alt.jpg"]').waitFor({state: "attached"});
        assert.deepEqual(await art("Foreign Harbour").locator("img").evaluateAll(images => images.map(img => img.getAttribute("src"))),
            ["/movie-art/movie-alt.jpg", "/movie-art/movie-alt.jpg"]);
        assert.equal(await art("Unknown port").getAttribute("data-initial"), "U");
        assert.equal(await art("Unknown port").locator("img").getAttribute("src"), null);
        assert.notEqual(await art("Unknown port").getAttribute("style"), await art("Blank sky").getAttribute("style"));
        const lookups = await page.evaluate(() => {
            const start = calls.findIndex(([method, term]) => method === "MovieMatches" && term === "Poster search");
            return calls.slice(start + 1).filter(([method]) => method === "MovieMatches").map(([, term]) => term);
        });
        assert.equal(lookups.length, 6);
        assert.equal(new Set(lookups).size, 6);
        assert.equal(lookups.includes("Poster search"), false);
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
