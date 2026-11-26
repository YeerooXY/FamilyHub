// Each title gets one automatic search per session. The sheet keeps a manual retry available.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, moviePage, playMovieDetails, verifyMovieProfiles } = require("./movies_fixture.cjs");

const clip = fs.readFileSync(path.join(__dirname, "fixtures/movie-subtitles.mp4"));

async function run(browser, options, scenario) {
    const { preference, locale, language, code, firstResponse, nativeFullscreen = false } = scenario;
    const page = await browser.newPage({ ...options, locale });
    page.setDefaultTimeout(7000);
    const decodeVideo = browser.browserType().name() === "chromium";
    let searches = 0, saves = [], saved = false, mediaReads = 0;
    let releaseSearch;
    const pendingSearch = new Promise(resolve => { releaseSearch = resolve; });
    const addedTrack = {Type: "Subtitle", IsTextSubtitleStream: true, IsExternal: true, Language: code,
        DisplayTitle: language + " (external)", Index: 3, Path: "/internal/trinity.srt"};
    try {
        if (!decodeVideo) await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            document.addEventListener("error", event => {
                if (event.target instanceof HTMLVideoElement) event.stopImmediatePropagation();
            }, true);
        });
        await page.route(jellyfin + "/**", async route => {
            const req = route.request();
            const url = new URL(req.url());
            const reply = props => route.fulfill({headers: cors, ...props});
            if (req.method() === "OPTIONS") return reply({status: 204});
            if (url.pathname === "/Items/trinity/PlaybackInfo")
                return reply({json: {PlaySessionId: "play-1", MediaSources: [{Id: "source", SupportsDirectPlay: true, MediaStreams: []}]}});
            if (url.pathname === "/Items/trinity") {
                const MediaStreams = saved && mediaReads++ > 0 ? [addedTrack] : [];
                return reply({json: {MediaSources: [{Id: "source", MediaStreams}]}});
            }
            if (url.pathname.startsWith("/Items/trinity/RemoteSearch/Subtitles/")) {
                const key = decodeURIComponent(url.pathname.split("/").pop());
                if (req.method() === "POST") { saves.push(key); saved = true; return reply({status: 204}); }
                searches++;
                assert.equal(key, code);
                if (searches === 1) await pendingSearch;
                if (searches === 1 && firstResponse === "error") return reply({status: 503});
                if (searches === 1 && firstResponse === "empty") return reply({json: []});
                return reply({json: [
                    {Id: "provider_srt-7", Name: "Trinity rare", DownloadCount: 7, CommunityRating: 9},
                    {Id: "provider_srt-420", Name: "Trinity popular", DownloadCount: 420, CommunityRating: 7},
                    {Id: "provider_srt-99", Name: "Trinity middle", DownloadCount: 99, CommunityRating: 8}]});
            }
            if (url.pathname === "/Videos/trinity/source/Subtitles/3/Stream.vtt")
                return reply({contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHungarian fixture cue\n"});
            if (url.pathname === "/Videos/trinity/stream") {
                const headers = {...cors, "Content-Type": "video/mp4", "Accept-Ranges": "bytes"};
                const range = req.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
                if (!range) return route.fulfill({headers, body: clip});
                const start = Number(range[1]), end = Math.min(clip.length - 1, Number(range[2] || clip.length - 1));
                headers["Content-Range"] = `bytes ${start}-${end}/${clip.length}`;
                return route.fulfill({headers, status: 206, body: clip.subarray(start, end + 1)});
            }
            if (url.pathname === "/Items")
                return reply({json: {Items: url.searchParams.get("includeItemTypes") === "Movie"
                    ? [{Id: "trinity", Name: "They Call Me Trinity", Type: "Movie"}] : []}});
            return reply({status: 204});
        });
        await moviePage(page);
        await page.evaluate(async ({ jellyfin, preference, nativeFullscreen, firstResponse }) => {
            const { openMovies, saveMoviePreferences } = await import("/movies.js");
            const viewer = {server: jellyfin + "/", profile: "fixture"};
            if (preference) saveMoviePreferences(viewer, {subtitles: preference});
            window.fullscreenCalls = [];
            const host = document.querySelector("main");
            if (nativeFullscreen) host.dataset.nativeFullscreen = "true";
            window.openMovieFixture(openMovies, host,
                {url: jellyfin, user: "fixture", token: "fixture", device: "fixture"},
                {invokeMethodAsync: async (method, on) => {
                    if (method === "MovieFetchSubtitle") return JSON.stringify({error: firstResponse === "error"
                        ? "The subtitle provider is unreachable. Try again later."
                        : "No subtitles found for this title and language. Try another language."});
                    if (method !== "MovieWindowFullscreen") return "{}";
                    window.fullscreenCalls.push(on);
                    return on;
                }}, viewer);
        }, { jellyfin, preference, nativeFullscreen, firstResponse });
        const title = "They Call Me Trinity";
        const open = () => playMovieDetails(page, page.getByRole("button", {name: title, exact: true}).first(), title);
        await open();
        const video = page.locator("video");
        await video.waitFor();
        if (nativeFullscreen) {
            const fullscreen = page.getByRole("button", {name: "Full screen", exact: true});
            const exit = page.getByRole("button", {name: "Exit full screen", exact: true});
            await fullscreen.press("F11");
            await exit.waitFor();
            await page.keyboard.press("Escape");
            await fullscreen.waitFor();
            assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), [true, false]);
        }
        const openSheet = async () => {
            await page.getByRole("button", {name: "Audio & Subtitles", exact: true}).press("Enter");
            return page.getByRole("dialog", {name: "Audio & Subtitles"});
        };
        const sheet = await openSheet();
        const find = sheet.getByRole("button", {name: "Find subtitles", exact: true});
        const off = sheet.getByRole("radio", {name: "Off", exact: true});
        if (preference !== "off") {
            await sheet.getByText("Searching…", {exact: true}).waitFor();
            assert.equal(await find.getAttribute("aria-disabled"), "true");
            assert.equal(await sheet.getByRole("combobox", {name: "Subtitle language"}).inputValue(), code);
            if (!firstResponse) await off.focus();
            releaseSearch();
        }
        if (preference === "off") {
            assert.equal(await find.getAttribute("aria-disabled"), "false");
            assert.equal(searches, 0);
        } else if (firstResponse) {
            await sheet.getByText(firstResponse === "error" ? "The subtitle provider is unreachable. Try again later."
                : "No subtitles found for this title and language. Try another language.",
                {exact: true}).waitFor();
            const retry = sheet.getByRole("button", {name: "Retry", exact: true});
            assert.equal(await sheet.getByText("503", {exact: false}).count(), 0);
            assert.equal(searches, 1);
            assert.equal(await retry.getAttribute("aria-disabled"), "false");
            await retry.press("Enter");
            await sheet.getByRole("button", {name: /Trinity popular/}).waitFor();
            assert.equal(searches, 2);
        } else {
            await sheet.getByText(`${language} subtitles added.`).waitFor();
            assert.equal(searches, 1);
            assert.deepEqual(saves, ["provider_srt-420"]);
            assert.equal(await video.evaluate(node => node.textTracks[0]?.mode), "hidden");
            assert.equal(await off.evaluate(row => row === document.activeElement), true);
            assert.equal(await sheet.getByRole("radio", {name: language + " (external)"}).getAttribute("aria-checked"), "true");
            await sheet.getByRole("button", {name: "Close audio and subtitles"}).press("Enter");
            if (nativeFullscreen) {
                await page.getByRole("button", {name: "Full screen", exact: true}).press("Enter");
                await page.getByRole("button", {name: "Exit full screen", exact: true}).waitFor();
            }
            await page.getByRole("button", {name: "Back to movies"}).press("Enter");
            await video.waitFor({state: "detached"});
            if (nativeFullscreen) assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), [true, false, true, false]);
            await page.getByRole("region", {name: title, exact: true})
                .getByRole("button", {name: /^(Play|Resume)$/}).press("Enter");
            await video.waitFor();
            await openSheet();
            assert.equal(await find.getAttribute("aria-disabled"), "false");
            assert.equal(searches, 1);
        }
    } finally {
        releaseSearch();
        await page.close();
    }
}

verifyMovieProfiles(async (browser, profile, options) => {
    await run(browser, options, {locale: "hu-HU", language: "Hungarian", code: "hun",
        nativeFullscreen: profile === "chromium-1280"});
    await run(browser, options, {preference: "hu", locale: "en-US", language: "Hungarian", code: "hun"});
    await run(browser, options, {preference: "off", locale: "en-US"});
    for (const firstResponse of ["error", "empty"])
        await run(browser, options, {locale: "en-US", language: "English", code: "eng", firstResponse});
}).then(() => console.log("Automatic subtitle search, language, retry, and session limit passed."))
    .catch(error => { console.error(error); process.exitCode = 1; });
