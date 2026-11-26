// While an update downloads, the update popup becomes the full-window updater on PC, tablet and phone.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { constants, setPriority } = require("node:os");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const { jellyfin, cors, moviePage, playMovieDetails } = require("./movies_fixture.cjs");
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = process.argv[2] || path.join(__dirname, "../.local/update-fullscreen-2026-11-25");
setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
fs.mkdirSync(out, { recursive: true });
const page$ = updating => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/popup-native.css"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/startup.css"><body style="margin:0;background:#05070d">
<dialog open class="popup-panel update-dialog night-backdrop ${updating ? "is-updating" : ""}" aria-labelledby="h"><div class="dialog-heading"><h2 id="h">FamilyHub 1.5.1 is available</h2><button class="quiet" aria-label="Close update">x</button></div>
<div class="app-update">${updating
    ? `<div class="update-screen night-backdrop" role="dialog" aria-modal="true" aria-labelledby="t"><div class="update-card"><h2 id="t" tabindex="-1">Updating FamilyHub</h2><p class="update-versions">1.5.0 → 1.5.1</p><div class="update-line" role="progressbar" aria-valuenow="40" aria-labelledby="t"><span class="update-line-fill" style="width:40%"></span></div></div></div>`
    : `<button id="u" type="button">Download and restart</button>`}</div>
