// Automatic subtitles: a title with no subtitle in the viewer's language gets the most downloaded one, once a week at most.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");

const clip = fs.readFileSync(path.join(__dirname, "fixtures/movie-subtitles.mp4"));

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(7000);
    const decodeVideo = browser.browserType().name() === "chromium";
    let searches = 0, saves = [], saved = false, mediaReads = 0;
    const addedTrack = {Type: "Subtitle", IsTextSubtitleStream: true, IsExternal: true, Language: "hun",
        DisplayTitle: "Hungarian (external)", Index: 3, Path: "/internal/trinity.hun.srt"};
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
                assert.equal(key, "hun");
                return reply({json: [
                    {Id: "provider_srt-hun-7", Name: "Trinity rare", DownloadCount: 7, CommunityRating: 9},
                    {Id: "provider_srt-hun-420", Name: "Trinity popular", DownloadCount: 420, CommunityRating: 7},
                    {Id: "provider_srt-hun-99", Name: "Trinity middle", DownloadCount: 99, CommunityRating: 8}]});
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
            window.openMovieFixture(openMovies, document.querySelector("main"), {url: jellyfin, user: "fixture", token: "fixture", device: "fixture"},
                {invokeMethodAsync: async () => "{}"}, viewer);
        }, jellyfin);
        await page.getByRole("button", {name: "They Call Me Trinity", exact: true}).first().press("Enter");
        const video = page.locator("video");
        await video.waitFor();
        await page.getByText("Hungarian subtitles added.").first().waitFor();
        assert.equal(searches, 1);
        assert.deepEqual(saves, ["provider_srt-hun-420"]);
        assert.equal(await video.evaluate(node => node.textTracks.length), 1);
        // The attempt is remembered for the week, so playing the title again does not search again.
        const remembered = await page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith(":autosub:trinity:hu")));
        assert.equal(remembered.length, 1);
        assert.ok(Date.now() - Number(await page.evaluate(key => localStorage.getItem(key), remembered[0])) < 60000);
    } finally {
        await page.close();
    }
}

verifyMovieProfiles(verify).then(() => console.log("Automatic subtitles passed in eight browser profiles."))
    .catch(error => { console.error(error); process.exitCode = 1; });
