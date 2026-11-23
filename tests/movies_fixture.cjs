const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]
}));

const root = path.resolve(__dirname, "..");
const output = path.resolve(process.argv[2] || path.join(root, ".local/downloads-preview"));
const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };

async function moviePage(page) {
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (name === "shell.css") return route.fulfill({path: path.join(root, "music_web/static/shell.css")});
        if (name) return route.fulfill({path: path.join(root, "clients/FamilyHub.App/wwwroot", name)});
        return route.fulfill({contentType: "text/html", body: `
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css">
            <style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style>
            <main class="movie-library"></main>`});
    });
    await page.goto(app);
}

async function verifyMovieProfiles(verify) {
    fs.mkdirSync(output, {recursive: true});
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch({headless: true});
        try {
            for (const [profile, options] of [
                ["1280", {viewport: {width: 1280, height: 850}}],
                ["2000", {viewport: {width: 2000, height: 1000}}],
                ["pixel7", devices["Pixel 7"]],
                ["iphone13", devices["iPhone 13"]]
            ]) {
                const { defaultBrowserType, ...context } = options;
                await verify(browser, engine.name() + "-" + profile, {...context, reducedMotion: "reduce"});
            }
        } finally {
            await browser.close();
        }
    }
}

module.exports = { app, jellyfin, cors, output, moviePage, verifyMovieProfiles };
