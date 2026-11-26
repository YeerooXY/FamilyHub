const assert = require("node:assert/strict");
const { app, jellyfin, cors, moviePage, playMovieDetails, reviewMovieProfiles } = require("./movies_fixture.cjs");

const item = {Id: "fixture-film", Name: "Fixture Film", Type: "Movie"};
const manifestPath = "/Videos/fixture-film/master.m3u8";
const reportUrl = app + "/api/movies/report";
const windowsUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

reviewMovieProfiles(async (browser, profile, options) => {
    if (profile === "windows-chromium-2000" || profile === "chromium-tablet-768") return;
    const chromium = browser.browserType().name() === "chromium";
    const page = await browser.newPage(profile === "windows-chromium-1280" ? {...options, userAgent: windowsUa} : options);
    page.setDefaultTimeout(7000);
    const requests = [];
    const pendingManifest = new Promise(resolve => page.once("close", resolve));
    try {
        await page.addInitScript(() => {
            const canPlayType = HTMLMediaElement.prototype.canPlayType;
            HTMLMediaElement.prototype.canPlayType = function (type) {
                return type === "application/vnd.apple.mpegurl" ? "maybe" : canPlayType.call(this, type);
            };
            HTMLMediaElement.prototype.play = () => Promise.resolve();
            document.addEventListener("error", event => {
                if (event.isTrusted && event.target instanceof HTMLVideoElement) event.stopImmediatePropagation();
            }, true);
        });
        await moviePage(page);
        await page.route(reportUrl, route => route.fulfill({status: 204}));
        await page.route(jellyfin + "/**", route => {
            const request = route.request(), url = new URL(request.url());
            if (request.method() === "OPTIONS") return route.fulfill({status: 204, headers: cors});
            // Keep the transfer pending while the test injects the media error.
            if (url.pathname === manifestPath) return pendingManifest;
            const json = value => route.fulfill({headers: cors, json: value});
            if (url.pathname.endsWith("/PlaybackInfo")) {
                requests.push(request.postDataJSON());
                return json({PlaySessionId: String(requests.length), MediaSources: [{
                    Id: "source", SupportsDirectPlay: false, TranscodingUrl: manifestPath, DefaultSubtitleStreamIndex: -1
                }]});
            }
            if (url.pathname === "/Items/" + item.Id) return json(item);
            const Items = url.pathname === "/Items" && url.searchParams.get("includeItemTypes") === "Movie" ? [item] : [];
            return json({Items, TotalRecordCount: Items.length});
        });
        const features = await page.evaluate(async ({jellyfin, reportUrl}) => {
            const {openMovies} = await import("/movies.js");
            window.movies = window.openMovieFixture(openMovies, document.querySelector("main"),
                {url: jellyfin, user: "test", token: "fixture", device: "fixture"},
                {async invokeMethodAsync(name, kind, method, title, minutes, diagnostics) {
                    if (name === "MovieConnectionKind") return "wifi";
                    if (name === "MovieEvent") await fetch(reportUrl, {method: "POST", headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({kind, method, title, minutes, diagnostics})});
                }});
            return {ua: navigator.userAgent, mediaSource: Boolean(globalThis.MediaSource), hls: typeof globalThis.Hls};
        }, {jellyfin, reportUrl});
        assert.equal(features.hls, "undefined");
        assert.equal(/\bChrome\//.test(features.ua), chromium);
        if (chromium) assert.equal(features.mediaSource, true);
        else assert.match(features.ua, /Safari\//);

        const vendorRequests = [];
        page.on("request", request => {
            if (new URL(request.url()).pathname === "/vendor/hls.light.min.js") vendorRequests.push(request.url());
        });
        await playMovieDetails(page, page.getByRole("button", {name: item.Name, exact: true}), item.Name);
        const video = page.locator(".movie-video");
        const source = async previous => {
            await page.waitForFunction(previous => {
                const src = document.querySelector(".movie-video")?.src;
                return src && src !== previous;
            }, previous);
            return video.evaluate(media => media.src);
        };
        const firstSource = await source("");
        assert.equal(await page.evaluate(() => typeof globalThis.Hls), chromium ? "function" : "undefined");
        assert.deepEqual(vendorRequests, chromium ? [app + "/vendor/hls.light.min.js"] : []);
        if (chromium) assert.match(firstSource, /^blob:/);
        else assert.equal(new URL(firstSource).pathname, manifestPath);
        assert.equal(requests[0].DeviceProfile.TranscodingProfiles[0].Protocol, "hls");

        async function failPlayback(method, forced) {
            const response = page.waitForResponse(response => {
                if (response.url() !== reportUrl) return false;
                const body = response.request().postDataJSON();
                return body.kind === "playback-error" && body.method === method;
            });
            await video.evaluate(media => {
                Object.defineProperty(media, "error", {value: {code: 4}});
                media.dispatchEvent(new Event("error"));
            });
            const report = await response;
            assert.equal(report.status(), 204);
            const {diagnostics} = report.request().postDataJSON();
            assert.equal(diagnostics.mediaCode, 4);
            assert.equal(diagnostics.hlsLoaded, chromium);
            assert.equal(diagnostics.forced, forced);
        }
        await failPlayback("DirectStream", false);
        const retrySource = await source(firstSource);
        if (chromium) assert.match(retrySource, /^blob:/);
        else assert.equal(new URL(retrySource).pathname, manifestPath);
        assert.equal(requests.length, 2);
        for (const flag of ["EnableDirectPlay", "EnableDirectStream", "AllowVideoStreamCopy", "AllowAudioStreamCopy"])
            assert.equal(requests[1][flag], false);
        await failPlayback("Transcode", true);
        await page.getByText("The video stream could not be decoded.", {exact: true}).waitFor();
        await page.evaluate(() => window.movies.close());
        console.log("PASS", profile, chromium ? "hls.js" : "native HLS");
    } finally {
        await page.close();
    }
}).catch(error => { console.error(error); process.exitCode = 1; });
