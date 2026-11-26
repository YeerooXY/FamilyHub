const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const { chromium } = require(require.resolve("playwright", {
    paths: [root, path.resolve(root, "../agent-dock")]
}));

const origin = "https://familyhub.test";
const nativeAssets = path.join(root, "clients/FamilyHub.App/wwwroot");
const sharedAssets = path.join(root, "music_web/static");
const index = fs.readFileSync(path.join(nativeAssets, "index.html"), "utf8");
const notice = "The server will restart in a moment. Music keeps playing from downloaded or cached songs.";
const reconnecting = "Reconnecting to the server...";

async function fixture(browser, width, reloadStillBroken) {
    const page = await browser.newPage({
        viewport: { width, height: 800 },
        reducedMotion: width === 390 ? "reduce" : "no-preference"
    });
    const requests = { documents: 0, bridge: 0 };
    await page.clock.install();
    await page.route("**/*", route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === "/_familyhub/ReloadApp") {
            assert.equal(request.method(), "POST");
            assert.equal(request.headers()["x-familyhub-webview"], "reload");
            requests.bridge++;
            return route.fulfill({ status: 204 });
        }
        if (url.pathname === "/" && request.isNavigationRequest()) {
            requests.documents++;
            const body = requests.documents === 1 ? index : reloadStillBroken
                ? index.replace('style="display:none" aria-labelledby="blazor-error-title"', 'style="display:block" aria-labelledby="blazor-error-title"')
                : index.replace('id="blazor-startup"', 'id="rendered-app"');
            return route.fulfill({ contentType: "text/html", body });
        }
        if (url.pathname === "/_framework/blazor.webview.js")
            return route.fulfill({ contentType: "text/javascript", body: "" });
        const name = url.pathname.slice(1);
        const asset = [nativeAssets, sharedAssets].map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
        return asset ? route.fulfill({ path: asset }) : route.fulfill({ status: 404 });
    });
    await page.goto(origin);
    return { page, requests };
}

async function verifyReload(browser, width, stuck) {
    const { page, requests } = await fixture(browser, width, stuck);
    try {
        const panel = page.locator("#blazor-error-ui");
        const button = panel.getByRole("button", { name: "Reload", exact: true });
        assert.equal(await panel.isVisible(), false);
        await page.evaluate(() => {
            const dialog = document.createElement("dialog");
            dialog.innerHTML = "<button>Cancel</button>";
            document.querySelector("#app").append(dialog);
            dialog.showModal();
            document.querySelector("#blazor-error-ui").style.display = "block";
        });
        await button.waitFor();
        assert.equal(await button.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator("#app dialog").evaluate(node => node.open), false);
        assert.equal(await page.getByRole("alert").textContent(), "FamilyHub needs to reload. Your music queue and settings are kept.");
        assert.equal(await panel.getByRole("heading").textContent(), "FamilyHub needs to reload");
        const box = await panel.boundingBox();
        assert.ok(box && Math.abs(box.width - width) < 1);
        assert.ok((await button.boundingBox()).height >= 44);
        assert.equal(await panel.locator(".fh-notice").evaluate(node => getComputedStyle(node).animationName),
            width === 390 ? "none" : "reload-panel-entry");
        const loaded = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
        if (stuck) await button.press("Space");
        else await button.click();
        await loaded;
        await page.waitForLoadState("load");
        assert.equal(requests.documents, 2);
        if (stuck) {
            const bridge = page.waitForResponse(origin + "/_familyhub/ReloadApp");
            await page.clock.fastForward(3100);
            await bridge;
            assert.equal(requests.bridge, 1);
            assert.equal(await panel.isVisible(), true);
        } else {
            await page.clock.fastForward(3100);
            assert.equal(requests.bridge, 0);
            assert.equal(await panel.isVisible(), false);
        }
    } finally {
        await page.close();
    }
}

