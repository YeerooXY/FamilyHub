const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app, jellyfin, cors, moviePage } = require("./movies_fixture.cjs");

const root = path.join(__dirname, "..");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [root, path.resolve(root, "../agent-dock")]
}));
const fixture = new URL(process.env.OUTAGE_FIXTURE_URL || "http://127.0.0.1:38870");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(fixture.hostname));
const origin = fixture.origin;
const output = path.join(root, "docs/verification/outage-states-2026-11-25");
const assets = path.join(root, "clients/FamilyHub.App/wwwroot");
const adminAssets = path.join(root, "music_web/admin_static");

const profiles = [
    [chromium, "windows-chromium", { viewport: { width: 1280, height: 850 } }],
    [webkit, "mac-safari", devices["Desktop Safari"]],
    [chromium, "android-pixel7", devices["Pixel 7"]],
    [webkit, "iphone13-safari", devices["iPhone 13"]]
];
const native = [
    ["movies", "Retry movies"],
    ["files", "Retry files", "outage-files"],
    ["movie-health", "Retry movie server check"],
    ["health", "Retry current readings"],
    ["health", "Retry history"],
    ["server-work", "Retry server work"],
    ["server-work", "Retry seeding"],
    ["leaderboard", "Retry leaderboard"],
    ["song-review", "Retry song review"],
    ["artist-mappings", "Retry artist mappings"],
    ["wordle", "Retry puzzle"],
    ["wordle", "Retry Wordle statistics", "outage-api", "Statistics"],
    ["wordle-settings", "Retry Wordle settings"],
    ["discovery", "Retry new releases"],
    ["lyrics", "Retry lyrics", "outage-lyrics"],
    ["diagnostics", "Retry playback diagnostics", "outage-api", "Load attempts"],
    ["listening", "Retry listening sessions", "outage-session", "Listen Together"],
    ["add-songs", "Retry Add songs connection", "outage-session", "Open Add songs"],
    ["playlist-picker", "Retry playlist connection", "outage-session", "Open playlist picker"],
    ["upload", "Retry upload status"],
    ["playlist-progress", "Retry playlist progress"],
    ["report-song", "Retry report connection", "outage-session", "Open song report"],
    ["not-found", "Open library"]
];

async function verifyCard(page, label, { motion = true } = {}) {
    const action = page.getByRole(label === "Open library" ? "link" : "button", { name: label, exact: true });
    await action.waitFor();
    assert.equal(await action.count(), 1, label);
    const card = action.locator("xpath=ancestor::div[contains(concat(' ',normalize-space(@class),' '),' service-status ')][1]");
    assert.equal(await card.locator(":scope > .service-status-icon").count(), 1, label);
    assert.equal(await card.locator(":scope > .service-status-copy > .service-status-timing").count(), 1, label);
    assert.equal(await card.getByRole("status").count(), 1, label);
    assert.equal(await card.locator(".service-status-announcement :is(strong,p)").count(), 2, label);
    assert.doesNotMatch(await card.innerText(), /\b(?:HTTP\s*)?[45][0-9]{2}\b|Exception:/i);
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    const box = await action.boundingBox();
    const minimum = (width >= 1920 ? 60 : 44) - .5; // sub-pixel layout rounds 44 px to 43.8 in some engines
    assert.ok(box.height >= minimum && box.width >= minimum, label + " " + JSON.stringify(box));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, label);
    if (motion) {
        const animation = () => card.evaluate(node => getComputedStyle(node).animationName);
        assert.equal(await animation(), "service-status-entry", label);
        await page.waitForFunction(() => window.outageEntries > 0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await animation(), "none");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => { document.body.dataset.effects = "off"; });
        assert.equal(await animation(), "none");
        await page.evaluate(() => { delete document.body.dataset.effects; });
    }
    return action;
}

async function guard(page) {
    await page.route("**/*", route => {
        const address = new URL(route.request().url());
        return [origin, app, jellyfin].includes(address.origin) ? route.continue() : route.abort();
    });
    await page.addInitScript(() => {
        window.outageEntries = 0;
        document.addEventListener("animationstart", event => {
            if (event.animationName === "service-status-entry") window.outageEntries++;
        });
    });
}

