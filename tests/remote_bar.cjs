// The "Playing on another device" bar: play button, elapsed time, seek line and total time stack without overlap on PC;
// the clock counts up while that device plays. Phones keep the thin line and hide the labels.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/player-native.css">
<style>body{margin:0;background:#000;color:#fff;font:14px system-ui}.frame{position:fixed;left:0;right:0;bottom:0;height:92px;display:grid;grid-template-columns:1fr}.frame>.remote-mini{grid-area:1/1}
.icon{width:16px;height:16px}.cover{display:block;background:#345}</style>
<div class="frame"><div id="remote-now-playing" class="remote-mini" role="group">
<button class="remote-mini-main"><span class="cover" style="width:56px;height:56px"></span><span class="remote-mini-copy"><strong>Alien Victory</strong><small>Starcadian</small></span></button>
<div class="remote-mini-center"><button id="remote-toggle" class="remote-mini-toggle"><svg class="icon" viewBox="0 0 24 24"><path d="M7 4h4v16H7z"/></svg></button>
<span class="remote-mini-seek"><span class="remote-clock" data-clock="at" data-clock-from="62" data-clock-duration="241" data-clock-running="true" aria-hidden="true">1:02</span>
<span class="remote-mini-progress"><span style="width:25%"></span></span><span class="remote-clock" aria-hidden="true">4:01</span></span></div>
<span class="remote-mini-line"><strong>Playing on Phone</strong></span></div></div>`;
const clockScript = require("node:fs").readFileSync(path.join(wwwroot, "app.js"), "utf8").split("// Time labels on the")[1];
(async () => {
    for (const [engine, name, viewport] of [[chromium, "pc-1894", { width: 1894, height: 600 }], [webkit, "mac-1280", { width: 1280, height: 600 }], [chromium, "phone", { width: 412, height: 700 }]]) {
        const browser = await engine.launch(), page = await browser.newPage({ viewport });
        await page.route("http://t.test/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: html });
        });
        await page.goto("http://t.test/");
        await page.addScriptTag({ content: "// Time labels on the" + clockScript });
        const box = sel => page.locator(sel).first().evaluate(n => n.getBoundingClientRect().toJSON());
        if (viewport.width > 720) {
            const [toggle, line, first, last] = [await box("#remote-toggle"), await box(".remote-mini-progress"), await box(".remote-clock"), await box(".remote-clock:last-child")];
            assert.ok(toggle.bottom <= line.top - 1, `${name}: play button (${toggle.bottom}) sits above the line (${line.top})`);
            assert.ok(first.right <= line.left && line.right <= last.left, `${name}: times flank the line`);
            assert.ok(line.width > 300, `${name}: the line is wide (${line.width})`);
            const frame = await box(".frame"), bar = await box(".remote-mini");
            assert.ok(line.bottom <= bar.bottom - 20 && toggle.top >= bar.top, `${name}: the stack fits the bar`);
            const before = await page.locator("[data-clock=at]").innerText();
            await page.waitForTimeout(3400);
            const after = await page.locator("[data-clock=at]").innerText();
            assert.notEqual(before, after, `${name}: the clock moves while the other device plays`);
        } else {
            assert.equal(await page.locator(".remote-clock").first().isVisible(), false, "phones hide the time labels");
        }
        await page.screenshot({ path: path.join(__dirname, "../docs/verification/remote-bar-2026-11-23-" + name + ".png"), clip: { x: 0, y: viewport.height - 100, width: viewport.width, height: 100 } });
        await browser.close();
    }
    console.log("Remote bar: no overlap, times shown on PC and live, labels hidden on phones.");
})().catch(e => { console.error(e); process.exit(1); });
