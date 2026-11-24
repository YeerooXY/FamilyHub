const assert = require("node:assert/strict");
const path = require("node:path");
const { jellyfin, cors, output, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");

verifyMovieProfiles(async (browser, profile, options) => {
    if (profile.endsWith("2000")) return;
    const page = await browser.newPage(options);
    page.setDefaultTimeout(7000);
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.canPlayType = () => "probably";
        HTMLMediaElement.prototype.play = function () {
            if (this.tagName === "AUDIO") {
                this.fixturePlaying = true;
                window.fixtureAudio = this;
            }
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () { this.fixturePlaying = false; };
        const create = document.createElement.bind(document);
        document.createElement = (tag, ...args) => {
            const el = create(tag, ...args);
            if (tag === "audio") {
                Object.defineProperties(el, {
                    readyState: { value: 4 }, duration: { value: 100 },
                    src: { value: "", writable: true },
                    currentTime: { value: 0, writable: true },
                    paused: { get: () => !el.fixturePlaying }
                });
            }
            return el;
        };
    });
    const movie = {Id: "a".repeat(32), Name: "In Time", Type: "Movie", Overview: "A man races against the clock."};
    const tracks = [{Type: "Audio", Index: 1, Language: "eng", DisplayTitle: "English"},
        {Type: "Audio", Index: 7, Language: "hun", IsExternal: true}];
    const requested = [];
    await page.route(jellyfin + "/**", route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() === "OPTIONS") return route.fulfill({status: 204, headers: cors});
        let json = {Items: [], TotalRecordCount: 0};
        if (url.pathname === "/Items" && url.searchParams.get("includeItemTypes") === "Movie")
            json = {Items: [movie], TotalRecordCount: 1};
        if (url.pathname === "/Items/" + movie.Id) json = movie;
        if (url.pathname.endsWith("/PlaybackInfo")) {
            const index = req.postDataJSON().AudioStreamIndex;
            if (index != null) requested.push(index);
            json = {PlaySessionId: "fixture", MediaSources: [{Id: movie.Id, SupportsDirectPlay: index == null,
                DefaultAudioStreamIndex: index ?? 1, DefaultSubtitleStreamIndex: -1, MediaStreams: tracks,
                TranscodingUrl: "/Videos/" + movie.Id + "/stream"}]};
        }
        return route.fulfill({headers: cors, json});
    });
    await moviePage(page);
    await page.evaluate(async ({jellyfin, movie}) => {
        const {openMovies} = await import("/movies.js");
        const result = {id: "report", state: "Added", can_delete: true,
            report: {offset_ms: -1200, speed_ratio: 1.0427, confidence: "high", matched: true}};
        const job = {id: "job", item: movie.Id, name: "Adding Hungarian audio to In Time",
            state: "Added", progress: 1, results: [result]};
        let started = false;
        const handlers = {
            MovieDownloads: () => ({available: true, items: started ? [job] : []}),
            MovieAudioSources: (item, offset) => {
                if (item !== movie.Id || offset !== 0) throw Error("Unexpected source request");
                return {sources: [{id: "b".repeat(64), name: "In Time dub.mkv", location: "Imports",
                    streams: [{index: 3, language: "hun", codec: "ac3", channels: 6, duration: 6000}]}], next: null};
            },
            MovieAddAudio: (item, source, index, code, title) => {
                if (item !== movie.Id || source !== "b".repeat(64) || index !== 3 || code !== "hu" || title !== "Hungarian")
                    throw Error("Unexpected audio request");
                started = true;
                return {...job, state: "Waiting", progress: 0, results: []};
            },
            MovieDeleteAudioSource: (id, resultId) => {
                if (id !== "job" || resultId !== "report") throw Error("Unexpected delete request");
                window.removedAudio = true;
                result.can_delete = false;
                return job;
            }
        };
        window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
            {url: jellyfin, user: "owner", device: "fixture", token: "fixture", downloads_enabled: true},
            {invokeMethodAsync: async (method, ...args) => JSON.stringify(handlers[method]?.(...args))},
            {profile: "owner"});
    }, {jellyfin, movie});
    const focused = async node => page.waitForFunction(el => el === document.activeElement, await node.elementHandle());
    const library = page.getByRole("region", {name: "Audio tracks"});
    const add = page.getByRole("button", {name: "Add audio track for In Time", exact: true}).first();
    await add.press("Enter");
    const sheet = page.getByRole("dialog", {name: "Add audio track"});
    const close = sheet.getByRole("button", {name: "Close", exact: true});
    await focused(close);
    const start = sheet.getByRole("button", {name: "Start matching"});
    await sheet.getByRole("option", {name: /Hungarian.*AC3.*6 ch/}).waitFor({state: "attached"});
    assert.equal(await sheet.getByRole("combobox", {name: "Track language"}).inputValue(), "hu");
    await page.screenshot({path: path.join(output, profile + "-sources.png")});
    await start.press("Enter");
    await sheet.getByText("Audio moved 1.2 s earlier. Confidence high.").waitFor();
    await focused(start);
    await page.screenshot({path: path.join(output, profile + "-result.png")});
    await close.press("Enter");
    await focused(add);
    await library.getByText(jobName()).waitFor();
    const remove = library.getByRole("button", {name: "Delete source file"});
    await remove.press("Enter");
    const keep = library.getByRole("button", {name: "Keep file"});
    await focused(keep);
    await keep.press("Enter");
    await focused(remove);
    await remove.press("Enter");
    await library.getByRole("button", {name: "Delete file", exact: true}).press("Enter");
    await library.getByText("Source file deleted.").waitFor();
    assert.equal(await page.evaluate(() => window.removedAudio), true);

    await page.getByRole("button", {name: "In Time", exact: true}).first().press("Enter");
    const audio = page.getByRole("button", {name: "Audio", exact: true});
    await audio.press("Enter");
    const source = page.getByRole("radio", {name: "Hungarian, added"});
    function simulateVideo() {
        const video = page.locator("video");
        return video.evaluate(media => {
            Object.defineProperties(media, {
                duration: {value: 100}, currentTime: {value: 5, writable: true}, paused: {value: false}
            });
            media.dispatchEvent(new Event("loadedmetadata"));
            media.dispatchEvent(new Event("playing"));
            return media.currentTime;
        });
    }
    await simulateVideo();
    await source.press("Enter");
    await focused(source);
    assert.equal(await simulateVideo(), 5);
    assert.deepEqual(requested, [7]);
    const plus = page.getByRole("button", {name: "Play audio 100 ms later"});
    await plus.press("Enter");
    await focused(plus);
    await page.getByText("100 ms later", {exact: true}).waitFor();
    await page.waitForFunction(() => window.fixtureAudio?.currentTime === 4.9 && document.querySelector("video").muted);
    const minus = page.getByRole("button", {name: "Play audio 100 ms earlier"});
    if (options.hasTouch) {
        await minus.tap();
        await minus.tap();
    } else {
        await minus.press("Space");
        await minus.press("Enter");
    }
    await focused(minus);
    await page.getByText("100 ms earlier", {exact: true}).waitFor();
    await page.waitForFunction(() => window.fixtureAudio?.currentTime === 5.1 && document.querySelector("video").muted);
    await page.screenshot({path: path.join(output, profile + "-sync.png")});
    const addFromPlayer = page.getByRole("button", {name: "Add audio track"});
    await addFromPlayer.press("Enter");
    await focused(close);
    await close.press("Enter");
    await focused(addFromPlayer);
    await page.close();
}).catch(error => { console.error(error); process.exitCode = 1; });

function jobName() { return "Adding Hungarian audio to In Time"; }
