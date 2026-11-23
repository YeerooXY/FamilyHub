// The Files screen with a fake server behind the .NET bridge: listing, folders, rename, delete, upload progress,
// share links and focus. Runs in Chromium and WebKit at phone and desktop width.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit, devices } = require(require.resolve("playwright", { paths: [process.cwd(), path.resolve(__dirname, "../../agent-dock")] }));

const app = "http://familyhub.test";
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const sharedStatic = path.join(__dirname, "../music_web/static");
const captures = path.join(__dirname, "../docs/verification/files-tiles-2026-11-23");
const styles = fs.readFileSync(path.join(wwwroot, "index.html"), "utf8").match(/<link rel="stylesheet"[^>]*>/g).join("");

async function check(browser, label, profile, capture = true) {
    const page = await browser.newPage({ ...profile, locale: "en-GB", timezoneId: "UTC", reducedMotion: "reduce" });
    const screenshot = (state) => capture && page.screenshot({ path: path.join(captures, `${label}-${state}.png`), scale: "css" });
    page.setDefaultTimeout(6000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route(app + "/**", (route) => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (!name) return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body data-view="Files"><div class="workspace" data-app-view="Files"><main id="content" tabindex="-1"><h1 id="view-title">Files</h1><div id="host" class="files-host"></div></main></div></body></html>` });
        const asset = [wwwroot, sharedStatic].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
        return asset ? route.fulfill({ path: asset }) : route.fulfill({ status: 404 });
    });
    await page.goto(app + "/");
    await page.evaluate(async () => {
        const now = Date.UTC(2026, 10, 23, 12) / 1000;
        const tree = { mine: { "": [["Trips", "dir"], ["notes.txt", "file", 1200], ["report.pdf", "file", 3400000], ["Travel itinerary and booking confirmations.pdf", "file", 920000]], Trips: [["Receipts", "dir"], ["plan.txt", "file", 80]] }, family: { "": [["Photos", "dir"], ["recipes.doc", "file", 5000]] } };
        const links = [];
        const heldListings = new Map();
        window.holdListing = (key) => {
            let release;
            const pending = new Promise((resolve) => { release = resolve; });
            heldListings.set(key, { pending, release });
        };
        window.releaseListing = async ([key, error]) => {
            const hold = heldListings.get(key);
            heldListings.delete(key);
            hold.release(error);
            await new Promise((resolve) => requestAnimationFrame(resolve));
        };
        window.log = [];
        const reply = (status, body) => JSON.stringify({ status, body: body === undefined ? "" : JSON.stringify(body) });
        const bridge = { invokeMethodAsync: async (name, ...args) => {
            window.log.push([name, ...args]);
            if (name === "FilesCall") {
                const [method, url, json] = args, u = new URL(url, "http://x"), p = u.searchParams, space = p.get("space"), dir = p.get("path") || "";
                const body = json ? JSON.parse(json) : {};
                if (u.pathname === "/api/files/list") {
                    const hold = heldListings.get(space + "/" + dir);
                    if (hold) {
                        const error = await hold.pending;
                        if (error) return reply(404, { error });
                    }
                    const rows = (tree[space]?.[dir] ?? []).map(([n, t, s]) => ({ name: n, type: t, size: s ?? 0, modified: now - 86400, owner: null }));
                    return reply(200, { space, path: dir, entries: rows.sort((a, b) => a.name.localeCompare(b.name)) });
                }
                if (u.pathname === "/api/files/folder") {
                    if (body.name === "Unavailable") return reply(503, { error: "HTTP 503" });
                    (tree[body.space][body.path] ??= []).push([body.name, "dir"]);
                    tree[body.space][body.path === "" ? body.name : body.path + "/" + body.name] = [];
                    return reply(201, { name: body.name });
                }
                if (u.pathname === "/api/files/rename") {
                    const parts = body.path.split("/"), old = parts.pop(), where = parts.join("/");
                    if (tree[body.space][where].some((r) => r[0] === body.name)) return reply(409, { error: "Something with that name already exists." });
                    tree[body.space][where].find((r) => r[0] === old)[0] = body.name;
                    return reply(200, { name: body.name });
                }
                if (u.pathname === "/api/files" && method === "DELETE") {
                    const parts = dir.split("/"), old = parts.pop(), where = parts.join("/");
                    tree[space][where] = tree[space][where].filter((r) => r[0] !== old);
                    return reply(204);
                }
                if (u.pathname === "/api/files/links" && method === "POST") {
                    links.unshift({ id: "a".repeat(16), space: body.space, path: body.path, name: body.path.split("/").at(-1), created: now, expires: now + body.expires_hours * 3600, max_downloads: body.max_downloads ?? null, downloads: 0, protected: Boolean(body.password), active: true });
                    return reply(201, { id: "a".repeat(16), url: "/api/share/SECRET", expires: now + body.expires_hours * 3600 });
                }
                if (u.pathname === "/api/files/links" && method === "GET") return reply(200, { links });
                if (u.pathname.startsWith("/api/files/links/") && method === "DELETE") { links[0].active = false; return reply(204); }
            }
            if (name === "FilesUpload") {
                for (const pct of [10, 60, 100]) { window.screen1.progress("big.iso", pct, 100); await new Promise((r) => setTimeout(r, 120)); }
                tree[args[0]][args[1]].push(["big.iso", "file", 9e9]);
                return JSON.stringify({ uploaded: ["big.iso"], errors: [] });
            }
            if (name === "FilesDownload") return `Saved ${args[2]} to your Downloads folder.`;
            if (name === "FilesCopy") return true;
            return null;
        } };
        const { openFiles } = await import("/files.js");
        window.screen1 = openFiles(document.getElementById("host"), bridge, { server: "https://server.test" });
    });
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
    const noScroll = async (where) => assert.equal(await page.evaluate(() =>
        [document.documentElement, document.getElementById("content")].every((node) => node.scrollWidth <= node.clientWidth)
    ), true, `${label}: no sideways scroll ${where}`);

    // Listing, tabs, breadcrumb
    await page.getByRole("button", { name: "Open folder Trips" }).waitFor();
    assert.equal(await page.locator(".files-tile").count(), 4);
    assert.match(await page.locator(".files-tile").first().innerText(), /Trips/);
    assert.equal(await page.getByRole("button", { name: "Download Travel itinerary and booking confirmations.pdf" }).getAttribute("title"), "Travel itinerary and booking confirmations.pdf");
    await page.getByRole("button", { name: "Open folder Trips" }).click();
    await page.getByRole("button", { name: "Download plan.txt" }).waitFor();
    assert.equal(await page.locator(".files-crumb", { hasText: "Trips" }).getAttribute("aria-current"), "page");
    await page.locator(".files-crumb", { hasText: "My files" }).click();
    await page.getByRole("button", { name: "Download notes.txt" }).waitFor();
    await page.getByRole("tab", { name: "Family" }).click();
    await page.getByRole("button", { name: "Download recipes.doc" }).waitFor();
    await page.getByRole("tab", { name: "My files" }).click();
    await page.getByRole("button", { name: "Download notes.txt" }).waitFor();

    // A slow Family response cannot redraw My files or take focus back to Family.
    await page.evaluate(() => window.holdListing("family/"));
    await page.getByRole("tab", { name: "My files" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await active(), "Family");
    assert.equal(await page.getByRole("tab", { name: "Family" }).getAttribute("aria-selected"), "true");
    assert.equal(await page.locator(".files-tile").count(), 0);
    await page.keyboard.press("Tab");
    assert.equal(await active(), "Upload files");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await active(), "Family");
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("button", { name: "Download notes.txt" }).waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await active(), "Upload files");
    await page.evaluate(() => window.releaseListing(["family/"]));
    assert.equal(await page.getByRole("button", { name: "Download notes.txt" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Download recipes.doc" }).count(), 0);
    assert.equal(await page.locator(".files-status").innerText(), "");
    assert.equal(await active(), "Upload files");

    // A slow nested folder error cannot clear its parent's rows or announce an error there.
    await page.getByRole("button", { name: "Open folder Trips" }).focus();
    await page.keyboard.press("Enter");
    const receipts = page.getByRole("button", { name: "Open folder Receipts" });
    await receipts.waitFor();
    await page.evaluate(() => window.holdListing("mine/Trips/Receipts"));
    await receipts.focus();
    await page.keyboard.press("Space");
    assert.equal(await page.locator(".files-crumb[aria-current]").innerText(), "Receipts");
    assert.equal(await page.locator(".files-status").innerText(), "Loading…");
    await page.getByRole("button", { name: "Trips", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Download plan.txt" }).waitFor();
    await page.getByRole("button", { name: "New folder" }).focus();
    await page.evaluate(() => window.releaseListing(["mine/Trips/Receipts", "The folder was removed."]));
    assert.equal(await page.getByRole("button", { name: "Download plan.txt" }).count(), 1);
    assert.equal(await page.locator(".files-crumb[aria-current]").innerText(), "Trips");
    assert.equal(await page.locator(".files-status").innerText(), "");
    assert.equal(await active(), "New folder");
    await page.getByRole("button", { name: "My files", exact: true }).click();
    await page.getByRole("button", { name: "Download notes.txt" }).waitFor();

    await noScroll("listing");
    const progressFill = page.locator(".files-progress-fill");
    const progressTransition = () => progressFill.evaluate((node) => getComputedStyle(node).transitionDuration);
    assert.equal(await progressTransition(), "0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.notEqual(await progressTransition(), "0s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const tile = page.locator(".files-tile").first();
    assert.ok((await tile.boundingBox()).width <= 192);
    const first = page.getByRole("button", { name: "Open folder Trips" });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await active(), "Download notes.txt");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await active(), "Open folder Trips");
    if (profile.viewport.width <= 600) {
        const columns = await page.locator(".files-list").evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(" ").length);
        assert.equal(columns, 2);
        const actionRows = await page.locator(".files-actions button").evaluateAll((nodes) => new Set(nodes.map((n) => n.offsetTop)).size);
        assert.equal(actionRows, 1);
        await page.keyboard.press("ArrowDown");
        assert.equal(await active(), "Download report.pdf");
        await page.keyboard.press("ArrowUp");
        assert.equal(await active(), "Open folder Trips");
    }
    if (profile.viewport.width >= 1600) {
        assert.equal(await first.evaluate((n) => getComputedStyle(n).outlineWidth), "4px");
        assert.equal((await page.getByRole("button", { name: "Upload files", exact: true }).boundingBox()).height, 60);
    }
    await page.mouse.move(0, 0);
    await screenshot("tiles");
    const actions = page.getByRole("button", { name: "Actions for report.pdf" });
    if (profile.hasTouch) await actions.tap();
    else { await actions.focus(); await page.keyboard.press("Enter"); }
    assert.equal(await active(), "Download");
    await page.keyboard.press("ArrowDown");
    assert.equal(await active(), "Share link");
    await noScroll("menu");
    await page.keyboard.press("Escape");
    assert.equal(await active(), "Actions for report.pdf");
    await page.getByRole("button", { name: "Download report.pdf" }).press("Enter");
    await page.getByRole("status").filter({ hasText: "Saved report.pdf" }).waitFor();

    // New folder: Escape closes the sheet and returns focus to its opener.
    await page.getByRole("button", { name: "New folder" }).click();
    const newDialog = page.getByRole("dialog", { name: "New folder" });
    await newDialog.waitFor();
    const nameField = newDialog.getByRole("textbox", { name: "Name" });
    assert.equal(await nameField.evaluate((n) => n === document.activeElement), true);
    assert.equal(await nameField.getAttribute("autocomplete"), "off");
    const minTarget = profile.viewport.width >= 1600 ? 60 : 44;
    assert.equal((await newDialog.getByRole("button", { name: "Close new folder" }).boundingBox()).height, minTarget);
    assert.equal((await nameField.boundingBox()).height, Math.max(48, minTarget));
    assert.equal(await newDialog.getByRole("button", { name: "Create folder" }).isDisabled(), true);
    await noScroll("new folder dialog");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await active(), "New folder", `${label}: Escape returns focus to New folder`);
    await page.getByRole("button", { name: "New folder" }).click();
    await nameField.fill("Unavailable");
    await nameField.press("Enter");
    await newDialog.getByRole("alert").filter({ hasText: "That did not work. Try again." }).waitFor();
    await nameField.fill("Taxes");
    await screenshot("new-folder");
    await nameField.press("Enter");
    const taxes = page.getByRole("button", { name: "Open folder Taxes" });
    await taxes.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.name), "Taxes", `${label}: focus lands on the new folder`);
    await taxes.click();
    await page.getByText("This folder is empty.").waitFor();
    await page.getByRole("button", { name: "Upload to this folder" }).waitFor();
    await noScroll("empty folder");
    await screenshot("empty");
    await page.getByRole("button", { name: "My files", exact: true }).click();

    // Rename: a clash shows the server's own words, then a free name works.
    await page.getByRole("button", { name: "Actions for notes.txt" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Taxes");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Something with that name already exists." }).waitFor();
    await page.getByRole("textbox", { name: "Name" }).fill("diary.txt");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("button", { name: "Download diary.txt" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.name), "diary.txt");

    // Delete: focus moves to a neighbouring row, never to the page.
    await page.getByRole("button", { name: "Actions for diary.txt" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Download diary.txt" }).waitFor({ state: "detached" });
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY", `${label}: focus did not fall to the page`);
    assert.match(await page.evaluate(() => document.activeElement.dataset.name || ""), /report\.pdf|Taxes|Trips/);

    // Upload shows a progress line, then hides it and reports the result.
    await page.getByRole("button", { name: "Upload files" }).click();
    await page.getByRole("progressbar").waitFor({ state: "visible" });
    assert.match(await page.getByRole("progressbar").getAttribute("aria-valuetext"), /big\.iso: \d+ percent/);
    await page.getByRole("button", { name: "Download big.iso" }).waitFor();
    await page.getByRole("progressbar").waitFor({ state: "hidden" });
    assert.match(await page.locator(".files-status").innerText(), /1 file uploaded\./);
    assert.equal(await active(), "Upload files");

    // Share link: password and one-off, copy, then revoke from the list.
    await page.getByRole("button", { name: "Actions for report.pdf" }).click();
    await page.getByRole("menuitem", { name: "Share link" }).click();
    const share = page.getByRole("dialog", { name: "Share link" });
    assert.equal(await share.getByRole("combobox").evaluate((node) => node === document.activeElement), true);
    assert.match(await share.getByRole("button", { name: "Create link" }).evaluate((node) => getComputedStyle(node).backgroundImage), /^linear-gradient/);
    await noScroll("share dialog");
    if (label === "iphone-13") await screenshot("share-link");
    await page.getByLabel("Password (optional)").fill("abc");
    await page.getByRole("alert").filter({ hasText: "at least 4 characters" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create link" }).isDisabled(), true);
    await page.getByLabel("Password (optional)").fill("pa55word");
    await page.getByLabel("One-off: works for a single download").check();
    await page.getByLabel("Password (optional)").press("Enter");
    const address = page.getByRole("textbox", { name: "Link address" });
    await address.waitFor();
    assert.equal(await address.inputValue(), "https://server.test/api/share/SECRET");
    assert.equal(await address.evaluate((n) => n.readOnly), true);
    await page.getByRole("button", { name: "Copy link" }).click();
    await page.getByText("Copied.").waitFor();
    assert.ok(await page.evaluate(() => window.log.some((l) => l[0] === "FilesCopy" && l[1] === "https://server.test/api/share/SECRET")));
    const sent = await page.evaluate(() => JSON.parse(window.log.filter((l) => l[0] === "FilesCall" && l[1] === "POST" && l[2] === "/api/files/links").at(-1)[3]));
    assert.deepEqual([sent.max_downloads, sent.password, sent.expires_hours], [1, "pa55word", 168]);
    await page.getByRole("button", { name: "Close share link" }).click();
    assert.equal(await active(), "Actions for report.pdf", `${label}: focus returns to the row's menu button`);
    await page.getByRole("button", { name: "Your links" }).click();
    await page.getByText("report.pdf · works until").waitFor();
    if (label === "iphone-13") await screenshot("your-links");
    await page.getByRole("button", { name: "Revoke link to report.pdf" }).click();
    await page.getByText("Revoked the link to report.pdf.").waitFor();
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY", `${label}: focus stays in the sheet after revoke`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await noScroll("after sheets");
    assert.deepEqual(pageErrors, []);
    await page.evaluate(() => window.screen1.close());
    await page.close();
}

(async () => {
    for (const [engine, profiles] of [
        [chromium, [
            ["desktop-1280", { viewport: { width: 1280, height: 800 } }],
            ["desktop-2000", { viewport: { width: 2000, height: 1000 } }],
            ["pixel-7", { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } }],
        ]],
        [webkit, [
            ["iphone-13", { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }],
            ["webkit-desktop", { viewport: { width: 1280, height: 800 } }, false],
        ]],
    ]) {
        const browser = await engine.launch();
        try {
            for (const [label, profile, capture] of profiles) await check(browser, label, profile, capture);
        } finally { await browser.close(); }
    }
    console.log("Files screen verified: list, tabs, breadcrumb, folder, rename, delete focus, upload progress, share link, revoke, in Chromium and WebKit at phone and desktop width.");
})().catch((error) => { console.error(error); process.exit(1); });
