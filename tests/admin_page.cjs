const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {app, reviewMovieProfiles} = require("./movies_fixture.cjs");

const assets = path.join(__dirname, "../music_web/admin_static");
const shared = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const out = process.argv[2];
const gb = 1024 ** 3;
const snapshot = {
    available: true, goal: 2, global_ratio: 1.5, total_uploaded: 30 * gb, total_downloaded: 20 * gb,
    items: [
        {name: "Debian installer", state: "Seeding", ratio: 2.5, uploaded: 25 * gb, downloaded: 10 * gb},
        {name: "Archive of public domain films", state: "Stalled seeding", ratio: .5, uploaded: 5 * gb, downloaded: 10 * gb}
    ]
};

async function verify(browser, profile, options) {
    const page = await browser.newPage(options);
    try {
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let signedIn, unavailable = false;
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
            if (resource === "/api/server/seeding") {
                if (!signedIn) return route.fulfill({status: 401, json: {}});
                if (signedIn !== "admin") return route.fulfill({status: 403, json: {}});
                if (unavailable) return route.fulfill({status: 503, json: {}});
                return route.fulfill({json: snapshot});
            }
            const asset = resource === "/admin" ? "admin.html" : path.basename(resource);
            return route.fulfill({path: path.join(asset.startsWith("service-status.") ? shared : assets, asset), headers: {
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
        const heading = page.getByRole("heading", {name: "All torrents"});
        await heading.waitFor();
        assert.equal(await focused(heading), true);
        const meter = page.getByRole("progressbar", {name: "All torrents"});
        assert.equal(await meter.getAttribute("aria-valuenow"), "75");
        assert.equal(await meter.locator("i").evaluate(node => node.style.width), "75%");
        assert.equal(await page.getByRole("progressbar", {name: "Debian installer share ratio"}).getAttribute("aria-valuenow"), "100");
        assert.equal(await page.getByRole("progressbar", {name: "Archive of public domain films share ratio"}).getAttribute("aria-valuenow"), "25");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (out) await page.screenshot({path: path.join(out, profile + "-admin-seeding.png")});
        unavailable = true;
        await page.clock.fastForward(31000);
        const retry = page.getByRole("button", {name: "Retry seeding"});
        await retry.waitFor();
        await page.getByRole("status").filter({hasText: "Showing the last reading"}).waitFor();
        assert.equal(await meter.isVisible(), true);
        unavailable = false;
        await retry.press("Enter");
        await retry.waitFor({state: "hidden"});
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
