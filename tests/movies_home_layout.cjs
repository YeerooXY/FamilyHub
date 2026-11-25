const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
const { jellyfin, movieHomeFixture } = require("./movies_fixture.cjs");

const widths = [[1280, 850], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]];
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} vs ${expected}`);
const focusIs = node => node.evaluate(element => document.activeElement === element);
const shelf = (page, title) => page.locator(".movie-shelf").filter({has: page.getByRole("heading", {name: title, exact: true})});
const viewport = row => row.locator(".movie-shelf-scroll");
const scrollLeft = row => viewport(row).evaluate(node => node.scrollLeft);
const activeIndex = row => row.locator(".movie-card").evaluateAll(cards => cards.indexOf(document.activeElement));

async function measure(row) {
    return viewport(row).evaluate(node => {
        const frame = node.getBoundingClientRect(), track = node.querySelector(".movie-cards");
        const cards = [...track.children].map(card => card.getBoundingClientRect());
        const heading = node.closest(".movie-shelf").querySelector("h2");
        const pixels = card => Math.min(card.right, frame.right) - Math.max(card.left, frame.left);
        return {
            full: cards.filter(card => pixels(card) >= card.width - 1).length,
            left: cards.filter(card => card.left < frame.left - 1 && pixels(card) > 1).map(card => pixels(card) / card.width),
            right: cards.filter(card => card.right > frame.right + 1 && pixels(card) > 1).map(card => pixels(card) / card.width),
            width: cards[0].width, gap: parseFloat(getComputedStyle(track).columnGap), rowWidth: frame.width,
            firstLeft: cards[0].left, headingLeft: heading.getBoundingClientRect().left + parseFloat(getComputedStyle(heading).paddingLeft),
            offset: node.scrollLeft
        };
    });
}

function checkPeek(peek, side) {
    assert.equal(peek.length, 1, `${side} peek count`);
    assert.ok(peek[0] >= .10 && peek[0] <= .20, `${side} peek is ${peek[0]} of a card`);
}

async function waitPage(row, target) {
    await row.page().waitForFunction(({node, target}) => Math.abs(node.scrollLeft - target) <= 1, {node: await viewport(row).elementHandle(), target});
}

async function checkHover(row, index, scale) {
    const card = row.locator(".movie-card").nth(index);
    await card.evaluate(node => node.closest(".movie-shelf").scrollIntoView({block: "center", inline: "nearest"}));
    const before = await card.evaluate(node => node.closest(".movie-shelf-scroll").scrollLeft);
    const box = await card.boundingBox();
    await card.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await card.page().waitForFunction(({card, scale}) => {
        const matrix = getComputedStyle(card).transform;
        return matrix !== "none" && Math.abs(new DOMMatrix(matrix).a - scale) < .002;
    }, {card: await card.elementHandle(), scale});
    const safe = await card.evaluate(node => {
        const a = node.getBoundingClientRect(), frame = node.closest(".movie-shelf-scroll").getBoundingClientRect();
        const previous = node.previousElementSibling?.getBoundingClientRect();
        const next = node.nextElementSibling?.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (!previous || a.left >= previous.right - 1) && (!next || a.right <= next.left + 1) &&
            a.top >= frame.top - 1 && a.bottom <= frame.bottom + 1 && a.left >= frame.left - 1 && a.right <= frame.right + 1 &&
            style.outlineWidth === "2px" && style.outlineColor === "rgb(255, 255, 255)";
    });
    assert.equal(safe, true, `card ${index + 1} grows within its shelf and clears the adjacent cards`);
    assert.ok(Math.abs(await card.evaluate(node => node.closest(".movie-shelf-scroll").scrollLeft) - before) <= 1.5, "hovering never scrolls the row");
    await card.page().mouse.move(0, 0);
    await card.page().waitForFunction(card => !card.getAnimations().length, await card.elementHandle());
}

async function checkWidth(browser, width, height) {
    const page = await browser.newPage({viewport: {width, height}});
    try {
        const {favoriteWrites} = await movieHomeFixture(page, {matches: [{id: 42, title: "Moon Signal", kind: "movie", year: 2022}]});
        const row = shelf(page, "Continue watching"), initial = await measure(row);
        assert.equal(initial.full, 5);
        assert.deepEqual(initial.left, []);
        checkPeek(initial.right, "initial right");
        near(initial.width, (initial.rowWidth - 6 * initial.gap) / 5.3, "card width");
        const step = 5 * (initial.width + initial.gap);
        const logo = page.locator(".movie-hero-logo");
        await logo.waitFor();
        assert.match(await page.locator(".movie-hero-art").getAttribute("src"), new RegExp(`maxWidth=${width > 1920 ? 3840 : 1920}$`));

        const compact = shelf(page, "Collections");
        const small = await measure(compact);
        assert.equal(small.full, 3);
        assert.deepEqual([...small.left, ...small.right], []);
        near(small.width, initial.width, "short row card width");
        near(small.firstLeft, initial.firstLeft, "short row start");
        near(small.headingLeft, small.firstLeft, "short row heading");
        near(initial.headingLeft, initial.firstLeft, "full row heading");
        const hero = await page.locator(".movie-hero").evaluate(node => ({
            height: node.getBoundingClientRect().height,
            titleLeft: node.querySelector(".movie-hero-title").getBoundingClientRect().left
        }));
        near(hero.titleLeft, initial.firstLeft, "hero title alignment");
        assert.ok(hero.height >= .50 * height && hero.height <= .56 * height, "hero height");
        assert.equal(await compact.getByRole("button", {name:/^(Previous|Next) collections$/}).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

        await checkHover(row, 0, 1.08);
        await checkHover(row, 4, 1.08);
        const posters = shelf(page, "Movies");
        for (const [shelfRow, ratio] of [[posters, 2 / 3], [row, 16 / 9]]) {
            const size = await shelfRow.locator(".movie-card").first().evaluate(card => {
                const art = card.querySelector(".movie-art").getBoundingClientRect();
                const progress = card.querySelector(".movie-progress")?.getBoundingClientRect();
                return {card: card.getBoundingClientRect().width, art: art.width, height: art.height,
                    progressInset: progress ? art.bottom - progress.bottom : undefined};
            });
            near(size.art, size.card, "art fills the card width");
            near(size.art, size.height * ratio, "art ratio");
            if (ratio === 16 / 9) near(size.progressInset, 0, "progress meets the bottom of the art");
        }
        await checkHover(posters, 1, 1.12);
        const next = row.getByRole("button", {name:"Next continue watching"});
        const previous = row.getByRole("button", {name:"Previous continue watching"});
        await next.focus();
        await next.press("Enter");
        await waitPage(row, step);
        assert.equal(await focusIs(next), true);
        const paged = await measure(row);
        near(paged.offset, step, "one page");
        near(paged.width, initial.width, "card width after scrolling");
        assert.equal(paged.full, 5);
        checkPeek(paged.left, "paged left");
        checkPeek(paged.right, "paged right");
        await checkHover(row, 5, 1.08);
        await checkHover(row, 9, 1.08);
        await previous.press("Space");
        await waitPage(row, 0);

        await row.locator(".movie-card").first().focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await activeIndex(row), 1);
        await page.keyboard.press("PageDown");
        assert.equal(await activeIndex(row), 6);
        await waitPage(row, step);
        await page.keyboard.press("PageUp");
        assert.equal(await activeIndex(row), 1);
        await waitPage(row, 0);

        if (width === 1280) {
            const ids = await page.locator('.movie-shelf:not([hidden]):not([data-format="resume"]) .movie-card').evaluateAll(cards => cards.map(card => card.dataset.titleKey));
            assert.equal(new Set(ids).size, ids.length);
            assert.equal(await shelf(page, "Recently added").locator(".movie-card-new").count(), 8);
            const genres = page.locator('.movie-shelf[data-format="genre"]:not([hidden])');
            assert.equal(await genres.count(), 3);
            assert.ok(await genres.evaluateAll(rows => rows.every(row => row.querySelectorAll(".movie-card").length >= 4)));
            const favorite = page.locator(".movie-hero-favorite");
            await favorite.press("Enter");
            await page.waitForFunction(() => document.querySelector(".movie-hero-favorite")?.getAttribute("aria-pressed") === "true");
            assert.equal(await focusIs(favorite), true);
            assert.deepEqual(favoriteWrites, [{item:"preview-Movie-0", favorite:true}]);
            await favorite.press("Space");
            await page.waitForFunction(() => document.querySelector(".movie-hero-favorite")?.getAttribute("aria-pressed") === "false");
            assert.deepEqual(favoriteWrites.at(-1), {item:"preview-Movie-0", favorite:false});

            const query = page.getByRole("searchbox", {name:"Search movies and TV"});
            await next.press("Enter");
            await waitPage(row, step);
            await page.keyboard.press("/");
            assert.equal(await focusIs(query), true);
            await query.fill("Demo");
            const results = shelf(page, "In your library");
            await results.waitFor();
            const searchFirst = results.locator(".movie-shelf-lane").first();
            const resultGeometry = await measure(searchFirst);
            assert.equal(resultGeometry.full, 5);
            checkPeek(resultGeometry.right, "search right");
            assert.equal(await row.isVisible(), false);
            await page.keyboard.press("Escape");
            assert.equal(await query.inputValue(), "");
            assert.equal(await focusIs(query), true);
            near(await scrollLeft(row), step, "home shelf position restored");

            await query.fill("Moon Signal");
            const find = page.getByRole("button", {name:/Find releases for Moon Signal/});
            await find.waitFor();
            await page.getByRole("status").filter({hasText:"1 title found."}).waitFor();
            await find.press("Enter");
            await page.waitForFunction(() => window.movieCalls.some(([method, term]) => method === "MovieReleaseSearch" && term === "Moon Signal 2022"));
            await page.keyboard.press("Escape");
            await row.locator(".movie-card").nth(5).press("Enter");
            assert.equal(await query.isVisible(), false);
            await page.getByRole("button", {name:"Back to titles"}).press("Enter");
            assert.equal(await focusIs(row.locator(".movie-card").nth(5)), true);
        }
    } finally { await page.close(); }
}

async function checkQuiet(browser, reducedMotion) {
    const page = await browser.newPage({viewport:{width: 1280, height: 850}, reducedMotion});
    try {
        const requests = [];
        page.on("request", request => { if (request.url().startsWith(jellyfin)) requests.push(request.url()); });
        await movieHomeFixture(page, {preview:true});
        assert.equal(await page.getByText("Layout preview: demo library").isVisible(), true);
        assert.equal(await page.getByRole("region", {name:"Movie library", exact:true}).evaluate(node => {
            node.focus();
            return getComputedStyle(node).outlineStyle;
        }), "none");
        if (reducedMotion !== "reduce") await page.evaluate(() => { document.body.dataset.effects = "off"; });
        const row = shelf(page, "Continue watching");
        const first = row.locator(".movie-card").first();
        await first.hover();
        assert.equal(await first.evaluate(card => {
            const {transform, boxShadow, outlineColor, transitionDuration} = getComputedStyle(card);
            return new DOMMatrix(transform === "none" ? undefined : transform).a === 1 && boxShadow === "none" &&
                outlineColor === "rgb(255, 255, 255)" && transitionDuration === "0s";
        }), true);
        const start = await measure(row);
        const result = await row.evaluate(node => {
            node.querySelector(".movie-shelf-arrow:last-child").click();
            return node.querySelector(".movie-shelf-scroll").scrollLeft;
        });
        near(result, 5 * (start.width + start.gap), "instant page");
        await first.press("Enter");
        assert.equal(await page.getByRole("button", {name:/^(Play|Resume|Request download)$/}).count(), 0);
        await page.getByRole("button", {name:"Back to titles"}).press("Enter");
        assert.equal(await focusIs(first), true);
        assert.deepEqual(requests, []);
        assert.deepEqual(await page.evaluate(() => window.movieCalls), []);
    } finally { await page.close(); }
}

(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        for (const [width, height] of widths) await checkWidth(browser, width, height);
        await checkQuiet(browser, "reduce");
        await checkQuiet(browser, "no-preference");
    } finally { await browser.close(); }
    console.log("Movies Home geometry and keyboard checks passed at five widths, with reduced-motion and effects-off checks.");
})().catch(error => { console.error(error); process.exitCode = 1; });
