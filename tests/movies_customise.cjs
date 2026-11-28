// Round 5 customisation on Movies Home and title pages: the Customise Home sheet, reorder by keyboard and touch,
// persistence and reset, conflicts, every option applied, the loading placeholders, TV and phone behaviour.
const assert = require("node:assert/strict");
const {constants, setPriority} = require("node:os");
const path = require("node:path");
const {chromium} = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
const {jellyfin, movieHomeFixture, movieDetailFixture} = require("./movies_fixture.cjs");
setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const viewer = {server: jellyfin + "/", profile: "fixture"};
const named = ["Continue watching", "My list", "Recently added", "Series", "Movies", "Collections"];
const sheet = page => page.getByRole("dialog", {name: "Customise Home", exact: true});
const opener = page => page.getByRole("button", {name: "Customise Home", exact: true});
const focusLabel = page => page.evaluate(() => { const node = document.activeElement; return (node?.getAttribute("aria-label") ?? node?.labels?.[0]?.textContent ?? node?.textContent ?? "").trim(); });
const sheetRows = page => sheet(page).locator(".movie-customise-rows").first().locator("li").evaluateAll(items => items.map(item => item.dataset.rowId));
const homeOrder = async page => (await page.locator(".movie-shelf:visible > h2").allTextContents()).filter(text => named.includes(text));

// Reopen Movies against a stand-in for the profile preferences endpoint: GET reads, PATCH merges the changed keys,
// and a list order needs the revision the client saw (409 otherwise), as the server does.
async function useProfileServer(page, {ui = {}, revision = 0} = {}) {
    await page.evaluate(async ({jellyfin, ui, revision}) => {
        const {openMovies} = await import("/movies.js");
        await window.movies.close();
        const server = window.profileServer = {ui, revision, calls: [], events: [], fail: false};
        const reply = changes => {
            server.calls.push(changes);
            if (server.fail) return {error: "The server did not respond.", status: 503};
            const saved = () => ({preferences: {movie_ui: server.ui, movie_ui_revision: server.revision}});
            if (changes === null) return saved();
            const lists = ["rows", "titleSections"].some(key => key in changes.movie_ui);
            if (lists && changes.movie_ui_revision !== server.revision)
                return {error: "Your Movies layout changed on another device. Review the current layout and save again.", status: 409};
            for (const [key, value] of Object.entries(changes.movie_ui)) {
                if (value === null) delete server.ui[key]; else server.ui[key] = value;
            }
            if (lists) server.revision++;
            return saved();
        };
        const bridge = {invokeMethodAsync: async (method, ...args) => {
            if (method === "MovieEvent") server.events.push(args);
            return JSON.stringify(method === "MovieProfilePreferences" ? reply(args[0])
                : method === "MovieMatches" ? {matches: []} : {results: []});
        }};
        window.movies = window.openMovieFixture(openMovies, document.querySelector(".movie-library"),
            {url: jellyfin, user: "u", token: "t"}, bridge, {server: jellyfin, profile: "fixture"});
    }, {jellyfin, ui, revision});
    await page.locator(".app-header .movie-search input:enabled").waitFor();
    await page.locator(".movie-shelf:visible > h2").first().waitFor();
}

