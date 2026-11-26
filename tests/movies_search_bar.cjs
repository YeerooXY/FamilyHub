// Movies Home keeps its black search field in the app's top bar, centred and always visible
// (docs/design/1-6-0-movies-spec.md, "Search (Home only)"). The fixture loads hub.css and the
// Movies workspace like the app host, so a shell rule that hides the header's centre column fails here.
const assert = require("node:assert/strict");
const {constants, setPriority} = require("node:os");
const {chromium, webkit, devices} = require(require.resolve("playwright", {
    paths: [process.cwd(), require("node:path").resolve(__dirname, "../../agent-dock")]
}));
const {movieHomeFixture} = require("./movies_fixture.cjs");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const profiles = [
    [chromium, "windows-1280", {viewport: {width: 1280, height: 850}}],
    [chromium, "windows-1920", {viewport: {width: 1920, height: 1000}}],
    [chromium, "windows-2000", {viewport: {width: 2000, height: 1000}}],
    [chromium, "android-pixel7", devices["Pixel 7"]],
    [webkit, "mac-1280", {viewport: {width: 1280, height: 850}}],
    [webkit, "iphone13", devices["iPhone 13"]]
];

async function geometry(page) {
    return page.evaluate(() => {
        const header = document.querySelector(".app-header"), field = header?.querySelector(".header-search .movie-search");
        if (!field) return null;
        const box = node => node.getBoundingClientRect();
        const h = box(header), f = box(field), input = field.querySelector("input");
        return {
            headerCentre: h.left + h.width / 2, fieldCentre: f.left + f.width / 2,
            inHeader: f.top >= h.top - 1 && f.bottom <= h.bottom + 1, width: f.width, height: f.height,
            visible: field.checkVisibility() && input.checkVisibility(),
            background: getComputedStyle(field).backgroundColor,
            title: [...document.querySelectorAll("h1")].some(node => node.checkVisibility() && /Movies & TV/.test(node.textContent))
        };
    });
}

async function check(browser, name, {defaultBrowserType, ...options}) {
    const page = await browser.newPage({...options, reducedMotion: "reduce"});
    page.setDefaultTimeout(8000);
    try {
        await movieHomeFixture(page, {matches: [{id: 42, title: "Moon Signal", kind: "movie", year: 2022}]});
        const at = await geometry(page);
        assert.ok(at, `${name}: search field is in the top bar`);
        assert.equal(at.visible, true, `${name}: search field visible`);
        assert.equal(at.inHeader, true, `${name}: search field inside the top bar`);
        assert.ok(at.width >= 150 && at.height >= 36, `${name}: search field size ${at.width}x${at.height}`);
        assert.equal(at.background, "rgb(5, 5, 8)", `${name}: black field`);
        assert.equal(at.title, false, `${name}: no Movies & TV title text`);
        const phone = (options.viewport?.width ?? 1280) <= 720;
        // Phones keep the launcher and avatar columns, so the field is centred in its own column.
        const centre = phone ? await page.evaluate(() => {
            const column = document.querySelector(".app-header .header-search").getBoundingClientRect();
            return column.left + column.width / 2;
        }) : at.headerCentre;
        assert.ok(Math.abs(at.fieldCentre - centre) <= 8, `${name}: field centre ${at.fieldCentre} vs ${centre}`);

        // A title missing from the library reaches the release search from this field.
        const query = page.locator(".app-header .movie-search input");
        await query.fill("Moon Signal");
        const find = page.getByRole("button", {name: /Find releases for Moon Signal/});
        await find.waitFor();
        await find.press("Enter");
        await page.waitForFunction(() => window.movieCalls.some(([method, term]) => method === "MovieReleaseSearch" && term === "Moon Signal 2022"));
        await page.keyboard.press("Escape");
        await query.fill("");
        await page.keyboard.press("Escape");

        // Other Movies screens hide the field.
        await page.locator(".movie-shelf .movie-card").first().press("Enter");
        await page.getByRole("button", {name: "Back to titles"}).waitFor();
        assert.equal(await query.isVisible(), false, `${name}: hidden on a title page`);
        await page.getByRole("button", {name: "Back to titles"}).press("Enter");
        await page.waitForFunction(() => document.querySelector(".app-header .movie-search input")?.checkVisibility());
        console.log(`${name}: centred within ${Math.abs(at.fieldCentre - centre).toFixed(1)} px`);
    } finally { await page.close(); }
}

(async () => {
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch({headless: true});
        try {
            for (const [type, name, options] of profiles) if (type === engine) await check(browser, name, options);
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
