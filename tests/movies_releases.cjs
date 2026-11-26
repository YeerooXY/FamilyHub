const { useMovieBridge, movieAssetPath } = require("./movies_fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {constants, setPriority} = require("node:os");
const {homeOutput, verifyMovieProfiles} = require("./movies_fixture.cjs");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

const app = "http://familyhub.test", jellyfin = "https://jellyfin.test";
const output = process.argv[2] || homeOutput;
const title = "The Gentlemen S2";
const pack = "The.Gentlemen.S02.1080p.NF.WEB-DL.DDP5.1.ENG.Atmos.ITA.H265-TBK";
const soundCases = [
    ["Film.1080p.DDP5.1", "DDP 5.1"],
    ["Film DD+ 5.1", "DDP 5.1"],
    ["Film.DTS-HD.MA.7.1", "DTS-HD MA 7.1"],
    ["Film.DTS-X", "DTS:X"],
    ["Film.TrueHD.Atmos", "Atmos"],
    ["Film Atmos", "Atmos"],
    ["Film AAC 2.0", "AAC 2.0"],
    ["Film AC3 5.1", "AC3 5.1"],
    ["Film.FLAC", "FLAC"],
    ["Film.TrueHD.7.1", "TrueHD 7.1"],
    ["Film AAC 20", "AAC"],
    ["Film 1080p H265", null],
    ["Film AAC123", null]
];
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
        await page.route("**/*", route => [app, jellyfin].includes(new URL(route.request().url()).origin) ? route.fallback() : route.abort());
        await page.route(app + "/**", route => {
            const name = new URL(route.request().url()).pathname.slice(1);
            if (name) return route.fulfill({path: movieAssetPath(name)});
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
            const {openMovies, saveMoviePreferences} = await import("/movies.js");
            saveMoviePreferences({server:jellyfin + "/"}, {screen:"1080"});
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
                    if (method === "MovieMatches" && term === "Late artwork") return new Promise(resolve => {
                        window.finishArtwork = () => resolve(JSON.stringify({matches:[
                            {id:91, kind:"movie", title:"Late artwork", poster:"/movie-art/movie.jpg", runtime:95}
                        ]}));
                    });
                    if (method === "MovieMatches") return JSON.stringify(term === "Browse releases" ? {matches:
                        Array.from({length:10}, (_, i) => ({id:50 + i, kind:"movie", title:`Browse film ${i + 1}`}))
                    } : term === "The Gentlemen S2" ? {matches:[
                        {id:1, kind:"tv", title:"The Gentlemen", year:2024, poster:"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 2 3%27%3E%3Crect width=%272%27 height=%273%27 fill=%27%23355a6e%27/%3E%3C/svg%3E", overview:""},
                        {id:2, kind:"movie", title:"The Gentlemen", year:2019, poster:null, overview:""},
                        {id:3, kind:"movie", title:"Gentlemen Broncos", year:2009, poster:null, overview:""}]} : {matches:[]});
                    if (method !== "MovieReleaseSearch") return "";
                    if (term === "Late artwork") return JSON.stringify({results:[{title:"Late artwork 1080p AAC 2.0"}]});
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
        if (name === "chromium-1280") {
            const inputs = soundCases.map(([title]) => title);
            assert.deepEqual(await page.evaluate(async inputs => {
                const {releaseSound, librarySound} = await import("/movie-releases.js");
                return [
                    inputs.map(title => releaseSound(title)?.label ?? null),
                    librarySound([{Type:"Audio", Codec:"aac", Channels:2}, {Type:"Audio", IsDefault:true,
                        Codec:"dts", Profile:"DTS-HD MA", Channels:8}])?.label,
                    librarySound([{Type:"Audio", Codec:"unknown"}]),
                    librarySound([{Type:"Audio", Channels:6}])?.name
                ];
            }, inputs), [soundCases.map(([, label]) => label), "DTS-HD MA 7.1", null, "Sound: 5.1"]);
            assert.deepEqual(await page.evaluate(async () => {
                const {movieScreen, readMoviePreferences} = await import("/movies.js");
                Object.defineProperty(window, "screen", {value:{width:720, height:1280}});
                Object.defineProperty(window, "devicePixelRatio", {value:2});
                return [movieScreen("auto"), movieScreen("projector"), readMoviePreferences({server:"different profile"}).screen];
            }), [{width:2560, height:1440}, {width:7680, height:4320}, "auto"]);
        }
        await search(title);
        const download = page.getByRole("button", {name:"Request season 2: The Gentlemen (2024)"});
        await download.waitFor();
        assert.equal(await page.getByRole("heading", {name:"Matching titles", exact:true}).isVisible(), false);
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.getByRole("heading", {name:"In your library", exact:true}).isVisible(), false);
        assert.equal(await focus(submit), true);
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieReleaseSearch"), [["MovieReleaseSearch", title]]);
        await page.screenshot({path:path.join(output, name + "-release-request.png"), fullPage:true});
        const heading = page.getByRole("heading", {name:"Releases", exact:true});
        await heading.waitFor();
        await page.getByRole("status").filter({hasText:"9 releases found."}).waitFor();
        await page.getByText("The Gentlemen, season 2: 8 episodes, 7 h 20 min in total", {exact:true}).waitFor();
        await page.getByText("Also searched: Úriemberek", {exact:true}).waitFor();
        const guide = page.locator(".movie-quality-guide");
        const guideToggle = guide.getByText("Quality guide", {exact:true});
        assert.equal(await guide.getByRole("table").isVisible(), false);
        await guideToggle.press("Space");
        await guide.getByRole("table").waitFor();
        await guide.getByText("Original 4K disc video", {exact:false}).waitFor();
        assert.equal(await focus(guideToggle), true);
        await guideToggle.press("Enter");
        assert.equal(await guide.getByRole("table").isVisible(), false);
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
        assert.equal(await first.getByRole("img", {name:"Sound: Dolby Atmos"}).isVisible(), true);
        assert.equal(await first.locator(".movie-screen-flag").count(), 0);
        assert.equal(await guide.getByText("Times assume a 100 Mbps connection.").isVisible(), false);
        assert.equal(await page.getByRole("spinbutton").count(), 0);
        const second = result.getByRole("listitem").nth(1);
        assert.match(await second.innerText(), /720p.*Full season 2.*1\.9 GB.*about 6 min.*Easy to get/s);
        assert.equal(await second.locator(".movie-release-quality").getAttribute("data-level"), "hd");
        assert.equal(await second.locator(".movie-sound-chip").count(), 0);
        const none = result.getByRole("listitem").nth(2);
        assert.match(await none.innerText(), /4K Remux.*May never finish.*Hard to get/s);
        assert.equal(await none.locator(".movie-release-quality").getAttribute("data-level"), "4k-remux");
        assert.doesNotMatch(await none.innerText(), /about \d+ (?:min|h)/);
        const above = none.getByRole("img", {name:/Above your screen.*Lower quality saves data and storage/});
        assert.equal(await above.isVisible(), true);
        assert.match(await above.getAttribute("title"), /picture will look the same on this screen/);
        // The action is present on every tile and explains itself while downloads are off for the profile.
        const action = first.getByRole("button", {name: /^Download The Gentlemen/});
        assert.equal(await action.getAttribute("aria-disabled"), "true");
        assert.equal(await page.getByRole("button", {name: "Smallest file", exact: true}).isVisible(), false);
        await page.getByRole("button", {name:"Show all releases"}).click();
        assert.equal(await result.getByRole("listitem").count(), 9);
        assert.equal(await first.locator("strong").textContent(), pack);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        if (name === "chromium-1280") {
            const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
            const rowStyle = () => first.evaluate(row => {
                const css = getComputedStyle(row);
                return [css.outlineWidth, css.outlineColor, css.transform, css.transitionDuration];
            });
            for (const width of [320, 390, 1280, 1920, 2560, 3840]) {
                await page.setViewportSize({width, height:850});
                assert.equal(await noOverflow(), true, `release rows at ${width}px`);
            }
            await page.setViewportSize({width:1280, height:850});
            await first.hover();
            assert.deepEqual(await rowStyle(), ["2px", "rgb(255, 255, 255)", "none", "0s"]);
            await page.emulateMedia({reducedMotion:"no-preference"});
            await page.waitForFunction(row => getComputedStyle(row).transform === "matrix(1.02, 0, 0, 1.02, 0, 0)", await first.elementHandle());
            await page.evaluate(() => { document.body.dataset.effects = "off"; });
            assert.deepEqual(await rowStyle(), ["2px", "rgb(255, 255, 255)", "none", "0s"]);
            await page.evaluate(() => { delete document.body.dataset.effects; });
            await page.emulateMedia({reducedMotion:"reduce"});
        }
        await page.screenshot({path:path.join(output, name + "-releases.png"), fullPage:true});
        await page.getByRole("heading", {name:"YouTube", exact:true}).waitFor();
        await page.getByRole("heading", {name:"The Gentlemen trailer"}).waitFor();
        await page.getByText("Shorter than the season", {exact:true}).waitFor();
        await page.screenshot({path:path.join(output, name + "-release.png"), fullPage:true, scale:"css"});
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
            await page.screenshot({path:path.join(output, name + "-estimated.png"), fullPage:true, scale:"css"});
        }
        await search("Nothing matching");
        await page.getByRole("status").filter({hasText:"No watch or download options found"}).waitFor();
        assert.equal(await result.isVisible(), false);
        await search("Unavailable");
        const retry = page.getByRole("button", {name:"Retry release lookup"});
        await retry.waitFor();
        await page.getByRole("status").filter({hasText:"Reconnect to search for releases."}).waitFor();
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
        const local = page.getByRole("button", {name:"Catalogued Show", exact:true});
        await local.waitFor();
        assert.equal(await page.getByRole("button", {name:"First Season", exact:true}).count(), 0);
        assert.equal(await page.evaluate(() => calls.length), count);
        await page.screenshot({path:path.join(output, name + "-library.png"), fullPage:true});

        if (name === "chromium-1280") {
            await search("Late artwork");
            const lateAction = result.getByRole("button", {name:/^Download Late artwork/});
            await lateAction.focus();
            await page.waitForFunction(() => typeof finishArtwork === "function");
            await page.evaluate(() => finishArtwork());
            await result.locator(".movie-release-poster").waitFor();
            assert.equal(await focus(lateAction), true);
            assert.equal(await result.getByText("1 h 35 min", {exact:true}).isVisible(), true);

            await search("Browse releases");
            const shelf = page.locator('.movie-shelf[data-format="search"]').filter({has:page.getByRole("heading", {name:"Find releases"})});
            const cards = shelf.locator(".movie-card");
            await cards.first().waitFor();
            assert.equal(await cards.count(), 10);
            for (const width of [1280, 1920, 2560]) {
                await page.setViewportSize({width, height:850});
                await shelf.locator(".movie-shelf-scroll").evaluate(viewport => {
                    viewport.scrollLeft = 0;
                });
                const edges = await cards.evaluateAll(nodes => {
                    const {left, right} = nodes[0].closest(".movie-shelf-scroll").getBoundingClientRect();
                    return nodes.slice(0, 6).map(node => {
                        const rect = node.getBoundingClientRect();
                        return rect.left >= left && rect.right <= right ? "full" : rect.left < right && rect.right > left ? "peek" : "hidden";
                    });
                });
                assert.deepEqual(edges, ["full", "full", "full", "full", "full", "peek"], `matching cards at ${width}px`);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
            }
            await cards.first().press("PageDown");
            assert.equal(await focus(cards.nth(5)), true);
            assert.equal(await cards.nth(5).evaluate(node => getComputedStyle(node).outlineColor), "rgb(255, 255, 255)");
            await page.keyboard.press("Enter");
            assert.equal(await query.inputValue(), "Browse film 6");
            assert.equal(await focus(submit), true);
            await page.setViewportSize({width:1280, height:850});
        }

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
        const dialog = page.getByRole("dialog", {name: "Download options"});
        const closeOptions = dialog.getByRole("button", {name: "Close", exact: true});
        const huAudio = dialog.getByRole("checkbox", {name: "Hungarian audio", exact: true});
        const huSubtitles = dialog.getByRole("checkbox", {name: "Hungarian subtitles", exact: true});
        const submitOptions = dialog.getByRole("button", {name: "Download", exact: true});
        await dialog.waitFor();
        assert.equal(await focus(closeOptions), true);
        assert.equal(await huAudio.isChecked(), false);
        assert.equal(await huSubtitles.isChecked(), false);
        await page.keyboard.press("Escape");
        await dialog.waitFor({state: "hidden"});
        assert.equal(await focus(grab), true);
        assert.equal(await page.evaluate(() => calls.some(call => call[0] === "MovieDownload")), false);
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        await page.keyboard.press("Tab");
        assert.equal(await focus(huAudio), true);
        await page.keyboard.press("Space");
        assert.equal(await huAudio.isChecked(), true);
        await submitOptions.press("Enter");
        const retryGrab = first.getByRole("button", {name:/^Try again/});
        await retryGrab.waitFor();
        assert.equal(await focus(retryGrab), true);
        await page.getByRole("status").filter({hasText:"Prowlarr has no download client"}).waitFor();
        await page.clock.install();
        await page.keyboard.press("Space");
        await dialog.waitFor();
        assert.equal(await huAudio.isChecked(), true);
        assert.equal(await huSubtitles.isChecked(), false);
        await huSubtitles.press("Space");
        await submitOptions.press("Enter");
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
            [["MovieDownload", "reference-a", 1, pack, true, false], ["MovieDownload", "reference-a", 1, pack, true, true]]);
        await page.clock.fastForward(3200);
        await page.getByRole("region", {name:"Downloading"}).getByText("The Gentlemen Season 2", {exact:true}).waitFor();
        assert.equal(await focus(sent), true);
        assert.equal(await sent.isVisible(), true);
    } finally { await page.close(); }
}

(async () => {
    fs.mkdirSync(output, {recursive:true});
    await verifyMovieProfiles(verify);
    console.log("Integrated release search passed in eight browser profiles.");
})().catch(error => { console.error(error); process.exitCode = 1; });
