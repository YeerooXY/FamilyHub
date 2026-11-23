// The opening screen: logo, orbiting ring, wordmark and progress line at several moments, leaving, and reduced motion.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.join(__dirname, "../docs/verification/startup-2026-11-23");
const markup = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/startup.css"><body style="margin:0;background:#000">
<main class="startup-screen" role="status" aria-label="Opening FamilyHub" aria-busy="true"><div class="startup-twinkle" aria-hidden="true"></div>
<div class="startup-stage"><div class="startup-disc"><span class="startup-orbit" aria-hidden="true"></span><img src="/familyhub-logo.svg" alt=""></div><p class="startup-word" aria-hidden="true">FamilyHub</p></div>
<div class="startup-line" aria-hidden="true"><span></span></div></main><div class="workspace" id="app" style="padding:2rem;color:#fff">App</div>`;

async function run(engine, name, viewport, reduced) {
    const browser = await engine.launch(), page = await browser.newPage({ viewport, reducedMotion: reduced ? "reduce" : "no-preference" });
    await page.route("http://t.test/**", (route) => {
        const n = new URL(route.request().url()).pathname.slice(1);
        return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: markup });
    });
    await page.goto("http://t.test/");
    const opacity = (sel) => page.evaluate((s) => Number(getComputedStyle(document.querySelector(s)).opacity), sel);
    const tag = `${name}${reduced ? "-reduced" : ""}`;
    if (!reduced) {
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(out, `${tag}-0.4s.png`) });
        assert.ok(await opacity(".startup-word") < 0.9, `${tag}: the wordmark is still arriving at 0.4 s`);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(out, `${tag}-1.9s.png`) });
    }
    await page.waitForTimeout(reduced ? 100 : 1700);
    assert.equal(await opacity(".startup-word"), 1, `${tag}: wordmark fully visible`);
    const line = await page.evaluate(() => document.querySelector(".startup-line span").getBoundingClientRect().width / document.querySelector(".startup-line").getBoundingClientRect().width);
    assert.ok(line > 0.9, `${tag}: the progress line is full after the minimum time (${line})`);
    const box = await page.evaluate(() => { const r = document.querySelector(".startup-disc").getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    assert.ok(Math.abs(box.cx - viewport.width / 2) < 2, `${tag}: logo is centred`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${tag}: no sideways scroll`);
    await page.screenshot({ path: path.join(out, `${tag}-3.4s.png`) });
    await page.evaluate(() => document.querySelector(".startup-screen").classList.add("is-leaving"));
    await page.waitForTimeout(reduced ? 400 : 700);
    assert.equal(await opacity(".startup-screen"), 0, `${tag}: the screen is gone after leaving`);
    await browser.close();
}

(async () => {
    require("node:fs").mkdirSync(out, { recursive: true });
    await run(chromium, "pc-chromium", { width: 1280, height: 800 }, false);
    await run(chromium, "phone-chromium", { width: 412, height: 915 }, false);
    await run(webkit, "iphone-webkit", { width: 390, height: 844 }, false);
    await run(chromium, "phone-chromium", { width: 412, height: 915 }, true);
    console.log("Opening screen verified: arrives in stages, fills to full, centred, fades out; reduced motion shows it at once (emulated).");
})().catch((e) => { console.error(e); process.exit(1); });
