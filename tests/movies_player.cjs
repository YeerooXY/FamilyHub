const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {constants, setPriority} = require("node:os");
const { jellyfin, cors, moviePage, playMovieDetails, verifyMovieProfiles } = require("./movies_fixture.cjs");
const output = process.argv[2] || path.join(__dirname, "../docs/verification/movies-1-5-2-2026-11-25");

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    try {
        await moviePage(page);
        await page.evaluate(async () => {
            const { buildPlayerUi } = await import("/movie-player-ui.js");
            const surface = document.createElement("section");
            surface.className = "movie-player movie-expanded";
            const media = document.createElement("video");
            let paused = true;
            Object.defineProperties(media, {
                paused: {get: () => paused},
                duration: {value: 100},
                currentTime: {value: 20, writable: true},
                volume: {value: 1, writable: true},
                muted: {value: false, writable: true}
            });
            media.play = async () => { paused = false; media.dispatchEvent(new Event("play")); };
            media.pause = () => { paused = true; media.dispatchEvent(new Event("pause")); };
            let fullscreen = false;
            const pick = () => {
                const label = document.createElement("label"), select = document.createElement("select");
                label.append(select);
                return select;
            };
            const audioPick = pick(), subtitlePick = pick();
            subtitlePick.add(new Option("Off", -1));
            const ui = buildPlayerUi({
                media, surface, back: document.createElement("button"), signal: new AbortController().signal,
                title: "The movie", notice: document.createElement("p"),
                audioPick, subtitlePick,
                fullscreenEnabled: true, isFullscreen: () => fullscreen,
                setFullscreen: async on => { fullscreen = on; return true; }
            });
            const input = document.createElement("input");
            input.setAttribute("aria-label", "Player test input");
            input.style.cssText = "position:absolute;left:1rem;top:6rem";
            surface.append(media, ui.root, input);
            document.querySelector("main").append(surface);
            ui.playButton.focus();
        });

        const button = name => page.getByRole("button", {name, exact: true});
        const focused = locator => locator.evaluate(node => node === document.activeElement);
        const position = () => page.locator("video").evaluate(video => video.currentTime);
        const shortcut = page.locator(".movie-ui-shortcut");
        const forward = button("Forward 10 seconds");
        const rewind = button("Back 10 seconds");
        await (options.hasTouch ? forward.tap() : forward.click());
        assert.equal(await position(), 30);
        assert.equal(await focused(forward), true);
        assert.equal(await forward.evaluate(node => getComputedStyle(node).outlineStyle), "none");
        assert.equal(await forward.locator("text").textContent(), "10");
        assert.equal(await forward.locator("text").evaluate(node => getComputedStyle(node).userSelect), "none");
        await (options.hasTouch ? rewind.tap() : rewind.click());
        assert.equal(await position(), 20);
        const controls = await page.locator(".movie-ui-mid > button").evaluateAll(nodes => nodes.map(node => {
            const button = node.getBoundingClientRect();
            const icon = node.querySelector("svg");
            return {
                center: button.top + button.height / 2, target: Math.min(button.width, button.height),
                grid: icon.getAttribute("viewBox"), size: icon.getBoundingClientRect().width, stroke: getComputedStyle(icon).strokeWidth
            };
        }));
        for (const control of controls) {
            assert.ok(Math.abs(control.center - controls[0].center) < 1);
            assert.ok(control.target >= 44);
            assert.equal(control.grid, "0 0 24 24");
            assert.equal(control.size, controls[0].size);
            assert.equal(control.stroke, "2px");
        }
        const gradient = await page.locator(".movie-ui-bottom").evaluate(node => getComputedStyle(node).backgroundImage);
        assert.match(gradient, /rgba\(0, 0, 0, 0\.93\d*\).*rgb\(0, 0, 0\) 90%/);

        await page.getByRole("slider", {name: "Seek"}).focus();
        await page.keyboard.press("Tab");
        assert.equal(await focused(button("Play")), true);
        await page.keyboard.press("Tab");
        assert.equal(await focused(rewind), true);
        assert.equal(await rewind.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(button("Play")), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(page.getByRole("slider", {name: "Seek"})), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(button("Back to movies")), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(page.locator(".movie-ui-actions button:visible").last()), true);
        await page.keyboard.press("Tab");
        assert.equal(await focused(button("Back to movies")), true);

        const tracks = button("Audio & Subtitles");
        const sheet = page.getByRole("dialog", {name: "Audio & Subtitles"});
        await (options.hasTouch ? tracks.tap() : tracks.click());
        await page.waitForFunction(() => [...document.styleSheets].some(style => style.href?.endsWith("/movie-player.css")));
        const audioRows = sheet.getByRole("radiogroup", {name: "Audio track"}).getByRole("radio");
        const subtitleRows = sheet.getByRole("radiogroup", {name: "Subtitle track"}).getByRole("radio");
        const labels = rows => rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
        assert.deepEqual(await labels(audioRows), ["Original", "English", "Hungarian"]);
        assert.deepEqual(await labels(subtitleRows), ["Off", "English", "Hungarian"]);
        assert.equal(await sheet.getByRole("heading", {name: "Timing", exact: true}).isVisible(), true);
        const panel = await sheet.boundingBox();
        const viewport = page.viewportSize();
        assert.ok(Math.abs(panel.x + panel.width / 2 - viewport.width / 2) < 1);
        if (viewport.width < 600) {
            assert.ok(Math.abs(panel.width - viewport.width) < 1);
            assert.ok(Math.abs(panel.y + panel.height - viewport.height) < 1);
        } else {
            assert.ok(panel.width <= 448);
            assert.ok(Math.abs(panel.y + panel.height / 2 - viewport.height / 2) < 1);
        }
        assert.equal(await button("Close audio and subtitles").evaluate(node => node === document.activeElement), true);
        await button("Close audio and subtitles").press("Enter");
        assert.equal(await focused(tracks), true);
        await page.keyboard.press("Space");
        await button("Pause").waitFor();
        assert.equal(await sheet.count(), 0);
        assert.equal(await button("Settings").count(), 0);
        assert.equal(await focused(tracks), true);
        await page.keyboard.press("k");
        await button("Play").waitFor();

        for (const [key, expected, label] of [
            ["ArrowRight", 30, "+10 s"], ["Shift+ArrowRight", 60, "+30 s"],
            ["ArrowLeft", 50, "−10 s"], ["Shift+ArrowLeft", 20, "−30 s"]
        ]) {
            await page.keyboard.press(key);
            assert.equal(await position(), expected);
            assert.equal(await shortcut.textContent(), label);
        }
        if (!options.hasTouch) {
            await page.keyboard.press("ArrowDown");
            assert.equal(await shortcut.textContent(), "Volume 95%");
            await page.keyboard.press("ArrowUp");
            assert.equal(await shortcut.textContent(), "Volume 100%");
            await page.keyboard.press("m");
            assert.equal(await shortcut.textContent(), "Muted");
            await page.keyboard.press("m");
            assert.equal(await shortcut.textContent(), "Volume 100%");
        } else {
            assert.equal(await button("Mute").count(), 0);
            await page.keyboard.press("m");
            assert.equal(await page.locator("video").evaluate(video => video.muted), false);
        }

        const canFullscreen = !/iphone/.test(profile);
        for (const key of canFullscreen ? ["F11", "Alt+Enter", "f"] : []) {
            await page.keyboard.press(key);
            await button("Exit full screen").waitFor();
            await page.keyboard.press("Escape");
            await button("Full screen").waitFor();
            assert.equal(await focused(tracks), true);
        }
        const input = page.getByRole("textbox", {name: "Player test input"});
        await input.press("f");
        await input.press("k");
        await input.press("Space");
        await input.press("m");
        await input.press("ArrowRight");
        await input.press("ArrowDown");
        await input.press("F11");
        await input.press("Alt+Enter");
        assert.equal(await input.inputValue(), "fk m");
        assert.equal(await position(), 20);
        assert.equal(await button("Play").count(), 1);
        assert.equal(await button("Full screen").count(), Number(canFullscreen));
        assert.equal(await focused(input), true);

        await page.waitForFunction(() => !document.querySelector(".movie-ui-shortcut").textContent);
        const bar = page.locator(".movie-ui-bottom");
        const spinner = page.locator(".movie-ui-spinner");
        await page.locator("video").dispatchEvent("waiting");
        assert.equal(await bar.evaluate(node => getComputedStyle(node).transitionDuration), "0s");
        assert.equal(await spinner.evaluate(node => node.getAnimations().length), 0);
        await page.emulateMedia({reducedMotion: "no-preference"});
        assert.equal(await bar.evaluate(node => getComputedStyle(node).transitionDuration), "0.25s");
        await page.waitForFunction(() => document.querySelector(".movie-ui-spinner").getAnimations()
            .some(animation => animation.playState === "running"));
        await page.locator("video").dispatchEvent("canplay");
        await page.screenshot({path: path.join(output, profile + "-player.png")});
    } finally {
        await page.close();
    }
}

