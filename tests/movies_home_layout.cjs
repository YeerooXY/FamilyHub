const assert = require("node:assert/strict");
const {constants, setPriority} = require("node:os");
const path = require("node:path");
const { chromium } = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
const { jellyfin, movieHomeFixture } = require("./movies_fixture.cjs");
setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const widths = [[1280, 850], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]];
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} vs ${expected}`);
const focusIs = node => node.evaluate(element => document.activeElement === element);
const shelf = (page, title) => page.locator(".movie-shelf").filter({has: page.getByRole("heading", {name: title, exact: true})});
const viewport = row => row.locator(".movie-shelf-scroll");
const scrollLeft = row => viewport(row).evaluate(node => node.scrollLeft);
const activeIndex = row => row.locator(".movie-card").evaluateAll(cards => cards.indexOf(document.activeElement));
const heroFillSelector = '.movie-hero-pager [aria-current="true"] .movie-hero-dot-fill';
const fillScale = fill => fill.evaluate(node => node.getBoundingClientRect().width / node.offsetWidth);

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

async function checkArrowPress(page, row, next) {
    await row.locator(".movie-card").first().hover();
    await page.waitForFunction(arrow => getComputedStyle(arrow).opacity === "1" && !arrow.getAnimations().length,
        await next.elementHandle());
    await next.hover();
    assert.equal(await next.evaluate(node => getComputedStyle(node).outlineStyle), "none");
    const before = await next.boundingBox();
    const restingTransform = await next.evaluate(node => getComputedStyle(node).transform);
    await page.mouse.down();
    try {
        assert.equal(await next.evaluate((node, transform) => getComputedStyle(node).transform === transform, restingTransform), true);
        assert.equal(await next.evaluate(node => getComputedStyle(node).outlineStyle), "none");
        assert.deepEqual(await next.boundingBox(), before);
    } finally {
        await page.mouse.move(0, 0);
        await page.mouse.up();
    }
    await page.keyboard.press("Tab");
    await next.focus();
    assert.deepEqual(await next.evaluate(node => {
        const {outlineStyle, outlineOffset, outlineWidth} = getComputedStyle(node);
        return [outlineStyle, outlineOffset, outlineWidth];
    }), ["solid", "-4px", "1px"]);
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
        const meta = page.locator(".movie-hero-meta");
        assert.deepEqual((await meta.locator(":scope > span").allTextContents()).slice(0, 4), ["2001", "12", "1 h 20 min", "1080p"]);
        for (const label of ["2001", "1 h 20 min"]) {
            assert.equal(await meta.getByText(label, {exact: true}).evaluate(node => node.classList.contains("movie-chip")), false);
        }
        assert.equal(await meta.getByRole("img", {name: "Age rating 12"}).textContent(), "12");
        assert.equal(await meta.locator(".movie-release-quality").getAttribute("data-level"), "web");
        assert.equal(await meta.locator(".movie-release-quality").evaluate(node => {
            const style = getComputedStyle(node);
            return style.backgroundColor === "rgba(0, 0, 0, 0)" && parseFloat(style.borderTopWidth) >= 1;
        }), true);

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
            titleLeft: node.querySelector(".movie-hero-title").getBoundingClientRect().left,
            titleSize: parseFloat(getComputedStyle(node.querySelector(".movie-hero-title")).fontSize),
            logoHeight: node.querySelector(".movie-hero-logo").getBoundingClientRect().height,
            descriptionSize: parseFloat(getComputedStyle(node.querySelector(".movie-hero-overview")).fontSize),
            controlHeights: [...node.querySelectorAll(".movie-hero-actions button")].map(button => button.getBoundingClientRect().height)
        }));
        near(hero.titleLeft, initial.firstLeft, "hero title alignment");
        assert.ok(hero.height >= .50 * height && hero.height <= .56 * height, "hero height");
        for (const controlHeight of hero.controlHeights)
            near(controlHeight, width >= 1600 ? Math.min(104, width * .0405) : 44, "hero control height");
        if (width >= 1920) {
            assert.ok(hero.titleSize >= (width === 1920 ? 100 : 135));
            assert.ok(hero.descriptionSize >= (width === 1920 ? 28 : 31));
            near(hero.logoHeight, height * .12 > 224 ? 224 : height * .12, "hero logo height");
        }
        assert.equal(hero.controlHeights.length, 3);
        assert.equal(await compact.getByRole("button", {name:/^(Previous|Next) collections$/}).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

        await checkHover(row, 0, 1.08);
        await checkHover(row, 4, 1.08);
        const posters = shelf(page, "Movies");
        for (const [shelfRow, ratio] of [[posters, 2 / 3], [row, 16 / 9]]) {
            assert.equal(await shelfRow.locator(".movie-caption").first().evaluate(node =>
                getComputedStyle(node).backgroundColor), "rgb(0, 0, 0)");
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
        if (width === 1280) await checkArrowPress(page, row, next);
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
            const firstDot = page.locator(".movie-hero-pager button").first();
            await firstDot.press("Enter");
            await firstDot.and(page.locator('[aria-current="true"]')).waitFor();
            const favorite = page.locator(".movie-hero-slide:not([inert]) .movie-hero-favorite");
            const savedCard = shelf(page, "My list").locator('.movie-card[data-item-id="preview-Movie-0"]');
            await favorite.press("Enter");
            await page.waitForFunction(() => document.querySelector(".movie-hero-favorite")?.getAttribute("aria-pressed") === "true");
            assert.equal(await focusIs(favorite), true);
            assert.deepEqual(favoriteWrites, [{item:"preview-Movie-0", favorite:true}]);
            assert.equal(await savedCard.isVisible(), true);
            await favorite.press("Space");
            await page.waitForFunction(() => document.querySelector(".movie-hero-favorite")?.getAttribute("aria-pressed") === "false");
            assert.deepEqual(favoriteWrites.at(-1), {item:"preview-Movie-0", favorite:false});
            assert.equal(await savedCard.count(), 0);

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
            near(await scrollLeft(row), 0, "home shelf resets after search");

            await query.fill("Moon Signal");
            const find = page.getByRole("button", {name:/Find releases for Moon Signal/});
            await find.waitFor();
            await page.getByRole("status").filter({hasText:"1 title found."}).waitFor();
            await find.press("Enter");
            await page.waitForFunction(() => window.movieCalls.some(([method, term]) => method === "MovieReleaseSearch" && term === "Moon Signal 2022"));
            await page.keyboard.press("Escape");
            await viewport(posters).evaluate(node => { node.scrollLeft = 150; });
            assert.ok(await scrollLeft(posters) > 0);
            const opener = row.locator(".movie-card").nth(5);
            await opener.press("Enter");
            assert.equal(await query.isVisible(), false);
            await page.getByRole("button", {name:"Back to titles"}).press("Enter");
            assert.equal(await focusIs(opener), true);
            near(await scrollLeft(posters), 0, "other shelves reset");
            assert.ok(await scrollLeft(row) > 0 && await scrollLeft(row) < step, "only enough scroll to reveal the focused card");
        }
    } finally { await page.close(); }
}

async function checkHero(browser) {
    const page = await browser.newPage({viewport: {width: 320, height: 720}});
    try {
        const {library} = await movieHomeFixture(page);
        const hero = page.locator(".movie-hero");
        const slide = hero.locator(".movie-hero-slide:not([inert])");
        const pager = hero.locator(".movie-hero-pager");
        const dots = pager.getByRole("button", {name: /^Show /});
        const fill = page.locator(heroFillSelector);
        const assertPaused = async reason => {
            const [state, stopped, afterFrame] = await fill.evaluate(async node => {
                const animation = node.getAnimations()[0];
                await animation.ready;
                const stopped = animation.currentTime;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return [animation.playState, stopped, animation.currentTime];
            });
            assert.equal(state, "paused", reason);
            assert.equal(afterFrame, stopped, reason);
            return stopped;
        };
        const waitForProgress = time => page.waitForFunction(({selector, time}) => {
            const animation = document.querySelector(selector)?.getAnimations()[0];
            return animation?.playState === "running" && animation.currentTime > time;
        }, {selector: heroFillSelector, time}, {timeout: 5000});
        const current = () => pager.locator('[aria-current="true"]').getAttribute("aria-label");
        const checkDotHandoff = async (outgoing, incoming) => {
            for (const [dot, grows] of [[outgoing, false], [incoming, true]]) {
                const samples = await dot.locator(".movie-hero-dot").evaluate(async node => {
                    const width = () => node.getBoundingClientRect().width;
                    width();
                    const transition = node.getAnimations().find(animation => animation.transitionProperty === "width");
                    if (!transition) return null;
                    transition.pause();
                    await transition.ready;
                    transition.currentTime = 75;
                    const first = width();
                    transition.currentTime = 250;
                    const second = width();
                    transition.play();
                    return {first, second, duration: transition.effect.getTiming().duration};
                });
                assert.ok(samples, "dot has a width transition");
                assert.ok([samples.first, samples.second].every(value => value > 4 && value < 28), JSON.stringify(samples));
                assert.ok(grows ? samples.second > samples.first : samples.first > samples.second, JSON.stringify(samples));
                assert.equal(samples.duration, 350);
            }
        };
        const labels = await dots.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
        assert.equal(labels.length, 5);
        assert.equal(new Set(labels).size, labels.length);
        assert.equal(labels[0], "Show Midnight Meridian (Demo)");
        assert.equal(await current(), labels[0]);
        assert.equal(await dots.first().getAttribute("title"), labels[0]);
        const pill = dots.first().locator(".movie-hero-dot");
        const {width, height} = await pill.boundingBox();
        assert.deepEqual([width, height], [28, 6]);
        assert.equal(await pill.getAttribute("aria-hidden"), "true");
        assert.equal(await fill.evaluate(node => node.getAnimations()[0].effect.getTiming().duration), 9000);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        near((await slide.locator("h2").boundingBox()).x, (await measure(shelf(page, "Continue watching"))).headingLeft, "phone hero alignment");
        const groups = await slide.evaluate(node => {
            const actions = node.querySelector(".movie-hero-actions").getBoundingClientRect();
            const progress = node.querySelector(".movie-hero-progress").getBoundingClientRect();
            return {actions: actions.width, progress: progress.width, height: progress.height,
                buttons: [...node.querySelectorAll("button")].map(button => button.getBoundingClientRect().height)};
        });
        near(groups.actions, groups.progress, "progress matches the controls");
        assert.equal(groups.height, 3);
        assert.deepEqual(groups.buttons.map(Math.round), [44, 44, 44]);
        assert.equal(await slide.locator(".movie-hero-time").textContent(), "1 h 12 min left");

        await page.mouse.move(0, 0);
        await waitForProgress(0);
        await dots.first().hover();
        const hovered = await assertPaused("hover pauses the fill");
        assert.ok(hovered > 0, "hover holds a partly filled pill");
        assert.equal(await current(), labels[0], "hover keeps the current slide");
        const play = slide.getByRole("button", {name: "Resume"});
        await play.focus();
        await page.mouse.move(0, 0);
        assert.equal(await assertPaused("focus pauses the fill"), hovered);
        assert.equal(await current(), labels[0], "focus pauses rotation");
        assert.equal(await focusIs(play), true);

        const search = page.getByRole("searchbox", {name: "Search movies and TV"});
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", {configurable: true, value: true});
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await search.focus();
        assert.equal(await assertPaused("a hidden document pauses the fill"), hovered);
        assert.equal(await current(), labels[0], "a hidden document pauses rotation");
        await page.evaluate(() => {
            delete document.hidden;
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await waitForProgress(hovered);
        await fill.evaluate(node => { node.getAnimations()[0].currentTime = 8800; });
        await pager.locator('[aria-current="true"]').and(dots.nth(1)).waitFor();
        await checkDotHandoff(dots.first(), dots.nth(1));
        assert.equal(await focusIs(search), true);
        assert.equal(await hero.getByRole("status").textContent(), "");
        assert.equal(await slide.locator(".movie-hero-art").evaluate(art => art.complete && art.naturalWidth > 0), true);
        assert.equal(await slide.evaluate(node => node.getAnimations().some(animation => animation.effect.getTiming().duration === 900)), true);
        await hero.locator(".movie-hero-slide[inert]").waitFor({state: "detached"});

        await waitForProgress(0);
        await dots.nth(1).click();
        assert.equal(await current(), labels[1]);
        assert.equal(await assertPaused("clicking the current dot restarts its fill"), 0);
        assert.equal(await fillScale(fill), 0);
        await dots.first().press("Space");
        await pager.locator('[aria-current="true"]').and(dots.first()).waitFor();
        await checkDotHandoff(dots.nth(1), dots.first());
        assert.equal(await assertPaused("selecting another dot starts its fill empty"), 0);
        assert.equal(await focusIs(dots.first()), true);
        assert.equal(await hero.getByRole("status").textContent(), labels[0].slice(5));
        await page.keyboard.press("Tab");
        assert.equal(await focusIs(dots.nth(1)), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focusIs(dots.first()), true);
        await assertPaused("pager focus pauses the fill");
        assert.equal(await current(), labels[0], "pager focus pauses rotation");

        for (const item of library.slice(1)) item.BackdropImageTags = [];
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await pager.waitFor({state: "hidden"});
        assert.equal(await focusIs(slide.getByRole("button", {name: "Resume"})), true);
        await search.focus();
        assert.equal(await fill.count(), 0);
        assert.equal(await slide.locator("h2").textContent(), labels[0].slice(5));
    } finally { await page.close(); }
}

async function checkQuiet(browser, reducedMotion) {
    const page = await browser.newPage({viewport:{width: 1280, height: 850}, reducedMotion});
    try {
        await page.clock.install();
        const requests = [];
        page.on("request", request => { if (request.url().startsWith(jellyfin)) requests.push(request.url()); });
        await movieHomeFixture(page, {preview:true});
        assert.equal(await page.getByText("Demo library", {exact: true}).isVisible(), true);
        assert.equal(await page.getByRole("region", {name:"Movie library", exact:true}).evaluate(node => {
            node.focus();
            return getComputedStyle(node).outlineStyle;
        }), "none");
        if (reducedMotion !== "reduce") await page.evaluate(() => { document.body.dataset.effects = "off"; });
        const hero = page.locator(".movie-hero"), pager = hero.locator(".movie-hero-pager");
        const dots = pager.getByRole("button", {name: /^Show /});
        const fill = page.locator(heroFillSelector);
        await page.clock.fastForward(9100);
        assert.equal(await dots.first().getAttribute("aria-current"), "true");
        assert.equal(await fillScale(fill), 1);
        assert.equal(await fill.evaluate(node => node.getAnimations().length), 0);
        await dots.nth(1).press("Enter");
        assert.equal(await dots.nth(1).getAttribute("aria-current"), "true");
        assert.deepEqual(await pager.locator(".movie-hero-dot").evaluateAll(nodes => nodes.slice(0, 2).map(node => [
            node.getBoundingClientRect().width, node.getAnimations().length
        ])), [[4, 0], [28, 0]]);
        assert.equal(await focusIs(dots.nth(1)), true);
        assert.equal(await fillScale(fill), 1);
        assert.equal(await fill.evaluate(node => node.getAnimations().length), 0);
        assert.equal(await hero.locator(".movie-hero-slide").evaluate(node => node.getAnimations().length), 0);
        const row = shelf(page, "Continue watching");
        assert.deepEqual(await row.locator(".movie-card small").allTextContents(), ["S1 E2, The Crossing", "S1 E3, First Light"]);
        const first = row.locator(".movie-card").first();
        await first.hover();
        assert.deepEqual(await row.getByRole("button", {name: "Next continue watching"}).evaluate(node => {
            const {opacity, translate, transitionDuration} = getComputedStyle(node);
            return [opacity, translate, transitionDuration];
        }), ["1", "0px", "0s"]);
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

async function checkDownloads(browser) {
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}, reducedMotion: "reduce"});
    try {
        const resumeItems = [2026, 1998].map((ProductionYear, index) => ({
            Id: "resume-" + index, Name: "Harbor Night", ProductionYear, Type: "Movie", UserData: {PlayedPercentage: 40}
        }));
        resumeItems.push({Id: "resume-episode", Name: "The Harbour", Type: "Episode", SeriesId: "harbour-town",
            SeriesName: "Harbour Town", ParentIndexNumber: 7, IndexNumber: 2, UserData: {PlayedPercentage: 40}});
        await movieHomeFixture(page, {downloads: true, resumeItems});
        const hero = page.locator(".movie-hero"), heroTop = () => hero.evaluate(node => node.getBoundingClientRect().top);
        const tray = page.locator(".movie-download-toggle");
        const panel = page.getByRole("dialog", {name: "Downloads"});
        const resume = shelf(page, "Continue watching").locator(".movie-card");
        await hero.waitFor();
        await resume.nth(1).waitFor();
        const top = await heroTop();
        const card = resume.and(page.locator('[data-item-id="resume-0"]'));
        const normal = resume.and(page.locator('[data-item-id="resume-1"]'));
        const otherSeason = resume.and(page.locator('[data-item-id="resume-episode"]'));
        await otherSeason.waitFor();
        const height = locator => locator.evaluate(node => node.offsetHeight);
        const before = await height(card);
        assert.equal(await tray.isVisible(), false);
        const title = await card.locator(".movie-card-name").textContent();
        await page.evaluate(title => {
            window.queue = [
                {name: title.replaceAll(" ", ".") + ".2026.1080p.WEB-DL", progress: .42, state: "Downloading", eta: 1077 * 60},
                {name: "Harbour.Town.S06.1080p.WEB-DL", progress: .28, state: "Downloading", eta: 100 * 60}
            ];
            document.dispatchEvent(new Event("visibilitychange"));
        }, title);
        await tray.waitFor();
        assert.equal(await heroTop(), top);
        assert.equal(await page.locator(".movie-catalogue .movie-downloads").count(), 0);
        assert.equal(await tray.getAttribute("aria-label"), "Downloads, 2 active");
        assert.equal(await tray.locator(".movie-download-count").textContent(), "2");
        assert.equal(await tray.evaluate(node => node.style.getPropertyValue("--download-percent")), "35");
        assert.equal((await tray.boundingBox()).height, 60);
        const badge = card.locator(".movie-download-badge");
        await badge.waitFor();
        assert.equal(await normal.locator(".movie-download-badge").isVisible(), false);
        assert.equal(await otherSeason.locator(".movie-download-badge").isVisible(), false);
        assert.deepEqual(await badge.evaluate(node => {
            const readable = node.querySelector(".movie-visually-hidden");
            const copy = node.cloneNode(true);
            copy.querySelector(".movie-visually-hidden").remove();
            return [copy.textContent, getComputedStyle(readable).clipPath];
        }), ["", "inset(50%)"]);
        assert.equal(await card.getAttribute("aria-describedby"), await badge.locator(".movie-visually-hidden").getAttribute("id"));
        assert.equal(await badge.locator(".movie-visually-hidden").textContent(), "Downloading, 40%");
        near(await height(card), before, "card height after download");
        near(await height(card), await height(normal), "download and normal card heights");

        const lastShelfCard = page.locator(".movie-browse .movie-shelf:not([hidden]) .movie-card").last();
        await lastShelfCard.press("ArrowDown");
        assert.equal(await focusIs(tray), true);
        assert.equal(await tray.evaluate(node => getComputedStyle(node).outlineWidth), "4px");
        await tray.press("Enter");
        assert.equal(await focusIs(panel.getByRole("button", {name: "Close"})), true);
        assert.equal(await panel.evaluate(node => node.getAnimations({subtree: true}).length), 0);
        await panel.getByRole("button", {name: title + " (2026)", exact: true}).waitFor();
        await panel.getByRole("button", {name: "Harbour Town, Season 6", exact: true}).waitFor();
        assert.equal(await panel.getByText("about 18 h left", {exact: true}).isVisible(), true);
        assert.equal(await panel.getByText("about 1 h 40 min left", {exact: true}).isVisible(), true);
        assert.doesNotMatch(await panel.innerText(), /WEB-DL|1080p|1077/);
        await page.keyboard.press("Escape");
        assert.equal(await panel.isVisible(), false);
        assert.equal(await focusIs(tray), true);
        await tray.press("Enter");
        await panel.getByRole("button", {name: "Close"}).press("Enter");
        assert.equal(await focusIs(tray), true);
    } finally { await page.close(); }
}

(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        for (const [width, height] of widths) await checkWidth(browser, width, height);
        await checkHero(browser);
        await checkDownloads(browser);
        await checkQuiet(browser, "reduce");
        await checkQuiet(browser, "no-preference");
    } finally { await browser.close(); }
    console.log("Movies Home geometry, hero rotation and keyboard checks passed, including reduced motion and effects off.");
})().catch(error => { console.error(error); process.exitCode = 1; });
