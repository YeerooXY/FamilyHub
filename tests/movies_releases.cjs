const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {constants, setPriority} = require("node:os");
const {jellyfin, homeOutput, moviePage, verifyMovieProfiles} = require("./movies_fixture.cjs");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

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
    { title: "The Gentlemen S02 2160p Remux", source: "Knaben", size: 30500000000, seeders: 0 },
    { title: "The Gentlemen S02 2160p BDRip x265", source: "LimeTorrents", size: 18000000000, seeders: 0 },
    { title: "The Gentlemen S02 2160p WEB-DL", source: "1337x", size: 15000000000, seeders: 0 },
    { title: "The Gentlemen S02 1080p Remux", source: "TheRARBG", size: 29000000000, seeders: 0 },
    { title: "The Gentlemen S02 1080p BluRay", source: "EZTV", size: 16000000000, seeders: 0 },
    { title: "The Gentlemen S02 DVDRip", source: "nCore", size: 5000000000, seeders: 0 },
    { title: "The Gentlemen S02 HDCAM", source: "Nebula Index", size: 3000000000, seeders: 0 }
];
const indexerBadges = [
    ["The Pirate Bay", "TPB", "rgb(87, 56, 42)"],
    ["Knaben", "K", "rgb(23, 107, 112)"],
    ["LimeTorrents", "L", "rgb(82, 115, 26)"],
    ["1337x", "13", "rgb(163, 67, 19)"],
    ["TheRARBG", "R", "rgb(35, 74, 145)"],
    ["EZTV", "E", "rgb(101, 68, 144)"],
    ["nCore", "n", "rgb(161, 47, 67)"],
    ["Nebula Index", "N", "rgb(22, 103, 90)"]
];

async function openReleaseFixture(page, {shell = false, sources = fixture} = {}) {
    await moviePage(page, {shell, nested: shell});
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
    await page.evaluate(async ({jellyfin, fixture}) => {
        const {openMovies, saveMoviePreferences} = await import("/movies.js");
        saveMoviePreferences({server:jellyfin + "/"}, {screen:"1080"});
        const title_details = {title:"The Gentlemen", kind:"tv", year:2024, season:2, runtime_minutes:440, official_rating:"TV-MA",
            episode_count:8, hungarian_title:"Úriemberek"};
        window.calls = [];
        window.movieSession = {url:jellyfin, user:"fixture", token:"fixture", device:"fixture", release_search_enabled:true, requests_enabled:true};
        window.startMovieFixture = () => window.openMovieFixture(openMovies, document.querySelector(".movie-library"), window.movieSession, {
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
                if (method === "MovieMatches" && term === "Foreign harbour") return new Promise(resolve => {
                    window.finishRowArtwork = () => resolve(JSON.stringify({matches: [
                        {id: 92, kind: "movie", title: "Foreign Harbour", poster: "/movie-art/movie-alt.jpg"}
                    ]}));
                });
                if (method === "MovieMatches" && term === "tmdb:tv:74")
                    return JSON.stringify({seasons: [1, 2, 3, 4, 5].map(number => ({number}))});
                if (method === "MovieMatches") return JSON.stringify(term === "Browse releases" ? {matches:
                    Array.from({length:10}, (_, i) => ({id:50 + i, kind:"movie", title:`Browse film ${i + 1}`}))
                } : term === "The Gentlemen S2" ? {matches:[
                    {id:1, kind:"tv", title:"The Gentlemen", year:2024, poster:"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 2 3%27%3E%3Crect width=%272%27 height=%273%27 fill=%27%23355a6e%27/%3E%3C/svg%3E", overview:""},
                    {id:2, kind:"movie", title:"The Gentlemen", year:2019, poster:null, overview:""},
                    {id:3, kind:"movie", title:"Gentlemen Broncos", year:2009, poster:null, overview:""}]} : {matches:[]});
                if (method !== "MovieReleaseSearch") return "";
                if (term === "Late artwork") return JSON.stringify({results:[{title:"Late artwork 1080p AAC 2.0"}]});
                if (term === "Slow search") return new Promise(resolve => window.finishSlow = () => resolve(JSON.stringify({results:fixture})));
                if (term === "Ripper Street") return JSON.stringify({
                    title_details: {title: term, kind: "tv", tmdb_id: 74},
                    results: [
                        "Ripper.Street.Complete.Series.4.EN.SUB.MPEG4.x264.WEBRIP.[MPup]",
                        "Ripper Street Season 1-3 S01-S03 720p BluRay x264-MIXED",
                        "Ripper.Street.Complete.S01-05.720p",
                        "Ripper Street S05 HDTV", "Ripper Street S04 DVDRip", "Ripper Street S04 XviD",
                        "Ripper Street S04 576p", "Ripper Street S04 540p", "Ripper Street S04 2160p",
                        "Ripper Street S04 UHD", "Ripper Street S04 1080i", "Ripper Street S04 FHD", "Ripper Street S04 HD",
                        "Ripper Street S04"
                    ].map(title => ({title}))
                });
                if (term === "Many releases") return JSON.stringify({results:Array.from({length: 10}, (_, index) =>
                    ({title: `Release ${index + 1} 1080p`, size: 1e9, seeders: 50}))});
                if (term === "Poster search") return JSON.stringify({
                    title_details: {title: "Poster search", poster: "/movie-art/movie.jpg", kind: "movie"},
                    results: ["Poster search 1080p WEB-DL", "Foreign harbour 1080p WEB-DL", "Foreign harbour 720p WEB-DL",
                        "Unknown port 1080p", "Blank sky 1080p",
                        ...Array.from({length: 5}, (_, i) => `Other port ${i + 1} 720p`)]
                        .map((title, i) => ({title, size: (i + 1) * 1e9, seeders: 50}))
                });
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
                return JSON.stringify(term === "The Gentlemen S2" ? {results:fixture, title_details, unavailable:1} : {results:[], unavailable:0});
            }
        });
        window.movieScreen = window.startMovieFixture();
    }, {jellyfin, fixture: sources});
}