async function verifyTranscodeFallback(browser, profile, options) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(5000);
    const requests = [], item = {Id: "in-time", Name: "In Time", Type: "Movie"};
    try {
        await page.addInitScript(() => {
            HTMLMediaElement.prototype.canPlayType = () => "";
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            Object.defineProperty(HTMLMediaElement.prototype, "src", {
                get() { return this.fixtureSource ?? ""; },
                set(url) { this.fixtureSource = String(url); }
            });
            window.Hls = class {
                static isSupported() { return true; }
                static Events = {ERROR: "error", MANIFEST_PARSED: "manifestParsed"};
                static ErrorTypes = {NETWORK_ERROR: "networkError"};
                static ErrorDetails = {MANIFEST_LOAD_ERROR: "manifestLoadError"};
                static DefaultConfig = {loader: class {
                    async load(context, _settings, callbacks) {
                        const response = await fetch(context.url);
                        callbacks.onError({code: response.status}, context, response);
                        window.manifestStatus = response.status;
                    }
                }};
                constructor(config) { this.loader = new config.loader(); }
                on(_name, fail) { window.hlsFailure = fail; }
                once() {}
                loadSource(url) { this.loader.load({type: "manifest", url}, {}, {onError() {}}); }
                attachMedia() {}
                destroy() {}
            };
        });
        await page.route(jellyfin + "/**", route => {
            const request = route.request(), url = new URL(request.url());
            if (request.method() === "OPTIONS") return route.fulfill({status: 204, headers: cors});
            const json = body => route.fulfill({headers: cors, json: body});
            if (url.pathname.endsWith("/PlaybackInfo")) {
                const options = request.postDataJSON();
                requests.push(options);
                return json({PlaySessionId: String(requests.length), MediaSources: [{
                    Id: "source", SupportsDirectPlay: options.EnableDirectPlay,
                    TranscodingUrl: "/Videos/in-time/master.m3u8?MaxWidth=3840&MaxHeight=900", DefaultSubtitleStreamIndex: -1
                }]});
            }
            if (url.pathname.endsWith("/master.m3u8")) return route.fulfill({headers: cors, status: 503});
            if (url.pathname === "/Items/in-time") return json(item);
            const items = url.pathname === "/Items" && url.searchParams.get("includeItemTypes") === "Movie" ? [item] : [];
            return json({Items: items, TotalRecordCount: items.length});
        });
        await moviePage(page);
        await page.evaluate(async jellyfin => {
            const {openMovies, saveMoviePreferences} = await import("/movies.js");
            saveMoviePreferences({server:jellyfin + "/"}, {screen:"1080"});
            window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
                {url: jellyfin, user: "test", token: "fixture", device: "fixture"},
                {invokeMethodAsync: async (method, ...args) => {
                    if (method === "MovieEvent") (window.movieEvents ??= []).push(args);
                    if (method === "MovieConnectionKind") return "wifi";
                }});
        }, jellyfin);
        await playMovieDetails(page, page.getByRole("button", {name: item.Name, exact: true}), item.Name);
        const video = page.locator("video");
        await video.waitFor();
        assert.match(await video.evaluate(node => node.src), /static=true/);
        const manifest = () => page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/master.m3u8"));
        const fallback = manifest();
        await video.evaluate(node => {
            Object.defineProperty(node, "error", {value: {
                code: 4, message: "PIPELINE_ERROR_DECODE: Could not decode https://private.test/stream?token=secret"
            }});
            node.dispatchEvent(new Event("error"));
        });
        const cappedUrl = new URL((await fallback).url());
        await page.waitForFunction(() => window.manifestStatus === 503);
        assert.equal(requests.length, 2);
        const transcode = requests[1];
        assert.equal(transcode.MediaSourceId, "source");
        assert.equal(transcode.DeviceProfile.TranscodingProfiles[0].Protocol, "hls");
        assert.deepEqual(transcode.DeviceProfile.CodecProfiles[0].Conditions.map(({Property, Value}) => [Property, Value]),
            [["Height", "1080"], ["Width", "1920"]]);
        assert.equal(cappedUrl.searchParams.get("maxWidth"), "1920");
        assert.equal(cappedUrl.searchParams.get("maxHeight"), "900");
        assert.equal(cappedUrl.searchParams.has("MaxWidth") || cappedUrl.searchParams.has("MaxHeight"), false);
        for (const key of ["EnableDirectPlay", "EnableDirectStream", "AllowVideoStreamCopy", "AllowAudioStreamCopy"])
            assert.equal(transcode[key], false);
        await page.evaluate(() => window.hlsFailure("error", {
            fatal: true, type: "networkError", details: "manifestLoadError"
        }));
        const message = page.getByText("The video stream stopped responding.", {exact: true});
        const retry = page.getByRole("button", {name: "Try again", exact: true});
        await retry.waitFor();
        assert.equal(await message.getAttribute("role"), "status");
        assert.doesNotMatch(await page.locator(".movie-ui-message").innerText(), /503/);
        const errors = await page.evaluate(() => window.movieEvents.filter(([kind]) => kind === "playback-error"));
        assert.equal(errors.length, 2);
        assert.equal(errors[0][1], "DirectPlay");
        assert.equal(errors[0][4].mediaCode, 4);
        assert.equal(errors[0][4].mediaMessage, "PIPELINE_ERROR_DECODE Could not decode");
        assert.equal(errors[1][1], "Transcode");
        assert.deepEqual(errors[1][4], {mediaCode:null, mediaMessage:"", hlsType:"networkError",
            hlsDetails:"manifestLoadError", hlsFatal:true, audioIndex:null, hlsLoaded:true, httpStatus:503, forced:true});
        await page.evaluate(() => { document.body.dataset.effects = "off"; });
        await page.waitForFunction(() => {
            const player = document.querySelector(".movie-expanded");
            return [player, ...player.querySelectorAll("video, .movie-ui, .movie-ui-message, .movie-ui-retry")]
                .every(node => getComputedStyle(node).cursor === "none");
        });
        assert.equal(await retry.isVisible(), true);
        assert.equal(await retry.evaluate(node => node.tabIndex), 0);
        assert.equal(await retry.evaluate(node => getComputedStyle(node).pointerEvents), "auto");
        const cursor = () => video.evaluate(node => getComputedStyle(node).cursor);
        await video.dispatchEvent(options.hasTouch ? "touchstart" : "pointermove");
        assert.notEqual(await cursor(), "none");
        await page.waitForFunction(() => getComputedStyle(document.querySelector("video")).cursor === "none");
        await page.keyboard.press("Tab");
        assert.notEqual(await cursor(), "none");
        await page.screenshot({path: path.join(output, profile + "-player-error.png"), animations: "disabled"});
        const retried = manifest();
        await retry.press("Enter");
        await retried;
        assert.equal(requests.length, 3);
        await page.waitForFunction(() => document.activeElement?.classList.contains("movie-ui-play"));
        await page.evaluate(() => window.movies.close());
    } finally {
        await page.close();
    }
}

fs.mkdirSync(output, {recursive: true});
verifyMovieProfiles(async (browser, profile, options) => {
    await verify(browser, profile, options);
    await verifyTranscodeFallback(browser, profile, options);
}).then(() => console.log("Movie controls, shortcuts and server transcode fallback passed."))
    .catch(error => { console.error(error); process.exitCode = 1; });
