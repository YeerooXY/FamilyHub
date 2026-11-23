// The update popup: night-sky background, and the button turns into the progress bar in place.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.join(__dirname, "../docs/verification/update-screen-2026-11-23");
const razor = fs.readFileSync(path.join(__dirname, "../clients/FamilyHub.App/Components/AppUpdate.razor"), "utf8");
const stage = razor.slice(razor.indexOf('<div class="update-stage"'), razor.indexOf("@* /stage *@"));
const page$ = (morphing, percent) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/popup-native.css"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/startup.css"><body style="margin:0;background:#0b0d12">
<dialog open class="popup-panel update-dialog night-backdrop" aria-labelledby="h"><div class="dialog-heading"><h2 id="h">FamilyHub 0.1.95 is available</h2></div>
<div class="app-update"><button id="u" type="button" class="${morphing ? "is-morphing" : ""}" ${morphing ? `role="progressbar" aria-valuenow="${percent}"` : ""}>
<span class="update-btn-label">Download and restart</span><span class="update-line-fill" style="width:${percent}%"></span></button>${morphing ? stage : ""}</div>
<button class="quiet">Later</button></dialog>`;
(async () => {
    for (const [engine, name, viewport] of [[chromium, "pc", { width: 1280, height: 800 }], [webkit, "iphone", { width: 390, height: 844 }]]) {
        const browser = await engine.launch(), page = await browser.newPage({ viewport });
        let morphing = false;
        await page.route("http://t.test/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: page$(morphing, 60) });
        });
        await page.goto("http://t.test/");
        const idle = await page.locator("#u").boundingBox();
        assert.ok(idle.height >= 40, `${name} button is a normal 44px button before the download`);
        const bg = await page.evaluate(() => getComputedStyle(document.querySelector("dialog")).backgroundImage);
        assert.ok(bg.includes("radial-gradient"), `${name} popup wears the night sky`);
        morphing = true;
        await page.goto("http://t.test/?x=1");
        await page.waitForTimeout(700);
        const bar = await page.locator("#u").boundingBox(), fill = await page.locator("#u .update-line-fill").boundingBox();
        assert.ok(bar.height <= 8, `${name} button became a bar (${bar.height}px)`);
        assert.ok(Math.abs(fill.width / bar.width - .6) < .02, `${name} fill follows the percentage`);
        assert.equal(await page.locator(".update-stage").count(), 1);
        await page.screenshot({ path: path.join(out, `dialog-${name}.png`) });
        await browser.close();
    }
    console.log("Update popup: night-sky background, and the button turns into the progress bar (PC Chromium and iPhone WebKit, emulated).");
})().catch(e => { console.error(e); process.exit(1); });