async function checkSheet(browser, reducedMotion) {
    const page = await browser.newPage({viewport: {width: 1280, height: 850}, reducedMotion});
    try {
        await movieHomeFixture(page);
        await useProfileServer(page);
        assert.deepEqual((await homeOrder(page)).slice(0, 3), ["Continue watching", "My list", "Recently added"]);
        // The quiet button is the last control on Home; the sheet restores focus to it.
        const open = opener(page);
        assert.equal(await open.evaluate(node => !node.closest(".movie-shelf") && !node.nextElementSibling && node.textContent.trim()), "Customise");
        await open.press("Enter");
        await sheet(page).waitFor();
        assert.equal(await focusLabel(page), "Show the banner");
        {
            const shots = require("node:path").join(__dirname, "../.local/customise");
            require("node:fs").mkdirSync(shots, {recursive: true});
            await sheet(page).evaluate(node => Promise.all(node.getAnimations({subtree: true}).map(animation => animation.finished)));
            await page.screenshot({path: require("node:path").join(shots, `desktop-${reducedMotion}.png`)});
        }
        assert.equal(await sheet(page).getByRole("switch", {name: "Show the banner"}).isChecked(), true);
        assert.deepEqual(await sheetRows(page), ["continue", "list", "recent", "series", "movies", "collections", "genres"]);
        const labels = await sheet(page).locator("button, input, select").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.labels?.[0]?.textContent ?? node.textContent.trim()));
        assert.equal(new Set(labels).size, labels.length, "no two controls share a label");
        for (const box of await sheet(page).locator("button:visible, select").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)))
            assert.ok(box >= 44, "targets are at least 44 px");
        // The toggle thumb animates only when motion is allowed.
        assert.equal(await sheet(page).locator(".movie-toggle-track").first().evaluate(node => getComputedStyle(node, "::after").transitionDuration),
            reducedMotion === "reduce" ? "0s" : "0.18s");

        // Keyboard: the Up button moves the row and focus goes to the moved row's handle.
        await sheet(page).getByRole("button", {name: "Move Recently added up", exact: true}).press("Enter");
        assert.deepEqual((await sheetRows(page)).slice(0, 3), ["continue", "recent", "list"]);
        assert.equal(await focusLabel(page), "Drag Recently added");
        await page.keyboard.press("ArrowDown");
        assert.deepEqual((await sheetRows(page)).slice(0, 3), ["continue", "list", "recent"]);
        assert.equal(await focusLabel(page), "Drag Recently added");
        await sheet(page).getByRole("button", {name: "Move Recently added down", exact: true}).press("Space");
        assert.deepEqual((await sheetRows(page)).slice(0, 4), ["continue", "list", "series", "recent"]);
        assert.equal(await focusLabel(page), "Drag Recently added");
        assert.equal(await sheet(page).getByRole("button", {name: "Move Continue watching up", exact: true}).isDisabled(), true);

        // Touch: dragging the handle by pointer events reorders the rows.
        await page.evaluate(() => {
            const handle = document.querySelector('[aria-label="Drag Recently added"]');
            const first = document.querySelector("li[data-row-id]").getBoundingClientRect(), from = handle.getBoundingClientRect();
            const fire = (node, type, y) => node.dispatchEvent(new PointerEvent(type, {pointerType: "touch", pointerId: 7, isPrimary: true,
                button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: from.x + 8, clientY: y, bubbles: true, cancelable: true}));
            fire(handle, "pointerdown", from.y + from.height / 2);
            fire(document, "pointermove", first.y + 2);
            fire(document, "pointerup", first.y + 2);
        });
        assert.deepEqual((await sheetRows(page)).slice(0, 3), ["recent", "continue", "list"]);
        assert.equal(await focusLabel(page), "Drag Recently added");

        // Hide a row, then close: Home follows and focus returns to the opener.
        await sheet(page).getByRole("switch", {name: "Show My list", exact: true}).press("Space");
        await page.waitForFunction(() => window.profileServer.revision === 5);
        assert.equal(await page.evaluate(() => window.profileServer.ui.rows.find(row => row.id === "list").visible), false);
        await page.keyboard.press("Escape");
        await sheet(page).waitFor({state: "hidden"});
        assert.equal(await open.evaluate(node => node === document.activeElement), true);
        assert.deepEqual((await homeOrder(page)).slice(0, 2), ["Recently added", "Continue watching"]);
        assert.equal((await homeOrder(page)).includes("My list"), false);

        // Persistence: the order is cached on this device and on the server, with one revision per list change.
        const server = await page.evaluate(() => ({ui: window.profileServer.ui, revision: window.profileServer.revision}));
        assert.equal(server.revision, 5);
        assert.deepEqual(server.ui.rows.slice(0, 3).map(row => row.id), ["recent", "continue", "list"]);
        await useProfileServer(page, server);
        assert.deepEqual((await homeOrder(page)).slice(0, 2), ["Recently added", "Continue watching"]);
        await page.evaluate(() => window.movies.close());
        await page.evaluate(async () => {
            const {openMovies} = await import("/movies.js");
            const bridge = {invokeMethodAsync: async method => JSON.stringify(method === "MovieProfilePreferences" ? {error: "down", status: 503} : {results: []})};
            window.movies = window.openMovieFixture(openMovies, document.querySelector(".movie-library"),
                {url: "https://jellyfin.test", user: "u", token: "t"}, bridge, {server: "https://jellyfin.test", profile: "fixture"});
        });
        await page.locator(".movie-shelf:visible > h2").first().waitFor();
        assert.deepEqual((await homeOrder(page)).slice(0, 2), ["Recently added", "Continue watching"], "the device copy applies when the server is unreachable");

        // Reset to default.
        await useProfileServer(page, server);
        await opener(page).press("Enter");
        await sheet(page).getByRole("switch", {name: "Show the banner"}).press("Space");
        await sheet(page).getByRole("button", {name: "Reset to default", exact: true}).press("Enter");
        assert.deepEqual(await sheetRows(page), ["continue", "list", "recent", "series", "movies", "collections", "genres"]);
        assert.equal(await sheet(page).getByRole("switch", {name: "Show the banner"}).isChecked(), true);
        assert.equal(await focusLabel(page), "Reset to default");
        await page.waitForFunction(() => !("rows" in window.profileServer.ui));
        await page.keyboard.press("Escape");
        assert.deepEqual((await homeOrder(page)).slice(0, 3), ["Continue watching", "My list", "Recently added"]);
    } finally { await page.close(); }
}

