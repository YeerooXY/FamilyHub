const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(require.resolve("playwright", {paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")]}));
const { jellyfin, cors, moviePage, playMovieDetails } = require("./movies_fixture.cjs");

const titles = [{Id: "film", Name: "Timing Test", Type: "Movie"}, {Id: "other", Name: "Other Title", Type: "Movie"}];
const subtitle = (Index, Language, Codec, Path) => ({Type: "Subtitle", Index, Language, Codec, Path});
const english = [subtitle(3, "eng", "dvdsub"), subtitle(4, "en", "ass", "/video/film.en.ass"),
    {...subtitle(5, "en-US", "srt", "/video/longer.en.srt"), LineCount: 200}];
const hungarian = [subtitle(6, "hun", "subrip"), subtitle(7, "hu-HU", "vtt")];
const audio = [{Type: "Audio", Index: 1, Language: "eng", DisplayTitle: "English"},
    {Type: "Audio", Index: 2, Language: "jpn", IsOriginal: true}, {Type: "Audio", Index: 8, Language: "deu"}];
const findName = "Find a subtitle for this film";

async function verify() {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 1280, height: 850}, locale: "en-US"});
        await page.clock.install();
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            Element.prototype.requestFullscreen = () => Promise.resolve();
            document.addEventListener("error", event => {
                if (event.target instanceof HTMLVideoElement) event.stopImmediatePropagation();
            }, true);
        });
        const ranked = new Set();
        await page.route(jellyfin + "/**", route => {
            const url = new URL(route.request().url());
            const reply = props => route.fulfill({headers: cors, ...props});
            if (route.request().method() === "OPTIONS") return reply({status: 204});
            if (url.pathname.endsWith("/PlaybackInfo")) {
                const primary = url.pathname.includes("/film/");
                return reply({json: {PlaySessionId: "play", MediaSources: [{Id: "source", Path: "/video/film.mp4",
                    SupportsDirectPlay: true, DefaultAudioStreamIndex: 1, DefaultSubtitleStreamIndex: 5,
                    MediaStreams: [...audio, ...english, ...(primary ? hungarian : [])]}]}});
            }
            if (url.pathname === "/Items") return reply({json: {Items: url.searchParams.get("includeItemTypes") === "Movie" ? titles : []}});
            if (/\/Subtitles\/[67]\/Stream.vtt$/.test(url.pathname)) {
                const index = Number(url.pathname.split("/").at(-2));
                ranked.add(index);
                const body = index === 7 ? "00:00:10.000 --> 00:00:11.000\nOne\nTwo\nThree\n"
                    : "00:00:10.000 --> 00:00:11.000\nOne\n\n00:00:12.000 --> 00:00:13.000\nTwo\n";
                return reply({contentType: "text/vtt", body: "WEBVTT\n\n" + body});
            }
            return reply({status: 204});
        });
        await moviePage(page);
        await page.evaluate(async jellyfin => {
            const { openMovies } = await import("/movies.js");
            window.openMovieFixture(openMovies, document.querySelector("main"), {url: jellyfin, user: "u", token: "t"},
                {invokeMethodAsync: async () => "{}"}, {server: jellyfin + "/", profile: "fixture"});
        }, jellyfin);
        const opener = page.getByRole("button", {name: "Audio & Subtitles", exact: true});
        const sheet = page.getByRole("dialog", {name: "Audio & Subtitles"});
        const close = sheet.getByRole("button", {name: "Close audio and subtitles"});
        const find = sheet.getByRole("button", {name: findName});
        const audioGroup = sheet.getByRole("radiogroup", {name: "Audio track"});
        const subs = sheet.getByRole("radiogroup", {name: "Subtitle track"});
        const radio = name => subs.getByRole("radio", {name, exact: true});
        const focused = locator => locator.evaluate(node => node === document.activeElement);
        const output = label => sheet.getByRole("status", {name: label + " value"}).textContent();
        const step = name => sheet.getByRole("button", {name, exact: true});
        const increaseShift = step("Increase subtitle shift"), increaseSpeed = step("Increase subtitle speed");
        const video = page.locator("video");
        const open = async title => {
            await playMovieDetails(page, page.getByRole("button", {name: title, exact: true}).first(), title);
            await opener.press("Enter");
            await close.waitFor();
        };
        const exit = async () => {
            await page.keyboard.press("Escape");
            assert.equal(await focused(opener), true);
            await page.getByRole("button", {name: "Back to movies"}).press("Enter");
            await video.waitFor({state: "detached"});
            await page.getByRole("button", {name: "Back to titles", exact: true}).press("Enter");
        };
        await open(titles[0].Name);
        assert.deepEqual(await subs.getByRole("radio").allInnerTexts(), ["Off", "English", "Hungarian"]);
        assert.deepEqual(await audioGroup.getByRole("radio").allInnerTexts(), ["English", "Original (Japanese)"]);
        assert.deepEqual([...ranked].sort(), [6, 7]);
        assert.deepEqual(await video.locator("track").evaluateAll(nodes => nodes.map(node => node.src.match(/\/Subtitles\/(\d+)\//)[1])), ["4", "7"]);
        assert.equal(await radio("Off").getAttribute("aria-checked"), "true");
        assert.equal(await find.count(), 0);
        assert.equal(await sheet.getByRole("button", {name: "Find subtitles", exact: true}).count(), 0);
        assert.equal(await sheet.getByRole("button", {name: "Add audio track", exact: true}).count(), 0);
        assert.equal(await sheet.getByRole("combobox", {name: "Subtitle language"}).count(), 0);
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".movie-sheet-tracks")).animationName === "movie-tracks-open");
        assert.equal(await close.evaluate(node => getComputedStyle(node.closest(".movie-sheet")).animationDuration), "0.2s");
        assert.equal(await focused(close), true);
        await page.keyboard.press("Tab");
        assert.equal(await focused(audioGroup.getByRole("radio", {name: "English"})), true);
        await page.keyboard.press("ArrowDown");
        assert.equal(await focused(audioGroup.getByRole("radio", {name: "Original (Japanese)"})), true);
        await page.keyboard.press("Tab");
        if (await sheet.getByText("Sound options", {exact: true}).count()) await page.keyboard.press("Tab");
        assert.equal(await focused(radio("Off")), true);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Space");
        assert.equal(await focused(radio("English")), true);
        assert.equal(await radio("English").getAttribute("aria-checked"), "true");
        await sheet.getByRole("status").filter({hasText: "Subtitles: English"}).waitFor({state: "attached"});

        await video.evaluate(node => {
            const track = [...node.textTracks].find(track => track.mode === "hidden");
            Object.defineProperty(track, "cues", {value: [new VTTCue(10, 11, "First cue"), new VTTCue(100, 101, "Later cue")]});
            Object.defineProperty(node, "currentTime", {value: 0, writable: true});
        });
        await increaseShift.press("Enter");
        await increaseShift.press("PageUp");
        await increaseSpeed.click({modifiers: ["Shift"]});
        assert.equal(await output("Shift"), "+1.1 s");
        assert.equal(await output("Speed"), "+0.10 %");
        const draw = async (time, expected) => {
            await video.evaluate((node, time) => {
                node.currentTime = time;
                node.dispatchEvent(new Event("timeupdate"));
            }, time);
            assert.equal(await page.locator(".movie-ui-subs").innerText(), expected);
        };
        await draw(11.09, "");
        await draw(11.11, "First cue");
        await draw(101.15, "");
        await draw(101.20, "Later cue");
        await draw(102.20, "");

        await radio("Hungarian").press("Enter");
        assert.equal(await output("Shift"), "0.0 s");
        const hold = await increaseShift.boundingBox();
        await page.mouse.move(hold.x + hold.width / 2, hold.y + hold.height / 2);
        await page.mouse.down();
        await page.clock.runFor(1000);
        await page.mouse.up();
        const held = Number.parseFloat(await output("Shift"));
        assert.ok(held >= .4, "holding accelerates subtitle adjustment");
        await page.clock.runFor(500);
        assert.equal(Number.parseFloat(await output("Shift")), held);
        const reset = step("Reset subtitle shift");
        await reset.press("Space");
        assert.equal(await output("Shift"), "0.0 s");
        assert.equal(await focused(increaseShift), true);
        for (const [control, label, limit] of [[increaseShift, "Shift", "+60.0 s"], [increaseSpeed, "Speed", "+5.00 %"]]) {
            await control.evaluate(node => {
                for (let press = 0; press < 61; press++)
                    node.dispatchEvent(new KeyboardEvent("keydown", {key: "PageUp", bubbles: true}));
            });
            assert.equal(await output(label), limit);
        }
        await radio("English").press("Enter");
        assert.equal(await output("Shift"), "+1.1 s");

        for (const width of [320, 390, 1280, 1920]) {
            await page.setViewportSize({width, height: 900});
            await page.clock.runFor(210);
            const panel = await sheet.boundingBox();
            assert.ok(Math.abs(panel.x + panel.width / 2 - width / 2) < 1);
            assert.ok(width < 600 ? Math.abs(panel.width - width) < 1 : panel.width <= 448);
            const targets = await sheet.getByRole("radio").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            assert.ok(targets.every(height => height >= (width >= 1600 ? 60 : 44)));
            assert.equal(await sheet.evaluate(node => node.scrollWidth > node.clientWidth), false);
        }
        await page.emulateMedia({reducedMotion: "reduce"});
        assert.equal(await sheet.evaluate(node => getComputedStyle(node).animationName), "none");
        await page.emulateMedia({reducedMotion: "no-preference"});
        await page.evaluate(() => { document.body.dataset.effects = "off"; });
        assert.equal(await sheet.evaluate(node => getComputedStyle(node).animationName), "none");

        await exit();
        await open(titles[1].Name);
        assert.equal(await find.isVisible(), true);
        await radio("English").press("Enter");
        assert.equal(await output("Shift"), "0.0 s");
        assert.equal(await output("Speed"), "0.00 %");
        await exit();
        await page.evaluate(async jellyfin => {
            const { saveMoviePreferences } = await import("/movies.js");
            saveMoviePreferences({server: jellyfin + "/", profile: "fixture"}, {subtitles: "en"});
        }, jellyfin);
        await open(titles[0].Name);
        assert.equal(await radio("English").getAttribute("aria-checked"), "true");
        assert.equal(await output("Shift"), "+1.1 s");
        assert.equal(await output("Speed"), "+0.10 %");
    } finally {
        await browser.close();
    }
}

verify().then(() => console.log("Subtitle ranking, timing, persistence, and keyboard checks passed."))
    .catch(error => { console.error(error); process.exitCode = 1; });
