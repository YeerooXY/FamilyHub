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
        const expectedFacts = ["2026", "6", "1 h 50 min", "4K", "DDP 5.1"];
        await film.getByRole("img", {name: "Sound: Dolby Digital Plus 5.1"}).waitFor();
        assert.deepEqual(await film.locator(".movie-title-facts > span").allTextContents(), expectedFacts);
        assert.equal(await film.locator(".movie-title-facts > span:not(.movie-chip)").count(), 2);
        assert.equal(await film.getByText(/TMDB/).count(), 0);
        assert.equal(await film.getByRole("heading", {name: "Cast", exact: true}).count(), 0);
        assert.equal(await film.getByRole("list", {name: "Cast", exact: true}).count(), 1);
        assert.equal(await film.getByRole("img", {name: "Age rating 6", exact: true}).textContent(), "6");
        assert.equal(await film.locator(".movie-title-facts .movie-release-quality").getAttribute("data-level"), "4k-web");
        assert.equal(await film.locator(".movie-title-facts :is(.movie-release-quality, .movie-sound-chip)").evaluateAll(
            badges => badges.every(badge => {
                const style = getComputedStyle(badge);
                return style.backgroundColor === "rgba(0, 0, 0, 0)" && parseFloat(style.borderTopWidth) >= 1;
            })), true);
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
        const retryName = "Related films are unavailable. Retry";
        const retry = film.getByRole("button", {name: retryName, exact: true});
        await retry.waitFor();
        assert.equal(await more.isVisible(), true);
        assert.equal(await retry.getAttribute("title"), null);
        assert.equal(await retry.textContent(), "");
        assert.equal(await retry.locator("svg").count(), 1);
        assert.equal(await film.getByText("Manual retry").count(), 0);
        assert.equal(await page.locator(".movie-load-status").textContent(), "Related films are unavailable");
        const retryTarget = options.viewport.width >= 1600 ? 60 : 44;
        assert.deepEqual(await retry.evaluate(node => [node.offsetWidth, node.offsetHeight]), [retryTarget, retryTarget]);
        const retryBox = await retry.boundingBox();
        assert.ok(Math.min(retryBox.width, retryBox.height) >= retryTarget - 0.01, `${profile}: retry target`);
        await retry.press("Enter");
        await film.getByRole("button", {name: "Second Orbit, in your library", exact: true}).waitFor();
        assert.equal(await focused(retry), true);
        assert.equal(await page.locator(".movie-load-status").textContent(), "");
        await page.keyboard.press("Tab");
        assert.equal(await retry.isVisible(), false);
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");
        const myList = home.locator('.movie-shelf[data-format="favorites"]');
        assert.equal(await myList.getByRole("button", {name: "First Orbit"}).isVisible(), true);
        assert.equal(await focused(firstOrbit()), true);
        await firstOrbit().press("Enter");

        const related = film.locator('.movie-shelf[data-format="related"]');
        const owned = related.getByRole("button", {name: "Second Orbit, in your library", exact: true});
        const missing = related.getByRole("button", {name: "Find releases for Outer Station 1", exact: true});
        await owned.waitFor();
        assert.equal(await related.getByText("Untitled Home Alone Film").count(), 0);
        assert.equal(await more.count(), 1);
        assert.equal(await owned.locator(".movie-card-owned svg").count(), 1);
        assert.equal(await owned.evaluate(node => node.parentElement.firstElementChild === node), true);
        const desktop = options.viewport.width >= 1280;
        for (const [width, height] of desktop ? [[1280, 720], [1920, 1080], [2000, 1040], [2560, 1440], [3840, 2160]]
            : [[options.viewport.width, options.viewport.height]]) {
            if (desktop) await page.setViewportSize({width, height});
            const expectedWidth = width > 1920 ? "3840" : "1920";
            await page.waitForFunction(expectedWidth => {
                const art = document.querySelector(".movie-film-detail:not([hidden]) .movie-hero-art");
                return art?.src && new URL(art.src).searchParams.get("maxWidth") === expectedWidth;
            }, expectedWidth);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${profile} ${width}`);
            if (desktop) await heading.focus();
            const layout = await film.evaluate(node => {
                const image = node.querySelector(".movie-hero-art");
                const art = image.getBoundingClientRect(), header = document.querySelector(".app-header").getBoundingClientRect();
                const back = node.querySelector(".movie-title-back").getBoundingClientRect();
                const documentScroll = document.scrollingElement ?? document.documentElement;
                const host = node.closest(".workspace > main") ?? documentScroll;
                const scrolled = [];
                for (let ancestor = node.querySelector(".movie-title-text h2"); ancestor; ancestor = ancestor.parentElement)
                    if (ancestor.scrollTop !== 0) scrolled.push(ancestor.className || ancestor.tagName);
                return {top: art.top - header.bottom, left: art.left, right: innerWidth - art.right,
                    bottom: art.bottom - node.getBoundingClientRect().bottom,
                    viewportBottom: innerHeight - art.bottom,
                    radius: getComputedStyle(image).borderRadius, fit: getComputedStyle(image).objectFit,
                    headerAndBackVisible: [header, back].every(rect =>
                        rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth),
                    scrolled,
                    overflow: host.scrollHeight - host.clientHeight,
                    pageOverflow: documentScroll.scrollHeight - documentScroll.clientHeight};
            });
            assert.deepEqual([layout.top, layout.left, layout.right, layout.bottom, layout.radius, layout.fit],
                [0, 0, 0, 0, "0px", "cover"], `${profile} ${width}x${height}`);
            if (desktop) {
                assert.equal(layout.headerAndBackVisible, true, `${profile} ${width}x${height}`);
                assert.deepEqual(layout.scrolled, [], `${profile} ${width}x${height} scrolled after heading focus`);
                const innerOverflow = await related.locator(".movie-shelf-scroll").evaluate(node => node.scrollHeight - node.clientHeight);
                assert.ok(layout.overflow <= 1 && innerOverflow <= 1 && layout.pageOverflow <= 1,
                    `${profile} ${width}x${height} ${JSON.stringify(layout)}`);
                assert.equal(layout.viewportBottom, 0, "backdrop reaches the bottom of the viewport");
                assert.ok(await related.evaluate(node => Math.abs(node.getBoundingClientRect().bottom - innerHeight) <= 1));
                assert.ok(await film.locator(".movie-title-back svg").evaluate(back =>
                    Math.abs(back.getBoundingClientRect().left -
                        document.querySelector("#open-hub svg").getBoundingClientRect().left) <= 1));
                if ([1920, 2560].includes(width)) {
                    const portrait = await film.locator(".movie-cast-portrait").first().boundingBox();
                    assert.ok(Math.abs(portrait.width - (width === 1920 ? 120 : 160)) <= 1);
                }
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
        if (desktop) {
            const viewport = related.locator(".movie-shelf-scroll");
            const cards = viewport.locator(".movie-card");
            const peek = cards.nth(5);
            const nextPage = related.getByRole("button", {name: "Next more like this"});
            assert.equal(await nextPage.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
            assert.equal(await nextPage.evaluate(node => node.offsetHeight), 60);
            await page.waitForFunction(card => card.tabIndex === -1, await peek.elementHandle());
            const point = await peek.evaluate(node => {
                const card = node.getBoundingClientRect(), frame = node.closest(".movie-shelf-scroll").getBoundingClientRect();
                return {x: (card.left + frame.right) / 2, y: card.top + 10};
            });
            await page.mouse.move(point.x, point.y);
            await page.waitForFunction(card => getComputedStyle(card).outlineColor === "rgba(0, 0, 0, 0)", await peek.elementHandle());
            await page.mouse.click(point.x, point.y);
            await page.waitForFunction(card => card.tabIndex === 0, await peek.elementHandle());
            assert.equal(await film.isVisible(), true);
            assert.equal(await page.getByRole("searchbox").count(), 0);
            await viewport.evaluate(node => { node.dispatchEvent(new WheelEvent("wheel")); node.scrollLeft = 0; });
            await page.waitForFunction(card => card.tabIndex === -1, await peek.elementHandle());
            await cards.nth(4).focus();
            await page.keyboard.press("Tab");
            assert.equal(await focused(nextPage), true);
            await cards.nth(4).focus();
            await page.keyboard.press("ArrowRight");
            assert.equal(await focused(peek), true);
            // The card becomes tabbable once the smooth scroll has brought it fully into view.
            await page.waitForFunction(card => card.tabIndex === 0, await peek.elementHandle());
            await viewport.evaluate(node => { node.dispatchEvent(new WheelEvent("wheel")); node.scrollLeft = 0; });
            await page.waitForFunction(card => card.tabIndex === -1, await peek.elementHandle());
            const cast = film.locator(".movie-cast li").first();
            const checkOutline = async (target, width) => {
                await page.waitForFunction(({node, width}) => {
                    const style = getComputedStyle(node);
                    return style.outlineStyle === "solid" && style.outlineWidth === width && style.outlineColor === "rgb(255, 255, 255)";
                }, {node: await target.elementHandle(), width});
            };
            for (const target of [owned, play, cast]) {
                await target.hover();
                await checkOutline(target, "4px");
                await page.mouse.move(0, 0);
                await page.keyboard.press("Tab");
                await target.focus();
                await checkOutline(target, "4px");
            }
            const back = film.getByRole("button", {name: "Back to titles"});
            for (const target of [back, favorite, nextPage]) assert.equal(await target.getAttribute("title"), null);
            const background = await back.evaluate(node => getComputedStyle(node).backgroundColor);
            await back.hover();
            await page.waitForFunction(node => {
                const transform = getComputedStyle(node.firstElementChild).transform;
                return transform !== "none" && new DOMMatrix(transform).e === -3;
            }, await back.elementHandle());
            assert.equal(await back.evaluate(node => getComputedStyle(node).backgroundColor), background);
            await back.evaluate(node => node.addEventListener("click", event => event.stopImmediatePropagation(), {capture: true, once: true}));
            await back.click();
            assert.equal(await back.evaluate(node => getComputedStyle(node).outlineStyle), "none");
            await heading.focus();
            await page.keyboard.press("Shift+Tab");
            assert.equal(await focused(back), true);
            await checkOutline(back, "4px");
            await nextPage.click();
            const range = page.getByText(/^Showing titles \d+ to \d+ of \d+\.$/);
            await range.waitFor({state: "attached"});
            assert.equal(await range.evaluate(node => node.classList.contains("movie-visually-hidden") &&
                getComputedStyle(node).clipPath === "inset(50%)"), true);
            await page.setViewportSize({width: 1280, height: 560});
            assert.equal(await film.evaluate(node => {
                const host = node.closest(".workspace > main") ?? document.scrollingElement ?? document.documentElement;
                return host.scrollHeight > host.clientHeight;
            }), true);
            await page.setViewportSize({width: 1280, height: 720});
            await play.hover();
            await checkOutline(play, "2px");
            await page.mouse.move(0, 0);
            await page.clock.install();
            await play.press("Enter");
            const notice = page.locator(".movie-playback-notice");
            await notice.getByRole("status").filter({hasText: "The server did not return playback information."}).waitFor();
            assert.equal(await notice.evaluate(node => getComputedStyle(node).position), "fixed");
            assert.equal(await focused(play), true);
            const dismiss = notice.getByRole("button", {name: "Dismiss playback notice"});
            await dismiss.focus();
            await page.clock.fastForward(8100);
            assert.equal(await notice.isVisible(), true);
            await dismiss.press("Enter");
            assert.equal(await notice.isVisible(), false);
            assert.equal(await focused(play), true);
            await play.press("Enter");
            await notice.waitFor();
            await page.clock.fastForward(8100);
            assert.equal(await notice.isVisible(), false);
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
        const read = sequel.locator(".movie-description-more");
        const description = sequel.locator(".movie-film-overview");
        const expand = sequel.getByRole("button", {name: "Show full description"});
        await expand.waitFor();
        const collapsedHeight = (await description.boundingBox()).height;
        if (options.hasTouch && options.viewport.width <= 600) {
            assert.equal(await expand.evaluate(node => {
                const box = node.getBoundingClientRect();
                const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return getComputedStyle(node).opacity === "1" && node.contains(target);
            }), true, profile + " shows the chevron before any touch");
            await expand.tap();
        } else await expand.press("Enter");
        assert.equal(await read.getAttribute("aria-expanded"), "true");
        assert.equal(await read.getAttribute("aria-label"), "Show less");
        if (!options.hasTouch || options.viewport.width > 600) assert.equal(await focused(read), true);
        await page.waitForFunction(node => node.clientHeight >= node.scrollHeight - 1, await description.elementHandle());
        assert.ok((await description.boundingBox()).height > collapsedHeight);
        await read.press("Space");
        assert.equal(await read.getAttribute("aria-expanded"), "false");
        assert.equal(await focused(read), true);
        await page.waitForFunction(({node, height}) => Math.abs(node.getBoundingClientRect().height - height) <= 1,
            {node: await description.elementHandle(), height: collapsedHeight});
        await page.emulateMedia({reducedMotion: "reduce"});
        await read.press("Enter");
        assert.equal(await description.evaluate(node => node.getAnimations().length), 0);
        assert.equal(await description.evaluate(node => node.clientHeight >= node.scrollHeight - 1), true);
        await read.press("Space");
        assert.equal(await focused(read), true);
        await page.emulateMedia({reducedMotion: options.reducedMotion ?? "no-preference"});
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
