// Typing in the Movies search must never move the page (the app content area used to reserve 76 px above focused fields).
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));
const root = path.resolve(__dirname, ".."), assets = path.join(root, "clients/FamilyHub.App/wwwroot");
(async () => {
    for (const [engine, name] of [[chromium, "Chromium"], [webkit, "WebKit"]]) {
        const browser = await engine.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
            await page.route("http://f.test/**", route => {
                const n = new URL(route.request().url()).pathname.slice(1);
                if (n === "shell.css") return route.fulfill({ path: path.join(root, "music_web/static/shell.css") });
                if (n) return route.fulfill({ path: path.join(assets, n) });
                return route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/app-native.css"><link rel="stylesheet" href="/movies.css"><div class="workspace" style="height:100dvh"><main id="content"><h1>Movies &amp; TV</h1><div class="movie-library"></div><div style="height:1500px"></div></main></div>' });
            });
            await page.route("https://j.test/**", route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { Items: [], TotalRecordCount: 0 } }));
            await page.goto("http://f.test");
            await page.evaluate(async () => { const { openMovies } = await import("/movies.js"); openMovies(document.querySelector(".movie-library"), { url: "https://j.test", user: "u", token: "t", device: "d" }, { invokeMethodAsync: async () => "{}" }); });
            await page.waitForTimeout(500);
            const pos = () => page.evaluate(() => ({ scroll: document.getElementById("content").scrollTop, bar: Math.round(document.querySelector(".movie-toolbar").getBoundingClientRect().top) }));
            await page.evaluate(() => { document.getElementById("content").scrollTop = 300; });
            await page.waitForTimeout(100);
            await page.click("input[type=search]");
            const before = await pos();
            for (const ch of "great gatsby") { await page.keyboard.type(ch); await page.waitForTimeout(40); }
            assert.deepEqual(await pos(), before, `${name}: typing moved the page`);
        } finally { await browser.close(); }
    }
    console.log("Typing in Movies search does not move the page (Chromium and WebKit).");
})().catch(e => { console.error(e); process.exitCode = 1; });