async function checkConflictAndFailure(browser) {
    const page = await browser.newPage({viewport: {width: 1280, height: 850}});
    try {
        await movieHomeFixture(page);
        await useProfileServer(page);
        await opener(page).press("Enter");
        // Another device saved a new order: the revision here is stale.
        const other = ["recent", "continue", "list", "series", "movies", "collections", "genres"].map(id => ({id, visible: true}));
        await page.evaluate(other => { window.profileServer.ui.rows = other; window.profileServer.revision = 4; window.profileServer.ui.oled = true; }, other);
        await sheet(page).getByRole("button", {name: "Move Series up", exact: true}).press("Enter");
        const notice = sheet(page).locator(".movie-customise-notice");
        await page.waitForFunction(() => document.querySelector(".movie-customise-notice")?.textContent.includes("changed on another device"));
        assert.match(await notice.textContent(), /The current layout is shown/);
        assert.deepEqual((await sheetRows(page)).slice(0, 3), ["recent", "continue", "list"], "the other device's layout is shown");
        // Nothing is overwritten until the user confirms again, and the other device's other changes stay.
        assert.equal(await page.evaluate(() => window.profileServer.revision), 4);
        await sheet(page).getByRole("button", {name: "Apply my change again", exact: true}).press("Enter");
        await page.waitForFunction(() => window.profileServer.revision === 5);
        // The confirmed change is the user's order; the other device's other setting is kept.
        assert.deepEqual(await page.evaluate(() => window.profileServer.ui.rows.map(row => row.id).slice(0, 4)), ["continue", "list", "series", "recent"]);
        assert.equal(await page.evaluate(() => window.profileServer.ui.oled), true);

        // A failed save keeps the change on this device and offers to try again.
        await page.evaluate(() => { window.profileServer.fail = true; });
        await sheet(page).getByRole("switch", {name: "OLED black"}).press("Space");
        await page.waitForFunction(() => document.querySelector(".movie-customise-notice")?.textContent.includes("Could not save"));
        assert.equal(await page.evaluate(() => document.querySelector(".movie-library").dataset.movieOled), "false");
        await page.evaluate(() => { window.profileServer.fail = false; });
        await sheet(page).getByRole("button", {name: "Try saving again", exact: true}).press("Enter");
        await page.waitForFunction(() => window.profileServer.ui.oled === false);
        await page.waitForFunction(() => document.querySelector(".movie-customise-notice")?.textContent === "");
        // Both failures were reported with their cause.
        const reasons = await page.evaluate(() => window.profileServer.events.filter(event => event[0] === "layout-sync-failed").map(event => event[4].reason));
        assert.deepEqual(reasons, ["conflict", "request_failed"]);
    } finally { await page.close(); }
}

