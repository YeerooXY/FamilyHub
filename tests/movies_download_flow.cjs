const assert = require("node:assert/strict");
const {cors, jellyfin, moviePage, verifyMovieProfiles} = require("./movies_fixture.cjs");

const movie = "Harbor Night", show = "Snow Line";
const filmRelease = "Harbor.Night.2025.1080p.WEB-DL.DDP5.1";
const seasonRelease = "Snow.Line.S02.1080p.WEB-DL";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#344466"/></svg>';
const picture = "data:image/svg+xml," + encodeURIComponent(svg);
const held = "https://art.test/film-backdrop.svg";
const focused = locator => locator.evaluate(node => node === document.activeElement);

async function openFixture(page) {
    await moviePage(page, {shell: true, nested: true});
    const owned = new Set();
    await page.route(jellyfin + "/**", route => {
        if (route.request().method() === "OPTIONS") return route.fulfill({status: 204, headers: cors});
        const url = new URL(route.request().url());
        const name = url.searchParams.get("searchTerm");
        const items = owned.has(name) ? [{
            Id: name === movie ? "film" : "series", Name: name, Type: name === movie ? "Movie" : "Series",
            ProductionYear: 2025, ProviderIds: {Tmdb: name === movie ? 71 : 72}
        }] : owned.has(show) && url.pathname === "/Shows/series/Episodes" ? [{
            Id: "episode", Name: "The crossing", IndexNumber: 1, ParentIndexNumber: 2, Type: "Episode"
        }] : [];
        return route.fulfill({headers: cors, json: {Items: items, TotalRecordCount: items.length}});
    });
    await page.clock.install();
    await page.evaluate(async ({jellyfin, movie, show, filmRelease, seasonRelease, picture, held}) => {
        const {openMovies, saveMoviePreferences} = await import("/movies.js");
        const base = jellyfin + "/";
        saveMoviePreferences({server: base}, {screen: "1080"});
        window.queue = [];
        window.requests = [];
        let filmVisits = 0;
        window.movieView = window.openMovieFixture(openMovies, document.querySelector(".movie-library"), {
            url: base, user: "fixture", token: "fixture", device: "fixture",
            downloads_enabled: true, release_search_enabled: true
        }, {invokeMethodAsync: async (method, ...args) => {
            window.requests.push([method, ...args]);
            const series = args[0]?.startsWith?.(show) || args[0] === "tv";
            const title = series ? show : movie;
            const identity = {title, year: 2025, kind: series ? "tv" : "movie", official_rating: "12",
                tmdb_id: series ? 72 : 71, season: series ? 2 : undefined, episode_count: series ? 2 : undefined};
            const release = (title, size, guid) => ({title, size, seeders: 50, guid, indexerId: 1});
            const answers = {
                MovieDownloads: {available: true, items: window.queue},
                MovieMatches: args[0]?.startsWith?.("tmdb:tv:") ? {series_id: 72, seasons: [{number: 2, episode_count: 2}]} :
                    {matches: [{id: identity.tmdb_id, title, year: 2025, kind: identity.kind, poster: picture}]},
                MovieReleaseSearch: {title_details: identity, results: series ? [release(seasonRelease, 5 * 1024 ** 3, "season")] : [
                    release(filmRelease, 5 * 1024 ** 3, "film"),
                    release("Harbor Night 2025 1080p BluRay", 15 * 1024 ** 3, "medium"),
                    release("Harbor Night 2025 1080p Remux", 30 * 1024 ** 3, "large"),
                    ...[10, 30, 60, 61].map(minutes => release("Harbor Night 2025 720p WEB-DL " + minutes,
                        minutes * 60 * 100e6 / 8, "time-" + minutes))
                ]},
                MovieTitleDetails: {title, poster: picture, backdrop: series ? picture : held, logo: picture,
                    genres: ["Adventure"], overview: "A crew crosses the harbor.", cast: [{name: "Sam Bell", portrait: picture}]},
                MovieRelated: {matches: [{id: 73, title: "Harbor Morning", poster: picture}]},
                MovieSeasonEpisodes: {episodes: [{number: 1, name: "The crossing", still: picture}, {number: 2, name: "High ground", still: picture}]},
                MovieDownload: {state: "sent"}
            };
            if (method === "MovieTitleDetails" && !series) answers.MovieTitleDetails.backdrop = held + "?visit=" + ++filmVisits;
            return JSON.stringify(answers[method] ?? {results: []});
        }});
    }, {jellyfin, movie, show, filmRelease, seasonRelease, picture, held});
    return name => owned.add(name);
}

async function search(page, name) {
    const input = page.getByRole("searchbox", {name: "Search movies and TV"});
    await input.fill(name);
    await input.press("Enter");
    const rows = page.locator(".movie-release");
    await rows.first().waitFor();
    return rows;
}

