// Round 5 player gestures: hold for 2x, double-tap to skip 10 s, the pause screen. A stub video stands in for the stream.
const assert = require("node:assert/strict");
const {constants, setPriority} = require("node:os");
const path = require("node:path");
const {chromium} = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
const {moviePage} = require("./movies_fixture.cjs");
setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

async function openPlayer(browser, options) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.clock.install({time: 0});
    await moviePage(page);
    await page.evaluate(async () => {
        const {buildPlayerUi} = await import("/movie-player-ui.js");
        const surface = document.createElement("section");
        surface.className = "movie-player movie-expanded";
        const media = document.createElement("video");
        let paused = true;
        Object.defineProperties(media, {
            paused: {get: () => paused}, duration: {value: 100}, currentTime: {value: 20, writable: true},
            volume: {value: 1, writable: true}, muted: {value: false, writable: true}
        });
        media.play = async () => { paused = false; media.dispatchEvent(new Event("play")); };
        media.pause = () => { paused = true; media.dispatchEvent(new Event("pause")); };
        const pick = () => { const label = document.createElement("label"), select = document.createElement("select"); label.append(select); return select; };
        const back = document.createElement("button");
        const ui = buildPlayerUi({
            media, surface, back, signal: new AbortController().signal, kicker: "Night Signal", title: "S1:E2 “The Crossing”",
            description: "The crew follows a radio signal across the harbour.", notice: document.createElement("p"),
            audioPick: pick(), subtitlePick: pick(), fullscreenEnabled: false, isFullscreen: () => false, appFullscreen: () => false,
            setFullscreen: async () => true
        });
        surface.append(media, ui.root);
        document.querySelector("main").append(surface);
        window.fixtureMedia = media;
    });
    return {context, page};
}

const state = page => page.evaluate(() => ({rate: fixtureMedia.playbackRate, time: fixtureMedia.currentTime,
    badge: !document.querySelector(".movie-ui-fast").hidden, idle: document.querySelector(".movie-ui").classList.contains("movie-idle"),
    pause: !document.querySelector(".movie-pause-screen").hidden}));
const touch = (page, type, selector = ".movie-ui-surface", x = .5) => page.evaluate(({type, selector, x}) => {
    const node = document.querySelector(selector), box = node.getBoundingClientRect();
    node.dispatchEvent(new PointerEvent(type, {pointerType: "touch", pointerId: 3, isPrimary: true, bubbles: true, cancelable: true,
        clientX: box.left + box.width * x, clientY: box.top + box.height / 2}));
}, {type, selector, x});

async function checkTouch(browser) {
    const {context, page} = await openPlayer(browser, {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, reducedMotion: "reduce"});
    try {
        await page.evaluate(() => { fixtureMedia.playbackRate = 1.25; return fixtureMedia.play(); });
        // A short press does nothing. A press held for half a second plays at 2x until it is released, then the speed comes back.
        await touch(page, "pointerdown");
        await page.clock.fastForward(200);
        await touch(page, "pointerup");
        assert.equal((await state(page)).rate, 1.25);
        await touch(page, "pointerdown");
        await page.clock.fastForward(600);
        assert.deepEqual([(await state(page)).rate, (await state(page)).badge], [2, true]);
        await touch(page, "pointerup");
        assert.deepEqual([(await state(page)).rate, (await state(page)).badge], [1.25, false]);

        // A single tap still shows and hides the controls. Reduced motion removes the fade, never the hiding.
        await page.clock.fastForward(3500);
        assert.equal((await state(page)).idle, true);
        const surface = page.locator(".movie-ui-surface");
        await surface.tap({position: {x: 190, y: 400}});
        assert.equal((await state(page)).idle, false);
        await page.clock.fastForward(400);
        await surface.tap({position: {x: 190, y: 400}});
        assert.equal((await state(page)).idle, true);
        assert.equal((await state(page)).time, 20, "single taps never seek");

        // Two quick taps on one side skip 10 s, and the controls end as they began.
        await page.clock.fastForward(400);
        await surface.tap({position: {x: 300, y: 400}});
        await surface.tap({position: {x: 300, y: 400}});
        assert.deepEqual([(await state(page)).time, (await state(page)).idle], [30, true]);
        await page.clock.fastForward(400);
        await surface.tap({position: {x: 60, y: 400}});
        await surface.tap({position: {x: 60, y: 400}});
        assert.equal((await state(page)).time, 20);
        await page.clock.fastForward(400);
        await surface.tap({position: {x: 60, y: 400}});
        await page.clock.fastForward(400);
        await surface.tap({position: {x: 60, y: 400}});
        assert.equal((await state(page)).time, 20, "slow taps are not a double tap");
    } finally { await context.close(); }
}

