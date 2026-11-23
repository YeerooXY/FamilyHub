const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", {
    paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]
}));

const app = "http://familyhub.test";
const jellyfin = "https://jellyfin.test";
const streams = [
    { Type: "Audio", Index: 1, Language: "eng", DisplayTitle: "English stereo" },
    { Type: "Audio", Index: 2, Language: "hun", DisplayTitle: "Hungarian stereo" },
    { Type: "Subtitle", Index: 3, Language: "hu-HU", DisplayTitle: "Hungarian", IsTextSubtitleStream: true },
    { Type: "Subtitle", Index: 4, Language: "eng", DisplayTitle: "English", IsTextSubtitleStream: true }
];

async function check(browser, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(5000);
    const requestedTracks = [];
    const reports = [];
    let savedPosition = 0, playSession = 0;
    await page.addInitScript(() => {
        // These checks cover negotiation and track controls independently of the media stream.
        HTMLMediaElement.prototype.play = () => Promise.resolve();
        HTMLMediaElement.prototype.canPlayType = () => "probably";
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
                assert.equal(url.searchParams.get("includeItemTypes"), "Movie,Episode");
                const Items = url.searchParams.get("searchTerm") === "Pilot" ? [{ Id: "ep", Name: "Pilot", Type: "Episode" }] : [];
                return route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
            }
            const movies = url.searchParams.get("includeItemTypes") === "Movie";
            assert.equal(url.searchParams.get("enableImageTypes"), "Primary,Thumb,Backdrop");
            const Items = movies ? [
                { Id: "full", Name: "Two languages", ImageTags: { Primary: "poster" } },
                { Id: "limited", Name: "One language", ImageTags: { Primary: "missing" } },
                { Id: "sample1080", Name: "FamilyHub Sample 1080p" },
                { Id: "sample4k", Name: "FamilyHub Sample 4K HEVC" }
            ] : [
                { Id: "ep", Type: "Episode", Name: "Pilot", SeriesName: "Show", SeriesId: "series",
                    ImageTags: { Thumb: "missing" }, BackdropImageTags: ["missing"], SeriesThumbImageTag: "inherited" },
                { Id: "ep2", Type: "Episode", Name: "Finale", SeriesName: "Show" }
            ];
            return route.fulfill({ headers, json: { Items, TotalRecordCount: Items.length } });
        }
        if (url.pathname === "/UserItems/Resume") return route.fulfill({ headers, json: { Items: [], TotalRecordCount: 0 } });
        if (url.pathname === "/Items/full")
            return route.fulfill({ headers, json: { UserData: { PlaybackPositionTicks: savedPosition * 1e7 } } });
        if (url.pathname.startsWith("/Sessions/Playing")) {
            reports.push([url.pathname, req.postDataJSON()]);
            if (url.pathname === "/Sessions/Playing")
                await new Promise(resolve => setTimeout(resolve, 75));
            return route.fulfill({ headers, status: 204 });
        }
        return route.fulfill({ headers, status: 204 });
    });
    await page.goto(app);
    const open = profile => page.evaluate(async ({ profile, jellyfin }) => {
        await window.movies?.close();
        const { openMovies } = await import("/movies.js");
        window.movies = openMovies(document.querySelector("main"),
            { url: jellyfin, user: profile, device: "device", token: "fixture" },
            { invokeMethodAsync: () => Promise.resolve() }, { server: location.origin, profile });
    }, { profile, jellyfin });
    const focused = async node => page.waitForFunction(el => el === document.activeElement, await node.elementHandle());
    // "Recently added" repeats titles from the library shelves, so look cards up outside it.
    const moviesShelf = page.locator(".movie-shelf").filter({ hasNot: page.getByRole("heading", { name: "Recently added" }) });
    const openTracks = () => page.getByRole("button", { name: "Audio and subtitles" }).click();
    const select = name => page.getByRole("combobox", { name, exact: true });
    const preferences = (profile, values) => page.evaluate(async ({ profile, values }) => {
        const { readMoviePreferences, saveMoviePreferences } = await import("/movies.js");
        const viewer = { server: location.origin, profile };
        return values ? saveMoviePreferences(viewer, values) : readMoviePreferences(viewer);
    }, { profile, values });
    const image = async (name, expectedSource, ratio) => {
        const card = moviesShelf.getByRole("button", { name, exact: true });
        await card.scrollIntoViewIfNeeded();
        await page.waitForFunction(({ selector, expectedSource }) =>
            Array.from(document.querySelectorAll(selector)).some(img => img.currentSrc.includes(expectedSource)
                && img.complete && img.naturalWidth > 0), { selector: ".movie-card img", expectedSource });
        const art = card.locator("img");
        assert.ok((await art.getAttribute("src")).includes(expectedSource));
        assert.equal(await art.getAttribute("alt"), "");
        const box = await art.boundingBox();
        assert.ok(Math.abs(box.width / box.height - ratio) < .02);
    };
    const audio = select("Audio track"), subtitle = select("Subtitle track");
    const back = page.getByRole("button", { name: "Back to movies" });
    const two = moviesShelf.getByRole("button", { name: "Two languages" });
    const one = moviesShelf.getByRole("button", { name: "One language" });

    await open("viewer-a");
    const search = page.getByRole("searchbox");
    await search.fill("Pilot");
    await search.press("Enter");
    await page.getByRole("button", { name: "Pilot", exact: true }).waitFor();
    await page.getByText("1 matching title.").waitFor();
    await search.fill("Éjfél");
    await search.press("Enter");
    await page.getByText("No matching titles.").waitFor();
    await page.getByRole("button", { name: "Clear", exact: true }).press("Space");
    await focused(search);
    await two.waitFor();
    assert.equal(await page.getByRole("combobox").count(), 0);
    assert.equal(await preferences("viewer-a", { audio: "hu", subtitles: "hu" }), true);
    await image("Two languages", "/Items/full/Images/Primary", 2 / 3);
    await image("One language", "/movie-art/movie-alt.jpg", 2 / 3);
    await image("FamilyHub Sample 1080p", "/movie-art/movie.jpg", 2 / 3);
    await image("FamilyHub Sample 4K HEVC", "/movie-art/movie-alt.jpg", 2 / 3);
    await image("Show · Pilot", "/Items/series/Images/Thumb", 16 / 9);
    await image("Show · Finale", "/movie-art/episode.jpg", 16 / 9);
    await two.press("Enter");
    await back.waitFor();
    // The player fills the window; controls follow the Netflix-style layout and start on Play.
    const box = () => page.locator(".movie-player").evaluate(node => [getComputedStyle(node).position, node.getBoundingClientRect().width === innerWidth]);
    assert.deepEqual(await box(), ["fixed", true]);
    const playPause = page.getByRole("button", { name: /^(Play|Pause)$/ });
    await focused(playPause);
    for (const name of ["Back 10 seconds", "Forward 10 seconds", "Audio and subtitles"]) await page.getByRole("button", { name }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Episodes" }).count(), 0, "a film has no Episodes button");
    assert.equal(await page.getByRole("button", { name: /^Next episode/ }).count(), 0, "a film has no Next Episode button");
    await page.getByRole("slider", { name: "Seek" }).waitFor();
    // Tab order: close, 10 s back, play, 10 s forward, seek bar.
    await back.focus();
    for (const next of [page.getByRole("button", { name: "Back 10 seconds" }), playPause, page.getByRole("button", { name: "Forward 10 seconds" }), page.getByRole("slider", { name: "Seek" })]) {
        await page.keyboard.press("Tab");
        await focused(next);
    }
    // A TV remote has only arrows: they move between controls, and left and right on the seek bar scrub.
    const press = async (key, next) => { await page.keyboard.press(key); await focused(next); };
    await playPause.focus();
    await press("ArrowRight", page.getByRole("button", { name: "Forward 10 seconds" }));
    await press("ArrowLeft", playPause);
    await press("ArrowDown", page.getByRole("slider", { name: "Seek" }));
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement.closest(".movie-ui-actions"));
    await press("ArrowUp", page.getByRole("slider", { name: "Seek" }));
    await press("ArrowUp", playPause);
    // Up from play lands on whichever top control is nearer (the left arrow or the close button); left and right reach the other.
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.activeElement.closest(".movie-ui-top"));
    await press("ArrowLeft", page.getByRole("button", { name: "Back", exact: true }));
    await press("ArrowRight", back);
    // Audio & Subtitles opens a sheet with one named close control and Escape returns focus to its opener.
    const tracks = page.getByRole("button", { name: "Audio and subtitles" });
    await tracks.click();
    await page.getByRole("button", { name: "Close audio and subtitles" }).waitFor();
    await audio.waitFor();
    // A browser in fullscreen spends the first Escape on leaving fullscreen, so allow a second press.
    const closer = page.getByRole("button", { name: "Close audio and subtitles" });
    for (let press = 0; press < 2 && await closer.isVisible(); press++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
    }
    await closer.waitFor({ state: "hidden" });
    await focused(tracks);
    await tracks.click();
    assert.equal(await audio.inputValue(), "2");
    assert.equal(await subtitle.inputValue(), "3");
    assert.equal(await page.locator("video").evaluate(video => {
        video.dispatchEvent(new Event("loadedmetadata"));
        return video.textTracks[0].mode;
    }), "hidden", "the player draws subtitles itself, so the browser keeps the track hidden");
    // The player's own subtitle layer shows the active cue without YouTube's ">>" mark.
    await page.locator("video").evaluate(video => {
        const track = video.textTracks[0];
        Object.defineProperty(track, "activeCues", { configurable: true, get: () => [{ text: ">> Hello &amp; welcome\n<i>Second line</i>" }] });
        track.dispatchEvent(new Event("cuechange"));
    });
    assert.deepEqual(await page.locator(".movie-ui-sub").allInnerTexts(), ["Hello & welcome", "Second line"]);
    if (browser.browserType() === chromium)
        await page.waitForFunction(() => document.querySelector("video").textTracks[0].cues?.length === 1);
    await subtitle.selectOption("-1");
    await audio.focus();
    await audio.selectOption("1");
    await back.waitFor();
    await audio.waitFor();
    await focused(audio);
    assert.equal(await subtitle.inputValue(), "-1");
    assert.deepEqual(await preferences("viewer-a"), { audio: "hu", subtitles: "hu" });
    await back.press("Space");
    await focused(two);
    await one.press("Enter");
    await page.getByText("Hungarian audio unavailable. Using the default track. Hungarian subtitles unavailable. Subtitles are off.").waitFor();
    await back.press("Space");
    await focused(one);
    assert.deepEqual(requestedTracks, [2, 1]);
    assert.equal(await page.locator("main").evaluate(node => node.scrollWidth <= node.clientWidth), true);

    await open("viewer-b");
    assert.deepEqual(await preferences("viewer-b"), { audio: "default", subtitles: "default" });
    await two.press("Enter");
    await back.waitFor();
    await openTracks();
    assert.equal(await subtitle.inputValue(), "4");
    await back.press("Space");
    await focused(two);
    assert.equal(await preferences("viewer-b", { audio: "default", subtitles: "off" }), true);
    await two.press("Enter");
    await back.waitFor();
    await openTracks();
    assert.equal(await subtitle.inputValue(), "-1");
    await page.reload();
    await open("viewer-a");
    assert.deepEqual(await preferences("viewer-a"), { audio: "hu", subtitles: "hu" });

    // The library card predates the position saved on another device.
    savedPosition = 180;
    await two.press("Enter");
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
    await audio.selectOption("1");
    await focused(audio);
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
    await two.press("Enter");
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

    // The HTTP-only fallback must keep the saved position when it cannot seek.
    await page.evaluate(() => {
        HTMLMediaElement.prototype.canPlayType = () => "";
        window.MediaSource = window.ManagedMediaSource = undefined;
    });
    const reportCount = reports.length;
    await open("viewer-a");
    await two.press("Enter");
    await page.getByText("This device cannot resume this video. Continue on another device.").waitFor();
    await focused(two);
    assert.equal(reports.length, reportCount);
    await page.close();
}

(async () => {
    for (const [engine, desktop, phone] of [
        [chromium, { width: 1280, height: 800 }, "Pixel 7"],
        [webkit, { width: 768, height: 1024 }, "iPhone 13"]
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
