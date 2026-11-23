// The opening screen: the logo animates only with transform and opacity, and on leaving it grows to fill the window
// while the app settles in. Emulated engines and profiles, not real devices.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = path.join(__dirname, "../docs/verification/startup-2026-11-23");
fs.mkdirSync(out, { recursive: true });
const razor = fs.readFileSync(path.join(__dirname, "../clients/FamilyHub.App/Components/StartupSplash.razor"), "utf8");
const markup = razor.slice(0, razor.indexOf("@code")).replace('@(Leaving ? "is-leaving" : "")', "").replace('@(Leaving ? "false" : "true")', "true");
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/startup.css"><body style="margin:0;background:#06070c">
<div class="workspace" style="position:fixed;inset:0;background:#10131c;color:#fff;display:grid;place-items:center;font:600 2rem system-ui">FamilyHub</div>${markup}`;
const animated = /box-shadow|\bwidth\b|letter-spacing|\bleft\b|\btop\b/;
(async () => {
    const css = fs.readFileSync(path.join(wwwroot, "startup.css"), "utf8");
    for (const [, body] of css.matchAll(/@keyframes startup-[\w-]+ \{([\s\S]*?)\n(?=[@.\n])/g)) assert.doesNotMatch(body, animated, "a startup keyframe animates paint or layout");
    for (const [engine, name, options] of [[chromium, "pc", { viewport: { width: 1280, height: 800 } }], [chromium, "pixel7", devices["Pixel 7"]], [webkit, "iphone13", devices["iPhone 13"]]]) {
        const browser = await engine.launch(), page = await browser.newPage(options);
        await page.route("http://t.test/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) }) : route.fulfill({ contentType: "text/html", body: html });
        });
        await page.goto("http://t.test/");
        await page.waitForTimeout(1600);
        await page.screenshot({ path: path.join(out, name + "-showing.png") });
        await page.evaluate(() => document.querySelector(".startup-screen").classList.add("is-leaving"));
        const scale = () => page.evaluate(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector(".startup-disc")).transform); return m.a; });
        await page.waitForTimeout(250);
        const early = await scale();
        await page.screenshot({ path: path.join(out, name + "-zoom-early.png") });
        await page.waitForTimeout(350);
        const late = await scale();
        await page.screenshot({ path: path.join(out, name + "-zoom-late.png") });
        assert.ok(late > early && late > 3, `${name}: the logo should keep growing (${early.toFixed(2)} -> ${late.toFixed(2)})`);
        await page.waitForTimeout(700);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".startup-screen")).opacity), "0");
        await browser.close();
        console.log(name, `zoom ${early.toFixed(1)}x -> ${late.toFixed(1)}x ok`);
    }
})().catch(e => { console.error(e); process.exit(1); });
