const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jellyfin, cors, moviePage, verifyMovieProfiles } = require("./movies_fixture.cjs");

const output = path.join(__dirname, "../docs/verification/data-saver-2026-11-23");
const item = { Id: "in-time", Name: "In Time", Type: "Movie" };
const streams = [
    { Type: "Audio", Index: 1, DisplayTitle: "English" },
    { Type: "Audio", Index: 2, DisplayTitle: "Hungarian", IsExternal: true },
    { Type: "Subtitle", Index: 3, DisplayTitle: "English", IsTextSubtitleStream: true }
];

async function checkAppSettings(page, name, origin) {
    const openSettings = async () => {
        await page.goto(origin);
        await page.getByRole("button", { name: /^Music\b/ }).click();
        await page.getByRole("button", { name: "Profile menu" }).click();
        await page.locator("#profile-menu[open] #open-settings").click();
        await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    };
    await openSettings();
    await page.locator("#settings-movies").click();
    const movies = page.getByRole("combobox", { name: "Data saver" });
    await page.locator("#movie-data-saver:enabled").waitFor();
    await movies.focus();
    await movies.selectOption("good");
    assert.equal(await movies.inputValue(), "good");
    assert(await movies.evaluate(el => el === document.activeElement));
    await page.screenshot({ path: path.join(output, name + "-movies-settings.png") });
    await page.locator("#settings-music").click();
    const music = page.getByRole("checkbox", { name: "Data saver" });
    await music.press("Space");
    assert(await music.isChecked());
    await page.screenshot({ path: path.join(output, name + "-music-settings.png") });
    await music.press("Space");
    await openSettings();
    await page.locator("#settings-movies").click();
    await page.waitForFunction(() => document.querySelector("#movie-data-saver")?.value === "good");
}

