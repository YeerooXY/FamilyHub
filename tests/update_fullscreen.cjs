// While an update downloads, the update popup becomes the full-window updater on PC, tablet and phone.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.join(__dirname, "../docs/verification/update-fullscreen-2026-11-25");
fs.mkdirSync(out, { recursive: true });
const page$ = updating => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/popup-native.css"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/startup.css"><body style="margin:0;background:#05070d">
<dialog open class="popup-panel update-dialog night-backdrop ${updating ? "is-updating" : ""}" aria-labelledby="h"><div class="dialog-heading"><h2 id="h">FamilyHub 1.5.1 is available</h2><button class="quiet" aria-label="Close update">x</button></div>
<div class="app-update">${updating
    ? `<div class="update-screen night-backdrop" role="dialog" aria-modal="true" aria-labelledby="t"><div class="update-card"><h2 id="t" tabindex="-1">Updating FamilyHub</h2><p class="update-versions">1.5.0 → 1.5.1</p><div class="update-line" role="progressbar" aria-valuenow="40" aria-labelledby="t"><span class="update-line-fill" style="width:40%"></span></div></div></div>`
    : `<button id="u" type="button">Download and restart</button>`}</div>
<button class="quiet" id="update-later">Later</button></dialog>`;
(async () => {
    for (const [engine, name, viewport] of [[chromium, "pc-1280", { width: 1280, height: 800 }], [chromium, "pc-2000", { width: 2000, height: 1100 }],
        [webkit, "mac-1280", { width: 1280, height: 800 }], [webkit, "iphone-390", { width: 390, height: 844 }], [chromium, "pixel7-412", { width: 412, height: 915 }]]) {
        const browser = await engine.launch(), page = await browser.newPage({ viewport });
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
    console.log("Full-screen updater passed on PC, Mac WebKit, iPhone WebKit and Pixel 7 profiles (emulated).");
})().catch(error => { console.error(error); process.exit(1); });