async function verify(browser, profile, options) {
    const viewport = profile.endsWith("-1280") ? {width: 1280, height: 720} : options.viewport;
    const page = await browser.newPage({...options, viewport});
    const reduced = profile.endsWith("-1280") || profile.endsWith("iphone13");
    const effectsOff = profile.endsWith("pixel7");
    await page.emulateMedia({reducedMotion: reduced ? "reduce" : "no-preference"});
    const pendingImages = new Map();
    const waitingForImage = new Map();
    const holdImage = visit => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The backdrop request did not reach the fixture.")), 6000);
        waitingForImage.set(held + "?visit=" + visit, () => { clearTimeout(timeout); resolve(); });
    });
    try {
        const makeOwned = await openFixture(page);
        if (effectsOff) await page.evaluate(() => { document.body.dataset.effects = "off"; });
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        await page.route(url => url.href.startsWith(held + "?visit="), async route => {
            await new Promise(resolve => {
                const url = route.request().url();
                pendingImages.set(url, resolve);
                waitingForImage.get(url)?.();
            });
            await route.fulfill({contentType: "image/svg+xml", body: svg}).catch(() => {});
        });
        const rows = await search(page, movie);
        const metric = (name, value) => rows.locator(".movie-release-" + name + " .movie-release-stat-value").filter({hasText: value});
        for (const [value, color] of [["5.0 GB", "green"], ["15.0 GB", "amber"], ["30.0 GB", "orange"]])
            assert.equal(await metric("size", new RegExp("^" + value + "$")).evaluate((el, color) => el.classList.contains("movie-release-cost-" + color), color), true);
        for (const [value, color] of [["about 10 min", "green"], ["about 30 min", "amber"], ["about 1 h", "orange"], ["about 1 h 1 min", "red"]])
            assert.equal(await metric("time", new RegExp("^" + value + "$")).evaluate((el, color) => el.classList.contains("movie-release-cost-" + color), color), true);
        const row = rows.filter({hasText:"DDP 5.1"}), download = row.getByRole("button", {name: /^Download/});
        const dialog = page.getByRole("dialog", {name: "Confirm download"});
        const confirm = dialog.getByRole("button", {name: "Download", exact: true});
        const cancel = dialog.getByRole("button", {name: "Cancel"});
        const sound = dialog.getByRole("switch", {name: "Hungarian audio"});
        const subs = dialog.getByRole("switch", {name: "Hungarian subtitles"});
        await download.click();
        await dialog.waitFor();
        assert.equal(await focused(confirm), true);
        assert.equal(await sound.isChecked(), false);
        assert.equal(await subs.isChecked(), true);
        assert.equal(await dialog.getByRole("switch").count(), 2);
        assert.equal(await dialog.getByText("Added automatically", {exact: true}).isVisible(), true);
        assert.equal(await dialog.getByRole("img", {name: "Rated 12"}).isVisible(), true);
        const layout = await dialog.evaluate(panel => {
            const style = getComputedStyle(panel);
            const sections = panel.querySelectorAll(".movie-confirm-summary, .movie-confirm-option, .movie-confirm-buttons");
            return {
                filter: style.filter,
                backdropFilter: style.getPropertyValue("backdrop-filter") || style.getPropertyValue("-webkit-backdrop-filter"),
                titleSize: parseFloat(getComputedStyle(panel.querySelector(".movie-confirm-title")).fontSize),
                innerWidth: panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                widths: [...sections].map(section => [section.className, section.offsetWidth]),
                buttons: [...panel.querySelectorAll(".movie-confirm-buttons button")].map(button => {
                    const {x, width, height} = button.getBoundingClientRect();
                    return {x, width, height};
                }),
                options: [...panel.querySelectorAll(".movie-confirm-option")].map(option => {
                    const row = option.getBoundingClientRect();
                    const toggle = option.querySelector(".movie-confirm-switch").getBoundingClientRect();
                    return {
                        height: row.height,
                        fontSize: getComputedStyle(option).fontSize,
                        rightInset: row.right - toggle.right,
                        centerOffset: toggle.top + toggle.height / 2 - (row.top + row.height / 2)
                    };
                })
            };
        });
        assert.equal(layout.filter, "none", `${profile} panel filter`);
        if (layout.backdropFilter) assert.equal(layout.backdropFilter, "none", `${profile} panel backdrop filter`);
        if (viewport.width >= 1280) assert.ok(layout.titleSize >= 32, `${profile} title: ${layout.titleSize}px`);
        assert.equal(layout.options.length, 3);
        assert.equal(layout.widths.length, 5);
        for (const [section, width] of layout.widths) {
            assert.ok(width >= layout.innerWidth * .95, `${profile} ${section}: ${width}px of ${layout.innerWidth}px`);
        }
        for (const [index, option] of layout.options.entries()) {
            const message = `${profile} option ${index + 1}`;
            assert.ok(Math.abs(option.height - layout.options[0].height) <= 1, `${message} row height`);
            assert.equal(option.fontSize, layout.options[0].fontSize, `${message} label size`);
            assert.ok(option.rightInset >= 0 && option.rightInset <= 40, `${message} switch right inset`);
            assert.ok(Math.abs(option.centerOffset) <= 1, `${message} switch vertical center`);
        }
        const [cancelBox, confirmBox] = layout.buttons;
        assert.ok(cancelBox.x < confirmBox.x);
        assert.ok(Math.abs(cancelBox.width - confirmBox.width) < 1);
        assert.ok(Math.abs(cancelBox.height - confirmBox.height) < 1, "buttons share a height (measured during the spring)");
        assert.ok(confirmBox.height >= (viewport.width >= 1600 ? 60 : 44));
        if (reduced || effectsOff) assert.equal(await dialog.evaluate(node => getComputedStyle(node).animationName), "none");
        assert.equal(await fits(), true);
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        for (const action of [sound, subs, cancel, confirm]) {
            await page.keyboard.press("Tab");
            assert.equal(await focused(action), true);
        }
        for (const action of [cancel, subs, sound, confirm]) {
            await page.keyboard.press("Shift+Tab");
            assert.equal(await focused(action), true);
        }
        await sound.press("Space");
        await subs.press("Space");
        await page.keyboard.press("Escape");
        await dialog.waitFor({state: "hidden"});
        assert.equal(await focused(download), true);
        await page.keyboard.press("Enter");
        await confirm.waitFor();
        assert.equal(await sound.isChecked(), true);
        assert.equal(await subs.isChecked(), false);
        await page.evaluate(() => {
            window.bodyReceivedFocus = false;
            window.watchHandoffFocus = new MutationObserver(() => {
                window.bodyReceivedFocus ||= document.activeElement === document.body;
            });
            window.watchHandoffFocus.observe(document.body, {attributes: true, childList: true, subtree: true});
        });
        await Promise.all([holdImage(1), confirm.press("Enter")]);
        const film = page.locator(".movie-film-detail"), play = film.locator(".movie-hero-play");
        assert.equal(await film.isVisible(), false);
        assert.equal(await focused(confirm), true);
        await page.evaluate(name => { window.queue = [{name, progress: .42, state: "Downloading"}]; }, filmRelease);
        pendingImages.get(held + "?visit=1")();
        await film.waitFor();
        assert.equal(await focused(play), true);
        assert.equal(await page.evaluate(() => {
            window.watchHandoffFocus.disconnect();
            return window.bodyReceivedFocus;
        }), false);
        assert.deepEqual(await page.evaluate(() => requests.find(([method]) => method === "MovieDownload")),
            ["MovieDownload", "film", 1, filmRelease, true, false]);
        await page.clock.fastForward(3200);
        await play.getByText("42%", {exact: true}).waitFor();
        assert.equal(await play.getAttribute("data-downloading"), "");
        assert.equal(await fits(), true);

        await film.getByRole("button", {name: "Back to titles"}).click();
        await page.getByRole("searchbox").press("Escape");
        const downloading = page.getByRole("region", {name: "Downloading"}).getByRole("button", {name: /Harbor Night/});
        await downloading.waitFor();
        assert.equal(await fits(), true);
        await Promise.all([holdImage(2), downloading.press("Enter")]);
        assert.equal(await film.isVisible(), false);
        assert.equal(await focused(downloading), true);
        await page.clock.fastForward(4005);
        await film.waitFor();
        pendingImages.get(held + "?visit=2")?.();
        assert.equal(await focused(play), true);
        makeOwned(movie);
        await page.evaluate(name => { window.queue = [{name, progress: 1, state: "Finished", fetching: ["Hungarian audio"]}]; }, filmRelease);
        await page.clock.fastForward(5000);
        await play.getByText("Play", {exact: true}).waitFor();
        await film.getByText("Fetching Hungarian audio", {exact: true}).waitFor();
        assert.equal(await focused(play), true);
        assert.equal(await play.getAttribute("data-downloading"), null);

        await film.getByRole("button", {name: "Back to titles"}).click();
        await search(page, show + " S02");
        await page.locator(".movie-release-action").first().click();
        await confirm.press("Enter");
        const seriesPage = page.locator(".movie-show-detail");
        await seriesPage.waitFor();
        const pill = seriesPage.getByRole("button", {name: "Season 2", exact: true});
        assert.equal(await focused(pill), true);
        assert.equal(await pill.getAttribute("data-downloading"), "");
        await seriesPage.locator('li[data-episode-state="downloading"]').first().waitFor();
        makeOwned(show);
        await page.evaluate(name => { window.queue = [{name, progress: 1, state: "Finished"}]; }, seasonRelease);
        await page.clock.fastForward(3200);
        await seriesPage.locator('li[data-episode-state="ready"] .movie-episode-download-icon svg').waitFor();
        assert.equal(await pill.getAttribute("data-downloading"), null);
        assert.equal(await focused(pill), true);
        assert.equal(await fits(), true);
    } finally {
        for (const release of pendingImages.values()) release();
        await page.close();
    }
}

verifyMovieProfiles(verify).catch(error => { console.error(error); process.exitCode = 1; });
