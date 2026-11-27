const assert = require("node:assert/strict");
const {constants, setPriority} = require("node:os");
const {movieDetailFixture, reviewMovieProfiles} = require("./movies_fixture.cjs");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

async function check(browser, profile, options) {
    const context = await browser.newContext(options);
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(7000);
        const writes = await movieDetailFixture(page, {denseSeries: true});
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
        const checkCast = async () => {
            const layout = await actors.evaluate(list => {
                const visible = [...list.children].filter(actor => !actor.hidden);
                const columns = getComputedStyle(list).gridTemplateColumns.split(" ").length;
                return {count: visible.length, columns, total: list.children.length,
                    first: visible[0]?.querySelector("strong").textContent,
                    rows: new Set(visible.map(actor => actor.offsetTop)).size, overflow: list.scrollWidth - list.clientWidth,
                    nameOverflow: getComputedStyle(visible[0].querySelector("strong")).textOverflow};
            });
            assert.ok(layout.count >= Math.min(layout.columns, layout.total) && layout.count <= layout.columns * 2, profile);
            assert.equal(layout.first, "Avery Vale", profile);
            assert.ok(layout.rows <= 2 && layout.overflow <= 1, JSON.stringify(layout));
            assert.equal(layout.nameOverflow, "ellipsis");
        };
        await checkCast();
        assert.equal(await cast.getByText("Skipped Director").count(), 0);
        assert.ok(await cast.getByText("Avery Vale").locator("..").locator("img").getAttribute("src"));
        assert.equal(await cast.getByText("Morgan Lee").locator("..").locator(".movie-cast-portrait").textContent(), "ML");
        assert.equal(await series.getByRole("img", {name: "Age rating 16", exact: true}).textContent(), "16");
        assert.equal(await series.getByText("Mystery", {exact: true}).count(), 1);

        const favorite = series.getByRole("button", {name: "My list: Night Signal"});
        await page.keyboard.press("Tab");
        const continueEpisode = series.getByRole("button", {name: "Continue S1 E1 from 13:48", exact: true});
        assert.equal(await focused(continueEpisode), true);
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
        const layout = () => series.evaluate(node => {
            const rect = selector => {
                const {x, y, width, height} = node.querySelector(selector).getBoundingClientRect();
                return [x, y, width, height];
            };
            return {height: document.documentElement.scrollHeight, list: rect(".movie-season-list"),
                picker: rect(".movie-season-picker"), info: rect(".movie-show-info")};
        });
        await page.evaluate(() => { window.slowDetailSeason = 2; });
        const before = await layout();
        await page.keyboard.press("Space");
        const skeleton = series.locator(".movie-episode-loading");
        await skeleton.waitFor();
        assert.deepEqual(await layout(), before);
        assert.equal(await focused(season(2)), true);
        const loading = series.getByRole("status").filter({hasText: "Loading episodes"});
        assert.equal(await loading.count(), 1);
        assert.equal(await loading.evaluate(node => getComputedStyle(node).clipPath), "inset(50%)");
        assert.equal(await skeleton.locator(".movie-episode-body").first().locator(".movie-loading-block").count(), 4);
        const shimmer = skeleton.locator(".movie-loading-block").first();
        assert.equal(await shimmer.evaluate(node => getComputedStyle(node).animationName),
            options.reducedMotion === "reduce" ? "none" : "movie-episode-shimmer");
        await page.evaluate(() => { document.body.dataset.effects = "off"; });
        assert.equal(await shimmer.evaluate(node => getComputedStyle(node).animationName), "none");
        await page.evaluate(() => { delete document.body.dataset.effects; window.finishDetailSeason(); });
        await series.getByRole("button", {name: "1. Return"}).waitFor();
        await skeleton.waitFor({state: "detached"});
        await series.getByRole("status").filter({hasText: "1 episode loaded"}).waitFor({state: "attached"});
        assert.equal(await focused(season(2)), true);
        assert.equal(await season(2).getAttribute("aria-pressed"), "true");
        assert.notEqual(await outline.evaluate(node => node.style.transform), oldOffset);
        assert.equal(await series.getByRole("button", {name: "Play", exact: true}).isVisible(), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(season(1)), true);
        await page.keyboard.press("Enter");
        const episode = series.getByRole("button", {name: "Pilot, 30% watched", exact: true});
        await episode.waitFor();
        assert.equal(await focused(season(1)), true);
        const checkTargets = async target => {
            for (const control of [season(1), episode]) {
                const size = await control.evaluate(node => Math.min(node.offsetWidth, node.offsetHeight));
                assert.ok(size >= target, `${profile}: ${size}px target, expected at least ${target}px`);
            }
        };
        await checkTargets(options.viewport.width >= 1600 ? 60 : 44);
        assert.equal(await episode.locator(".movie-release-quality").getAttribute("data-level"), "web");
        assert.equal(await episode.locator(".movie-episode-overview").textContent(), "The crew receives a radio signal.");
        assert.equal(await episode.locator(".movie-episode-facts > span").textContent(), "46 min");
        assert.equal(await episode.evaluate(node => {
            const card = node.getBoundingClientRect();
            const quality = node.querySelector(".movie-release-quality").getBoundingClientRect();
            const text = node.querySelector(".movie-episode-text").getBoundingClientRect();
            const progress = node.querySelector("progress").getBoundingClientRect();
            return quality.top >= card.top && quality.top - card.top < 12 && card.right - quality.right < 12 &&
                Math.abs(text.width - progress.width) < 1;
        }), true);
        const badges = series.locator(".movie-episode-body > .movie-release-quality");
        assert.deepEqual(await badges.evaluateAll(nodes => nodes.slice(0, 5).map(node => [node.textContent, node.dataset.level])), [
            ["1080p", "web"], ["720p", "hd"], ["4K", "4k-web"], ["4K HDR", "4k-remux"], ["4K Dolby Vision", "4k-remux"]
        ]);
        const back = series.getByRole("button", {name: "Back to titles", exact: true});
        assert.equal(await back.getAttribute("title"), null);
        await page.getByRole("button", {name: /Downloads, .* needs attention/}).waitFor();
        assert.equal(await series.getByText("Adding Hungarian audio to Signal 2").count(), 0);
        assert.equal(await series.getByText("Adding Hungarian audio to Signal 3").count(), 0);
        assert.equal(await series.getByText("Choose a different source from the library video.").count(), 0);
        assert.deepEqual(await series.locator(".movie-hero-art").evaluate(art => {
            const backdrop = art.getBoundingClientRect();
            const section = art.closest(".movie-show-detail").getBoundingClientRect();
            return [backdrop.top - section.top, backdrop.left, innerWidth - backdrop.right,
                getComputedStyle(art).borderRadius];
        }), [0, 0, 0, "0px"], `${profile}: series backdrop geometry`);

        const desktop = options.viewport.width >= 1280;
        if (desktop) {
            const scroll = series.getByRole("region", {name: "Episodes and related series"});
            assert.match(await outline.evaluate(node => getComputedStyle(node).transitionProperty), /transform/);
            for (const [width, height] of [[1280, 720], [1920, 1080], [2000, 1080], [2560, 1440], [2560, 850], [3840, 850]]) {
                await page.setViewportSize({width, height});
                await checkTargets(width >= 1600 ? 60 : 44);
                await actors.evaluate(list => new Promise(resolve => {
                    const resize = new ResizeObserver(() => { resize.disconnect(); resolve(); });
                    resize.observe(list);
                }));
                await checkCast();
                const layout = await related.evaluate(node => {
                    const host = node.closest("main");
                    const root = document.scrollingElement;
                    return {
                        hostOverflow: host.scrollHeight - host.clientHeight,
                        documentOverflow: root.scrollHeight - root.clientHeight,
                        hostTop: host.scrollTop, documentTop: root.scrollTop
                    };
                });
                assert.ok(layout.hostOverflow <= 1 && layout.documentOverflow <= 1 &&
                    layout.hostTop === 0 && layout.documentTop === 0, `${profile} ${width}x${height} ${JSON.stringify(layout)}`);
                assert.equal(await scroll.evaluate(node => node.scrollHeight > node.clientHeight &&
                    getComputedStyle(node).scrollbarWidth === "none" && node.contains(node.querySelector('[data-format="related"]'))), true);
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
                        for (const actor of [...list.children].filter(actor => !actor.hidden)) {
                            const box = actor.getBoundingClientRect();
                            if (!fits(box)) {
                                clipped.push(actor.querySelector("strong").textContent);
                            }
                        }
                        return clipped;
                    });
                    assert.deepEqual(clipped, [], `${profile} ${width}x${height} clipped series info`);
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
            await scroll.evaluate(node => { node.scrollTop = 0; });
            await page.waitForFunction(node => node.hasAttribute("data-more-below"), await scroll.elementHandle());
            await scroll.press("End");
            await page.waitForFunction(node => node.scrollTop > 0 && !node.hasAttribute("data-more-below"), await scroll.elementHandle());
            assert.equal(await related.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight + 1), true);
            await scroll.evaluate(node => { node.scrollTop = 0; });
            await episode.hover();
            await page.waitForFunction(node => {
                const style = getComputedStyle(node);
                return style.transform !== "none" && new DOMMatrix(style.transform).a > 1.02 &&
                    style.outlineColor === "rgb(255, 255, 255)";
            }, await episode.elementHandle());
        } else {
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, profile);
        }
        await page.getByRole("button", {name: /Downloads, .* needs attention/}).press("Enter");
        const downloads = page.getByRole("dialog", {name: "Downloads", exact: true});
        await downloads.getByText("Choose a different source from the library video.").waitFor();
        await downloads.getByRole("button", {name: "Choose another source", exact: true}).press("Enter");
        const audio = page.getByRole("dialog", {name: "Add audio track", exact: true});
        await audio.getByText("Signal 2", {exact: true}).waitFor();
        await audio.getByRole("button", {name: "Close", exact: true}).press("Enter");
        await downloads.getByRole("button", {name: "Close", exact: true}).press("Enter");
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
        assert.equal(await noCast.getByRole("button", {name: "Continue S1 E1 from 13:48", exact: true}).isVisible(), true);
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
        await noCast.getByRole("button", {name: "Back to titles", exact: true}).press("Enter");
        assert.equal(await focused(quietPort), true);
    } finally {
        await context.close();
    }
}

reviewMovieProfiles(check).catch(error => { console.error(error); process.exitCode = 1; });
