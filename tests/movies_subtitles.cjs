const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, output, moviePage, playMovieDetails, verifyMovieProfiles } = require("./movies_fixture.cjs");

const clip = fs.readFileSync(path.join(__dirname, "fixtures/movie-subtitles.mp4"));

async function verify(browser, profile, options) {
    const page = await browser.newPage({...options, locale: "hu-HU"});
    page.setDefaultTimeout(7000);
    const decodeVideo = browser.browserType().name() === "chromium";
    let finishSearch, finishSave, saved = false, mediaReads = 0, playbackRequests = 0;
    const searchGate = new Promise(resolve => { finishSearch = resolve; });
    const saveGate = new Promise(resolve => { finishSave = resolve; });
    let savedId, lastLanguage, englishAttempts = 0;
    const addedTrack = {Type: "Subtitle", IsTextSubtitleStream: true, IsExternal: true, Language: "hun",
        DisplayTitle: "Hungarian (external)", Index: 3, Path: "/internal/trinity.hun.srt"};
    const englishTrack = {...addedTrack, Language: "eng", DisplayTitle: "English (external)", Index: 4,
        Path: "/internal/trinity.en.srt"};
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
                if (englishAttempts === 5) MediaStreams.push(englishTrack);
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
            if (url.pathname === "/Videos/trinity/source/Subtitles/4/Stream.vtt")
                return reply({contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nEnglish fixture cue\n"});
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
            saveMoviePreferences(viewer, {subtitles: "off"});
            window.openMovieFixture(openMovies, document.querySelector("main"), {url: jellyfin, user: "fixture", token: "fixture", device: "fixture"},
                {invokeMethodAsync: async (method, item, language) => {
                    if (method !== "MovieFetchSubtitle") return "{}";
                    if (item !== "trinity" || language !== "en") throw Error("Unexpected subtitle request");
                    const reasons = [
                        "Subtitle provider is not set up",
                        "No subtitles found for this title and language. Try another language.",
                        "Daily subtitle limit reached, try again tomorrow. The limit resets at 2099-12-31 10:15 UTC.",
                        "The subtitle provider is unreachable. Try again later."
                    ];
                    window.subtitleFallbacks = (window.subtitleFallbacks ?? 0) + 1;
                    const error = reasons[window.subtitleFallbacks - 1];
                    return JSON.stringify(error ? {error} : {added: true, existing: false, refresh_pending: false});
                }}, viewer);
        }, jellyfin);
        const title = "They Call Me Trinity";
        await playMovieDetails(page, page.getByRole("button", {name: title, exact: true}).first(), title);
        const video = page.locator("video");
        await video.waitFor();
        await video.evaluate(async node => {
            window.originalVideo = node;
            window.originalVideoSrc = node.src;
            node.muted = true;
            await node.play();
        });
        const tracks = page.getByRole("button", {name: "Audio & Subtitles", exact: true});
        await tracks.press("Enter");
        const close = page.getByRole("button", {name: "Close audio and subtitles"});
        const focused = locator => locator.evaluate(node => node === document.activeElement);
        assert.equal(await focused(close), true);
        await page.getByRole("heading", {name: "Subtitles", exact: true}).waitFor();
        const sheet = page.getByRole("dialog", {name: "Audio & Subtitles"});
        assert.equal(await sheet.getByRole("combobox", {name: "Subtitle language"}).count(), 0);
        const audio = sheet.getByRole("radiogroup", {name: "Audio track", exact: true});
        const findEnglishAudio = audio.getByRole("button", {name: "Find English audio", exact: true});
        assert.equal(await audio.getByRole("radio", {name: "English", exact: true}).getAttribute("aria-disabled"), "true");
        await findEnglishAudio.press("Enter");
        const addAudio = page.getByRole("dialog", {name: "Add audio track", exact: true});
        assert.equal(await addAudio.getByRole("combobox", {name: "Track language"}).inputValue(), "en");
        await addAudio.getByRole("button", {name: "Close", exact: true}).press("Enter");
        assert.equal(await focused(findEnglishAudio), true);
        const findHungarian = sheet.getByRole("button", {name: "Find Hungarian subtitles"});
        const findEnglish = sheet.getByRole("button", {name: "Find English subtitles"});
        const subtitles = sheet.getByRole("radiogroup", {name: "Subtitle track", exact: true});
        const hungarian = subtitles.getByRole("radio", {name: "Hungarian", exact: true});
        const english = subtitles.getByRole("radio", {name: "English", exact: true});
        const off = subtitles.getByRole("radio", {name: "Off", exact: true});
        const status = message => sheet.getByRole("status").filter({hasText: message}).waitFor();
        assert.equal(await findHungarian.getAttribute("title"), "Find Hungarian subtitles");
        assert.equal(await hungarian.getAttribute("aria-disabled"), "true");
        assert.equal(await english.getAttribute("aria-disabled"), "true");
        await hungarian.evaluate(row => row.click());
        assert.equal(await off.getAttribute("aria-checked"), "true");
        const pausedBefore = await video.evaluate(node => {
            // The short cue fixture still decodes at its native position.
            Object.defineProperty(node, "currentTime", {value: 600, writable: true});
            return node.paused;
        });
        const checkPlayback = async paused => {
            assert.deepEqual(await video.evaluate(node => [
                node === window.originalVideo && node.src === window.originalVideoSrc,
                Math.abs(node.currentTime - 600) <= 2,
                node.paused
            ]), [true, true, paused]);
        };
        await findHungarian.press("Enter");
        await status("Searching for Hungarian subtitles");
        assert.equal(englishAttempts, 0);
        assert.equal(await focused(findHungarian), true);
        const spinner = findHungarian.locator(".movie-track-spinner");
        await spinner.waitFor();
        assert.equal(await findEnglish.locator(".movie-track-spinner").isVisible(), false);
        const running = () => spinner.evaluate(node => node.getAnimations().some(animation => animation.playState === "running"));
        await page.emulateMedia({reducedMotion: "no-preference"});
        assert.equal(await running(), true);
        await page.emulateMedia({reducedMotion: "reduce"});
        assert.equal(await running(), false);
        await page.emulateMedia({reducedMotion: options.reducedMotion ?? "no-preference"});
        await page.screenshot({path: path.join(output, profile + "-subtitles.png")});
        finishSearch();
        finishSave();
        await status("Found");
        await checkPlayback(pausedBefore);
        assert.equal(lastLanguage, "hun");
        assert.equal(englishAttempts, 0);
        assert.equal(savedId, "provider_srt-hun-42");
        assert.ok(mediaReads >= 2);
        await findHungarian.waitFor({state: "hidden"});
        assert.equal(await focused(hungarian), true);
        assert.equal(await hungarian.getAttribute("aria-disabled"), "false");
        assert.equal(await hungarian.getAttribute("aria-checked"), "false");
        assert.equal(await off.getAttribute("aria-checked"), "true");
        await hungarian.press("Space");
        assert.equal(await video.evaluate(node => [...node.textTracks].find(track => track.language === "hun").mode), "hidden");
        await checkPlayback(pausedBefore);
        if (!decodeVideo) {
            await video.evaluate(node => {
                const track = [...node.textTracks].find(track => track.language === "hun");
                Object.defineProperty(track, "activeCues", {value: [{text: "Hungarian fixture cue"}]});
                track.dispatchEvent(new Event("cuechange"));
            });
        }
        await page.getByText("Hungarian fixture cue").waitFor();
        await video.evaluate(node => node.pause());
        await findEnglish.press("Space");
        await status("Subtitle provider is not set up. Ask an admin to configure the OpenSubtitles API key.");
        assert.equal(await page.getByText("HTTP 503").count(), 0);
        assert.equal(await focused(findEnglish), true);
        await page.keyboard.press("Enter");
        await status("No subtitles found for this title and language. Try another language.");
        await page.keyboard.press("Enter");
        await status("Daily subtitle limit reached, try again tomorrow. The limit resets at 2099-12-31 10:15 UTC.");
        await page.keyboard.press("Enter");
        await status("The subtitle provider is unreachable. Try again later.");
        assert.equal(lastLanguage, "eng");
        assert.equal(await focused(findEnglish), true);
        await page.keyboard.press("Enter");
        await status("Found");
        await checkPlayback(true);
        assert.equal(await english.getAttribute("aria-checked"), "false");
        assert.equal(await hungarian.getAttribute("aria-checked"), "true");
        assert.equal(await focused(english), true);
        assert.equal(playbackRequests, 1);
        assert.equal(await video.evaluate(node => node === window.originalVideo && node.src === window.originalVideoSrc), true);
        await findEnglish.waitFor({state: "hidden"});
        await english.press("Enter");
        assert.equal(await english.getAttribute("aria-checked"), "true");
        await checkPlayback(true);
        assert.equal(await page.evaluate(() => window.subtitleFallbacks), 5);
        await close.press("Enter");
        assert.equal(await focused(tracks), true);
    } finally {
        await page.close();
    }
}

verifyMovieProfiles(verify).then(() => console.log("Subtitle search passed in eight browser profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