<button class="quiet" id="update-later">Later</button></dialog>`;

async function checkMovieChrome() {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
        const item = { Id: "in-time", Name: "In Time", Type: "Movie" };
        await page.route(jellyfin + "/**", route => {
            const url = new URL(route.request().url());
            if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            if (url.pathname.endsWith("/PlaybackInfo")) return route.fulfill({ headers: cors,
                json: { PlaySessionId: "fixture", MediaSources: [{ Id: "source", SupportsDirectPlay: true, DefaultSubtitleStreamIndex: -1 }] } });
            if (url.pathname === "/Items/in-time") return route.fulfill({ headers: cors, json: item });
            const items = url.pathname === "/Items" && url.searchParams.get("includeItemTypes") === "Movie" ? [item] : [];
            return route.fulfill({ headers: cors, json: { Items: items, TotalRecordCount: items.length } });
        });
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            HTMLMediaElement.prototype.load = () => {};
            Object.defineProperty(HTMLMediaElement.prototype, "src", {
                get() { return this.fixtureSource ?? ""; },
                set(url) { this.fixtureSource = String(url); }
            });
        });
        await moviePage(page, { shell: true });
        await page.addStyleTag({ url: "/hub.css" });
        await page.evaluate(() => {
            document.body.style.padding = "0 8px";
            window.chrome ??= {};
            window.chrome.webview = {};
            let fullscreen = false;
            window.setMoviePresenter = on => {
                fullscreen = on;
                window.dispatchEvent(new CustomEvent("chrome-refresh", { detail: on }));
            };
            window.DotNet = { async invokeMethodAsync(_assembly, method, rects) {
                if (method !== "UpdateWindowChrome") throw Error(method);
                window.chromeInteractive = rects;
                return fullscreen ? { supported: false } : { supported: true, height: 48, leftInset: 0, rightInset: 139.2 };
            } };
        });
        await page.addScriptTag({ url: "/app.js" });
        await page.evaluate(async jellyfin => {
            const {openMovies} = await import("/movies.js");
            const host = document.querySelector("main");
            host.dataset.nativeFullscreen = "true";
            window.openMovieFixture(openMovies, host, {url: jellyfin, user: "test", token: "fixture"}, {
                async invokeMethodAsync(method, on) {
                    if (method === "MovieWindowFullscreen") {
                        window.setMoviePresenter(on);
                        return on;
                    }
                    if (method === "MovieConnectionKind") return "wifi";
                }
            });
            window.familyhub.syncChrome();
        }, jellyfin);
        const header = page.locator(".app-header");
        async function checkMergedBar() {
            await page.waitForFunction(() => {
                const {top, height} = document.querySelector(".app-header").getBoundingClientRect();
                const avatar = document.querySelector("#profile-toggle").getBoundingClientRect();
                const inset = parseFloat(document.documentElement.style.getPropertyValue("--window-controls-width"));
                return document.body.classList.contains("native-titlebar") && top === 0 && height === 48 &&
                    inset === 139.2 && avatar.right <= innerWidth - inset &&
                    window.chromeInteractive.some(rect => Math.abs(rect.x - avatar.left + 4) < 0.5 &&
                        Math.abs(rect.width - avatar.width - 8) < 0.5);
            });
            assert.equal(await header.count(), 1);
            assert.equal(await header.evaluate(node => getComputedStyle(node).backgroundColor), "rgb(0, 0, 0)");
        }
        await checkMergedBar();
        const button = name => page.getByRole("button", {name, exact: true});
        const play = await playMovieDetails(page, button(item.Name), item.Name);
        for (const exit of ["Escape", "Back to movies", "window restore"]) {
            await button("Full screen").press("Enter");
            await button("Exit full screen").waitFor();
            await page.waitForFunction(() => !document.body.classList.contains("native-titlebar"));
            await header.waitFor({ state: "hidden" });
            assert.equal((await page.locator(".movie-player").boundingBox()).y, 0);
            if (exit === "Escape") await page.keyboard.press("Escape");
            if (exit === "window restore") await page.evaluate(() => window.setMoviePresenter(false));
            if (exit !== "Back to movies") {
                await button("Full screen").waitFor();
                await page.waitForFunction(() => document.body.classList.contains("native-titlebar"));
            }
            await button("Back to movies").press("Enter");
            await checkMergedBar();
            assert.equal(await play.evaluate(node => node === document.activeElement), true);
            if (exit !== "window restore") await play.press("Enter");
        }
        await page.setViewportSize({ width: 1100, height: 720 });
        await checkMergedBar();
    } finally {
        await browser.close();
    }
}

(async () => {
    for (const [engine, name, viewport] of [[chromium, "pc-1280", { width: 1280, height: 800 }], [chromium, "pc-2000", { width: 2000, height: 1100 }],
        [webkit, "mac-1280", { width: 1280, height: 800 }], [webkit, "iphone-390", { width: 390, height: 844 }], [chromium, "pixel7-412", { width: 412, height: 915 }]]) {
        const browser = await engine.launch({ headless: true }), page = await browser.newPage({ viewport });
        let updating = false;
        await page.route("http://t.test/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: page$(updating) });
        });
        await page.goto("http://t.test/");
        const idle = await page.locator("dialog").boundingBox();
        if (viewport.width >= 721) assert.ok(idle.width < viewport.width * 0.6, `${name}: before the download the update is a side panel`);
        updating = true;
        await page.goto("http://t.test/?x=1");
        await page.waitForTimeout(500);
        const box = await page.locator("dialog").boundingBox();
        assert.ok(Math.abs(box.x) < 1 && Math.abs(box.y) < 1 && Math.abs(box.width - viewport.width) < 1 && Math.abs(box.height - viewport.height) < 1,
            `${name}: while updating the dialog covers the whole window (${JSON.stringify(box)})`);
        const hidden = await page.evaluate(() => [".dialog-heading", "#update-later"].map(s => getComputedStyle(document.querySelector(s)).display));
        assert.deepEqual(hidden, ["none", "none"], `${name}: heading and Later are hidden while updating`);
        const card = await page.locator(".update-card").boundingBox();
        assert.ok(Math.abs(card.x + card.width / 2 - viewport.width / 2) < 2, `${name}: the card is centred in the window`);
        await page.screenshot({ path: path.join(out, name + "-updating.png") });
        await browser.close();
    }
    await checkMovieChrome();
    console.log("Full-screen updater and Chromium movie title-bar restoration checks passed (emulated).");
})().catch(error => { console.error(error); process.exit(1); });
