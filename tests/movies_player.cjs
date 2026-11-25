const assert = require("node:assert/strict");
const path = require("node:path");
const { moviePage, output, verifyMovieProfiles } = require("./movies_fixture.cjs");

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
            const ui = buildPlayerUi({
                media, surface, back: document.createElement("button"), signal: new AbortController().signal,
                title: "The movie", notice: document.createElement("p"),
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

verifyMovieProfiles(verify).then(() => console.log("Movie controls and shortcuts passed."))
    .catch(error => { console.error(error); process.exitCode = 1; });
