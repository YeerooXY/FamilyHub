// Renders the apps screen (HubApps.razor markup + hub.css) in emulated device profiles and checks that the four
// tiles are large, fill the window and stay inside it. Emulated engines and profiles, not real devices.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.resolve(process.argv[2] || path.join(__dirname, "../docs/verification/hub-2026-11-23"));
fs.mkdirSync(out, { recursive: true });
const razor = fs.readFileSync(path.join(__dirname, "../clients/FamilyHub.App/Components/HubApps.razor"), "utf8");
const markup = razor.slice(0, razor.indexOf("@code")).replace(/\s@(ref|onclick|onkeydown)=("[^"]*"|'[^']*')/g, "");
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/hub.css">
<body style="margin:0;background:#0b0d12;color:#fff;font-family:system-ui,sans-serif"><header style="height:56px"></header>
<div class="workspace" data-app-view="Hub" style="height:calc(100dvh - 56px);display:grid"><main id="content" tabindex="-1">${markup}</main></div>`;
const profiles = [
    [chromium, "windows-chromium-1280", { viewport: { width: 1280, height: 800 } }],
    [chromium, "windows-chromium-1920", { viewport: { width: 1920, height: 1080 } }],
    [chromium, "tv-1920x1080", { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }],
    [chromium, "android-pixel7", devices["Pixel 7"]],
    [webkit, "iphone13", devices["iPhone 13"]],
    [webkit, "mac-safari-engine-1280", { viewport: { width: 1280, height: 800 } }]
];
(async () => {
    for (const [engine, name, options] of profiles) {
        const browser = await engine.launch(), page = await browser.newPage(options);
        await page.route("http://t.test/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: html });
        });
        await page.goto("http://t.test/");
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => {
            const main = document.querySelector("main"), tiles = [...document.querySelectorAll(".hub-card")].map(c => c.getBoundingClientRect().toJSON());
            const arts = [...document.querySelectorAll(".hub-card")].map(c => { const box = c.getBoundingClientRect();
                return [...c.querySelectorAll(".hub-art > *")].every(a => { const r = a.getBoundingClientRect(); return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom; }); });
            return { sw: main.scrollWidth, cw: main.clientWidth, sh: main.scrollHeight, ch: main.clientHeight, tiles, arts, vw: innerWidth, vh: innerHeight };
        });
        assert.equal(m.tiles.length, 4);
        assert.ok(m.sw <= m.cw, `${name} scrolls sideways ${JSON.stringify([m.sw, m.cw])}`);
        const covered = m.tiles.reduce((sum, t) => sum + t.width * t.height, 0) / (m.vw * (m.vh - 56));
        assert.ok(covered > .55, `${name}: tiles cover only ${(covered * 100).toFixed(0)}% of the screen`);
        assert.ok(m.tiles.every(t => t.width >= m.vw * .4 && t.height >= 150), `${name}: tiles are too small ${JSON.stringify(m.tiles.map(t => [t.width | 0, t.height | 0]))}`);
        assert.ok(m.arts.every(Boolean), `${name}: a picture sits outside its tile`);
        await page.screenshot({ path: path.join(out, name + ".png") });
        await browser.close();
        console.log(name, `ok, tiles ${(covered * 100).toFixed(0)}% of the screen, page ${m.sh}/${m.ch}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
