const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const root = path.resolve(__dirname, "..");
const assets = path.join(root, "clients/FamilyHub.App/wwwroot");
const output = path.resolve(process.argv[2] || path.join(root, ".local/release-search-preview"));
const title = "Regular Show Season 1";
const pack = "Regular Show 2010 S01 720p WEBRip x264 [i_c]";
const bundle = "Regular Show - S01 & 2 w/ commentary - 1080p BrRip x264";
const fixture = [
    { title: pack, source: "The Pirate Bay", size: 1687928086, seeders: 82, leechers: 14 },
    { title: pack, source: "Knaben", size: 1687928086, seeders: 82, leechers: 14 },
    { title: "Regular Show S01", source: "The Pirate Bay", size: 1145434798, seeders: 1, leechers: 0 },
    { title: bundle, source: "The Pirate Bay", size: 13633085882, seeders: 0, leechers: 1 }
];

function makePreview() {
    const shell = fs.readFileSync(path.join(root, "music_web/static/shell.css"), "utf8");
    const css = fs.readFileSync(path.join(assets, "movies.css"), "utf8");
    const panel = fs.readFileSync(path.join(assets, "movie-releases.js"), "utf8").replace("export function", "function");
    fs.mkdirSync(output, { recursive: true });
    const preview = path.join(output, "release-search.html");
    fs.writeFileSync(preview, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FamilyHub Movies & TV · Release search</title>
<style>${shell}\n${css}
html,body{height:auto;min-height:100vh;overflow:auto}body{display:block;padding:clamp(1rem,4vw,3rem);background:#0b0d12}
h1{font-size:clamp(1.5rem,4vw,2.25rem);margin:0 0 1rem;letter-spacing:-.025em}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body><main class="movie-library"><h1>Movies &amp; TV</h1></main>
<script>${panel}
const sample = ${JSON.stringify(fixture)};
const release = buildReleaseSearch(async term => {
    await new Promise(resolve => setTimeout(resolve, 140));
    const words = term.toLowerCase().replace(/\\b(?:season\\s+0?1|s01)\\b/g, "s01").split(/\\s+/);
    return { results: sample.filter(item => words.every(word => item.title.toLowerCase().includes(word))) };
});
document.querySelector("main").append(release);
release.open = true;
release.querySelector('[name="query"]').value = ${JSON.stringify(title)};
release.querySelector("form").requestSubmit();
</script></body></html>`);
    return preview;
}

async function verify(browser, preview, name, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(8000);
    await page.goto(require("node:url").pathToFileURL(preview).href);
    const query = page.getByRole("searchbox", { name: "Title" });
    const submit = page.getByRole("button", { name: "Search releases" });
    const speed = page.getByRole("spinbutton", { name: "Assumed upload (Mbps)" });
    const results = page.getByRole("list", { name: "Release results" });
    const candidate = results.getByRole("listitem").first();
    await page.getByRole("status").filter({ hasText: "3 releases" }).waitFor();
    assert.match(await candidate.innerText(), /82 seeders · 14 leechers/);
    assert.match(await candidate.innerText(), /3.14 GiB for 2.0× · 45 min/);
    assert.match(await results.getByRole("listitem").last().innerText(), /1080p.*0 seeders/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });

    await query.fill("Nothing matching");
    await query.press("Enter");
    await page.getByRole("status").filter({ hasText: "No releases found" }).waitFor();
    const focused = locator => locator.evaluate(node => node === document.activeElement);
    assert.equal(await focused(submit), true);
    await page.keyboard.press("Tab");
    assert.equal(await focused(speed), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(submit), true);
    await query.fill(title);
    await submit.focus();
    await page.keyboard.press("Space");
    await candidate.waitFor();
    const budget = page.getByRole("spinbutton", { name: "Upload time budget (hours)" });
    await budget.fill("0.1");
    assert.match(await candidate.innerText(), /Over time budget/);
    await speed.fill("100");
    assert.doesNotMatch(await candidate.innerText(), /Over time budget/);
    const toggle = page.getByText("Release search", { exact: true }).first();
    if (options.hasTouch) await toggle.tap();
    else { await toggle.focus(); await page.keyboard.press("Enter"); }
    await query.waitFor({ state: "hidden" });
    assert.equal(await focused(toggle), true);
    await page.close();
}

async function verifyRanking(browser, preview) {
    const page = await browser.newPage();
    await page.goto(require("node:url").pathToFileURL(preview).href);
    await page.evaluate(() => {
        const panel = buildReleaseSearch(async term => term === "Failure" ? { error: "The sources did not respond. Try again." } : {
            results: [
                { title: "Series 720p", size: 1687928086, seeders: 20, leechers: 5, source: "Fixture" },
                { title: "Series 1080p", size: 13633085882, seeders: 14, leechers: 4, source: "Fixture" }
            ]
        });
        document.querySelector("details").replaceWith(panel);
        panel.open = true;
    });
    const query = page.getByRole("searchbox", { name: "Title" });
    await query.fill("Series");
    await query.press("Enter");
    const firstTitle = page.getByRole("listitem").first().locator("strong");
    await firstTitle.waitFor();
    assert.equal(await firstTitle.textContent(), "Series 1080p");
    await page.getByRole("spinbutton", { name: "Upload time budget (hours)" }).fill("1");
    assert.equal(await firstTitle.textContent(), "Series 720p");
    await query.fill("Failure");
    await query.press("Enter");
    await page.getByRole("status").filter({ hasText: "The sources did not respond. Try again." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Search releases" }).getAttribute("aria-disabled"), null);
    await page.close();
}

(async () => {
    const preview = makePreview();
    for (const [engine, profiles] of [
        [chromium, [["windows", { viewport: { width: 1280, height: 850 } }], ["android", devices["Pixel 7"]]]],
        [webkit, [["mac", { viewport: { width: 1280, height: 850 } }], ["iphone", { ...devices["iPhone 13"], reducedMotion: "reduce" }]]]
    ]) {
        const browser = await engine.launch();
        try {
            for (const [name, options] of profiles) await verify(browser, preview, name, options);
            await verifyRanking(browser, preview);
        }
        finally { await browser.close(); }
    }
    console.log(`Release search controls and four browser profiles passed. ${preview}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
