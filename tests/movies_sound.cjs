// Desktop volume, mute, sound mode and persistence. Phones and televisions use hardware volume.
const assert = require("node:assert/strict");
const path = require("node:path");
const { movieAssetPath } = require("./movies_fixture.cjs");
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
    for (const [name, options, expectVolume] of [["pc", { viewport: { width: 1280, height: 800 } }, true],
        ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, false],
        ["tv", { viewport: { width: 1920, height: 1080 }, userAgent: "Mozilla/5.0 (SmartTV; Tizen)" }, false]]) {
        const page = await browser.newPage(options);
        await page.route(app + "/**", route => {
            const n = new URL(route.request().url()).pathname.slice(1);
            return n ? route.fulfill({ path: movieAssetPath(n) })
                : route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/movies.css"><main class="movie-library"><section class="movie-player movie-expanded"><video></video></section></main>' });
        });
        await page.goto(app + "/");
        await page.evaluate(async () => {
            const { buildPlayerUi } = await import("/movie-player-ui.js");
            const media = document.querySelector("video"), surface = document.querySelector(".movie-player");
            const back = document.createElement("button");
            const pick = () => {
                const label = document.createElement("label"), select = document.createElement("select");
                label.append(select);
                return select;
            };
            const audioPick = pick(), subtitlePick = pick();
            const original = new Option("Original", 0);
            original.dataset.language = "original";
            audioPick.add(original);
            subtitlePick.add(new Option("Off", -1));
            const ui = buildPlayerUi({ media, surface, back, signal: new AbortController().signal, title: "Test",
                notice: document.createElement("p"), audioPick, subtitlePick, findAudio() {} });
            surface.append(ui.root);
        });
        await page.waitForFunction(() => document.querySelector("link[data-movie-player]")?.sheet);
        const mute = page.getByRole("button", { name: "Mute", exact: true });
        const tracks = page.getByRole("button", { name: "Audio & Subtitles", exact: true });
        const slider = page.getByRole("slider", { name: "Volume" });
        assert.equal(await mute.count(), Number(expectVolume), `${name}: desktop mute control`);
        assert.equal(await slider.count(), 0, `${name}: the slider starts collapsed`);
        if (expectVolume) {
            await mute.hover();
            await slider.waitFor();
            await slider.fill("50");
            assert.equal(await page.evaluate(() => document.querySelector("video").volume), .5);
            await mute.click();
            assert.equal(await page.evaluate(() => document.querySelector("video").muted), true);
            await page.getByRole("button", { name: "Unmute" }).click();
            await slider.fill("150");
            await page.getByText("Volume above 100% can distort.").waitFor();
            for (const value of ["0", "200"]) {
                await slider.fill(value);
                assert.equal(await slider.getAttribute("aria-valuetext"), value + "%");
                assert.equal(await page.locator(".movie-volume-tip").textContent(), value + "%");
            }
            await slider.fill("150");
            await tracks.press("Enter");
            await page.getByText("Sound options", {exact: true}).click();
            await page.getByRole("radio", { name: "Night mode" }).click();
            assert.equal(await page.getByRole("radio", { name: "Night mode" }).getAttribute("aria-checked"), "true");
            assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("familyhub.movie.sound.v1"))), { volume: 1.5, muted: false, mode: "night", device: "" });
            await page.getByRole("button", { name: "Close audio and subtitles" }).press("Enter");
            assert.equal(await tracks.evaluate(node => node === document.activeElement), true);
        } else {
            await tracks.press("Enter");
            assert.equal(await page.getByText("Sound options", {exact: true}).count(), 0);
            if (name === "tv") {
                const controls = page.locator(".movie-ui").locator("button:visible, select:visible, input:visible");
                assert.ok(await controls.count() > 0);
                const undersized = await controls.evaluateAll(nodes => nodes.flatMap(node => {
                    const {width, height} = node.getBoundingClientRect();
                    if (width >= 60 && height >= 60) return [];
                    const classes = [...node.classList].map(name => `.${name}`).join("");
                    return [{selector: `${node.localName}${classes}`, label: node.getAttribute("aria-label"), width, height}];
                }));
                assert.deepEqual(undersized, [], "TV targets below 60 × 60 CSS px");
                const close = page.getByRole("button", { name: "Close audio and subtitles" });
                const original = page.getByRole("radio", { name: "Original", exact: true });
                const find = page.getByRole("button", { name: "Find English audio" });
                for (const control of [close, original, find]) {
                    assert.deepEqual(await control.evaluate(node => [
                        document.activeElement === node, node.matches(":focus-visible"), getComputedStyle(node).outlineWidth
                    ]), [true, true, "4px"], await control.getAttribute("aria-label"));
                    await page.keyboard.press("Tab");
                }
            }
        }
        await page.close();
    }
    await browser.close();
    console.log("Desktop volume, mute, modes and persistence passed. Phone and television profiles use hardware volume.");
})().catch(e => { console.error(e); process.exit(1); });
