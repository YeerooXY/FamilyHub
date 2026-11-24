const { useMovieBridge } = require("./movies_fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {output: verification, verifyMovieProfiles} = require("./movies_fixture.cjs");

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const root = path.resolve(__dirname, "..");
const assets = path.join(root, "clients/FamilyHub.App/wwwroot");
const output = path.join(root, ".local/release-search-preview");
const title = "The Gentlemen S2";
const pack = "The.Gentlemen.S02.1080p.NF.WEB-DL.DDP5.1.ENG.Atmos.ITA.H265-TBK";
const fixture = [
    { title: pack, source: "The Pirate Bay", size: 17244393718, seeders: 390, leechers: 157, guid: "reference-a", indexerId: 1 },
    { title: pack, source: "Knaben", size: 17244393718, seeders: 378, leechers: 145, guid: "reference-b", indexerId: 2 },
    { title: "The Gentlemen S02 720p WEB-DL", source: "The Pirate Bay", size: 2000000000, seeders: 22, leechers: 5 },
    { title: "The Gentlemen S02 2160p Remux", size: 30500000000, seeders: 0 },
    { title: "The Gentlemen S02 2160p BDRip x265", size: 18000000000, seeders: 0 },
    { title: "The Gentlemen S02 2160p WEB-DL", size: 15000000000, seeders: 0 },
    { title: "The Gentlemen S02 1080p Remux", size: 29000000000, seeders: 0 },
    { title: "The Gentlemen S02 1080p BluRay", size: 16000000000, seeders: 0 },
    { title: "The Gentlemen S02 DVDRip", size: 5000000000, seeders: 0 },
    { title: "The Gentlemen S02 HDCAM", size: 3000000000, seeders: 0 }
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
        await useMovieBridge(page);
        await page.goto(app);
        await page.evaluate(async ({jellyfin, fixture}) => {
            const {openMovies} = await import("/movies.js");
            const title_details = {title:"The Gentlemen", kind:"tv", season:2, runtime_minutes:440,
                episode_count:8, hungarian_title:"Úriemberek"};
            window.calls = [];
            window.movieSession = {url:jellyfin, user:"fixture", token:"fixture", device:"fixture", release_search_enabled:true, requests_enabled:true};
            window.startMovieFixture = () => window.openMovieFixture(openMovies, document.querySelector("main"), window.movieSession, {
                invokeMethodAsync: async (method, term, ...args) => {
                    if (method === "MovieDownloads") return JSON.stringify({available:true, items:window.queueItems || []});
                    window.calls.push([method, term, ...args]);
                    if (method === "MovieDownload") {
                        if (!window.downloadAttempt) {
                            window.downloadAttempt = 1;
                            return JSON.stringify({error:"Prowlarr has no download client set up for this release."});
                        }
                        return new Promise(resolve => window.confirmGrab = () => resolve(JSON.stringify({state:"sent"})));
                    }
                    if (method === "MovieFind") return JSON.stringify({results: term === "The Gentlemen S2" ? [
                        {title:"The Gentlemen trailer", url:"https://www.youtube.com/watch?v=fixture0000", label:"trailer", seconds:120}
                    ] : []});
                    if (method === "MovieRequestSearch") return JSON.stringify(term === "The Gentlemen S2" ? {season:2, title_details, results:[
                        {kind:"tv", id:12, title:"The Gentlemen", year:"2024"}
                    ]} : {results:[]});
                    if (method === "MovieRequest") return JSON.stringify({state:"approved"});
                    if (method === "MovieVideaSearch") return JSON.stringify({results:[]});
                    if (method === "MovieMatches") return JSON.stringify(term === "The Gentlemen S2" ? {matches:[
                        {id:1, kind:"tv", title:"The Gentlemen", year:2024, poster:"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 2 3%27%3E%3Crect width=%272%27 height=%273%27 fill=%27%23355a6e%27/%3E%3C/svg%3E", overview:""},
                        {id:2, kind:"movie", title:"The Gentlemen", year:2019, poster:null, overview:""},
                        {id:3, kind:"movie", title:"Gentlemen Broncos", year:2009, poster:null, overview:""}]} : {matches:[]});
                    if (method !== "MovieReleaseSearch") return "";
                    if (term === "Slow search") return new Promise(resolve => window.finishSlow = () => resolve(JSON.stringify({results:fixture})));
                    if (term === "Many releases") return JSON.stringify({results:Array.from({length: 10}, (_, index) =>
                        ({title: `Release ${index + 1} 1080p`, size: 1e9, seeders: 50}))});
                    if (term === "Unavailable" && !window.recovered) {
                        window.recovered = true;
                        return JSON.stringify({error:"The sources did not respond. Try again."});
                    }
                    if (term === "Unavailable") return JSON.stringify({results:fixture});
                    if (term === "Game of Thrones") return JSON.stringify({
                        title_details:{title:"Game of Thrones", kind:"tv", runtime_minutes:3600, episode_count:73,
                            series_minutes:3600, hungarian_title:"Trónok harca"},
                        results:[
                            {title:"<b>Tr&oacute;nok Harca Full HUN</b>", size:11.1 * 1024 ** 3, seeders:10},
                            {title:"R&amp;D&#39;s &lt;b&gt;copy&lt;/b&gt; 1080p", size:2e9, seeders:1}
                        ]});
                    return JSON.stringify(term === "The Gentlemen S2" ? {results:fixture, title_details, unavailable:0} : {results:[], unavailable:0});
                }
            });
            window.movieScreen = window.startMovieFixture();
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
        await page.getByRole("heading", {name:"Matching titles", exact:true}).waitFor();
        assert.equal(await page.locator(".movie-match").count(), 3);
        assert.match(await page.locator(".movie-matches-credit").innerText(), /not endorsed or certified by TMDB/);
        await page.screenshot({path:path.join(output, name + "-matches.png"), fullPage:true});
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.getByRole("heading", {name:"In your library", exact:true}).isVisible(), false);
        assert.equal(await focus(submit), true);
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieReleaseSearch"), [["MovieReleaseSearch", title]]);
        await page.screenshot({path:path.join(output, name + ".png"), fullPage:true});
        const heading = page.getByRole("heading", {name:"Releases", exact:true});
        await heading.waitFor();
        await page.getByRole("status").filter({hasText:"9 releases found."}).waitFor();
        await page.getByText("The Gentlemen, season 2: 8 episodes, 7 h 20 min in total", {exact:true}).waitFor();
        await page.getByText("Also searched: Úriemberek", {exact:true}).waitFor();
        const guide = page.getByRole("region", {name:"Quality guide"});
        await guide.getByText("Original 4K disc video", {exact:false}).waitFor();
        assert.equal(await guide.locator("details").count(), 0);
        const first = result.getByRole("listitem").first();
        assert.equal(await result.getByRole("listitem").count(), 8);
        // Facts first, in plain words: what it is, what it holds, how big, how long, how easy to get. No seeders, leechers or upload settings.
        const text = await first.innerText();
        assert.match(text, /Recommended/);
        assert.match(text, /1080p Web/);
        assert.match(text, /Full season 2/);
        assert.match(text, /^The Gentlemen\n/);
        assert.match(text, /Size\s+16\.1 GB/);
        assert.match(text, /Length\s+7 h 20 min/);
        assert.match(text, /Download time\s+about 23 min/);
        assert.doesNotMatch(text, /Estimate based on how many people share it/);
        assert.match(text, /Availability\s+Very easy to get/);
        assert.doesNotMatch(text, /seeder|leecher|Upload|The Pirate Bay|Knaben/);
        assert.equal(await first.locator(".movie-release-quality").getAttribute("data-level"), "web");
        assert.equal(await page.getByText("Times assume a 100 Mbps connection.").isVisible(), true);
        assert.equal(await page.getByRole("spinbutton").count(), 0);
        const second = result.getByRole("listitem").nth(1);
        assert.match(await second.innerText(), /720p.*Full season 2.*1\.9 GB.*about 6 min.*Easy to get/s);
        assert.equal(await second.locator(".movie-release-quality").getAttribute("data-level"), "hd");
        const none = result.getByRole("listitem").nth(2);
        assert.match(await none.innerText(), /4K Remux.*May never finish.*Hard to get/s);
        assert.equal(await none.locator(".movie-release-quality").getAttribute("data-level"), "4k-remux");
        assert.doesNotMatch(await none.innerText(), /about \d+ (?:min|h)/);
        // The action is present on every tile and explains itself while downloads are off for the profile.
        const action = first.getByRole("button", {name: /^Download The Gentlemen/});
        assert.equal(await action.getAttribute("aria-disabled"), "true");
        // Sorting by file size puts the smallest first; sorting by quality puts 4K first.
        await page.getByRole("button", {name: "Smallest file", exact: true}).click();
        assert.match(await result.getByRole("listitem").first().innerText(), /720p/);
        await page.getByRole("button", {name: "Quality", exact: true}).click();
        await page.getByRole("button", {name:"Show all releases"}).click();
        assert.deepEqual(await result.locator(".movie-release-quality").allTextContents(),
            ["4K Remux", "4K Blu-ray", "4K Web", "1080p Remux", "1080p Blu-ray", "1080p Web", "720p", "TV or DVD", "Camera copy"]);
        await page.getByRole("button", {name: "Best match", exact: true}).click();
        assert.equal(await first.locator("strong").textContent(), pack);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await page.screenshot({path:path.join(output, name + "-releases.png"), fullPage:true});
        await page.getByRole("heading", {name:"YouTube", exact:true}).waitFor();
        await page.getByRole("heading", {name:"The Gentlemen trailer"}).waitFor();
        await page.getByText("Shorter than the season", {exact:true}).waitFor();
        await page.screenshot({path:path.join(verification, name + "-release.png"), fullPage:true, scale:"css"});
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieFind"), [["MovieFind", title]]);
        assert.equal(await first.locator("strong").textContent(), pack);
        await download.press("Space");
        const approved = page.getByText("Request approved");
        await approved.waitFor();
        assert.equal(await focus(approved), true);
        assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["MovieRequest", "tv", 12, 2]);
        await search("Game of Thrones");
        const legacy = result.getByText("Trónok Harca Full HUN", {exact:true}).first();
        await legacy.waitFor();
        const estimated = result.getByText("Estimated: about 480p or lower (from size and length)", {exact:true});
        assert.equal(await estimated.evaluate(node => getComputedStyle(node).borderTopStyle), "dashed");
        await result.getByText("R&D's copy 1080p", {exact:true}).waitFor();
        await result.getByText(/unusually small for a 1080p video/).waitFor();
        if (name === "chromium-1280" || name === "webkit-iphone13") {
            await page.screenshot({path:path.join(verification, name + "-estimated.png"), fullPage:true, scale:"css"});
        }
        await search("Nothing matching");
        await page.getByRole("status").filter({hasText:"No watch or download options found"}).waitFor();
        assert.equal(await result.isVisible(), false);
        await search("Unavailable");
        const retry = page.getByRole("button", {name:"Retry release lookup"});
        await retry.waitFor();
        await page.getByRole("status").filter({hasText:"The sources did not respond"}).waitFor();
        await retry.press("Enter");
        await heading.waitFor();
        assert.equal(await focus(heading), true);
        await search("Many releases");
        const more = page.getByRole("button", {name:"Show all releases"});
        await more.waitFor();
        assert.equal(await result.getByRole("listitem").count(), 8);
        await more.press("Space");
        assert.equal(await result.getByRole("listitem").count(), 10);
        assert.equal(await focus(result.getByRole("heading", {name:"Release 9", exact:true})), true);
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

        await page.evaluate(async () => {
            await movieScreen.close();
            movieSession.downloads_enabled = true;
            window.movieScreen = startMovieFixture();
        });
        await search(title);
        const grab = first.getByRole("button", {name: /^Download The Gentlemen/});
        await grab.waitFor();
        await grab.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focus(grab), true);
        await page.keyboard.press("Enter");
        const retryGrab = first.getByRole("button", {name:/^Try again/});
        await retryGrab.waitFor();
        assert.equal(await focus(retryGrab), true);
        await page.getByRole("status").filter({hasText:"Prowlarr has no download client"}).waitFor();
        await page.clock.install();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => typeof confirmGrab === "function");
        await page.keyboard.press("Enter");
        await page.evaluate(() => {
            window.queueItems = [{name:"The Gentlemen Season 2", progress:0, size:17244393718, state:"Waiting", eta:null, speed:0}];
            confirmGrab();
        });
        const sent = first.getByText("Sent to the server", {exact:true});
        await sent.waitFor();
        assert.equal(await focus(sent), true);
        assert.deepEqual(await page.evaluate(() => calls.filter(call => call[0] === "MovieDownload")),
            [["MovieDownload", "reference-a", 1, pack], ["MovieDownload", "reference-a", 1, pack]]);
        await page.clock.fastForward(3200);
        await page.getByRole("region", {name:"On the server"}).getByText("The Gentlemen Season 2", {exact:true}).waitFor();
        assert.equal(await focus(sent), true);
        await page.getByRole("button", {name:"Smallest file", exact:true}).click();
        await page.getByRole("button", {name:"Best match", exact:true}).click();
        assert.equal(await sent.isVisible(), true);
    } finally { await page.close(); }
}

(async () => {
    fs.mkdirSync(output, {recursive:true});
    await verifyMovieProfiles(verify);
    console.log("Integrated release search passed in eight browser profiles.");
})().catch(error => { console.error(error); process.exitCode = 1; });