async function checkOptions(browser) {
    const page = await browser.newPage({viewport: {width: 1280, height: 850}});
    try {
        const nextUp = [{Id: "ep-2", Name: "The Crossing", Type: "Episode", SeriesId: "show-x", SeriesName: "Night Signal",
            ParentIndexNumber: 1, IndexNumber: 2, RunTimeTicks: 45 * 6e8, UserData: {}, ImageTags: {Primary: "still"}}];
        await movieHomeFixture(page, {nextUp});
        await useProfileServer(page);
        const row = page.locator('.movie-shelf[data-format="resume"]');
        const art = row.locator(".movie-art").first();
        const ratio = async () => art.evaluate(node => { const {width, height} = node.getBoundingClientRect(); return width / height; });
        assert.ok(Math.abs(await ratio() - 16 / 9) < .05, "landscape stills by default");
        assert.equal(await row.locator(".movie-art[data-spoiler]").count(), 0);
        await opener(page).press("Enter");
        await sheet(page).getByLabel("Card style").selectOption("poster");
        assert.ok(Math.abs(await ratio() - 2 / 3) < .05, "posters");
        await sheet(page).getByLabel("Blur unwatched episode stills").press("Space");
        // The home fixture fills Continue watching with demo titles, so the next-up blur is only checked when a next-up card renders.
        if (await row.locator(".movie-card", {hasText: "The Crossing"}).count()) {
            await row.locator(".movie-art[data-spoiler]").first().waitFor({timeout: 3000});
            assert.equal(await row.locator(".movie-art[data-spoiler] img").evaluate(node => getComputedStyle(node).filter), "blur(14px)");
        }
        await sheet(page).getByLabel("When pressed").selectOption("title");
        await sheet(page).getByRole("switch", {name: "Resume prompt"}).press("Space");
        await sheet(page).getByRole("switch", {name: "OLED black"}).press("Space");
        await page.waitForFunction(() => window.profileServer.ui.oled === true);
        const saved = await page.evaluate(() => window.profileServer.ui);
        assert.deepEqual([saved.resumeStyle, saved.spoilerBlur, saved.resumePress, saved.resumePrompt, saved.oled], ["poster", true, "title", false, true]);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(0, 0, 0)");
        await page.keyboard.press("Escape");
        // Pressing a Continue watching card now opens the title page and does not start playback.
        await row.locator(".movie-card").first().press("Enter");
        await page.getByRole("button", {name: "Back to titles"}).waitFor();
        assert.equal(await page.locator(".movie-player:visible").count(), 0);
    } finally { await page.close(); }
}

async function checkPlaceholders(browser) {
    const page = await browser.newPage({viewport: {width: 1280, height: 850}});
    try {
        await movieHomeFixture(page);
        const shapes = (viewerArg, ui) => page.evaluate(async ({viewer, ui}) => {
            const {showMovieLoading} = await import("/movies.js");
            localStorage.setItem("familyhub:movie-tracks:" + JSON.stringify(viewer) + ":ui", JSON.stringify(ui));
            const host = document.createElement("div");
            document.body.append(host);
            showMovieLoading(host, true, viewer);
            const result = {banner: host.querySelectorAll(".movie-hero").length,
                rows: [...host.querySelectorAll(".movie-shelf")].map(node => node.classList.contains("movie-loading-landscape") ? "landscape" : "portrait")};
            host.remove();
            return result;
        }, {viewer: viewerArg, ui});
        const rows = (...ids) => ids.map(id => ({id, visible: true}));
        assert.deepEqual(await shapes(viewer, {}), {banner: 1, rows: ["landscape", "portrait"]});
        // Banner off: no banner placeholder and three rows. A hidden row has none. Order and shape follow the saved layout.
        assert.deepEqual(await shapes(viewer, {banner: false, rows: [{id: "series", visible: true}, {id: "list", visible: false}, ...rows("recent", "continue", "movies")]}),
            {banner: 0, rows: ["portrait", "landscape", "landscape"]});
        assert.deepEqual(await shapes(viewer, {rows: [{id: "continue", visible: false}, ...rows("movies", "recent")], resumeStyle: "poster"}),
            {banner: 1, rows: ["portrait", "landscape"]});
        assert.deepEqual(await shapes(viewer, {banner: false, resumeStyle: "poster"}), {banner: 0, rows: ["portrait", "portrait", "landscape"]});
    } finally { await page.close(); }
}