async function check(browser, name, options) {
    if (name.endsWith("-2000")) return;
    const page = await browser.newPage(options);
    page.setDefaultTimeout(7000);
    const requests = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
        await page.addInitScript(() => {
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
                await new Promise(resolve => setTimeout(resolve, 80));
                return json({ PlaySessionId: String(requests.length), MediaSources: [{
                    Id: "source", Bitrate: 10700000, SupportsDirectPlay: body.EnableDirectPlay,
                    TranscodingUrl: "/Videos/in-time/master.m3u8",
                    MediaStreams: streams, DefaultAudioStreamIndex: body.AudioStreamIndex ?? 1,
                    DefaultSubtitleStreamIndex: -1
                }] });
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
        const open = (profile = "alex") => page.evaluate(async ({ jellyfin, profile }) => {
            await window.movies?.close();
            const { openMovies } = await import("/movies.js");
            window.movies = window.openMovieFixture(openMovies, document.querySelector("main"), { url: jellyfin, user: profile, device: "fixture", token: "fixture" },
                { invokeMethodAsync: async method => method === "MovieConnectionKind" ? window.nativeConnection : undefined },
                { server: jellyfin + "/", profile });
        }, { jellyfin, profile });
        const start = () => page.getByRole("button", { name: item.Name, exact: true }).last().press("Enter");
        const settings = page.getByRole("button", { name: "Settings", exact: true });
        const sheet = page.getByRole("dialog", { name: "Settings", exact: true });
        const radio = label => sheet.getByRole("radio", { name: label });
        const video = page.locator(".movie-video");
        const position = time => page.waitForFunction(time => document.querySelector("video")?.currentTime === time, time);
        const focused = locator => locator.evaluate(el => el === document.activeElement);
        const quality = text => sheet.locator("p.movie-quality-label").filter({ hasText: text }).waitFor();
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
            assert.deepEqual(video.Conditions.map(c => [c.Property, c.Condition, c.Value]), [["Height", "LessThanEqual", String(height)]]);
            if (audio) {
                assert.equal(request.MaxAudioChannels, 2);
                assert.equal(transcode.MaxAudioChannels, "2");
                assert.equal(transcode.EnableAudioVbrEncoding, false);
                assert.deepEqual(audioProfile.Conditions.map(c => [c.Property, c.Value]), [["AudioBitrate", "96000"], ["AudioChannels", "2"]]);
            }
        }

        await open();
        await start();
        await position(125);
        assert.equal(requests.at(-1).MaxStreamingBitrate, undefined);
        assert.equal(requests.at(-1).DeviceProfile.MaxStreamingBitrate, undefined);
        assert.match(await video.evaluate(el => el.src), /\/stream\?.*static=true/);
        await video.evaluate(el => { el.currentTime = 387; el.pause(); });
        await settings.press("Enter");
        await quality("Full quality");
        assert(await radio("Full quality, about 4.8 GB an hour").isVisible());
        assert(await focused(radio(/^Auto,/)));
        await page.evaluate(() => {
            window.focusLost = false;
            window.focusWatch = setInterval(() => { window.focusLost ||= document.activeElement === document.body; }, 5);
        });
        await page.evaluate(() => window.changeConnection("cellular"));
        await quality("480p, saving data");
        await hint.waitFor();
        await position(387);
        capped(1_000_000, 480, true);
        assert.match(await video.evaluate(el => el.src), /master\.m3u8/);
        assert(await video.evaluate(el => el.paused));
        assert(await focused(radio(/^Auto,/)));
        await page.screenshot({ path: path.join(output, name + "-auto.png") });

        await radio(/^Good,/).press("Enter");
        await quality("720p, saving data");
        await position(387);
        assert(await focused(radio(/^Good,/)));
        capped(2_500_000, 720);
        await radio(/^Full quality,/).press("Enter");
        await quality("Full quality");
        await position(387);
        assert(await focused(radio(/^Full quality,/)));
        assert.equal(requests.at(-1).MaxStreamingBitrate, undefined);
        assert.equal(requests.at(-1).DeviceProfile.MaxStreamingBitrate, undefined);

        await page.keyboard.press("Escape");
        assert(await focused(settings));
        const tracks = page.getByRole("button", { name: "Audio and subtitles" });
        await tracks.press("Enter");
        await page.getByRole("radio", { name: "Hungarian", exact: true }).press("Enter");
        await page.getByRole("radio", { name: "Hungarian", checked: true }).waitFor();
        const subtitle = page.getByRole("radiogroup", { name: "Subtitle track" });
        await subtitle.getByRole("radio", { name: "English" }).press("Enter");
        await page.keyboard.press("Escape");
        await settings.press("Enter");
        await radio(/^Lowest,/).press("Enter");
        await quality("360p, saving data");
        await position(387);
        capped(500_000, 360, true);
        assert.equal(requests.at(-1).AudioStreamIndex, 2);
        assert.equal(requests.at(-1).SubtitleStreamIndex, -1);
        assert(await focused(radio(/^Lowest,/)));
        await page.screenshot({ path: path.join(output, name + "-lowest.png") });
        await page.keyboard.press("Escape");
        await tracks.press("Enter");
        assert(await page.getByRole("radio", { name: "Hungarian", checked: true }).isVisible());
        assert(await subtitle.getByRole("radio", { name: "English", checked: true }).isVisible());
        assert.equal(await page.evaluate(() => {
            clearInterval(window.focusWatch);
            return window.focusLost;
        }), false, "keyboard focus fell to the body");

        await page.reload();
        await open();
        await start();
        await settings.press("Enter");
        await quality("360p, saving data");
        assert(await focused(radio(/^Lowest,/)));
        await open("june");
        await page.evaluate(() => { window.nativeConnection = "cellular"; });
        await start();
        await settings.press("Enter");
        await quality("480p, saving data");
        assert(await focused(radio(/^Auto,/)));
        capped(1_000_000, 480, true);
        await hint.waitFor();
        await page.getByRole("button", { name: "Back to movies" }).press("Enter");
        await start();
        await settings.press("Enter");
        await quality("480p, saving data");
        assert.equal(await hint.count(), 0, "Auto should show its hint once per profile");
        if (process.env.DATA_SAVER_SHELL_URL) await checkAppSettings(page, name, process.env.DATA_SAVER_SHELL_URL);
        assert.deepEqual(errors, []);
        console.log("PASS", name);
    } finally {
        await page.context().close();
    }
}

fs.mkdirSync(output, { recursive: true });
verifyMovieProfiles(check).catch(error => { console.error(error); process.exitCode = 1; });
