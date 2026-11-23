// Files: the family's shared folder and each profile's private folder, with share links.
// This module owns the screen. The .NET side owns the network, the file picker and the clipboard: it answers
// `FilesCall` (JSON endpoints), `FilesUpload`, `FilesDownload`, `FilesCopy` and `FilesShare`.

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function bytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = n / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const stamp = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const EXPIRY = [[1, "1 hour"], [24, "1 day"], [168, "7 days"], [720, "30 days"]];

export function openFiles(host, app, viewer) {
    const life = new AbortController();
    let space = "mine", path = "", entries = [], menu = null, sheet = null, busy = false;

    const root = el("div", "files");
    host.replaceChildren(root);

    // The server answers every JSON call as {status, body}. Error text comes from the server, so say it as it is.
    async function call(method, url, json) {
        let reply;
        try { reply = JSON.parse(await app.invokeMethodAsync("FilesCall", method, url, json === undefined ? null : JSON.stringify(json))); }
        catch { return { ok: false, error: "The server did not answer. Check the connection and try again." }; }
        let body = null;
        try { body = reply.body ? JSON.parse(reply.body) : null; } catch { /* a non-JSON body */ }
        if (reply.status >= 200 && reply.status < 300) return { ok: true, body };
        return { ok: false, error: body?.error || "That did not work. Try again." };
    }
    const q = (p) => encodeURIComponent(p);
    const here = (name) => (path ? path + "/" : "") + name;

    // ---- layout ----
    const title = el("h2", "files-title", "Files"); // a quiet landing point for focus; the page heading above already says "Files"
    title.tabIndex = -1;
    const tabs = el("div", "files-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Whose files");
    const tabButtons = {};
    for (const [key, label] of [["mine", "My files"], ["family", "Family"]]) {
        const b = el("button", "files-tab", label);
        b.type = "button"; b.setAttribute("role", "tab"); b.dataset.space = key;
        b.onclick = () => { if (space !== key) { space = key; path = ""; load(); } };
        tabButtons[key] = b; tabs.append(b);
    }
    const actions = el("div", "files-actions");
    const upload = el("button", "files-primary", "Upload files"); upload.type = "button";
    const newFolder = el("button", "files-quiet", "New folder"); newFolder.type = "button";
    const linksButton = el("button", "files-quiet", "Your links"); linksButton.type = "button";
    actions.append(upload, newFolder, linksButton);
    const crumbs = el("nav", "files-crumbs");
    crumbs.setAttribute("aria-label", "Folder");
    const status = el("p", "files-status"); status.setAttribute("role", "status");
    const progress = el("div", "files-progress"); progress.hidden = true;
    progress.setAttribute("role", "progressbar"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
    const bar = el("span", "files-progress-fill"), thumb = el("span", "files-progress-thumb");
    progress.append(bar, thumb);
    const list = el("ul", "files-list");
    const empty = el("p", "files-empty");
    root.append(title, tabs, actions, crumbs, status, progress, list, empty);

    // ---- listing ----
    function drawTabs() {
        for (const [key, b] of Object.entries(tabButtons)) { b.setAttribute("aria-selected", String(key === space)); b.tabIndex = key === space ? 0 : -1; }
    }
    function drawCrumbs() {
        crumbs.replaceChildren();
        const parts = path ? path.split("/") : [];
        const make = (label, target, current) => {
            const b = el("button", "files-crumb", label); b.type = "button";
            if (current) b.setAttribute("aria-current", "page");
            b.onclick = () => { path = target; load(); };
            return b;
        };
        crumbs.append(make(space === "mine" ? "My files" : "Family", "", !parts.length));
        parts.forEach((part, i) => { crumbs.append(el("span", "files-sep", "›"), make(part, parts.slice(0, i + 1).join("/"), i === parts.length - 1)); });
    }
    function draw(focusName) {
        drawTabs(); drawCrumbs();
        title.textContent = (path ? path.split("/").at(-1) : space === "mine" ? "My files" : "Family files") + " folder";
        list.replaceChildren();
        empty.textContent = entries.length ? "" : path ? "This folder is empty." : space === "mine" ? "Nothing here yet. Upload a file to start." : "The family folder is empty.";
        for (const entry of entries) {
            const row = el("li", "files-row"), main = el("button", "files-name"), more = el("button", "files-more");
            main.type = "button"; more.type = "button";
            main.dataset.name = entry.name;
            main.append(el("span", "files-kind", entry.type === "dir" ? "Folder" : "File"), el("span", "files-label", entry.name));
            main.setAttribute("aria-label", entry.type === "dir" ? `Open folder ${entry.name}` : `Download ${entry.name}`);
            main.onclick = () => entry.type === "dir" ? (path = here(entry.name), load()) : download(entry, main);
            const meta = el("span", "files-meta", entry.type === "dir" ? "" : bytes(entry.size));
            const when = el("span", "files-when", day.format(new Date(entry.modified * 1000)));
            more.textContent = "⋯";
            more.setAttribute("aria-label", `Actions for ${entry.name}`);
            more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
            more.onclick = () => openMenu(entry, more);
            row.append(main, meta, when, more);
            list.append(row);
        }
        if (focusName) (list.querySelector(`.files-name[data-name="${CSS.escape(focusName)}"]`) ?? title).focus();
    }
    async function load(focusName) {
        closeMenu();
        status.textContent = "Loading…";
        const r = await call("GET", `/api/files/list?space=${space}&path=${q(path)}`);
        if (life.signal.aborted) return;
        if (!r.ok) { status.textContent = r.error; entries = []; draw(); return; }
        entries = r.body.entries;
        status.textContent = "";
        draw(focusName);
        if (!focusName) title.focus();
    }

    // ---- one actions menu per row ----
    function closeMenu(restore) {
        if (!menu) return;
        const { node, opener } = menu;
        menu = null; node.remove(); opener.setAttribute("aria-expanded", "false");
        if (restore) opener.focus();
    }
    function openMenu(entry, opener) {
        if (menu?.opener === opener) { closeMenu(true); return; }
        closeMenu();
        const node = el("div", "files-menu"); node.setAttribute("role", "menu");
        const item = (label, run) => { const b = el("button", "files-item", label); b.type = "button"; b.setAttribute("role", "menuitem"); b.onclick = () => { closeMenu(); run(); }; node.append(b); };
        if (entry.type === "file") { item("Download", () => download(entry, opener)); item("Share link", () => shareSheet(entry, opener)); }
        item("Rename", () => nameSheet("Rename", entry.name, "Rename", async (value) => call("POST", "/api/files/rename", { space, path: here(entry.name), name: value }), opener, entry));
        item("Delete", () => deleteSheet(entry, opener));
        opener.parentElement.append(node);
        opener.setAttribute("aria-expanded", "true");
        menu = { node, opener };
        node.querySelector("button").focus();
        node.onkeydown = (event) => {
            const items = [...node.querySelectorAll("button")], at = items.indexOf(document.activeElement);
            if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length].focus(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
            else if (event.key === "Tab") closeMenu();
        };
    }
    document.addEventListener("pointerdown", (event) => { if (menu && !menu.node.contains(event.target) && event.target !== menu.opener) closeMenu(); }, { signal: life.signal });

    // ---- sheets: one named close control, Escape closes, focus returns to the opener ----
    function openSheet(heading, opener) {
        closeSheet();
        const backdrop = el("div", "files-backdrop"), card = el("div", "files-sheet");
        card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", heading);
        const head = el("div", "files-sheet-head"), h = el("h3", "", heading);
        const close = el("button", "files-quiet", "Close"); close.type = "button"; close.setAttribute("aria-label", `Close ${heading.toLowerCase()}`);
        close.onclick = () => closeSheet(true);
        head.append(h, close);
        const body = el("div", "files-sheet-body");
        card.append(head, body);
        backdrop.append(card);
        backdrop.onclick = (event) => { if (event.target === backdrop) closeSheet(true); };
        root.append(backdrop);
        sheet = { backdrop, opener };
        card.onkeydown = (event) => {
            if (event.key === "Escape") { event.stopPropagation(); closeSheet(true); return; }
            if (event.key !== "Tab") return;
            const focusable = [...card.querySelectorAll("button, input, select, a[href]")].filter((n) => !n.disabled);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        return { body, card, close };
    }
    function closeSheet(restore) {
        if (!sheet) return;
        const { backdrop, opener } = sheet;
        sheet = null; backdrop.remove();
        if (restore && opener?.isConnected) opener.focus(); else if (restore) title.focus();
    }
    const field = (label, input) => { const l = el("label", "files-field"); l.append(el("span", "", label), input); return l; };
    const message = () => { const p = el("p", "files-error"); p.setAttribute("role", "alert"); return p; };

    function nameSheet(heading, value, verb, run, opener, entry) {
        const { body, card } = openSheet(heading, opener);
        const input = el("input"); input.type = "text"; input.value = value; input.maxLength = 120; input.autocomplete = "off";
        const error = message(), go = el("button", "files-primary", verb); go.type = "button";
        go.onclick = async () => {
            go.disabled = true; error.textContent = "";
            const r = await run(input.value.trim());
            go.disabled = false;
            if (!r.ok) { error.textContent = r.error; input.focus(); return; }
            const created = r.body?.name ?? input.value.trim();
            closeSheet(false);
            await load(created);
        };
        input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); go.click(); } };
        body.append(field("Name", input), error, go);
        input.focus(); input.select();
        void card;
    }
    newFolder.onclick = () => nameSheet("New folder", "", "Create folder", (value) => call("POST", "/api/files/folder", { space, path, name: value }), newFolder);

    function deleteSheet(entry, opener, recursive = false) {
        const folder = entry.type === "dir";
        const { body } = openSheet(recursive ? "Delete everything inside" : folder ? "Delete folder" : "Delete file", opener);
        body.append(el("p", "", recursive ? `“${entry.name}” and everything inside it will be deleted for good.` : `“${entry.name}” will be deleted for good.${entry.type === "file" ? " Links to it stop working." : ""}`));
        const error = message(), go = el("button", "files-danger", "Delete"); go.type = "button";
        const keep = el("button", "files-quiet", "Keep it"); keep.type = "button"; keep.onclick = () => closeSheet(true);
        go.onclick = async () => {
            go.disabled = true;
            const r = await call("DELETE", `/api/files?space=${space}&path=${q(here(entry.name))}${recursive ? "&recursive=true" : ""}`);
            go.disabled = false;
            if (!r.ok && folder && !recursive && /not empty/i.test(r.error)) { closeSheet(false); deleteSheet(entry, opener, true); return; }
            if (!r.ok) { error.textContent = r.error; return; }
            // The deleted row's neighbour gets focus, so keyboard focus never falls to the page.
            const at = entries.findIndex((e) => e.name === entry.name);
            const next = entries[at + 1] ?? entries[at - 1];
            closeSheet(false);
            await load(next?.name);
            status.textContent = `Deleted ${entry.name}.`;
        };
        body.append(error, el("div", "files-buttons"));
        body.lastChild.append(keep, go);
        keep.focus();
    }

    // ---- download and upload run in .NET (file system, picker) ----
    async function download(entry, opener) {
        status.textContent = `Downloading ${entry.name}…`;
        try { status.textContent = await app.invokeMethodAsync("FilesDownload", space, here(entry.name), entry.name); }
        catch { status.textContent = `Could not download ${entry.name}. Try again.`; }
        opener?.focus?.();
    }
    upload.onclick = async () => {
        if (busy) return;
        busy = true; upload.setAttribute("aria-disabled", "true");
        let result;
        try { result = JSON.parse(await app.invokeMethodAsync("FilesUpload", space, path)); }
        catch { result = { uploaded: [], errors: ["The upload did not finish. Try again."] }; }
        busy = false; upload.removeAttribute("aria-disabled");
        progress.hidden = true;
        const parts = [];
        if (result.uploaded.length) parts.push(`${result.uploaded.length} ${result.uploaded.length === 1 ? "file" : "files"} uploaded.`);
        parts.push(...result.errors);
        await load();
        status.textContent = parts.join(" ");
        upload.focus();
    };
    function showProgress(name, sent, total) {
        const percent = total ? Math.min(100, Math.round(sent * 100 / total)) : 0;
        progress.hidden = false;
        progress.setAttribute("aria-valuenow", String(percent)); progress.setAttribute("aria-label", `Uploading ${name}`);
        progress.setAttribute("aria-valuetext", `${name}: ${percent} percent`);
        bar.style.width = percent + "%"; thumb.style.left = percent + "%";
        status.textContent = `Uploading ${name}: ${percent}%`;
    }

    // ---- share links ----
    function shareSheet(entry, opener) {
        const { body } = openSheet("Share link", opener);
        body.append(el("p", "", `Anyone with the link can download “${entry.name}” until it expires.`));
        const expiry = el("select");
        for (const [hours, label] of EXPIRY) { const o = el("option", "", label); o.value = String(hours); if (hours === 168) o.selected = true; expiry.append(o); }
        const password = el("input"); password.type = "password"; password.autocomplete = "new-password"; password.maxLength = 200;
        const once = el("input"); once.type = "checkbox";
        const onceLabel = el("label", "files-check"); onceLabel.append(once, el("span", "", "One-off: works for a single download"));
        const error = message(), make = el("button", "files-primary", "Create link"); make.type = "button";
        const result = el("div", "files-result"); result.hidden = true;
        make.onclick = async () => {
            if (password.value && password.value.length < 4) { error.textContent = "The password needs at least 4 characters."; password.focus(); return; }
            make.disabled = true; error.textContent = "";
            const r = await call("POST", "/api/files/links", { space, path: here(entry.name), expires_hours: Number(expiry.value), password: password.value || undefined, max_downloads: once.checked ? 1 : undefined });
            make.disabled = false;
            if (!r.ok) { error.textContent = r.error; return; }
            const url = r.body.url.startsWith("http") ? r.body.url : viewer.server.replace(/\/+$/, "") + r.body.url;
            result.hidden = false; result.replaceChildren();
            const address = el("input"); address.type = "text"; address.readOnly = true; address.value = url; address.setAttribute("aria-label", "Link address");
            const copy = el("button", "files-primary", "Copy link"); copy.type = "button";
            copy.onclick = async () => { const ok = await app.invokeMethodAsync("FilesCopy", url).catch(() => false); message2.textContent = ok ? "Copied." : "Select the link and copy it."; };
            const send = el("button", "files-quiet", "Share…"); send.type = "button";
            send.onclick = () => app.invokeMethodAsync("FilesShare", url).catch(() => {});
            const message2 = el("p", "files-note"); message2.setAttribute("role", "status");
            const when = el("p", "files-note", `Works until ${stamp.format(new Date(r.body.expires * 1000))}. This is the only time the address is shown; make a new link if you lose it.`);
            result.append(address, el("div", "files-buttons"), message2, when);
            result.children[1].append(copy, send);
            make.hidden = true; address.focus(); address.select();
        };
        body.append(field("Link works for", expiry), field("Password (optional)", password), onceLabel, error, make, result);
        expiry.focus();
    }
    linksButton.onclick = async () => {
        const { body } = openSheet("Your links", linksButton);
        const note = el("p", "files-note", "Loading…"); body.append(note);
        const r = await call("GET", "/api/files/links");
        if (!sheet) return;
        if (!r.ok) { note.textContent = r.error; return; }
        note.textContent = r.body.links.length ? "Newest first. A link's address is shown only when it is made." : "You have not made any links yet.";
        const ul = el("ul", "files-links");
        for (const link of r.body.links) {
            const li = el("li", "files-link");
            const label = `${link.name} · ${link.active ? "works until " + stamp.format(new Date(link.expires * 1000)) : "no longer works"} · ${link.downloads}${link.max_downloads ? " of " + link.max_downloads : ""} ${link.downloads === 1 ? "download" : "downloads"}${link.protected ? " · password" : ""}`;
            li.append(el("span", "", label));
            if (link.active) {
                const revoke = el("button", "files-quiet", "Revoke"); revoke.type = "button"; revoke.setAttribute("aria-label", `Revoke link to ${link.name}`);
                revoke.onclick = async () => {
                    revoke.disabled = true;
                    const done = await call("DELETE", `/api/files/links/${link.id}`);
                    if (!done.ok) { revoke.disabled = false; note.textContent = done.error; return; }
                    const siblings = [...ul.querySelectorAll(".files-quiet:not([disabled])")].filter((b) => b !== revoke);
                    li.firstChild.textContent = label.replace(/works until [^·]+/, "no longer works");
                    revoke.remove();
                    note.textContent = `Revoked the link to ${link.name}.`;
                    (siblings[0] ?? sheet?.backdrop.querySelector("button"))?.focus();
                };
                li.append(revoke);
            }
            ul.append(li);
        }
        body.append(ul);
        sheet.backdrop.querySelector(".files-sheet button")?.focus();
    };

    tabs.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const keys = Object.keys(tabButtons), next = keys[(keys.indexOf(space) + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length];
        space = next; path = ""; load().then(() => tabButtons[next].focus());
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (sheet) closeSheet(true); else if (menu) closeMenu(true); } }, { signal: life.signal });

    load();
    return {
        progress: showProgress,
        close() { life.abort(); closeMenu(); closeSheet(); root.remove(); }
    };
}
