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
        const opener = home.getByRole("button", {name: "Night Signal", exact: true});
        const series = page.getByRole("region", {name: "Night Signal", exact: true});
        const title = series.getByRole("heading", {name: "Night Signal"});
        const season = number => series.getByRole("button", {name: `Season ${number}`, exact: true});
        const focused = target => target.evaluate(node => document.activeElement === node);
        await opener.press("Enter");
        await season(1).waitFor();
        assert.equal(await focused(title), true, profile);
        const cast = series.locator(".movie-cast");
        const actors = cast.getByRole("list", {name: "Cast", exact: true});
        await actors.waitFor();
        assert.equal(await cast.getByRole("heading", {name: "Cast"}).count(), 0);
        assert.equal(await series.getByText(/TMDB|^\d+ seasons/).count(), 0);
        assert.equal(await series.getByRole("button", {name: /^Add audio track for|^Download episode/}).count(), 0);
        const related = series.locator('.movie-shelf[data-format="related"]');
        await related.getByRole("heading", {name: "More like this"}).waitFor();
        await related.getByRole("button", {name: "Quiet Port, in your library"}).waitFor();
        assert.equal(await related.getByRole("button", {name: "Find releases for Distant Signal"}).count(), 1);
        assert.equal(await page.evaluate(() => window.detailCalls.some(call =>
            call[0] === "MovieRelated" && call[1] === "201" && call[2] === "tv")), true);
        assert.equal(await actors.evaluate(list => list.scrollWidth > list.clientWidth &&
            [...list.children].every(actor => actor.offsetTop === list.firstElementChild.offsetTop)), true);
        assert.equal(await cast.locator("li").count(), 12);
        assert.equal(await cast.getByText("Skipped Director").count(), 0);
        assert.ok(await cast.getByText("Avery Vale").locator("..").locator("img").getAttribute("src"));
        assert.equal(await cast.getByText("Morgan Lee").locator("..").locator(".movie-cast-portrait").textContent(), "ML");
        assert.equal(await series.getByRole("img", {name: "Rated 16", exact: true}).textContent(), "16");
        assert.equal(await series.getByText("Mystery", {exact: true}).count(), 1);

        const favorite = series.getByRole("button", {name: "My list: Night Signal"});
        await page.keyboard.press("Tab");
        assert.equal(await focused(series.getByRole("button", {name: "Resume", exact: true})), true);
        await page.keyboard.press("Tab");
        assert.equal(await focused(favorite), true);
        await page.keyboard.press("Space");
        await page.waitForFunction(node => node.getAttribute("aria-pressed") === "true", await favorite.elementHandle());
        assert.deepEqual(writes, [["show-a", true]]);
        const outline = series.locator(".movie-season-outline");
        const oldOffset = await outline.evaluate(node => node.style.transform);
        await season(1).focus();
        await page.keyboard.press("Tab");
        assert.equal(await focused(season(2)), true);
        await page.keyboard.press("Space");
        await series.getByRole("button", {name: "1. Return"}).waitFor();
        assert.equal(await focused(season(2)), true);
        assert.equal(await season(2).getAttribute("aria-pressed"), "true");
        assert.notEqual(await outline.evaluate(node => node.style.transform), oldOffset);
        assert.equal(await series.getByRole("button", {name: "Play", exact: true}).isVisible(), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(season(1)), true);
        await page.keyboard.press("Enter");
        const episode = series.getByRole("button", {name: /^1\. Pilot/});
        await episode.waitFor();
        assert.equal(await focused(season(1)), true);
        assert.equal(await episode.locator(".movie-release-quality").getAttribute("data-level"), "web");
        assert.deepEqual(await series.locator(".movie-hero-art").evaluate(art => {
            const backdrop = art.getBoundingClientRect();
            const section = art.closest(".movie-show-detail").getBoundingClientRect();
            return [backdrop.top - section.top, backdrop.left, innerWidth - backdrop.right,
                getComputedStyle(art).borderRadius];
        }), [0, 0, 0, "0px"], `${profile}: series backdrop geometry`);

        const desktop = options.viewport.width >= 1280;
        if (desktop) {
            assert.match(await outline.evaluate(node => getComputedStyle(node).transitionProperty), /transform/);
            for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [2560, 850], [3840, 850]]) {
                await page.setViewportSize({width, height});
                const layout = await related.evaluate(node => {
                    const host = node.closest("main");
                    const root = document.scrollingElement;
                    return {
                        shelfBottom: node.getBoundingClientRect().bottom - innerHeight,
                        hostOverflow: host.scrollHeight - host.clientHeight,
                        documentOverflow: root.scrollHeight - root.clientHeight,
                        hostTop: host.scrollTop, documentTop: root.scrollTop
                    };
                });
                assert.ok(Math.abs(layout.shelfBottom) <= 1 && layout.hostOverflow <= 1 && layout.documentOverflow <= 1 &&
                    layout.hostTop === 0 && layout.documentTop === 0, `${profile} ${width}x${height} ${JSON.stringify(layout)}`);
                if ([1920, 2560].includes(width)) {
                    const portrait = await cast.locator(".movie-cast-portrait").first().boundingBox();
                    assert.ok(Math.abs(portrait.width - (width === 1920 ? 120 : 160)) <= 1);
                }
                assert.equal(await series.locator(".movie-show-columns").evaluate(node => {
                    const episodes = node.querySelector(".movie-show-episodes").getBoundingClientRect();
                    const info = node.querySelector(".movie-show-info").getBoundingClientRect();
                    return episodes.right <= info.left + 1 && Math.abs(episodes.top - info.top) <= 1;
                }), true, `${profile} ${width}`);
                const frame = await series.evaluate(node => {
                    const header = document.querySelector(".app-header").getBoundingClientRect();
                    const hub = document.querySelector("#open-hub svg").getBoundingClientRect();
                    const back = node.querySelector(".movie-title-back svg").getBoundingClientRect();
                    const columns = node.querySelector(".movie-show-columns").getBoundingClientRect();
                    return {backOffset: back.left - hub.left, columnsOffset: columns.top - header.bottom};
                });
                assert.ok(Math.abs(frame.backOffset) <= 1 && Math.abs(frame.columnsOffset) <= 1,
                    `${profile} ${width}x${height} ${JSON.stringify(frame)}`);
                if ([720, 1080, 1440].includes(height)) {
                    const clipped = await actors.evaluate(list => {
                        const info = list.closest(".movie-show-info");
                        const frame = info.getBoundingClientRect();
                        const left = frame.left + info.clientLeft;
                        const top = frame.top + info.clientTop;
                        const fits = box => box.left >= left - 1 && box.top >= top - 1 &&
                            box.right <= left + info.clientWidth + 1 && box.bottom <= top + info.clientHeight + 1;
                        const intro = info.querySelector(".movie-title-intro");
                        const clipped = fits(intro.getBoundingClientRect()) ? [] : ["Title block"];
                        const scrollLeft = list.scrollLeft;
                        const listLeft = list.getBoundingClientRect().left;
                        const listRight = listLeft + list.clientWidth;
                        for (const actor of list.children) {
                            // Reveal each card horizontally while leaving the vertical position untouched.
                            list.scrollLeft += Math.max(0, actor.getBoundingClientRect().right - listRight);
                            const box = actor.getBoundingClientRect();
                            if (!fits(box) || box.left < listLeft - 1 || box.right > listRight + 1) {
                                clipped.push(actor.querySelector("strong").textContent);
                            }
                        }
                        list.scrollLeft = scrollLeft;
                        return clipped;
                    });
                    assert.deepEqual(clipped, [], `${profile} ${width}x${height} clipped series info`);
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
            await episode.hover();
            await page.waitForFunction(node => {
                const style = getComputedStyle(node);
                return style.transform !== "none" && new DOMMatrix(style.transform).a > 1.02 &&
                    style.outlineColor === "rgb(255, 255, 255)";
            }, await episode.elementHandle());
        } else {
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, profile);
        }
        await page.emulateMedia({reducedMotion: "reduce"});
        await episode.focus();
        assert.deepEqual(await episode.evaluate(node => {
            const {transform, outlineColor} = getComputedStyle(node);
            return [transform, outlineColor];
        }), ["none", "rgb(255, 255, 255)"]);
        assert.equal(await outline.evaluate(node => getComputedStyle(node).transitionDuration), "0s");
        await page.emulateMedia({reducedMotion: "no-preference"});
        await page.evaluate(() => { document.body.dataset.effects = "off"; });
        assert.equal(await episode.evaluate(node => getComputedStyle(node).transform), "none");
        assert.equal(await outline.evaluate(node => getComputedStyle(node).transitionDuration), "0s");
        await page.keyboard.press("Escape");
        assert.equal(await focused(home.locator('.movie-card[data-item-id="show-a"]')), true);
        const quietPort = home.getByRole("button", {name: "Quiet Port", exact: true});
        await quietPort.press("Enter");
        const noCast = page.getByRole("region", {name: "Quiet Port"});
        await noCast.getByRole("button", {name: "Season 1", exact: true}).waitFor();
        assert.equal(await noCast.getByRole("heading", {name: "Cast"}).count(), 0);
        assert.equal(await noCast.getByRole("button", {name: "Resume", exact: true}).isVisible(), true);
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
        await noCast.getByRole("button", {name: "Back to titles", exact: true}).press("Enter");
        assert.equal(await focused(quietPort), true);
    } finally {
        await context.close();
    }
}

reviewMovieProfiles(check).catch(error => { console.error(error); process.exitCode = 1; });