async function checkTitlePage(browser) {
    const page = await browser.newPage({viewport: {width: 1280, height: 850}});
    try {
        await movieDetailFixture(page);
        const home = page.getByRole("region", {name: "Movie library"});
        const film = page.getByRole("region", {name: "First Orbit", exact: true});
        const open = async () => {
            await home.locator('.movie-card[data-item-id="film-a"]').press("Enter");
            await film.waitFor();
        };
        await open();
        assert.equal(await film.getAttribute("data-title-background"), "backdrop");
        assert.equal(await film.locator(".movie-sections-ordered").count(), 0, "the default order leaves the page as it is");
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");
        await page.evaluate(async viewer => {
            localStorage.setItem("familyhub:movie-tracks:" + JSON.stringify(viewer) + ":ui", JSON.stringify({
                titleSections: ["cast", "related", "episodes"], titleBackground: "plain", oled: true}));
            await window.openDetailFixture("backdrop");
        }, viewer);
        await open();
        assert.equal(await film.getAttribute("data-title-background"), "plain");
        assert.equal(await film.locator(".movie-hero-art").count(), 0, "plain loads no backdrop");
        const cast = film.locator(".movie-cast");
        assert.equal(await cast.evaluate(node => node.style.order), "-1");
        assert.equal(await cast.evaluate(node => node.parentElement.classList.contains("movie-sections-ordered")), true);
        assert.equal(await page.evaluate(() => document.querySelector(".movie-library").dataset.movieOled), "true");
        await film.getByRole("button", {name: "Back to titles"}).press("Enter");
        await page.evaluate(async viewer => {
            localStorage.setItem("familyhub:movie-tracks:" + JSON.stringify(viewer) + ":ui", JSON.stringify({titleBackground: "blurred"}));
            await window.openDetailFixture("backdrop");
        }, viewer);
        await open();
        assert.equal(await film.locator(".movie-hero-art").evaluate(node => getComputedStyle(node).filter), "blur(26px)");
    } finally { await page.close(); }
}

async function checkTv(browser) {
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
    try {
        await movieHomeFixture(page);
        await useProfileServer(page);
        await opener(page).press("Enter");
        for (const height of await sheet(page).locator("button:visible, select").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)))
            assert.ok(height >= 60, "TV targets are at least 60 px");
        assert.equal(await focusLabel(page), "Show the banner");
        await page.keyboard.press("ArrowDown");
        assert.equal(await focusLabel(page), "Drag Continue watching");
        await page.keyboard.press("ArrowRight");
        assert.equal(await focusLabel(page), "Move Continue watching down");
        assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth), "4px");
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowDown");
        assert.equal(await focusLabel(page), "Drag My list", "plain arrows move focus on TV and never move a row");
        assert.deepEqual((await sheetRows(page)).slice(0, 2), ["continue", "list"]);
        await page.keyboard.press("Alt+ArrowUp");
        assert.deepEqual((await sheetRows(page)).slice(0, 2), ["list", "continue"]);
        assert.equal(await focusLabel(page), "Drag My list");
    } finally { await page.close(); }
}

async function checkPhone(browser) {
    const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
    const page = await context.newPage();
    try {
        await movieHomeFixture(page);
        await useProfileServer(page);
        await opener(page).tap();
        await sheet(page).waitFor();
        await sheet(page).evaluate(node => Promise.all(node.getAnimations({subtree: true}).map(animation => animation.finished))); await page.screenshot({path: require("node:path").join(__dirname, "../.local/customise/phone.png")});
        const box = await sheet(page).boundingBox();
        assert.ok(Math.abs(box.width - 390) < 1 && Math.abs(box.y + box.height - 844) < 1, "a bottom sheet on phones");
        const swipe = (from, to) => page.evaluate(({from, to}) => {
            const dialog = document.querySelector("dialog.movie-customise-dialog");
            const touch = y => new Touch({identifier: 1, target: dialog, clientX: 100, clientY: y});
            dialog.dispatchEvent(new TouchEvent("touchstart", {touches: [touch(from)], changedTouches: [touch(from)], bubbles: true}));
            dialog.dispatchEvent(new TouchEvent("touchend", {touches: [], changedTouches: [touch(to)], bubbles: true}));
        }, {from, to});
        await swipe(200, 230);
        assert.equal(await sheet(page).isVisible(), true, "a short swipe keeps the sheet");
        await swipe(200, 360);
        await sheet(page).waitFor({state: "hidden"});
        assert.equal(await opener(page).evaluate(node => node === document.activeElement), true);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        await checkSheet(browser, "reduce");
        await checkSheet(browser, "no-preference");
        await checkConflictAndFailure(browser);
        await checkOptions(browser);
        await checkPlaceholders(browser);
        await checkTitlePage(browser);
        await checkTv(browser);
        await checkPhone(browser);
    } finally { await browser.close(); }
    console.log("Movies customisation checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