async function verify(browser, name, options) {
    const page = await browser.newPage(options);
    try {
        await openReleaseFixture(page);
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
        const heading = page.locator(".movie-release-identity h2");
        await page.getByRole("heading", {name:"The Gentlemen (2024)", exact:true}).waitFor();
        assert.equal(await page.getByText(/\d+ releases found|source did not answer/).count(), 0);
        assert.equal(await page.locator(".movie-release-rail").getByRole("img", {name:"Age rating 18"}).textContent(), "18");
        assert.equal(await page.getByRole("searchbox").count(), 1);
        assert.equal(await page.getByRole("heading", {name:"In your library", exact:true}).isVisible(), false);
        assert.equal(await focus(submit), true);
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieReleaseSearch"), [["MovieReleaseSearch", title]]);
        const guide = page.locator(".movie-quality-guide");
        const guideToggle = page.getByRole("button", {name:"Quality guide"});
        assert.equal(await guide.getByRole("table").isVisible(), false);
        await guideToggle.press("Space");
        await guide.getByText("Original 4K disc video", {exact:true}).waitFor();
        assert.equal(await focus(guideToggle), true);
        await guideToggle.press("Enter");
        assert.equal(await guide.getByRole("table").isVisible(), false);
        const rows = result.getByRole("listitem");
        const first = rows.filter({has:page.getByRole("img", {name:"Sound: Dolby Atmos"})});
        assert.equal(await rows.count(), 10);
        assert.equal(await rows.first().getAttribute("data-tier"), "web");
        const text = await first.innerText();
        assert.match(text, /1080p\s+Web/);
        assert.match(text, /Season 2/);
        assert.match(text, /Size\s+16\.1 GB/);
        assert.match(text, /Download time\s+about 23 min/);
        assert.match(text, /Availability\s+Available/);
        assert.doesNotMatch(text, /seeder|leecher/);
        const indexers = rows.locator(".movie-release-top .movie-release-indexer");
        assert.equal(await indexers.count(), 9);
        for (const [name, monogram, color] of indexerBadges) {
            const badges = indexers.filter({has: page.getByText(name, {exact: true})});
            const expectedCount = name === "The Pirate Bay" ? 2 : 1;
            assert.deepEqual(await badges.evaluateAll(nodes => nodes.map(node => {
                const disc = node.querySelector(".movie-release-indexer-badge");
                const description = [...node.children].filter(child => child.getAttribute("aria-hidden") !== "true")
                    .map(child => child.textContent).join("");
                const row = node.closest(".movie-release");
                return [disc.textContent, getComputedStyle(disc).backgroundColor, disc.getAttribute("aria-hidden"),
                    Boolean(node.id) && document.getElementById(row.getAttribute("aria-describedby")) === node, description];
            })), Array.from({length: expectedCount}, () => [monogram, color, "true", true, `From ${name}`]), name);
        }
        assert.equal(await first.locator(".movie-age-rating").count(), 0);
        const raw = first.locator(".movie-release-name");
        const expand = first.getByRole("button", {name:/File name for The Gentlemen/});
        assert.equal(await raw.isVisible(), false);
        await expand.press("Enter");
        await raw.waitFor();
        assert.equal(await raw.textContent(), pack);
        assert.equal(await focus(expand), true);
        await expand.press("Space");
        assert.equal(await raw.isVisible(), false);
        assert.match(await rows.filter({has:page.locator(".movie-release-block[data-level='4k-remux']")}).innerText(),
            /4K\s+Remux.*May never finish.*Unavailable/s);
        const action = first.getByRole("button", {name: /^Download The Gentlemen/});
        assert.equal(await action.getAttribute("aria-disabled"), "true");
        await page.screenshot({path:path.join(output, name + "-releases.png"), fullPage:true});

        const otherSources = page.getByText("Other watch and download options", {exact:true});
        const trailer = rows.filter({has: page.getByRole("heading", {name:"The Gentlemen trailer"})});
        await trailer.getByRole("link", {name:"Watch on YouTube"}).waitFor();
        assert.equal(await trailer.locator(".movie-release-top").getByText("YouTube", {exact: true}).count(), 1);
        assert.equal(await trailer.locator(".movie-release-indexer").count(), 0);
        await trailer.getByText("Shorter than the season", {exact:true}).waitFor();
        await otherSources.press("Enter");
        assert.deepEqual((await page.evaluate(() => calls)).filter(([method]) => method === "MovieFind"), [["MovieFind", title]]);
        const request = page.getByRole("button", {name:"Request season 2: The Gentlemen (2024)"});
        await request.press("Space");
        const approved = page.getByText("Request approved");
        await approved.waitFor();
        assert.equal(await focus(approved), true);
        assert.deepEqual(await page.evaluate(() => calls.at(-1)), ["MovieRequest", "tv", 12, 2]);
        await search("Game of Thrones");
        await result.getByRole("heading", {name:"Trónok Harca Full HUN", exact:true}).waitFor();
        await result.getByText("Estimated: about 480p or lower (from size and length)", {exact:true}).waitFor();
        await result.getByRole("heading", {name:"R&D's copy", exact:true}).waitFor();
        await result.getByText(/unusually small for a 1080p video/).waitFor();
        assert.equal(await result.locator(".movie-release-name b").count(), 0);
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
        await result.getByRole("heading", {name:"Release 10", exact:true}).waitFor();
        assert.equal(await rows.count(), 10);
        await search("Slow search");
        await page.waitForFunction(() => typeof finishSlow === "function");
        await page.getByRole("status").filter({hasText: /^Searching…$/}).waitFor();
        assert.equal(await page.locator(".is-checking").count(), 1);
        await page.getByRole("button", {name:"Clear", exact:true}).click();
        await page.evaluate(() => finishSlow());
        assert.equal(await page.locator(".is-checking").count(), 0);
        assert.equal(await result.count(), 0);
        assert.equal(await focus(query), true);
        if (name === "chromium-1280") {
            await search("Ripper Street");
            await result.getByText("Complete series", {exact: true}).waitFor();
            const parsed = await rows.evaluateAll(nodes => Object.fromEntries(nodes.map(row => [
                row.querySelector(".movie-release-name").textContent.replace(/^Ripper[ .]Street[ .]/, ""),
                [row.querySelector(".movie-release-block").textContent, row.querySelector(".movie-release-kind").textContent]
            ])));
            assert.deepEqual(parsed["Complete.Series.4.EN.SUB.MPEG4.x264.WEBRIP.[MPup]"], ["SD Web", "Season 4"]);
            assert.deepEqual(parsed["Season 1-3 S01-S03 720p BluRay x264-MIXED"], ["720p Blu-ray", "Seasons 1 to 3"]);
            assert.deepEqual(parsed["Complete.S01-05.720p"], ["720p", "Complete series"]);
            for (const [tag, label] of Object.entries({HDTV:"SD TV", DVDRip:"SD DVD", XviD:"SD", "576p":"576p",
                "540p":"540p", "2160p":"4K", UHD:"4K", "1080i":"1080p", FHD:"1080p", HD:"720p"}))
                assert.equal(parsed[(tag === "HDTV" ? "S05 " : "S04 ") + tag][0], label, tag);
            assert.equal(parsed.S04[0], "Unknown quality");
        }
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
            await page.locator(".movie-release-poster img[src]").waitFor();
            assert.equal(await focus(lateAction), true);

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
        const dialog = page.getByRole("dialog", {name: "Confirm download"});
        const huAudio = dialog.getByRole("switch", {name: "Hungarian audio", exact: true});
        const huSubtitles = dialog.getByRole("switch", {name: "Hungarian subtitles", exact: true});
        const submitOptions = dialog.getByRole("button", {name: "Download", exact: true});
        await dialog.waitFor();
        assert.equal(await focus(submitOptions), true);
        assert.equal(await huAudio.isChecked(), false);
        assert.equal(await huSubtitles.isChecked(), true);
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
        await huSubtitles.press("Space");
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
        await page.evaluate(pack => {
            window.queueItems = [{name:pack, progress:.42, size:17244393718, state:"Downloading", eta:null, speed:0}];
            confirmGrab();
        }, pack);
        const season = page.getByRole("button", {name:"Season 2", exact:true});
        await season.waitFor();
        assert.equal(await focus(season), true);
        assert.deepEqual(await page.evaluate(() => calls.filter(call => call[0] === "MovieDownload")),
            [["MovieDownload", "reference-a", 1, pack, true, false], ["MovieDownload", "reference-a", 1, pack, true, true]]);
        await page.clock.fastForward(3200);
        await page.waitForFunction(node => node.getAttribute("aria-description")?.startsWith("Downloading 42%"), await season.elementHandle());
        assert.equal(await focus(season), true);
    } finally { await page.close(); }
}

module.exports = {openReleaseFixture, fixture, pack, title};

if (require.main === module) (async () => {
    fs.mkdirSync(output, {recursive:true});
    await verifyMovieProfiles(verify);
    console.log("Integrated release search passed in eight browser profiles.");
})().catch(error => { console.error(error); process.exitCode = 1; });