async function fixtureState(page, scenario, outage = "on") {
    for (const route of ["startup/" + scenario, "outage/" + outage]) {
        const response = await page.request.post(origin + "/fixture/" + route, { maxRedirects: 0 });
        assert.ok(response.ok(), route);
    }
}

async function capture(page, profile, screen) {
    await page.screenshot({ path: path.join(output, profile + "-" + screen + ".png"), animations: "disabled", scale: "css" });
}

async function checkWidths(page, label) {
    const viewport = page.viewportSize();
    for (const width of [320, 390, 768, 1280, 1920, 2000]) {
        await page.setViewportSize({ width, height: 900 });
        await verifyCard(page, label, { motion: false });
    }
    await page.setViewportSize(viewport);
}

async function nativeScreens(browser, profile, options) {
    const page = await browser.newPage(options);
    await guard(page);
    try {
        for (const [screen, label, scenario = "outage-api", open] of native) {
            await fixtureState(page, scenario);
            await page.goto(origin + "/outage/" + screen);
            if (open) await page.getByRole("button", { name: open, exact: true }).click();
            if (screen === "upload") {
                await page.locator("#outage-upload-audio-file").setInputFiles({
                    name: "fixture.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("Fixture")
                });
                await page.getByText("fixture.mp3", { exact: true }).waitFor();
                await page.getByRole("button", { name: "Submit songs" }).click();
            }
            if (screen === "playlist-picker") {
                // The first playlist already holds the fixture song, so checking it changes nothing to save.
                await page.getByRole("checkbox", {checked: false}).first().check();
                await page.getByRole("button", { name: "Done", exact: true }).click();
            }
            if (screen === "report-song") await page.locator("#report-quality").click();
            const action = await verifyCard(page, label);
            await action.scrollIntoViewIfNeeded();
            const suffix = { "Retry history": "-history", "Retry seeding": "-seeding", "Retry Wordle statistics": "-statistics" }[label] || "";
            await capture(page, profile, screen + suffix);
            await checkWidths(page, label);
            if (screen === "wordle-settings") {
                await fixtureState(page, "none", "off");
                await action.press("Space");
                await action.waitFor({ state: "hidden" });
                await page.waitForFunction(() => document.activeElement.id === "wordle-settings-choice");
            }
        }

        await fixtureState(page, "outage-session");
        await page.goto(origin);
        await page.locator("#open-hub").waitFor();
        for (const [screen, selector] of [["library", "#open-library"], ["playlists", "button.desktop-nav[aria-label=Playlists]"], ["home", "#open-home"]]) {
            const control = page.locator(selector);
            if (await control.isVisible()) await control.click();
            else await control.evaluate(button => button.click());
            await verifyCard(page, "Retry server connection");
            await capture(page, profile, screen);
            await checkWidths(page, "Retry server connection");
        }
        await fixtureState(page, "outage-connect");
        await page.goto(origin);
        await page.locator("#server").fill("https://music.fixture.test/");
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await verifyCard(page, "Retry server connection");
        await capture(page, profile, "connect");
        await checkWidths(page, "Retry server connection");
    } finally {
        await page.close();
    }
}

