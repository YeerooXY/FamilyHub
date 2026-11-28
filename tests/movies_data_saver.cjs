const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, playerOutput, moviePage, playMovieDetails, verifyMovieProfiles, stubMovieHls } = require("./movies_fixture.cjs");

const output = process.argv[2] || playerOutput;
const item = { Id: "in-time", Name: "In Time", Type: "Movie" };
const streams = [
    { Type: "Audio", Index: 1, Language: "eng", Channels: 6, DisplayTitle: "English" },
    { Type: "Audio", Index: 2, Language: "hun", Channels: 6, DisplayTitle: "Hungarian", IsExternal: true },
    { Type: "Subtitle", Index: 3, DisplayTitle: "English", IsTextSubtitleStream: true,
        FamilyHubSubtitleTiming: { method: "release", state: "idle" } }
];

async function checkAppSettings(page, name, origin) {
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname), "Use a local Razor stub");
    const openSettings = async () => {
        await page.goto(origin);
        await page.getByRole("button", { name: /^Music\b/ }).click();
        await page.getByRole("button", { name: "Profile menu" }).click();
        await page.locator("#profile-menu[open] #open-settings").click();
        await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    };
    await openSettings();
    await page.locator("#settings-data").click();
    const movies = page.locator('#movie-data-saver input[value="good"]:enabled');
    await movies.press("Space");
    assert(await movies.isChecked());
    assert(await movies.evaluate(el => el === document.activeElement));
    await page.screenshot({ path: path.join(output, name + "-movies-settings.png") });
    if (page.viewportSize().width <= 720) await page.getByRole("button", { name: "Back to settings categories" }).click();
    await page.locator("#settings-music").click();
    const music = page.getByRole("checkbox", { name: "Data saver" });
    await music.press("Space");
    assert(await music.isChecked());
    await page.screenshot({ path: path.join(output, name + "-music-settings.png") });
    await music.press("Space");
    await openSettings();
    await page.locator("#settings-data").click();
    await page.locator('#movie-data-saver input[value="good"]:checked').waitFor();
}