async function verifyResume(browser) {
    const { page } = await fixture(browser, 390, false);
    try {
        const panel = page.locator("#blazor-error-ui");
        await page.evaluate(() => {
            window.DotNet = { invokeMethodAsync: () => Promise.resolve() };
            familyhub.setNativeActive(false);
        });
        await page.clock.fastForward(61000);
        await page.evaluate(() => familyhub.setNativeActive(true));
        await page.clock.fastForward(3100);
        assert.equal(await panel.isVisible(), false);
        await page.evaluate(() => {
            window.DotNet.invokeMethodAsync = () => new Promise(() => {});
            familyhub.setNativeActive(false);
        });
        await page.clock.fastForward(61000);
        await page.evaluate(() => familyhub.setNativeActive(true));
        await page.clock.fastForward(3100);
        assert.equal(await panel.isVisible(), true);
        assert.equal(await panel.getByRole("button", { name: "Reload" }).evaluate(node => node === document.activeElement), true);
    } finally {
        await page.close();
    }
}

async function verifyRestartBanner(browser, width) {
    const { page } = await fixture(browser, width, false);
    try {
        await page.evaluate(async () => {
            const { createServiceStatus } = await import("/service-status.js");
            document.querySelector("#app").innerHTML = `
                <span class="sr" id="restart-live" role="status" aria-live="polite" aria-atomic="true"></span>
                <div class="workspace"><main id="content" tabindex="-1">
                    <div class="shell-status">
                        <div class="fh-notice" id="server-restart-status" hidden>
                            <span class="fh-notice-copy"><span class="fh-notice-text"></span></span>
                        </div>
                    </div>
                    <button id="library">Library</button>
                </main></div>`;
            const content = document.querySelector("#content");
            const banner = document.querySelector("#server-restart-status");
            const live = document.querySelector("#restart-live");
            const outage = createServiceStatus({ detail: "Reconnect to load this folder.", label: "Retry", retry() {} });
            content.append(outage.card);
            window.setRestartFixture = (message, reconnect, failed) => {
                const text = banner.querySelector(".fh-notice-text");
                if (text.textContent !== message) text.textContent = live.textContent = message;
                banner.dataset.level = reconnect ? "info" : "warning";
                banner.hidden = !message;
                content.classList.toggle("server-reconnecting", reconnect);
                if (failed) outage.show();
                else outage.clear();
            };
        });
        const set = (message, reconnect, failed) => page.evaluate(args => setRestartFixture(...args), [message, reconnect, failed]);
        const banner = page.locator("#server-restart-status");
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        const library = page.getByRole("button", { name: "Library", exact: true });
        await library.focus();
        await set(notice, false, false);
        assert.equal(await banner.innerText(), notice);
        assert.equal(await page.getByRole("status").textContent(), notice);
        assert.equal(await library.evaluate(node => node === document.activeElement), true);
        assert.equal(await banner.evaluate(node => node.offsetWidth), await banner.locator("..").evaluate(node => node.offsetWidth));
        await set(reconnecting, true, true);
        assert.equal(await banner.innerText(), reconnecting);
        assert.equal(await page.getByRole("status").textContent(), reconnecting);
        assert.equal(await retry.isVisible(), false);
        assert.equal(await library.evaluate(node => node === document.activeElement), true);
        await set("", false, false);
        assert.equal(await banner.isVisible(), false);
        assert.equal(await retry.isVisible(), false);
        await set(reconnecting, true, true);
        await set("", false, true);
        assert.equal(await retry.isVisible(), true);
        await retry.focus();
        await set(reconnecting, true, true);
        await page.waitForFunction(() => document.activeElement.id === "content");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
        await page.close();
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [320, 390, 1280]) {
            await verifyReload(browser, width, false);
            await verifyReload(browser, width, true);
            await verifyRestartBanner(browser, width);
        }
        await verifyResume(browser);
    } finally {
        await browser.close();
    }
    console.log("Reload, native fallback and restart banner fixtures passed at 320, 390 and 1280 px.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
