const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const root = path.resolve(__dirname, "..");
const assets = path.join(root, "clients/FamilyHub.App/wwwroot");
const output = path.resolve(process.argv[2] || path.join(root, ".local/release-search-preview"));
const title = "The Gentlemen S2";
const pack = "The.Gentlemen.S02.1080p.NF.WEB-DL.DDP5.1.ENG.Atmos.ITA.H265-TBK";
const fixture = [
    { title: pack, source: "The Pirate Bay", size: 17244393718, seeders: 390, leechers: 157 },
    { title: pack, source: "Knaben", size: 17244393718, seeders: 378, leechers: 145 },
    { title: "The Gentlemen S02 720p WEB-DL", source: "The Pirate Bay", size: 2000000000, seeders: 22, leechers: 5 },
    { title: "The Gentlemen S02 2160p", source: "Knaben", size: 30500000000, seeders: 0, leechers: 1 }
];

async function verify(browser, name, options) {
    const page = await browser.newPage(options);
    try {
        await page.route(app + "/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (name === "shell.css") return route.fulfill({path: path.join(root, "music_web/static/shell.css")});
            if (name) return route.fulfill({path: path.join(assets, name)});
            return route.fulfill({contentType:"text/html", body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/movies.css"><style>html,body{height:auto;min-height:100dvh;overflow:auto}body{display:block;padding:1rem;background:#0b0d12}</style><main class="movie-library"></main>'});
        });
        await page.route(jellyfin + "/**", route => {
            const headers = {"Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization,content-type"};
            if (route.request().method() === "OPTIONS") return route.fulfill({status:204, headers});
            const url = new URL(route.request().url());
            if (url.searchParams.get("searchTerm") === "Catalogued Show") {
                assert.equal(url.searchParams.get("includeItemTypes"), "Series");
                return route.fulfill({headers, json:{Items:[{Id:"show", Name:"Catalogued Show"}], TotalRecordCount:1}});
            }
            if (url.pathname === "/Shows/show/Episodes") {
                assert.equal(url.searchParams.get("season"), "2");
                return route.fulfill({headers, json:{Items:[
                    {Id:"first", Name:"First Season", Type:"Episode", ParentIndexNumber:1},
                    {Id:"second", Name:"Second Season", Type:"Episode", ParentIndexNumber:2}
                ]}});
            }
            return route.fulfill({headers, json:{Items:[], TotalRecordCount:0}});
        });
        await page.goto(app);
        await page.evaluate(async ({jellyfin, fixture}) => {
            const {openMovies} = await import("/movies.js");
            window.calls = [];
            openMovies(document.querySelector("main"), {url:jellyfin, user:"fixture", token:"fixture", device:"fixture", release_search_enabled:true, requests_enabled:true}, {
                invokeMethodAsync: async (method, term, ...args) => {
                    window.calls.push([method, term, ...args]);
                    if (method === "MovieFind") return JSON.stringify({results: term === "The Gentlemen S2" ? [
                        {title:"The Gentlemen trailer", url:"https://www.youtube.com/watch?v=fixture0000", label:"trailer"}
                    ] : []});
                    if (method === "MovieRequestSearch") return JSON.stringify(term === "The Gentlemen S2" ? {season:2, results:[
                        {kind:"tv", id:12, title:"The Gentlemen", year:"2024"}
                    ]} : {results:[]});
                    if (method === "MovieRequest") return JSON.stringify({state:"approved"});
                    if (method !== "MovieReleaseSearch") return "";
                    if (term === "Slow search") return new Promise(resolve => window.finishSlow = () => resolve(JSON.stringify({results:fixture})));
                    if (term === "Unavailable" && !window.recovered) {
                        window.recovered = true;
                        return JSON.stringify({error:"The sources did not respond. Try again."});
                    }
                    if (term === "Unavailable") return JSON.stringify({results:fixture});
                    return JSON.stringify(term === "The Gentlemen S2" ? {results:fixture, unavailable:0} : {results:[], unavailable:0});
                }
            });
        }, {jellyfin, fixture});
        const query = page.getByRole("searchbox");
        const focus = locator => locator.evaluate(node => node === document.activeElement);
        const submit = page.getByRole("button", {name:"Search", exact:true});
        const result = page.getByRole("list", {name:"Release results"});
        const search = async term => {
            await query.fill(term);
            await query.press("Enter");
        };
        await search(title);
        const download = page.getByRole("button", {name:"Request season 2: The Gentlemen (2024)"});
        await download.waitFor();
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.getByRole("heading", {name:"In your library", exact:true}).isVisible(), false);
        assert.equal(await focus(submit), true);
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieReleaseSearch"), [["MovieReleaseSearch", title]]);
        await page.screenshot({path:path.join(output, name + ".png"), fullPage:true});
        const disclosure = page.getByText("3 releases", {exact:true});
        await disclosure.focus();
        await page.keyboard.press("Space");
        assert.equal(await focus(disclosure), true);
        const first = result.getByRole("listitem").first();
        assert.equal(await result.getByRole("listitem").count(), 3);
        // Facts first, in plain words: what it is, what it holds, how big, how long, how easy to get. No seeders, leechers or upload settings.
        const text = await first.innerText();
        assert.match(text, /Recommended/);
        assert.match(text, /1080p Web/);
        assert.match(text, /Full season 2/);
        assert.match(text, /^The Gentlemen\n/);
        assert.match(text, /Size\s+16\.1 GB/);
        assert.match(text, /Download time\s+about 23 min/);
        assert.match(text, /Availability\s+Very easy to get/);
        assert.doesNotMatch(text, /seeder|leecher|Upload|The Pirate Bay|Knaben/);
        assert.equal(await first.locator(".movie-release-quality").getAttribute("data-level"), "web");
        assert.equal(await page.getByText("Times assume a 100 Mbps connection.").isVisible(), true);
        assert.equal(await page.getByRole("spinbutton").count(), 0);
        const second = result.getByRole("listitem").nth(1);
        assert.match(await second.innerText(), /720p.*Full season 2.*1\.9 GB.*Easy to get/s);
        assert.equal(await second.locator(".movie-release-quality").getAttribute("data-level"), "hd");
        const none = result.getByRole("listitem").nth(2);
        assert.match(await none.innerText(), /4K.*Hard to get/s);
        assert.equal(await none.locator(".movie-release-quality").getAttribute("data-level"), "uhd");
        assert.doesNotMatch(await none.innerText(), /about \d+ (?:min|h)/);
        // The action is present on every tile and explains itself while downloads are off for the profile.
        const action = first.getByRole("button", {name: /^Download The Gentlemen/});
        assert.equal(await action.getAttribute("aria-disabled"), "true");
        // Sorting by file size puts the smallest first; sorting by quality puts 4K first.
        await page.getByRole("button", {name: "Smallest file", exact: true}).click();
        assert.match(await result.getByRole("listitem").first().innerText(), /720p/);
        await page.getByRole("button", {name: "Quality", exact: true}).click();
        assert.match(await result.getByRole("listitem").first().innerText(), /4K/);
        await page.getByRole("button", {name: "Best match", exact: true}).click();
        assert.equal(await first.locator("strong").textContent(), pack);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await page.screenshot({path:path.join(output, name + "-releases.png"), fullPage:true});
        const related = page.getByText("YouTube results", {exact:true});
        if (options.hasTouch) await related.tap();
        else await related.press("Enter");
        await page.getByRole("link", {name:"The Gentlemen trailer"}).waitFor();
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieFind"), [["MovieFind", title]]);
        assert.equal(await first.locator("strong").textContent(), pack);
        await download.press("Space");
        const approved = page.getByText("Request approved");
        await approved.waitFor();
        assert.equal(await focus(approved), true);
        assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["MovieRequest", "tv", 12, 2]);
        await search("Nothing matching");
        await page.getByRole("status").filter({hasText:"No watch or download options found"}).waitFor();
        assert.equal(await result.isVisible(), false);
        await search("Unavailable");
        const retry = page.getByRole("button", {name:"Retry release lookup"});
        await retry.waitFor();
        await page.getByRole("status").filter({hasText:"The sources did not respond"}).waitFor();
        await retry.press("Enter");
        await disclosure.waitFor();
        assert.equal(await focus(disclosure), true);
        await search("Slow search");
        await page.waitForFunction(() => typeof finishSlow === "function");
        await page.getByRole("button", {name:"Clear", exact:true}).click();
        await page.evaluate(() => finishSlow());
        assert.equal(await result.count(), 0);
        assert.equal(await focus(query), true);
        const count = await page.evaluate(() => calls.length);
        await search("Catalogued Show Season 2");
        const local = page.getByRole("button", {name:"Second Season", exact:true});
        await local.waitFor();
        assert.equal(await page.getByRole("button", {name:"First Season", exact:true}).count(), 0);
        assert.equal(await page.evaluate(() => calls.length), count);
        await page.screenshot({path:path.join(output, name + "-library.png"), fullPage:true});
    } finally { await page.close(); }
}

(async () => {
    fs.mkdirSync(output, {recursive:true});
    for (const [engine, profiles] of [
        [chromium, [["windows", {viewport:{width:1280,height:850}}], ["android", devices["Pixel 7"]],
            ["wide", {viewport:{width:2000,height:1000}}]]],
        [webkit, [["mac", {viewport:{width:1280,height:850}}], ["iphone", {...devices["iPhone 13"], reducedMotion:"reduce"}]]]
    ]) {
        const browser = await engine.launch();
        try { for (const [name, options] of profiles) await verify(browser, name, options); }
        finally { await browser.close(); }
    }
    console.log("Integrated release search passed in four browser profiles.");
})().catch(error => { console.error(error); process.exitCode = 1; });
