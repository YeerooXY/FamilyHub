// Sound panel on a PC: volume, mute, sound mode and persistence. Phones get no panel (hardware volume).
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const app = "http://t.test";

(async () => {
    const unit = await import(require("node:url").pathToFileURL(path.join(wwwroot, "movie-sound.js")).href);
    assert.deepEqual(unit.normalizeSound({ volume: 9, muted: "x", mode: "bogus", device: 5 }), { volume: 2, muted: false, mode: "original", device: "" });
    assert.deepEqual(unit.normalizeSound({ volume: -1, muted: true, mode: "night", device: "abc" }), { volume: 0, muted: true, mode: "night", device: "abc" });
    const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    unit.saveSound({ volume: 1.5, mode: "bass" }, storage);
    assert.equal(unit.readSound(storage).volume, 1.5);

    const browser = await chromium.launch();
    for (const [name, options, expectPanel] of [["pc", { viewport: { width: 1280, height: 800 } }, true],
        ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, false]]) {
        const page = await browser.newPage(options);
        await page.route(app + "/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: path.join(wwwroot, n) })
                : route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/movies.css"><main class="movie-library"><section class="movie-player movie-expanded"><video></video></section></main>' });
        });
        await page.goto(app + "/");
        const result = await page.evaluate(async () => {
            const { buildPlayerUi } = await import("/movie-player-ui.js");
            const media = document.querySelector("video"), surface = document.querySelector(".movie-player");
            const back = document.createElement("button");
            const ui = buildPlayerUi({ media, surface, back, signal: new AbortController().signal, title: "Test", trackControls: [],
                notice: document.createElement("p"), dataSaver: { quality: "Full quality", choices: [] } });
            surface.append(ui.root);
            return { hasButton: !![...ui.root.querySelectorAll(".movie-ui-action")].find(b => b.getAttribute("aria-label") === "Sound" && !b.hidden) };
        });
        assert.equal(result.hasButton, expectPanel, `${name}: Sound button`);
        if (expectPanel) {
            await page.getByRole("button", { name: "Sound", exact: true }).click();
            const slider = page.getByRole("slider", { name: "Volume" });
            await slider.waitFor();
            await slider.fill("50");
            assert.equal(await page.evaluate(() => document.querySelector("video").volume), .5);
            await page.getByRole("button", { name: "Mute" }).click();
            assert.equal(await page.evaluate(() => document.querySelector("video").muted), true);
            await page.getByRole("button", { name: "Unmute" }).click();
            await slider.fill("150");
            await page.getByText("Above 100%").waitFor();
            await page.getByRole("radio", { name: "Night mode" }).click();
            assert.equal(await page.getByRole("radio", { name: "Night mode" }).getAttribute("aria-checked"), "true");
            assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("familyhub.movie.sound.v1"))), { volume: 1.5, muted: false, mode: "night", device: "" });
            await page.getByRole("button", { name: "Close sound" }).click();
            await page.getByRole("button", { name: "Sound", exact: true }).waitFor();
        }
        await page.close();
    }
    await browser.close();
    console.log("Sound panel: PC has volume, mute, modes and saved settings; phones have none.");
})().catch(e => { console.error(e); process.exit(1); });
