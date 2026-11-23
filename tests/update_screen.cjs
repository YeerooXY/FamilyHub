// Renders the updating screen markup with the real stylesheet and checks layout on phone and PC.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.join(__dirname, "../docs/verification/update-screen-2026-11-23");
const razor = fs.readFileSync(path.join(__dirname, "../clients/FamilyHub.App/Components/AppUpdate.razor"), "utf8");
const stage = razor.slice(razor.indexOf('<div class="update-stage"'), razor.indexOf("@* /stage *@"));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/startup.css"><body style="margin:0">
<div class="update-screen night-backdrop" role="dialog" aria-modal="true" aria-labelledby="t"><div class="update-card">
<div class="startup-disc update-disc"><img src="/familyhub-logo.svg" alt=""></div><h2 id="t" tabindex="-1">Updating FamilyHub</h2>
<p class="update-versions">0.1.85 → 0.1.87</p>
${stage}
<div class="update-line" role="progressbar" aria-valuenow="42"><span class="update-line-fill" style="width:42%"></span><span class="update-line-thumb" style="left:42%"></span></div>
<p class="update-status" role="status">25 percent downloaded.</p></div></div>`;
(async () => {
    for (const [engine, name, viewport] of [[chromium, "pc-chromium", { width: 1280, height: 800 }], [chromium, "phone-chromium", { width: 412, height: 915 }], [webkit, "iphone-webkit", { width: 390, height: 844 }]]) {
        const browser = await engine.launch(), page = await browser.newPage({ viewport });
        await page.route("http://t.test/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: html });
        });
        await page.goto("http://t.test/");
        // Each scene takes the stage in turn (3 s apiece) and the visible one always shows its label.
        const seen = new Set();
        for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(i ? 3000 : 1500);
            const shown = await page.evaluate(() => [...document.querySelectorAll(".update-scene")]
                .filter(scene => getComputedStyle(scene).opacity > .9).map(scene => scene.querySelector("b").textContent));
            for (const label of shown) seen.add(label);
            if (i === 1) await page.screenshot({ path: path.join(out, name + "-wordle.png") });
        }
        assert.deepEqual([...seen].sort(), ["Files", "Movies", "Music", "Wordle"], `${name} should cycle all four scenes`);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".update-status")).position), "absolute");
        assert.equal(await page.evaluate(() => !document.querySelector(".update-percent")), true);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
            sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight,
            line: document.querySelector(".update-line").getBoundingClientRect().toJSON(), fill: document.querySelector(".update-line-fill").getBoundingClientRect().width }));
        assert.ok(m.sw <= m.cw && m.sh <= m.ch, `${name} overflows ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.fill / m.line.width - .42) < .01, `${name} fill is not 42%`);
        await page.screenshot({ path: path.join(out, name + ".png") });
        await browser.close();
    }
    console.log("Updating screen fits and shows progress on PC, Android and iPhone profiles (emulated).");
})().catch(e => { console.error(e); process.exit(1); });
