// Renders the updating screen markup with the real stylesheet and checks layout on phone and PC.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const shellCss = path.join(__dirname, "../music_web/static/shell.css");
const out = path.join(__dirname, "../docs/verification/update-screen-2026-11-23");
const razor = fs.readFileSync(path.join(__dirname, "../clients/FamilyHub.App/Components/AppUpdate.razor"), "utf8");
const stage = razor.slice(razor.indexOf('<div class="update-stage"'), razor.indexOf("@* /stage *@"));
const summary = razor.slice(razor.indexOf('<div class="update-summary">'), razor.indexOf("                @WhatsNew", razor.indexOf('<div class="update-summary">')))
    .replace('@ref="titleRef" ', "").replace("@AppUpdater.CurrentVersion", "0.1.85").replace("@available.Version", "0.1.87")
    .replace("@Stage", stage).replaceAll("@(percent)", "42").replaceAll("@percent", "42").replace("@announcement", "25 percent downloaded.");
const releaseNotes = `<section class="whats-new" aria-labelledby="notes-heading">
    <h3 id="notes-heading">What's new in 0.1.87</h3><ul tabindex="0" aria-labelledby="notes-heading">
    ${Array.from({length: 12}, (_, index) => `<li>Release note ${index + 1}. Family members can resume the current download after the connection returns and see its progress from another device.</li>`).join("")}
    </ul></section>`;
const styles = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/startup.css"><link rel="stylesheet" href="/popup-native.css"><body style="margin:0">`;
const screen = notes => `<div class="update-screen night-backdrop"><div class="update-card">${summary}${notes}</div></div>`;
const popup = updating => `${styles}<dialog id="update-dialog" class="popup-panel update-dialog night-backdrop ${updating ? "is-updating" : ""}"
    aria-labelledby="${updating ? "update-screen-title" : "update-heading"}">
    <div class="dialog-heading"><h2 id="update-heading">FamilyHub 0.1.87 is available</h2><button aria-label="Close update">×</button></div>
    <div class="app-update"><button>Download update</button>${updating ? "" : releaseNotes}</div>
    ${updating ? screen(releaseNotes) : ""}<button id="update-later">Later</button>
    </dialog><script>document.getElementById("update-dialog").showModal();</script>`;

async function routeScreen(page, body) {
    await page.route("http://t.test/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (!name) return route.fulfill({ contentType: "text/html", body });
        return route.fulfill({ path: name === "shell.css" ? shellCss : path.join(wwwroot, name) });
    });
    await page.goto("http://t.test/");
}

async function checkPhoneUpdateLayout() {
    const portrait = {width: 390, height: 844}, landscape = {width: 844, height: 390};
    for (const [engine, motion] of [[chromium, "no-preference"], [webkit, "reduce"]]) {
        const browser = await engine.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: portrait, reducedMotion: motion, hasTouch: true});
            await routeScreen(page, popup(true));
            for (const viewport of [portrait, landscape, portrait]) {
                await page.setViewportSize(viewport);
                await page.waitForFunction(({width, height}) => innerWidth === width && innerHeight === height, viewport);
                const {card, stage, line, status, notes} = await page.evaluate(() => {
                    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
                    return {card: box(".update-card"), stage: box(".update-stage"), line: box(".update-line"),
                        status: box(".update-card [role=status]"), notes: box(".whats-new")};
                });
                assert.ok(Math.abs(card.left - (viewport.width - card.right)) <= 2, "Update card is horizontally centered");
                assert.ok(Math.abs(card.top - (viewport.height - card.bottom)) <= 2, "Update card is vertically centered");
                for (const box of [stage, line, status]) {
                    assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= viewport.width &&
                        box.top >= 0 && box.bottom <= viewport.height, "Scenes, progress and status fit in the viewport");
                }
                if (viewport === landscape) assert.ok(stage.right < notes.left, "Landscape notes are beside the scenes");
                else assert.ok(line.bottom < notes.top, "Portrait notes are below progress");
                await checkNotesScroll(page);
            }
            assert.equal(await page.locator(".update-stage").evaluate(node => node.getAnimations({subtree: true})
                .some(animation => animation.playState === "running")), motion === "no-preference");
            await page.unroute("http://t.test/**");
            await routeScreen(page, popup(false));
            await checkNotesScroll(page);
        } finally {
            await browser.close();
        }
    }
}

async function checkNotesScroll(page) {
    const notes = page.locator(".whats-new ul");
    assert.equal(await notes.locator("li").count(), 12);
    await notes.focus();
    assert.equal(await notes.evaluate(node => {
        node.scrollTop = 0;
        const panel = node.closest("dialog"), panelScroll = panel.scrollTop;
        node.scrollTop = node.scrollHeight;
        return node === document.activeElement && getComputedStyle(node).overflowY === "auto" &&
            node.scrollTop > 0 && panel.scrollTop === panelScroll;
    }), true, "The focused release list scrolls independently of the update dialog");
}

async function checkUpdateScreen() {
    await checkPhoneUpdateLayout();
    for (const [engine, name, viewport] of [[chromium, "pc-chromium", { width: 1280, height: 800 }], [chromium, "phone-chromium", { width: 412, height: 915 }], [webkit, "iphone-webkit", { width: 390, height: 844 }]]) {
        const browser = await engine.launch(), page = await browser.newPage({ viewport });
        await routeScreen(page, styles + screen(""));
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
        assert.equal(await page.locator(".update-status").isVisible(), true);
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
}

module.exports = {checkPhoneUpdateLayout};
if (require.main === module) checkUpdateScreen().catch(error => { console.error(error); process.exitCode = 1; });
