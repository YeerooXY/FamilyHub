const { useMovieBridge, playMovieDetails, dismissPlayerTracks } = require("./movies_fixture.cjs");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]
}));

const app = "http://familyhub.test";
const jellyfin = "https://jellyfin.test";
const show = { Id: "series", Type: "Series", Name: "Show", ImageTags: { Thumb: "inherited" } };
const pilot = { Id: "ep", Type: "Episode", Name: "Pilot", SeriesName: "Show", SeriesId: show.Id,
    ImageTags: { Thumb: "missing" }, BackdropImageTags: ["missing"], SeriesThumbImageTag: "inherited" };
const finale = { Id: "ep2", Type: "Episode", Name: "Finale", SeriesName: "Far Shore", SeriesId: "far-shore" };
const streams = [
    { Type: "Audio", Index: 1, Language: "eng", DisplayTitle: "English stereo", IsOriginal: true },
    { Type: "Audio", Index: 2, Language: "hun", DisplayTitle: "Hungarian stereo", IsExternal: true },
    { Type: "Subtitle", Index: 3, Language: "hu-HU", DisplayTitle: "Hungarian", IsTextSubtitleStream: true },
    { Type: "Subtitle", Index: 4, Language: "eng", DisplayTitle: "English", IsTextSubtitleStream: true }
];

