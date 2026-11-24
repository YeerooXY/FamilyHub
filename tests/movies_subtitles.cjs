const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, output, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");

const clip = fs.readFileSync(path.join(__dirname, "fixtures/movie-subtitles.mp4"));

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(7000);
    const decodeVideo = browser.browserType().name() === "chromium";
    let finishSearch, finishSave, saved = false, mediaReads = 0, playbackRequests = 0;
    const searchGate = new Promise(resolve => { finishSearch = resolve; });
    const saveGate = new Promise(resolve => { finishSave = resolve; });
    let savedId, lastLanguage, englishAttempts = 0;
    const addedTrack = {Type: "Subtitle", IsTextSubtitleStream: true, IsExternal: true, Language: "hun",
        DisplayTitle: "Hungarian (external)", Index: 3, Path: "/internal/trinity.hun.srt"};
    try {
        if (!decodeVideo) await page.addInitScript(() => {
            // Windows Playwright WebKit does not decode the H.264 fixture.
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
            if (url.pathname === "/Items/trinity/PlaybackInfo") {
                playbackRequests++;
                return reply({json: {PlaySessionId: "play-1", MediaSources: [{Id: "source", SupportsDirectPlay: true, MediaStreams: []}]}});
            }
            if (url.pathname === "/Items/trinity") {
                const MediaStreams = saved && mediaReads++ > 0 ? [addedTrack] : [];
                return reply({json: {MediaSources: [{Id: "source", MediaStreams}]}});
            }
            if (url.pathname.startsWith("/Items/trinity/RemoteSearch/Subtitles/")) {
                assert.match(req.headers().authorization, /Token="fixture"/);
                assert.equal(url.searchParams.has("api_key"), false);
                const key = url.pathname.split("/").pop();
                if (req.method() === "POST") {
                    savedId = decodeURIComponent(key);
                    await saveGate;
                    saved = true;
                    return reply({status: 204});
                }
                lastLanguage = key;
                if (key === "eng") return ++englishAttempts === 1
                    ? reply({status: 503, body: "HTTP 503"})
                    : reply({json: []});
                assert.equal(key, "hun");
                await searchGate;
                return reply({json: [{Id: "provider_srt-hun-42", Name: "Trinity (1970)", ThreeLetterISOLanguageName: "hun",
                    CommunityRating: 8.5, DownloadCount: 42}]});
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
        await page.evaluate(async jellyfin => {
            const { openMovies, saveMoviePreferences } = await import("/movies.js");
            const viewer = {server: jellyfin + "/", profile: "fixture"};
            saveMoviePreferences(viewer, {subtitles: "hu"});
            sessionStorage.setItem("familyhub:movie-tracks:" + JSON.stringify(viewer) + ":autosub:trinity", "1");
            window.openMovieFixture(openMovies, document.querySelector("main"), {url: jellyfin, user: "fixture", token: "fixture", device: "fixture"},
                {invokeMethodAsync: async () => "{}"}, viewer);
        }, jellyfin);
        const movie = page.getByRole("button", {name: "They Call Me Trinity", exact: true}).first();
        await movie.press("Enter");
        const video = page.locator("video");
        await video.waitFor();
        await video.evaluate(async node => {
            window.originalVideo = node;
            window.originalVideoSrc = node.src;
            node.muted = true;
            await node.play();
        });
        const tracks = page.getByRole("button", {name: "Subtitles", exact: true});
        await tracks.press("Enter");
        const close = page.getByRole("button", {name: "Close subtitles"});
        const focused = locator => locator.evaluate(node => node === document.activeElement);
        assert.equal(await focused(close), true);
        await page.getByRole("heading", {name: "Subtitles", exact: true}).waitFor();
        const language = page.getByRole("combobox", {name: "Subtitle language"});
        assert.equal(await language.inputValue(), "hun");
        await language.selectOption("eng");
        const find = page.getByRole("button", {name: "Find subtitles"});
        await find.focus();
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(language), true);
        await page.keyboard.press("Tab");
        assert.equal(await focused(find), true);
        await page.keyboard.press("Enter");
        await page.getByRole("status").filter({hasText: "Could not search for subtitles."}).waitFor();
        assert.equal(await page.getByText("HTTP 503").count(), 0);
        assert.equal(await focused(find), true);
        await page.keyboard.press("Enter");
        await page.getByRole("status").filter({hasText: "No subtitles found."}).waitFor();
        assert.equal(lastLanguage, "eng");
        assert.equal(await focused(find), true);
        await language.selectOption("hun");
        await find.press("Space");
        await page.getByRole("status").filter({hasText: "Searching for subtitles…"}).waitFor();
        assert.equal(await focused(find), true);
        finishSearch();
        const result = page.getByRole("button", {name: /Trinity \(1970\).*Hungarian.*Rating.*42 downloads/});
        await result.waitFor();
        await page.keyboard.press("Tab");
        assert.equal(await focused(result), true);
        await page.screenshot({path: path.join(output, profile + "-subtitles.png")});
        const position = await video.evaluate(node => node.currentTime);
        await page.keyboard.press("Space");
        await page.getByRole("status").filter({hasText: "Adding subtitles…"}).waitFor();
        assert.equal(await focused(result), true);
        finishSave();
        await page.getByRole("status").filter({hasText: "Subtitles added."}).waitFor();
        assert.equal(savedId, "provider_srt-hun-42");
        assert.ok(mediaReads >= 2);
        assert.equal(playbackRequests, 1);
        assert.equal(await focused(tracks), true);
        assert.equal(await video.evaluate(node => node === window.originalVideo && node.src === window.originalVideoSrc), true);
        assert.equal(await video.evaluate(node => node.textTracks[0].mode), "hidden");
        if (decodeVideo) {
            assert.ok(await video.evaluate((node, position) => !node.paused && node.currentTime > position, position));
        } else {
            await video.evaluate(node => {
                const track = node.textTracks[0];
                Object.defineProperty(track, "activeCues", {value: [{text: "Hungarian fixture cue"}]});
                track.dispatchEvent(new Event("cuechange"));
            });
        }
        await page.getByText("Hungarian fixture cue").waitFor();
        await tracks.press("Enter");
        assert.equal(await page.getByRole("radio", {name: "Hungarian (external)"}).getAttribute("aria-checked"), "true");
        await close.press("Enter");
        assert.equal(await focused(tracks), true);
    } finally {
        await page.close();
    }
}

verifyMovieProfiles(verify).then(() => console.log("Subtitle search passed in eight browser profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
