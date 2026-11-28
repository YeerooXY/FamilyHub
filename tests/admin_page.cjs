const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {app, reviewMovieProfiles} = require("./movies_fixture.cjs");

const assets = path.join(__dirname, "../music_web/admin_static");
const shared = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = process.argv[2];
const gb = 1024 ** 3;
const snapshot = {
    available: true, goal: 2, global_ratio: 1.5, total_uploaded: 63 * gb, total_downloaded: 42 * gb,
    finished: {goal: 0, no_demand: 0},
    last_sample_at: "2026-11-25T22:45:00Z", posters_enabled: true,
    items: [
        {hash: "a".repeat(40), name: "Home Alone 2", complete: 1, state: "Stopped", ratio: 5.26,
            uploaded: Math.round(52.6 * gb), downloaded: 10 * gb, up_speed: 0},
        {hash: "e".repeat(40), name: "Queued season", complete: 1, state: "Waiting",
            ratio: 0, uploaded: 0, downloaded: 8 * gb, up_speed: 0},
        {hash: "f".repeat(40), name: "Timed-out season", complete: 1, state: "Stopped, no demand",
            ratio: .2, uploaded: Math.round(.4 * gb), downloaded: 2 * gb, up_speed: 0},
        {hash: "b".repeat(40), name: "Archive of public domain films", complete: 1, state: "Seeding",
            ratio: .5, uploaded: 10 * gb, downloaded: 20 * gb, up_speed: 3 * 1024 ** 2},
        {hash: "c".repeat(40), name: "An archive of restored public domain films – winter collection",
            complete: 0, state: "Downloading", ratio: 0, progress: .4, size: 5 * gb, downloaded: 2 * gb,
            dl_speed: 1024 * 600, paused: false, added_on: "2026-11-18T09:00:00+00:00"},
        {hash: "d".repeat(40), name: "Film preservation project", complete: 0, state: "Fetching metadata",
            ratio: 0, progress: 0, downloaded: 0}
    ]
};

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    const window_controls = [];
    try {
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let signedIn, unavailable = false, sample = snapshot;
        await page.route(app + "/**", async route => {
            const resource = new URL(route.request().url()).pathname;
            if (resource === "/api/connect") return route.fulfill({json: {csrf_token: "fixture", profiles: [
                {id: "admin", name: "Alex"}, {id: "regular", name: "Sam"}
            ]}});
            if (resource === "/api/profile/select") {
                assert.equal(route.request().headers()["x-csrftoken"], "fixture");
                const {profile_id, password} = route.request().postDataJSON();
                if (password !== "fixture-password") return route.fulfill({status: 403, json: {error: "Incorrect password. Try again."}});
                signedIn = profile_id;
                return route.fulfill({json: {csrf_token: "signed-in"}});
            }
            if (resource === "/api/server/seeding/" + "c".repeat(40) + "/pause") {
                window_controls.push(route.request().headers()["x-csrftoken"] ? "pause" : "no-csrf");
                return route.fulfill({json: {paused: true}});
            }
            if (resource === "/api/server/seeding") {
                if (!signedIn) return route.fulfill({status: 401, json: {}});
                if (signedIn !== "admin") return route.fulfill({status: 403, json: {}});
                if (unavailable) return route.fulfill({status: 503, json: {}});
                const poster = new URL(route.request().url()).searchParams.get("poster");
                if (poster) return route.fulfill({json: {poster: poster === "c".repeat(40) ? app + "/fixture-poster.svg" : null}});
                return route.fulfill({json: sample});
            }
            if (resource === "/fixture-poster.svg") return route.fulfill({contentType: "image/svg+xml", body:
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 60"><path fill="#94534a" d="M0 0h40v60H0z"/><circle fill="#ffcd8b" cx="26" cy="20" r="9"/><path fill="#2d465a" d="M0 50 15 23 40 50v10H0z"/></svg>'});
            const asset = resource === "/admin" ? "admin.html" : path.basename(resource);
            return route.fulfill({path: path.join(/^(service-status|strings)\./.test(asset) ? shared : assets, asset), headers: {
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'"
            }});
        });
        await page.clock.install();
        await page.goto(app + "/admin");
        const focused = locator => locator.evaluate(node => document.activeElement === node);
        const profileSelect = page.getByLabel("Profile");
        const password = page.getByLabel("Password");
        const signIn = page.getByRole("button", {name: "Sign in"});
        await profileSelect.waitFor();
        assert.equal(await focused(profileSelect), true);
        await page.keyboard.press("Tab");
        assert.equal(await focused(password), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focused(profileSelect), true);
        if (out) await page.screenshot({path: path.join(out, profile + "-admin-signin.png")});
        await password.fill("wrong");
        await password.press("Enter");
        await page.getByRole("alert").filter({hasText: "Incorrect password"}).waitFor();
        assert.equal(await focused(password), true);
        await profileSelect.selectOption("regular");
        await password.fill("fixture-password");
        await signIn.press("Space");
        await page.getByRole("alert").filter({hasText: "Choose an administrator profile."}).waitFor();
        assert.equal(await page.getByRole("progressbar").count(), 0);
        await profileSelect.selectOption("admin");
        await password.fill("fixture-password");
        await password.press("Enter");
        const heading = page.getByRole("heading", {name: "Downloads", exact: true});
        await heading.waitFor();
        assert.equal(await focused(heading), true);
        // Downloads can be paused from here, and every torrent shows when it was added.
        const pause = page.getByRole("button", {name: /^Pause An archive of restored/});
        await page.getByText(/^(18 Nov 2026|Nov 18, 2026)$/).first().waitFor();
        await pause.press("Enter");
        const resume = page.getByRole("button", {name: /^Resume An archive of restored/});
        await resume.waitFor();
        assert.equal(await focused(resume), true);
        assert.deepEqual(window_controls, ["pause"]);
        await page.getByRole("status").filter({hasText: "Paused."}).waitFor();
        await heading.focus();
        const meter = page.getByRole("progressbar", {name: "All-time share ratio"});
        const globalDetail = "63.0 GB uploaded, 42.0 GB downloaded. 21.0 GB more to reach 2.0×";
        assert.equal(await meter.getAttribute("aria-valuenow"), "75");
        assert.equal(await meter.locator("i").evaluate(node => node.style.width), "75%");
        assert.equal(await page.locator("#global-detail").textContent(), globalDetail);
        const capped = page.getByRole("progressbar", {name: "Home Alone 2 share ratio"});
        assert.equal(await capped.getAttribute("aria-valuenow"), "100");
        assert.equal(await capped.getAttribute("aria-valuetext"), "5.26× of 2.0×");
        assert.equal(await capped.locator("i").evaluate(node => node.style.width), "100%");
        assert.equal(await page.getByRole("progressbar", {name: "Archive of public domain films share ratio"}).getAttribute("aria-valuenow"), "25");
        const seeding = page.getByRole("region", {name: "Seeding"});
        assert.deepEqual(await seeding.locator(".tag").allTextContents(),
            ["Seeding", "Waiting", "Stopped", "Stopped, no demand"]);
        const summary = seeding.locator("#finished-summary");
        assert.equal(await summary.isVisible(), false);
        assert.equal(await summary.textContent(), "");
        assert.equal(await seeding.getByText("1 title seeding", {exact: true}).count(), 1);
        assert.equal(await seeding.getByText("3.0 MB/s", {exact: true}).count(), 1);
        assert.equal(await seeding.getByText("0 KB/s", {exact: true}).count(), 3);
        const downloads = page.getByRole("region", {name: "Downloads"});
        assert.equal(await downloads.getByRole("progressbar", {name: /winter collection download/}).getAttribute("aria-valuetext"), "40%");
        await downloads.locator(".poster img").scrollIntoViewIfNeeded();
        await page.waitForFunction(() => document.querySelector(".poster img")?.naturalWidth > 0);
        await heading.scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (out) await page.screenshot({path: path.join(out, profile + "-admin-seeding.png"), fullPage: true});
        unavailable = true;
        await page.clock.fastForward(31000);
        const retry = page.getByRole("button", {name: "Retry torrent activity"});
        await retry.waitFor();
        await page.getByRole("status").filter({hasText: "Showing the last reading"}).waitFor();
        assert.equal(await meter.isVisible(), true);
        unavailable = false;
        await retry.press("Enter");
        await retry.waitFor({state: "hidden"});
        assert.equal(await focused(heading), true);
        const transition = await meter.locator("i").evaluate(node => getComputedStyle(node).transitionDuration);
        assert.equal(transition, options.reducedMotion === "reduce" ? "0s" : "0.4s");
        sample = {...snapshot, stale: true};
        await page.clock.fastForward(31000);
        await page.getByRole("status").filter({hasText: "Showing a reading"}).waitFor();
        assert.equal(await page.getByText("3.0 MB/s").count(), 0);
        sample = {...snapshot, finished: {goal: 1, no_demand: 0}, items: snapshot.items.slice(1)};
        await page.clock.fastForward(31000);
        await seeding.getByRole("status").getByText("1 title finished: 1 reached 2.0×", {exact: true}).waitFor();
        assert.equal(await seeding.getByRole("heading", {name: "Home Alone 2"}).count(), 0);
        assert.equal(await page.locator("#global-detail").textContent(), globalDetail);
        assert.equal(await meter.getAttribute("aria-valuenow"), "75");
        sample = {...snapshot, finished: {goal: 5, no_demand: 2},
            items: snapshot.items.filter(item => !["Home Alone 2", "Timed-out season"].includes(item.name))};
        await page.clock.fastForward(31000);
        await seeding.getByRole("status").getByText("7 titles finished: 5 reached 2.0×, 2 stopped with no demand", {exact: true}).waitFor();
        assert.deepEqual(await seeding.locator(".tag").allTextContents(), ["Seeding", "Waiting"]);
        assert.equal(await seeding.getByRole("heading", {name: "Timed-out season"}).count(), 0);
        assert.equal(await focused(heading), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        sample = {...snapshot, items: []};
        await page.clock.fastForward(31000);
        await page.getByText("No downloads in the queue.").waitFor();
        await page.getByText("No torrents ready to seed.").waitFor();
        assert.equal(await seeding.getByText("0 titles seeding", {exact: true}).count(), 1);
        assert.equal(await summary.isVisible(), false);
        assert.equal(await summary.textContent(), "");
        assert.equal(await focused(heading), true);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
}

(async () => {
    if (out) fs.mkdirSync(out, {recursive: true});
    await reviewMovieProfiles(verify);
    console.log("Admin sign-in, meters and refresh recovery passed in six browser profiles.");
})().catch(error => { console.error(error); process.exitCode = 1; });