async function check(browser, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(5000);
    const requestedTracks = [];
    const reports = [];
    const logoutAfter = [];
    let savedPosition = 0, playSession = 0, delayedProgress;
    await page.addInitScript(() => {
        // These checks cover negotiation and track controls independently of the media stream.
        HTMLMediaElement.prototype.play = () => Promise.resolve();
        HTMLMediaElement.prototype.canPlayType = () => "probably";
        Object.defineProperty(HTMLMediaElement.prototype, "src", {
            get() { return this.fixtureSource ?? ""; },
            set(url) { this.fixtureSource = String(url); }
        });
    });
    await page.route(app + "/**", route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        return name ? route.fulfill({ path: path.join(__dirname, "../clients/FamilyHub.App/wwwroot", name) })
            : route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/movies.css"><main class="movie-library"></main>' });
    });
    await page.route(jellyfin + "/**", async route => {
        const req = route.request();
        const url = new URL(req.url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" };
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname.endsWith("/PlaybackInfo")) {
            const body = req.postDataJSON();
            const full = url.pathname.includes("/full/");
            if (body.AudioStreamIndex !== undefined) {
                assert.equal(body.MediaSourceId, "source");
                assert.equal(body.SubtitleStreamIndex, -1);
                requestedTracks.push(body.AudioStreamIndex);
            }
            return route.fulfill({ headers, json: { PlaySessionId: "play-" + ++playSession, MediaSources: [{
                Id: "source", SupportsDirectPlay: body.EnableDirectPlay,
                ...(body.AudioStreamIndex !== undefined ? { TranscodingUrl: "/Videos/full/stream" } : {}),
                DefaultAudioStreamIndex: body.AudioStreamIndex ?? 1,
                DefaultSubtitleStreamIndex: body.SubtitleStreamIndex ?? (full ? 4 : -1),
                MediaStreams: full ? streams : streams.slice(0, 1)
            }] } });
        }
        if (url.pathname.endsWith("/Stream.vtt")) {
            return route.fulfill({ headers, contentType: "text/vtt", body: "WEBVTT\n\n00:00.000 --> 00:02.000\nText\n" });
        }
        if (url.pathname.includes("/Images/")) {
            assert.equal(url.searchParams.has("api_key"), false);
            if (["/Items/full/Images/Primary", "/Items/series/Images/Thumb"].includes(url.pathname))
                return route.fulfill({ headers, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="60"><rect width="50" height="60" fill="green"/></svg>' });
            return route.fulfill({ headers, status: 404 });
        }
        if (url.pathname === "/Items") {
            if (url.searchParams.has("searchTerm")) {
                assert.equal(url.searchParams.get("userId"), "viewer-a");
                assert.equal(url.searchParams.get("includeItemTypes"), "Movie,Series,Episode");
                const Items = url.searchParams.get("searchTerm") === "Pilot" ? [{ Id: "ep", Name: "Pilot", Type: "Episode" }] : [];
                return route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
            }
            const types = url.searchParams.get("includeItemTypes");
            assert.equal(url.searchParams.get("enableImageTypes"), "Primary,Thumb,Backdrop,Logo");
            const films = [
                { Id: "full", Name: "Two languages", Type: "Movie", ImageTags: { Primary: "poster" } },
                { Id: "limited", Name: "One language", Type: "Movie", ImageTags: { Primary: "missing" } },
                { Id: "sample1080", Name: "FamilyHub Sample 1080p", Type: "Movie" },
                { Id: "sample4k", Name: "FamilyHub Sample 4K HEVC", Type: "Movie" }
            ];
            const Items = types === "Movie" ? films : types === "Series" ? [show] : [...films, show];
            return route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
        }
        if (url.pathname === "/UserItems/Resume")
            return route.fulfill({headers, json: {Items: [pilot, finale], TotalRecordCount: 2}});
        if (url.pathname === "/Items/full")
            return route.fulfill({ headers, json: { UserData: { PlaybackPositionTicks: savedPosition * 1e7 } } });
        if (url.pathname.startsWith("/Sessions/Playing")) {
            const data = req.postDataJSON();
            reports.push([url.pathname, data]);
            if (delayedProgress && data.ItemId === "full") {
                if (url.pathname === "/Sessions/Playing/Progress") await delayedProgress;
                if (url.pathname === "/Sessions/Playing/Stopped") savedPosition = data.PositionTicks / 1e7;
            }
            if (url.pathname === "/Sessions/Playing")
                await new Promise(resolve => setTimeout(resolve, 75));
            return route.fulfill({ headers, status: 204 });
        }
        if (url.pathname === "/Sessions/Logout") logoutAfter.push(reports.length);
        return route.fulfill({ headers, status: 204 });
    });
    await useMovieBridge(page);
    await page.goto(app);
    const open = profile => page.evaluate(async ({ profile, jellyfin }) => {
        await window.movies?.close();
        const { openMovies } = await import("/movies.js");
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
            { url: jellyfin, user: profile, device: "device", token: "fixture" },
            { invokeMethodAsync: method => Promise.resolve(method === "MovieFind" ? '{"results":[]}' : undefined) },
            { server: jellyfin + "/", profile });
    }, { profile, jellyfin });
    const focused = async node => page.waitForFunction(el => el === document.activeElement, await node.elementHandle());
    const shelf = name => page.locator(".movie-shelf:not([hidden])").filter({
        has: page.getByRole("heading", {name, exact: true})
    });
    const moviesShelf = shelf("Movies");
    const resumeShelf = shelf("Continue watching");
    const tracks = page.getByRole("button", { name: "Audio & Subtitles", exact: true });
    const openTracks = () => tracks.press("Enter");
    const select = name => page.locator("label", { hasText: name }).locator("select");
    // Both track lists share one popover and keep their values in the hidden selects.
    const group = name => page.getByRole("radiogroup", { name, exact: true });
    const checkedIn = name => group(name).getByRole("radio", { checked: true });
    const preferences = (profile, values) => page.evaluate(async ({ profile, values, jellyfin }) => {
        const { readMoviePreferences, saveMoviePreferences } = await import("/movies.js");
        const viewer = { server: jellyfin + "/", profile };
        return values ? saveMoviePreferences(viewer, values) : readMoviePreferences(viewer);
    }, { profile, values, jellyfin });
    const image = async (card, expectedSource, ratio) => {
        await card.scrollIntoViewIfNeeded();
        const art = card.locator("img");
        await page.waitForFunction(({img, expectedSource}) => img.currentSrc.includes(expectedSource) &&
            img.complete && img.naturalWidth > 0, {img: await art.elementHandle(), expectedSource});
        assert.ok((await art.getAttribute("src")).includes(expectedSource));
        assert.equal(await art.getAttribute("alt"), "");
        const box = await art.boundingBox();
        assert.ok(Math.abs(box.width / box.height - ratio) < .02);
    };
    const audio = select("Audio track"), subtitle = select("Subtitle track");
    const back = page.getByRole("button", { name: "Back to movies" });
    const closer = page.getByRole("button", { name: "Close audio and subtitles" });
    const two = page.locator(".movie-shelf:not([hidden])").getByRole("button", { name: "Two languages" }).first();
    const one = moviesShelf.getByRole("button", { name: "One language" });
    const closePlayer = async (play, card) => {
        if (await closer.isVisible()) {
            await closer.press("Enter");
            await closer.waitFor({state: "hidden"});
            await focused(tracks);
        }
        await back.press("Enter");
        await back.waitFor({state: "hidden"});
        await focused(play);
        await page.getByRole("button", { name: "Back to titles", exact: true }).press("Enter");
        await focused(card);
    };

    await open("viewer-a");
    const search = page.getByRole("searchbox");
    await search.fill("Pilot");
    await search.press("Enter");
    await page.getByRole("button", { name: "Pilot", exact: true }).waitFor();
    await page.getByRole("status").filter({hasText: "1 title found."}).waitFor({state: "attached"});
    await search.fill("Éjfél");
    await search.press("Enter");
    await page.getByText("No watch or download options found. Try another title.").waitFor();
    await page.getByRole("button", { name: "Clear", exact: true }).press("Space");
    await focused(search);
    await two.waitFor();
    assert.equal(await page.getByRole("combobox").count(), 0);
    assert.equal(await preferences("viewer-a", { audio: "hu", subtitles: "hu" }), true);
    await image(two, "/Items/full/Images/Primary", 2 / 3);
    // A title without artwork gets its own colour and initial, never a shared stock image.
    const bare = async (card, initial) => {
        const art = card.locator(".movie-art");
        await art.waitFor();
        await page.waitForFunction(node => !node.querySelector("img[src]"), await art.elementHandle());
        assert.equal(await art.getAttribute("data-initial"), initial);
        assert.ok(await art.evaluate(node => node.style.getPropertyValue("--art-hue") !== ""));
    };
    await bare(one, "O");
    await bare(moviesShelf.getByRole("button", {name: "FamilyHub Sample 1080p", exact: true}), "F");
    await bare(moviesShelf.getByRole("button", {name: "FamilyHub Sample 4K HEVC", exact: true}), "F");
    await image(shelf("Series").getByRole("button", {name: "Show", exact: true}), "/Items/series/Images/Thumb", 2 / 3);
    await image(resumeShelf.getByRole("button", {name: "Show, Pilot", exact: true}), "/Items/series/Images/Thumb", 16 / 9);
    await bare(resumeShelf.getByRole("button", {name: "Far Shore, Finale", exact: true}), "F");
    const twoPlay = await playMovieDetails(page, two, "Two languages");
    await back.waitFor();
    // The player fills the window; controls follow the Netflix-style layout and start on Play.
    const box = () => page.locator(".movie-player").evaluate(node => [getComputedStyle(node).position, node.getBoundingClientRect().width === innerWidth]);
    assert.deepEqual(await box(), ["fixed", true]);
    const playPause = page.getByRole("button", { name: /^(Play|Pause)$/ });
    await focused(playPause);
    for (const name of ["Back 10 seconds", "Forward 10 seconds", "Audio & Subtitles"]) await page.getByRole("button", { name }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Episodes" }).count(), 0, "a film has no Episodes button");
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).count(), 0, "a film has no Next Episode button");
    await page.getByRole("slider", { name: "Seek" }).waitFor();
    // Tab order follows the seek row, then play and the skip controls.
    await back.focus();
    for (const next of [page.getByRole("slider", { name: "Seek" }), playPause, page.getByRole("button", { name: "Back 10 seconds" }), page.getByRole("button", { name: "Forward 10 seconds" })]) {
        await page.keyboard.press("Tab");
        await focused(next);
    }
    // Keyboard shortcuts keep the focused control in place.
    await playPause.focus();
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
        await page.keyboard.press(key);
        await focused(playPause);
    }
    // Escape closes Audio and returns focus to its opener.
    await tracks.click();
    await closer.waitFor();
    await group("Audio track").waitFor();
    await dismissPlayerTracks(page);
    await tracks.click();
    assert.equal(await audio.inputValue(), "2");
    assert.equal(await subtitle.inputValue(), "-1", "Hungarian audio starts with subtitles off");
    await group("Subtitle track").getByRole("radio", {name: "Hungarian", exact: true}).press("Space");
    assert.equal(await subtitle.inputValue(), "3");
    assert.equal(await page.locator("video").evaluate(video => {
        video.dispatchEvent(new Event("loadedmetadata"));
        return [...video.textTracks].find(track => track.language === "hu-HU").mode;
    }), "hidden", "the player draws subtitles itself, so the browser keeps the track hidden");
    // The player's own subtitle layer shows the active cue without YouTube's ">>" mark.
    await page.locator("video").evaluate(video => {
        const track = [...video.textTracks].find(track => track.language === "hu-HU");
        Object.defineProperty(track, "activeCues", { configurable: true, get: () => [{ text: ">> Hello &amp; welcome\n<i>Second line</i>" }] });
        track.dispatchEvent(new Event("cuechange"));
    });
    assert.deepEqual(await page.locator(".movie-ui-sub").allInnerTexts(), ["Hello & welcome", "Second line"]);
    if (browser.browserType() === chromium)
        await page.waitForFunction(() => [...document.querySelector("video").textTracks]
            .find(track => track.language === "hu-HU").cues?.length === 1);
    assert.equal(await checkedIn("Audio track").innerText(), "Hungarian");
    await group("Subtitle track").getByRole("radio", { name: "Off", exact: true }).click();
    await group("Audio track").getByRole("radio", { name: "English (original)", exact: true }).click();
    await back.waitFor();
    await group("Audio track").waitFor();
    await focused(checkedIn("Audio track"));
    assert.equal(await subtitle.inputValue(), "-1");
    assert.deepEqual(await preferences("viewer-a"), { audio: "hu", subtitles: "hu", dataSaver: "auto" });
    await closePlayer(twoPlay, two);
    const onePlay = await playMovieDetails(page, one, "One language");
    await openTracks();
    const audioRows = group("Audio track");
    assert.deepEqual(await audioRows.getByRole("radio").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))),
        ["English (original)", "Hungarian"]);
    const missing = audioRows.getByRole("radio", {name: "Hungarian", exact: true});
    assert.equal(await missing.getAttribute("aria-disabled"), "true");
    assert.match(await missing.innerText(), /Not available/);
    assert.equal(await audioRows.getByRole("button", {name: "Find Hungarian audio"}).isVisible(), true);
    await page.getByText("Hungarian audio unavailable. Using the default track.").waitFor();
    await closePlayer(onePlay, one);
    assert.deepEqual(requestedTracks, [2, 1]);
    assert.equal(await page.locator("main").evaluate(node => node.scrollWidth <= node.clientWidth), true);

    await open("viewer-b");
    assert.deepEqual(await preferences("viewer-b"), { audio: "default", subtitles: "default", dataSaver: "auto" });
    await playMovieDetails(page, two, "Two languages");
    await back.waitFor();
    await openTracks();
    assert.equal(await subtitle.inputValue(), "-1", "Jellyfin's subtitle default does not override Movies settings");
    await closePlayer(twoPlay, two);
    assert.equal(await preferences("viewer-b", { audio: "default", subtitles: "off" }), true);
    await playMovieDetails(page, two, "Two languages");
    await back.waitFor();
    await openTracks();
    assert.equal(await subtitle.inputValue(), "-1");
    await page.reload();
    await open("viewer-a");
    assert.deepEqual(await preferences("viewer-a"), { audio: "hu", subtitles: "hu", dataSaver: "auto" });

    // The library card predates the position saved on another device.
    savedPosition = 180;
    await playMovieDetails(page, two, "Two languages");
    await back.waitFor();
    const video = page.locator("video");
    const setMedia = (values, events) => video.evaluate((media, { values, events }) => {
        for (const [name, value] of Object.entries(values))
            Object.defineProperty(media, name, { value, configurable: true, writable: true });
        for (const event of events) media.dispatchEvent(new Event(event));
        return media.currentTime;
    }, { values, events });
    assert.equal(await setMedia({ duration: 1200, currentTime: 0, paused: false }, ["loadedmetadata", "playing"]), 180);
    await setMedia({ currentTime: 210 }, ["seeked"]);
    await setMedia({ currentTime: 215, paused: true }, ["pause"]);
    await openTracks();
    await group("Audio track").getByRole("radio", { name: "English (original)", exact: true }).click();
    await focused(checkedIn("Audio track"));
    assert.equal(await setMedia({ duration: 1200, currentTime: 0, paused: true }, ["loadedmetadata"]), 215);
    await setMedia({ paused: false }, ["playing"]);
    await setMedia({ currentTime: 1200, paused: true, ended: true }, ["pause", "ended"]);
    await page.evaluate(async () => window.movies.close());
    assert.deepEqual(reports.map(([path, data]) => [path.slice("/Sessions/Playing".length), data.PositionTicks / 1e7]), [
        ["", 180], ["/Progress", 210], ["/Progress", 215], ["/Stopped", 215], ["", 215], ["/Stopped", 1200]
    ]);
    assert.equal(reports[0][1].PlaySessionId, reports[3][1].PlaySessionId);
    assert.equal(reports[4][1].PlaySessionId, reports[5][1].PlaySessionId);
    assert.notEqual(reports[3][1].PlaySessionId, reports[4][1].PlaySessionId);

    await open("viewer-a");
    await playMovieDetails(page, two, "Two languages");
    await back.waitFor();
    await video.evaluate(async media => {
        Object.defineProperties(media, {
            duration: { value: 1200 }, currentTime: { value: 0, writable: true }, paused: { value: false }
        });
        media.dispatchEvent(new Event("loadedmetadata"));
        media.dispatchEvent(new Event("playing"));
        media.currentTime = 225;
        await window.movies.close();
    });
    assert.deepEqual(reports.slice(-2).map(([path, data]) => [path.slice("/Sessions/Playing".length), data.PositionTicks / 1e7]),
        [["", 180], ["/Stopped", 225]]);

    // Block the first title's progress write while opening a second title and then resuming the first.
    await open("viewer-b");
    await playMovieDetails(page, two, "Two languages");
    await back.waitFor();
    await page.evaluate(() => {
        const fetch = window.fetch;
        window.resumeReads = [];
        window.fetch = (url, options) => {
            const pathname = new URL(url).pathname;
            if (["/Items/full", "/Items/limited"].includes(pathname)) window.resumeReads.push(pathname);
            return fetch(url, options);
        };
    });
    const reportStart = reports.length;
    await setMedia({ duration: 1200, currentTime: 0, paused: false }, ["loadedmetadata", "playing"]);
    let releaseProgress;
    delayedProgress = new Promise(resolve => { releaseProgress = resolve; });
    try {
        const progress = page.waitForRequest(request => request.method() === "POST"
            && new URL(request.url()).pathname === "/Sessions/Playing/Progress");
        await setMedia({ currentTime: 250 }, ["seeked"]);
        await progress;
        await setMedia({ currentTime: 260 }, []);
        await closePlayer(twoPlay, two);

        await playMovieDetails(page, one, "One language");
        await page.getByRole("region", { name: "Movie player" }).getByRole("heading", { name: "One language", exact: true }).waitFor();
        await setMedia({ currentTime: 30, paused: false }, ["playing"]);
        await closePlayer(onePlay, one);
        assert.equal(reports.length, reportStart + 2, "playback reports still queue behind the slow write");

        const reopening = page.waitForResponse(response => response.request().method() === "POST"
            && new URL(response.url()).pathname === "/Items/full/PlaybackInfo");
        await playMovieDetails(page, two, "Two languages");
        await reopening;
        assert.deepEqual(await page.evaluate(() => window.resumeReads), ["/Items/limited"],
            "same-title startup waits to fetch the saved position");
    } finally {
        releaseProgress();
    }
    await back.waitFor();
    assert.equal(await setMedia({ duration: 1200, currentTime: 0, paused: false }, ["loadedmetadata", "playing"]), 260);
    const logoutCount = logoutAfter.length;
    await page.evaluate(() => window.movies.close());
    assert.deepEqual(reports.slice(reportStart).map(([path, data]) =>
        [path.slice("/Sessions/Playing".length), data.ItemId, data.PositionTicks / 1e7]), [
        ["", "full", 180], ["/Progress", "full", 250], ["/Stopped", "full", 260],
        ["", "limited", 30], ["/Stopped", "limited", 30], ["", "full", 260], ["/Stopped", "full", 260]
    ]);
    assert.deepEqual(logoutAfter.slice(logoutCount), [reports.length]);
    delayedProgress = undefined;

    // The HTTP-only fallback must keep the saved position when it cannot seek.
    await page.evaluate(() => {
        HTMLMediaElement.prototype.canPlayType = () => "";
        window.MediaSource = window.ManagedMediaSource = undefined;
    });
    const reportCount = reports.length;
    await open("viewer-a");
    await playMovieDetails(page, two, "Two languages");
    await page.getByText("This device cannot resume this video. Continue on another device.").waitFor();
    await focused(twoPlay);
    assert.equal(reports.length, reportCount);
    await page.close();
}

(async () => {
    for (const [engine, desktop, phone] of [
        [chromium, { width: 1280, height: 800 }, "Pixel 7"],
        [webkit, { width: 1280, height: 800 }, "iPhone 13"]
    ]) {
        const browser = await engine.launch();
        try {
            for (const [label, options] of [["desktop", { viewport: desktop }], [phone, devices[phone]]])
                await check(browser, options).catch(error => {
                    console.error("FAILED in", engine.name(), label);
                    throw error;
                });
        } finally {
            await browser.close();
        }
    }
    console.log("Movie artwork, track preferences and keyboard navigation verified in desktop and mobile Chromium and WebKit.");
})().catch(error => { console.error(error); process.exitCode = 1; });