async function checkPause(browser, reducedMotion) {
    const {context, page} = await openPlayer(browser, {viewport: {width: 1280, height: 850}, reducedMotion});
    try {
        await page.evaluate(() => fixtureMedia.play());
        await page.clock.fastForward(60000);
        assert.equal((await state(page)).pause, false, "no pause screen while playing");
        await page.evaluate(() => fixtureMedia.pause());
        await page.clock.fastForward(29000);
        assert.equal((await state(page)).pause, false, "not before 30 s");
        await page.clock.fastForward(1500);
        const screen = page.locator(".movie-pause-screen");
        assert.equal(await screen.isVisible(), true);
        assert.equal(await screen.getAttribute("aria-hidden"), "true");
        assert.deepEqual(await screen.locator("p, h2").allTextContents(),
            ["Night Signal", "S1:E2 “The Crossing”", "The crew follows a radio signal across the harbour."]);
        assert.equal(await screen.evaluate(node => getComputedStyle(node).animationName), reducedMotion === "reduce" ? "none" : "movie-pause-in");
        // Any input dismisses it, and a paused player shows it again after another 30 s.
        await page.mouse.move(200, 200);
        await page.mouse.move(240, 260);
        assert.equal((await state(page)).pause, false);
        await page.clock.fastForward(30500);
        assert.equal((await state(page)).pause, true);
        await page.keyboard.press("Shift");
        assert.equal((await state(page)).pause, false);
        await page.clock.fastForward(30500);
        assert.equal((await state(page)).pause, true);
        // Playing again removes it for good.
        await page.evaluate(() => fixtureMedia.play());
        assert.equal((await state(page)).pause, false);
        await page.clock.fastForward(60000);
        assert.equal((await state(page)).pause, false);
    } finally { await context.close(); }
}

async function checkDesktop(browser) {
    const {context, page} = await openPlayer(browser, {viewport: {width: 1280, height: 850}});
    try {
        await page.evaluate(() => fixtureMedia.play());
        // Arrow keys still seek, and holding Right on a desktop never changes the speed.
        await page.keyboard.press("ArrowRight");
        assert.equal((await state(page)).time, 30);
        await page.keyboard.down("ArrowRight");
        await page.keyboard.down("ArrowRight");
        await page.keyboard.up("ArrowRight");
        assert.deepEqual([(await state(page)).rate, (await state(page)).badge], [1, false]);
        assert.ok((await state(page)).time >= 50);
        // A mouse click on the picture still toggles playback.
        const before = await page.evaluate(() => fixtureMedia.paused);
        await page.locator(".movie-ui-surface").click({position: {x: 400, y: 300}});
        await page.clock.fastForward(300);
        assert.equal(await page.evaluate(() => fixtureMedia.paused), !before);
    } finally { await context.close(); }
}

async function checkTv(browser) {
    const {context, page} = await openPlayer(browser, {viewport: {width: 1920, height: 1080}, userAgent: "Mozilla/5.0 (SmartTV; Tizen 6.0) AppleWebKit/537.36 Chrome/94 TV Safari/537.36"});
    try {
        await page.evaluate(() => fixtureMedia.play());
        await page.keyboard.down("ArrowRight");
        assert.equal((await state(page)).rate, 1, "the first press only seeks or moves focus");
        await page.keyboard.down("ArrowRight");
        await page.keyboard.down("ArrowRight");
        assert.deepEqual([(await state(page)).rate, (await state(page)).badge], [2, true]);
        await page.keyboard.up("ArrowRight");
        assert.deepEqual([(await state(page)).rate, (await state(page)).badge], [1, false]);
        // Pausing while the key is held also restores the speed.
        await page.keyboard.down("ArrowRight");
        await page.keyboard.down("ArrowRight");
        await page.evaluate(() => fixtureMedia.pause());
        assert.equal((await state(page)).rate, 1);
        await page.keyboard.up("ArrowRight");
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        await checkTouch(browser);
        await checkPause(browser, "reduce");
        await checkPause(browser, "no-preference");
        await checkDesktop(browser);
        await checkTv(browser);
    } finally { await browser.close(); }
    console.log("Movie player hold, double-tap and pause screen checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