async function check(browser, name, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(7000);
    const requests = [];
    const errors = [];
    let heldPlayback, range = "SDR", remux = false, countedBytes = 412_000_000;
    page.on("pageerror", error => errors.push(error.message));
    try {
        await stubMovieHls(page, {metadata: true});
        await page.addInitScript(() => {
            const match = window.matchMedia.bind(window);
            window.matchMedia = query => query === "(dynamic-range: high)" ? { matches: !!window.fixtureHdrDisplay } : match(query);
            const connection = Object.assign(new EventTarget(), { type: "wifi", saveData: false });
            Object.defineProperty(navigator, "connection", { value: connection });
            window.nativeConnection = "";
            window.changeConnection = type => {
                connection.type = type;
                connection.dispatchEvent(new Event("change"));
            };
            const media = HTMLMediaElement.prototype;
            media.canPlayType = () => "probably";
            media.play = function () { this.fixturePaused = false; return Promise.resolve(); };
            media.pause = function () { this.fixturePaused = true; };
            media.load = () => {};
            Object.defineProperties(media, {
                paused: { get() { return this.fixturePaused ?? true; } },
                duration: { get() { return 7200; } },
                currentTime: { get() { return this.fixtureTime ?? 0; }, set(time) { this.fixtureTime = time; } },
                src: { get() { return this.fixtureSource; }, set(url) {
                    this.fixtureSource = String(url);
                    setTimeout(() => this.dispatchEvent(new Event("loadedmetadata")), 0);
                } }
            });
            // Check the full-window layout without a platform fullscreen prompt.
            Element.prototype.requestFullscreen = () => Promise.resolve();
        });
        await page.route(jellyfin + "/**", async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            const json = body => route.fulfill({ headers: cors, json: body });
            if (url.pathname.endsWith("/PlaybackInfo")) {
                const body = request.postDataJSON();
                requests.push(body);
                await heldPlayback;
                await new Promise(resolve => setTimeout(resolve, 80));
                return json({ PlaySessionId: String(requests.length), MediaSources: [{
                    Id: "source", Bitrate: 10700000, SupportsDirectPlay: body.EnableDirectPlay && !remux,
                    SupportsDirectStream: remux, TranscodeReasons: remux ? ["ContainerNotSupported"] : [],
                    TranscodingUrl: "/Videos/in-time/master.m3u8?VideoCodec=h264",
                    MediaStreams: [{Type: "Video", Index: 0, Height: 1080, Codec: "h264", VideoRangeType: range}, ...streams],
                    DefaultAudioStreamIndex: body.AudioStreamIndex ?? 1,
                    DefaultSubtitleStreamIndex: -1
                }] });
            }
            if (url.pathname === "/MediaUsage") {
                assert.match(request.postDataJSON().stream, /^[0-9a-f]{32}$/);
                return json({bytes: countedBytes});
            }
            if (url.pathname === "/Items" && url.searchParams.get("includeItemTypes") === "Movie")
                return json({ Items: [item], TotalRecordCount: 1 });
            if (url.pathname === "/Items/" + item.Id)
                return json({ UserData: { PlaybackPositionTicks: 125 * 1e7 } });
            if (url.pathname.endsWith("Stream.vtt"))
                return route.fulfill({ headers: cors, contentType: "text/vtt", body: "WEBVTT\n\n" });
            return json({ Items: [], TotalRecordCount: 0 });
        });
        await moviePage(page);
        const screen = await page.evaluate(async () => (await import("/movies.js")).movieScreen("auto"));
        const estimates = original => page.evaluate(async original => (await import("/movies.js")).movieQualityEstimates(original), original);
        assert.deepEqual(await estimates(6), {
            auto: "About 0.5 GB per hour", full: "About 6.0 GB per hour", good: "About 1.1 GB per hour",
            saver: "About 0.5 GB per hour", lowest: "About 0.2 GB per hour"
        });
        assert.equal((await estimates(null)).full, undefined);
        const open = (profile = "alex") => page.evaluate(async ({ jellyfin, profile }) => {
            await window.movies?.close();
            const { openMovies } = await import("/movies.js");
            window.movies = window.openMovieFixture(openMovies, document.querySelector("main"), { url: jellyfin, user: profile, device: "fixture", token: "fixture" },
                { invokeMethodAsync: async method => method === "MovieConnectionKind" ? window.nativeConnection : undefined },
                { server: jellyfin + "/", profile });
        }, { jellyfin, profile });
        const start = () => playMovieDetails(page, page.getByRole("button", { name: item.Name, exact: true }).last(), item.Name);
        const video = page.locator(".movie-video");
        const position = time => page.waitForFunction(time => document.querySelector("video")?.currentTime === time, time);
        const focused = locator => locator.evaluate(el => el === document.activeElement);
        const hint = page.getByRole("status").filter({ hasText: "Switched to Saver on mobile data." });

        function capped(bitrate, height, audio = false) {
            const request = requests.at(-1);
            const { DeviceProfile: profile } = request;
            assert.equal(request.MaxStreamingBitrate, bitrate);
            assert.equal(profile.MaxStreamingBitrate, bitrate);
            assert.equal(request.EnableDirectPlay, false);
            assert.equal(request.EnableDirectStream, false);
            assert.equal(request.EnableTranscoding, true);
            assert.equal(request.AllowVideoStreamCopy, false);
            assert.equal(request.AllowAudioStreamCopy, false);
            const [transcode] = profile.TranscodingProfiles;
            assert.equal(transcode.VideoCodec, "h264");
            assert.equal(transcode.AudioCodec, "aac");
            assert.equal(transcode.Protocol, "hls");
            const [video, audioProfile] = profile.CodecProfiles;
            assert.deepEqual(video.Conditions.map(c => [c.Property, c.Condition, c.Value]), [
                ["Height", "LessThanEqual", String(Math.min(height, screen.height))],
                ["Width", "LessThanEqual", String(screen.width)]
            ]);
            if (audio) {
                assert.equal(request.MaxAudioChannels, 2);
                assert.equal(transcode.MaxAudioChannels, "2");
                assert.equal(transcode.EnableAudioVbrEncoding, false);
                assert.deepEqual(audioProfile.Conditions.map(c => [c.Property, c.Value]), [["AudioBitrate", "96000"], ["AudioChannels", "2"]]);
            }
        }

        const tracks = page.getByRole("button", { name: "Audio & Subtitles", exact: true });
        const audio = page.getByRole("radiogroup", { name: "Audio track" });
        const subtitle = page.getByRole("radiogroup", { name: "Subtitle track" });
        const hungarian = audio.getByRole("radio", { name: "Hungarian", exact: true });
        const english = subtitle.getByRole("radio", { name: "English", exact: true });
        const info = page.getByRole("dialog", {name: "Playback info", exact: true});
        const infoButton = page.getByRole("button", {name: "Playback info", exact: true});
        const closeInfo = page.getByRole("button", {name: "Close playback info"});
        async function infoValues(values) {
            for (const [index, text] of values.entries())
                await info.locator("dd").nth(index).filter({hasText: text}).waitFor();
        }
        const setQuality = (dataSaver, profile = "alex") => page.evaluate(async ({ jellyfin, profile, dataSaver }) => {
            const { readMoviePreferences, saveMoviePreferences } = await import("/movies.js");
            const viewer = { server: jellyfin + "/", profile };
            return saveMoviePreferences(viewer, { ...readMoviePreferences(viewer), dataSaver });
        }, { jellyfin, profile, dataSaver });

        await open();
        await start();
        await position(125);
        assert.equal(requests.at(-1).MaxStreamingBitrate, undefined);
        assert.equal(requests.at(-1).DeviceProfile.MaxStreamingBitrate, undefined);
        assert.match(await video.evaluate(el => el.src), /\/stream\?.*static=true/);
        assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).count(), 0);
        await page.getByRole("button", {name: "Sound & subtitle style", exact: true}).press("Enter");
        assert.equal(await infoButton.evaluate(el => el === el.parentElement.lastElementChild), true);
        await infoButton.press("Enter");
        await infoValues(["Direct play", "1080p, H264, SDR", "English, 5.1", "Off", "412 MB", "Wi-Fi"]);
        {
            const shots = require("node:path").join(__dirname, "../.local/playback-info");
            require("node:fs").mkdirSync(shots, {recursive: true});
            await page.screenshot({path: require("node:path").join(shots, name + ".png"), animations: "disabled"});
        }
        assert(await focused(closeInfo));
        const box = await info.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= page.viewportSize().width);
        if (page.viewportSize().width === 2000) {
            await page.setViewportSize({width: 1920, height: 1080});
            assert((await closeInfo.boundingBox()).height >= 60);
            assert.equal(await closeInfo.evaluate(el => getComputedStyle(el).outlineWidth), "4px");
            await page.setViewportSize(options.viewport);
        }
        await page.locator(".movie-ui").evaluate(node => node.classList.add("movie-idle"));
        assert(await info.isVisible());
        await closeInfo.press("Escape");
        assert(await focused(infoButton));
        await page.keyboard.press("Escape");
        await page.keyboard.press("i");
        assert(await info.isVisible());
        await page.locator(".movie-ui").evaluate(node => node.dispatchEvent(new Event("movie-back")));
        assert.equal(await info.count(), 0);
        await page.keyboard.press("i");
        await closeInfo.click();
        assert.equal(await info.count(), 0);
        await video.evaluate(el => { el.currentTime = 387; el.pause(); });
        await tracks.press("Enter");
        await hungarian.press("Enter");
        await audio.getByRole("radio", { name: "Hungarian", exact: true, checked: true }).waitFor();
        const beforeSubtitle = await video.elementHandle();
        await english.press("Enter");
        await position(387);
        assert.equal(await video.evaluate((node, previous) => node === previous && node.paused, beforeSubtitle), true);
        await page.evaluate(() => {
            window.focusLost = false;
            window.focusWatch = setInterval(() => { window.focusLost ||= document.activeElement === document.body; }, 5);
        });
        let releasePlayback;
        heldPlayback = new Promise(resolve => { releasePlayback = resolve; });
        try {
            await page.evaluate(() => window.changeConnection("cellular"));
            const opening = page.getByRole("status").filter({hasText: "Opening In Time"});
            await opening.waitFor();
            assert.equal(await opening.count(), 1);
            assert(await opening.evaluate(node => node.closest(".movie-expanded") !== null));
        } finally {
            heldPlayback = undefined;
            releasePlayback();
        }
        await hint.waitFor();
        await position(387);
        capped(1_000_000, 480, true);
        assert.match(await video.evaluate(el => el.fixtureManifest ?? el.src), /master\.m3u8/);
        assert(await video.evaluate(el => el.paused));
        assert.equal(requests.at(-1).AudioStreamIndex, 2);
        assert.equal(requests.at(-1).SubtitleStreamIndex, -1);
        assert.equal(await hungarian.getAttribute("aria-checked"), "true");
        assert.equal(await english.getAttribute("aria-checked"), "true");
        assert(await focused(hungarian));
        assert.equal(await page.evaluate(() => {
            clearInterval(window.focusWatch);
            return window.focusLost;
        }), false, "keyboard focus fell to the body");
        countedBytes = 488_000_000;
        await page.keyboard.press("i");
        await infoValues(["Converted", "H264, SDR", "Hungarian, Stereo", "English, Timing from the release", "488 MB", "Mobile data"]);
        assert.match(await info.locator("dd").first().textContent(), /Streaming quality limit/);
        await page.keyboard.press("i");
        await page.keyboard.press("Escape");
        await page.screenshot({ path: path.join(output, name + "-auto.png") });

        for (const [choice, bitrate, height, limitAudio] of [
            ["good", 2_500_000, 720, false], ["saver", 1_000_000, 480, true],
            ["lowest", 500_000, 360, true], ["full"]
        ]) {
            assert(await setQuality(choice));
            await open();
            await start();
            await position(125);
            if (bitrate) capped(bitrate, height, limitAudio);
            else {
                assert.equal(requests.at(-1).MaxStreamingBitrate, undefined);
                assert.equal(requests.at(-1).DeviceProfile.MaxStreamingBitrate, undefined);
            }
            if (choice === "lowest") await page.screenshot({ path: path.join(output, name + "-lowest.png") });
        }

        assert(await setQuality("lowest"));
        await page.reload();
        await open();
        await start();
        await position(125);
        capped(500_000, 360, true);

        await open("june");
        await page.evaluate(() => { window.nativeConnection = "cellular"; });
        await start();
        await position(125);
        capped(1_000_000, 480, true);
        await hint.waitFor();
        await page.getByRole("button", { name: "Back to movies" }).press("Enter");
        await page.getByRole("region", { name: item.Name, exact: true })
            .getByRole("button", { name: /^(Play$|Continue\b)/ }).press("Enter");
        await position(125);
        capped(1_000_000, 480, true);
        assert.equal(await hint.count(), 0, "Auto should show its hint once per profile");
        assert(await setQuality("full", "june"));
        remux = true;
        await open("june");
        await start();
        await position(125);
        await page.keyboard.press("i");
        await infoValues(["Direct stream", "1080p, H264, SDR", "English, 5.1", "Off", "488 MB", "Mobile data"]);
        remux = false;
        range = "HDR10";
        const beforeHdr = requests.length;
        await open("june");
        await start();
        await position(125);
        assert.equal(requests.length, beforeHdr + 2);
        assert.equal(requests.at(-1).AllowVideoStreamCopy, false);
        assert.equal(requests.at(-1).EnableDirectPlay, false);
        assert.equal(requests.at(-1).EnableDirectStream, false);
        assert.equal(requests.at(-1).DeviceProfile.TranscodingProfiles[0].VideoCodec, "h264");
        await page.keyboard.press("i");
        // The height comes from the playing clip, so check codec and range only.
        await infoValues(["Converted", "H264, SDR", "English, 5.1", "Off", "488 MB", "Mobile data"]);
        assert.match(await info.locator("dd").first().textContent(), /HDR to SDR/);
        await open("june");
        await page.evaluate(() => { window.fixtureHdrDisplay = true; });
        const beforeHdrDisplay = requests.length;
        await start();
        await position(125);
        assert.equal(requests.length, beforeHdrDisplay + 1);
        assert.equal(requests.at(-1).AllowVideoStreamCopy, undefined);
        await page.keyboard.press("i");
        await infoValues(["Direct play", "1080p, H264, HDR", "English, 5.1", "Off", "488 MB", "Mobile data"]);
        if (process.env.DATA_SAVER_SHELL_URL) await checkAppSettings(page, name, process.env.DATA_SAVER_SHELL_URL);
        assert.deepEqual(errors, []);
        console.log("PASS", name);
    } finally {
        await page.context().close();
    }
}

fs.mkdirSync(output, { recursive: true });
verifyMovieProfiles(check).catch(error => { console.error(error); process.exitCode = 1; });