async function scriptScreens(browser, profile, options) {
    const page = await browser.newPage(options);
    await guard(page);
    let offline = true;
    try {
        await page.route(app + "/**", route => {
            const resource = new URL(route.request().url()).pathname;
            if (resource === "/api/server/seeding") {
                return offline ? route.fulfill({ status: 503 })
                    : route.fulfill({ json: { available: true, goal: 2, total_downloaded: 0, total_uploaded: 0, items: [] } });
            }
            if (resource === "/admin") return route.fulfill({ path: path.join(adminAssets, "admin.html") });
            if (resource.startsWith("/admin/")) {
                const name = path.basename(resource);
                return route.fulfill({ path: path.join(name.startsWith("service-status.") ? assets : adminAssets, name) });
            }
            return route.fallback();
        });
        await page.goto(app + "/admin");
        const admin = await verifyCard(page, "Retry seeding");
        await capture(page, profile, "web-admin");
        await checkWidths(page, "Retry seeding");
        await admin.focus();
        offline = false;
        await admin.press("Enter");
        await admin.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => document.activeElement.id), "global-title");

        await moviePage(page);
        await page.addStyleTag({ url: "/files.css" });
        await page.clock.install();
        await page.evaluate(async () => {
            const { openFiles } = await import("/files.js");
            window.filesOffline = true;
            window.filesReads = 0;
            openFiles(document.querySelector("main"), {
                invokeMethodAsync: async () => {
                    window.filesReads++;
                    return JSON.stringify(window.filesOffline ? { status: 503, body: '{"error":"HTTP 503"}' }
                        : { status: 200, body: '{"entries":[]}' });
                }
            }, { server: location.origin });
        });
        const files = await verifyCard(page, "Retry folder listing");
        await capture(page, profile, "files-listing");
        await checkWidths(page, "Retry folder listing");
        await files.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        assert.ok(await files.evaluate(button => button === document.activeElement));
        const reads = await page.evaluate(() => window.filesReads);
        await page.clock.fastForward(8200);
        await page.waitForFunction(previous => window.filesReads > previous, reads);
        assert.ok(await files.evaluate(button => document.activeElement === button));
        await page.evaluate(() => { window.filesOffline = false; });
        await files.press("Space");
        await files.waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => document.activeElement === document.body), false);

        await page.route(jellyfin + "/**", route => route.fulfill({ status: route.request().method() === "OPTIONS" ? 204 : 503, headers: cors }));
        await moviePage(page);
        await page.evaluate(async jellyfin => {
            const { openMovies } = await import("/movies.js");
            window.openMovieFixture(openMovies, document.querySelector("main"), {
                url: jellyfin, user: "fixture", token: "fixture", device: "0123456789abcdef0123456789abcdef"
            }, { invokeMethodAsync: async () => '{"error":"HTTP 503"}' });
        }, jellyfin);
        await verifyCard(page, "Retry genres");
        await verifyCard(page, "Retry movies");
        await capture(page, profile, "movie-shelves");
        await checkWidths(page, "Retry movies");
        const search = page.getByRole("searchbox");
        await search.fill("Fixture title");
        await search.press("Enter");
        await verifyCard(page, "Retry library search");
        await verifyCard(page, "Retry YouTube");
        await capture(page, profile, "movie-search");
        await checkWidths(page, "Retry library search");
    } finally {
        await page.close();
    }
}

async function main() {
    const ready = () => fetch(origin + "/fixture/update-check", { signal: AbortSignal.timeout(500), redirect: "error" })
        .then(response => response.ok, () => false);
    let host;
    try {
        if (!await ready()) {
            assert.ok(!process.env.OUTAGE_FIXTURE_URL, "Start the loopback fixture first.");
            const exe = path.join(__dirname, "fixtures/music-popup-host/bin/Debug/net10.0-windows10.0.19041.0/MusicPopupHost.exe");
            assert.ok(fs.existsSync(exe), "Build the Windows music popup fixture with the current native app first.");
            host = spawn(exe, { cwd: root, windowsHide: true, stdio: "inherit", env: { ...process.env, POPUP_URL: origin } });
            const deadline = Date.now() + 15000;
            while (!await ready()) {
                assert.ok(host.exitCode === null && Date.now() < deadline, "The local outage fixture did not start.");
                await delay(200);
            }
        }
        fs.mkdirSync(output, { recursive: true });
        for (const [engine, profile, { defaultBrowserType, ...options }] of profiles) {
            const browser = await engine.launch({ headless: true });
            try {
                await nativeScreens(browser, profile, options);
                await scriptScreens(browser, profile, options);
            } finally {
                await browser.close();
            }
        }
        console.log("Outage checks passed on four emulated browser profiles.");
    } finally {
        if (host) host.kill();
        else if (await ready()) await fetch(origin + "/fixture/outage/off", { method: "POST", redirect: "error" });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
