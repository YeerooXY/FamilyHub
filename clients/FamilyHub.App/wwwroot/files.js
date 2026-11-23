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
// Matches MusicIcon's outlined 24 px grid and 2 px stroke.
const FOLDER = "M3 7V5a2 2 0 0 1 2-2h4l2 4h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z";
const UPLOAD = "M12 16V3m-5 5 5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2";

function icon(path) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "files-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const shape = document.createElementNS(svg.namespaceURI, "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
}

function button(className, label, shape) {
    const node = el("button", className, label);
    node.type = "button";
    if (shape) node.prepend(icon(shape));
    return node;
}

function errorText(value, fallback = "That did not work. Try again.") {
    return typeof value === "string" && value.trim() &&
        !/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?|error)\s*[:(]?\s*[1-5]\d{2}\b|^\s*[1-5]\d{2}(?:\s|:|$)/i.test(value) ? value : fallback;
}

export function openFiles(host, app, viewer) {
    const life = new AbortController();
    let space = "mine", path = "", entries = [], menu = null, sheet = null, busy = false;
    let navigation = 0, listing = 0, uploadNavigation;

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
        return { ok: false, error: errorText(body?.error) };
    }
    const q = (p) => encodeURIComponent(p);
    const here = (name) => (path ? path + "/" : "") + name;

    // ---- layout ----
    const toolbar = el("div", "files-toolbar");
    const tabs = el("div", "files-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Whose files");
    const tabButtons = {};
    for (const [key, label] of [["mine", "My files"], ["family", "Family"]]) {
        const b = el("button", "files-tab", label);
        b.type = "button"; b.setAttribute("role", "tab"); b.dataset.space = key;
        b.onclick = () => { if (space !== key) navigate(key, "", b); };
        tabButtons[key] = b; tabs.append(b);
    }
    const actions = el("div", "files-actions");
    const upload = button("files-primary", "Upload files", UPLOAD);
    const newFolder = button("files-quiet", "New folder", FOLDER + "M12 11v6m-3-3h6");
    const linksButton = button("files-quiet", "Your links", "m10 13 4-4M8 16l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 8a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1");
    actions.append(upload, newFolder, linksButton);
    toolbar.append(tabs, actions);
    const crumbs = el("nav", "files-crumbs");
    crumbs.setAttribute("aria-label", "Folder");
    const status = el("p", "files-status"); status.setAttribute("role", "status");
    const progress = el("div", "files-progress"); progress.hidden = true;
    progress.setAttribute("role", "progressbar"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
    const bar = el("span", "files-progress-fill"), thumb = el("span", "files-progress-thumb");
    progress.append(bar, thumb);
    const list = el("ul", "files-list");
    list.setAttribute("aria-label", "Folder contents");
    const empty = el("div", "files-empty");
    empty.hidden = true;
    const illustration = el("div", "files-empty-art");
    illustration.append(icon(FOLDER));
    const emptyText = el("p");
    emptyText.setAttribute("role", "status");
    const emptyUpload = button("files-primary", "Upload to this folder", UPLOAD);
    empty.append(illustration, emptyText, emptyUpload);
    root.append(toolbar, crumbs, status, progress, list, empty);
    const currentCrumb = () => crumbs.querySelector("[aria-current]");

    // ---- listing ----
    function drawTabs() {
        for (const [key, b] of Object.entries(tabButtons)) { b.setAttribute("aria-selected", String(key === space)); b.tabIndex = key === space ? 0 : -1; }
    }
    function drawCrumbs() {
        crumbs.replaceChildren();
        const parts = path ? path.split("/") : [];
        const make = (label, target, current) => {
            const b = button("files-crumb", label);
            if (current) b.setAttribute("aria-current", "page");
            b.onclick = () => navigate(space, target);
            return b;
        };
        crumbs.append(make(space === "mine" ? "My files" : "Family", "", !parts.length));
        parts.forEach((part, i) => {
            crumbs.append(icon("m9 5 7 7-7 7"), make(part, parts.slice(0, i + 1).join("/"), i === parts.length - 1));
        });
    }
    function drawLocation() {
        drawTabs(); drawCrumbs();
    }
    function draw() {
        list.replaceChildren();
        for (const entry of entries) {
            const folder = entry.type === "dir";
            const row = el("li", "files-tile");
            const main = button("files-name");
            const more = button("files-more", undefined, "M6 12a1 1 0 1 0-2 0 1 1 0 1 0 2 0m7 0a1 1 0 1 0-2 0 1 1 0 1 0 2 0m7 0a1 1 0 1 0-2 0 1 1 0 1 0 2 0");
            main.dataset.name = entry.name;
            main.title = entry.name;
            const art = el("span", folder ? "files-tile-icon files-folder-icon" : "files-tile-icon");
            art.append(icon(folder ? FOLDER : "M6 3h8l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2ZM14 3v5h5M9 12h6m-6 4h6"));
            const name = el("span", "files-label", entry.name);
            const meta = el("span", "files-meta", folder ? "Folder" : bytes(entry.size));
            const when = el("span", "", day.format(new Date(entry.modified * 1000)));
            meta.append(when);
            main.append(art, name, meta);
            main.setAttribute("aria-label", folder ? `Open folder ${entry.name}` : `Download ${entry.name}`);
            meta.id = `files-meta-${list.children.length}`;
            main.setAttribute("aria-describedby", meta.id);
            main.onclick = () => folder ? navigate(space, here(entry.name)) : download(entry, main);
            more.setAttribute("aria-label", `Actions for ${entry.name}`);
            more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
            more.onclick = () => openMenu(entry, more);
            row.append(main, more);
            list.append(row);
        }
    }
    function navigate(nextSpace, nextPath, focusTarget) {
        if (space !== nextSpace || path !== nextPath) {
            space = nextSpace; path = nextPath; navigation++;
            closeMenu();
            drawLocation();
            entries = [];
            list.replaceChildren();
            (focusTarget || currentCrumb()).focus();
            empty.hidden = true;
        }
        load({ focusTarget });
    }
    async function load({ focusName, focusTarget = currentCrumb(), notice = "" } = {}) {
        const request = ++listing;
        closeMenu(true);
        const previousFocus = document.activeElement;
        status.textContent = "Loading…";
        const r = await call("GET", `/api/files/list?space=${space}&path=${q(path)}`);
        if (life.signal.aborted || request !== listing) return;
        entries = r.ok ? r.body.entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir")) : [];
        status.textContent = r.ok ? notice : [r.error, notice].filter(Boolean).join(" ");
        const isEmpty = r.ok && !entries.length;
        const focused = document.activeElement;
        const focusedRow = focused.closest(".files-tile");
        const moveFocus = focusTarget && !sheet && focused === previousFocus;
        const restoreRow = !moveFocus && focusedRow;
        if (restoreRow) focusName = focusedRow.querySelector(".files-name").dataset.name;
        closeMenu();
        draw();
        if (moveFocus || focusedRow) {
            const rowButton = focusName && list.querySelector(`.files-name[data-name="${CSS.escape(focusName)}"]`);
            const action = restoreRow && !focused.matches(".files-name") && rowButton?.parentElement.querySelector(".files-more");
            (action || rowButton || focusTarget || currentCrumb()).focus();
        }
        if (!isEmpty && document.activeElement === emptyUpload) upload.focus();
        empty.hidden = !isEmpty;
        emptyText.textContent = isEmpty ? "This folder is empty." : "";
    }

    list.addEventListener("keydown", (event) => {
        const tile = event.target.closest(".files-tile");
        if (!tile || menu?.node.contains(event.target)) return;
        const columns = getComputedStyle(list).gridTemplateColumns.split(" ").length;
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
        const offset = offsets[event.key];
        if (!offset) return;
        event.preventDefault();
        const index = Array.prototype.indexOf.call(list.children, tile);
        const next = list.children[index + offset];
        next?.querySelector(event.target.matches(".files-more") ? ".files-more" : ".files-name").focus();
    });

    // ---- one actions menu per tile ----
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
        node.setAttribute("aria-label", opener.getAttribute("aria-label"));
        const item = (label, run) => {
            const b = button("files-item", label);
            b.setAttribute("role", "menuitem");
            b.tabIndex = -1;
            b.onclick = () => { closeMenu(true); run(); };
            node.append(b);
        };
        if (entry.type === "file") { item("Download", () => download(entry, opener)); item("Share link", () => shareSheet(entry, opener)); }
        item("Rename", () => nameSheet("Rename", entry.name, "Rename", (value) => call("POST", "/api/files/rename", { space, path: here(entry.name), name: value }), opener));
        item("Delete", () => deleteSheet(entry, opener));
        opener.parentElement.append(node);
        opener.setAttribute("aria-expanded", "true");
        menu = { node, opener };
        const bounds = node.getBoundingClientRect();
        if (bounds.bottom > window.innerHeight && opener.getBoundingClientRect().top > bounds.height + 8) {
            node.classList.add("files-menu-above");
        }
        node.querySelector("button").focus();
        node.onkeydown = (event) => {
            const items = [...node.querySelectorAll("button")], at = items.indexOf(document.activeElement);
            if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length].focus(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
            else if (event.key === "Home" || event.key === "End") { event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1].focus(); }
            else if (event.key === "Tab") closeMenu(true);
        };
    }
    document.addEventListener("pointerdown", (event) => {
        if (menu && !menu.node.contains(event.target) && event.target !== menu.opener) closeMenu(true);
    }, { signal: life.signal });

    // ---- sheets: one named close control, Escape closes, focus returns to the opener ----
    function openSheet(heading, opener) {
        closeSheet();
        const card = el("dialog", "popup-panel popup-centered files-sheet");
        card.setAttribute("aria-label", heading);
        const head = el("div", "dialog-heading"), h = el("h2", "", heading);
        const close = button("files-close", undefined, "m5 5 14 14M19 5 5 19");
        close.setAttribute("aria-label", `Close ${heading.toLowerCase()}`);
        close.onclick = () => closeSheet(true);
        head.append(h, close);
        const body = el("div", "files-sheet-body");
        card.append(head, body);
        card.oncancel = (event) => { event.preventDefault(); closeSheet(true); };
        card.onclick = (event) => {
            if (event.target !== card) return;
            const { left, right, top, bottom } = card.getBoundingClientRect();
            if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) closeSheet(true);
        };
        root.append(card);
        sheet = { card, opener };
        card.showModal();
        return { body, card, close };
    }
    function closeSheet(restore) {
        if (!sheet) return;
        const { card, opener } = sheet;
        sheet = null;
        card.close();
        card.remove();
        if (restore) (opener?.isConnected ? opener : currentCrumb()).focus();
    }
    const field = (label, input) => {
        const l = el("label", "files-field");
        input.setAttribute("autocomplete", "off");
        l.append(el("span", "", label), input);
        return l;
    };
    const message = () => { const p = el("p", "files-error"); p.setAttribute("role", "alert"); return p; };

    function submitForm(body, input, label, validate, run) {
        const form = el("form", "files-sheet-body");
        const error = message(), go = button("files-primary", label);
        go.type = "submit";
        error.id = "files-field-error";
        input.setAttribute("aria-describedby", error.id);
        let pending = false;
        const update = (showError) => {
            const prompt = validate();
            go.disabled = Boolean(prompt);
            error.textContent = showError ? prompt : "";
            input.setAttribute("aria-invalid", String(Boolean(error.textContent)));
        };
        input.oninput = () => update(true);
        update(false);
        form.onsubmit = async (event) => {
            event.preventDefault();
            if (pending || go.disabled) return;
            pending = true;
            go.setAttribute("aria-disabled", "true");
            error.textContent = "";
            input.setAttribute("aria-invalid", "false");
            const failure = await run();
            pending = false;
            go.removeAttribute("aria-disabled");
            if (failure && form.isConnected) {
                error.textContent = failure;
                input.setAttribute("aria-invalid", "true");
                input.focus();
            }
        };
        body.append(form);
        return { form, error, go };
    }

    function nameSheet(heading, value, verb, run, opener) {
        const { body, card } = openSheet(heading, opener);
        const input = el("input"); input.type = "text"; input.value = value; input.maxLength = 120;
        const validate = () => {
            const name = input.value.trim();
            if (!name) return "Enter a name.";
            if (name.startsWith(".")) return "Start the name with a character other than a dot.";
            if (/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name)) return 'Remove / \\ : * ? " < > | and any control characters from the name.';
            return "";
        };
        const { form, error, go } = submitForm(body, input, verb, validate, async () => {
            const location = navigation;
            const name = input.value.trim();
            const r = await run(name);
            if (life.signal.aborted || location !== navigation) return;
            if (!r.ok) return r.error;
            const ownsFocus = card.open;
            if (ownsFocus) closeSheet(true);
            await load({ focusName: r.body?.name ?? name, focusTarget: ownsFocus ? currentCrumb() : null });
        });
        form.append(field("Name", input), error, go);
        input.focus(); input.select();
    }
    newFolder.onclick = () => nameSheet("New folder", "", "Create folder", (value) => call("POST", "/api/files/folder", { space, path, name: value }), newFolder);

    function deleteSheet(entry, opener, recursive = false) {
        const folder = entry.type === "dir";
        const { body, card } = openSheet(recursive ? "Delete everything inside" : folder ? "Delete folder" : "Delete file", opener);
        body.append(el("p", "", recursive ? `“${entry.name}” and everything inside it will be deleted for good.` : `“${entry.name}” will be deleted for good.${entry.type === "file" ? " Links to it stop working." : ""}`));
        const error = message(), go = el("button", "files-danger", "Delete"); go.type = "button";
        const keep = el("button", "files-quiet", "Keep it"); keep.type = "button"; keep.onclick = () => closeSheet(true);
        go.onclick = async () => {
            const location = navigation;
            if (go.hasAttribute("aria-disabled")) return;
            go.setAttribute("aria-disabled", "true");
            const r = await call("DELETE", `/api/files?space=${space}&path=${q(here(entry.name))}${recursive ? "&recursive=true" : ""}`);
            go.removeAttribute("aria-disabled");
            if (life.signal.aborted || location !== navigation) return;
            if (!r.ok && card.open && folder && !recursive && /not empty/i.test(r.error)) { closeSheet(true); deleteSheet(entry, opener, true); return; }
            if (!r.ok) { error.textContent = r.error; return; }
            // The deleted row's neighbour gets focus, so keyboard focus never falls to the page.
            const at = entries.findIndex((e) => e.name === entry.name);
            const next = entries[at + 1] ?? entries[at - 1];
            const ownsFocus = card.open;
            if (ownsFocus) closeSheet(true);
            await load({ focusName: next?.name, focusTarget: ownsFocus ? currentCrumb() : null, notice: `Deleted ${entry.name}.` });
        };
        body.append(error, el("div", "files-buttons"));
        body.lastChild.append(keep, go);
        keep.focus();
    }

    // ---- download and upload run in .NET (file system, picker) ----
    async function download(entry, opener) {
        const location = navigation;
        const previousFocus = document.activeElement;
        status.textContent = `Downloading ${entry.name}…`;
        let result;
        try { result = await app.invokeMethodAsync("FilesDownload", space, here(entry.name), entry.name); }
        catch { result = `Could not download ${entry.name}. Try again.`; }
        if (life.signal.aborted || location !== navigation) return;
        status.textContent = result;
        if (opener.isConnected && document.activeElement === previousFocus) opener.focus();
    }
    upload.onclick = emptyUpload.onclick = async (event) => {
        if (busy) return;
        const opener = event.currentTarget;
        opener.focus();
        const uploadSpace = space, uploadPath = path;
        busy = true;
        for (const control of [upload, emptyUpload]) control.setAttribute("aria-disabled", "true");
        uploadNavigation = navigation;
        let result;
        try { result = JSON.parse(await app.invokeMethodAsync("FilesUpload", uploadSpace, uploadPath)); }
        catch { result = { uploaded: [], errors: ["The upload did not finish. Try again."] }; }
        busy = false;
        for (const control of [upload, emptyUpload]) control.removeAttribute("aria-disabled");
        progress.hidden = true;
        if (life.signal.aborted || uploadSpace !== space || uploadPath !== path) return;
        const sameVisit = uploadNavigation === navigation;
        const parts = [];
        if (result.uploaded.length) parts.push(`${result.uploaded.length} ${result.uploaded.length === 1 ? "file" : "files"} uploaded.`);
        parts.push(...result.errors.map((error) => errorText(error, "A file could not be uploaded. Try again.")));
        if (sameVisit && document.activeElement === document.body) opener.focus();
        await load({
            focusTarget: sameVisit && document.activeElement === opener ? opener : null,
            notice: sameVisit ? parts.join(" ") : ""
        });
    };
    function showProgress(name, sent, total) {
        const percent = total ? Math.min(100, Math.round(sent * 100 / total)) : 0;
        progress.hidden = false;
        progress.setAttribute("aria-valuenow", String(percent)); progress.setAttribute("aria-label", `Uploading ${name}`);
        progress.setAttribute("aria-valuetext", `${name}: ${percent} percent`);
        bar.style.width = percent + "%"; thumb.style.left = percent + "%";
        if (uploadNavigation === navigation) status.textContent = `Uploading ${name}: ${percent}%`;
    }

    // ---- share links ----
    function shareSheet(entry, opener) {
        const { body, card } = openSheet("Share link", opener);
        body.append(el("p", "", `Anyone with the link can download “${entry.name}” until it expires.`));
        const expiry = el("select");
        for (const [hours, label] of EXPIRY) { const o = el("option", "", label); o.value = String(hours); if (hours === 168) o.selected = true; expiry.append(o); }
        const password = el("input"); password.type = "password"; password.maxLength = 200;
        const once = el("input"); once.type = "checkbox";
        const onceLabel = el("label", "files-check"); onceLabel.append(once, el("span", "", "One-off: works for a single download"));
        const result = el("div", "files-result"); result.hidden = true;
        const validate = () => password.value && password.value.length < 4 ? "The password needs at least 4 characters." : "";
        const { form, error, go } = submitForm(body, password, "Create link", validate, async () => {
            const r = await call("POST", "/api/files/links", { space, path: here(entry.name), expires_hours: Number(expiry.value), password: password.value || undefined, max_downloads: once.checked ? 1 : undefined });
            if (!card.open) return;
            if (!r.ok) return r.error;
            const url = r.body.url.startsWith("http") ? r.body.url : viewer.server.replace(/\/+$/, "") + r.body.url;
            result.hidden = false; result.replaceChildren();
            const address = el("input"); address.type = "text"; address.readOnly = true; address.value = url; address.autocomplete = "off"; address.setAttribute("aria-label", "Link address");
            const copy = el("button", "files-primary", "Copy link"); copy.type = "button";
            copy.onclick = async () => { const ok = await app.invokeMethodAsync("FilesCopy", url).catch(() => false); message2.textContent = ok ? "Copied." : "Select the link and copy it."; };
            const send = el("button", "files-quiet", "Share…"); send.type = "button";
            send.onclick = () => app.invokeMethodAsync("FilesShare", url).catch(() => {});
            const message2 = el("p", "files-note"); message2.setAttribute("role", "status");
            const when = el("p", "files-note", `Works until ${stamp.format(new Date(r.body.expires * 1000))}. This is the only time the address is shown; make a new link if you lose it.`);
            result.append(field("Link address", address), el("div", "files-buttons"), message2, when);
            result.children[1].append(copy, send);
            form.hidden = true; address.focus(); address.select();
        });
        form.append(field("Link works for", expiry), field("Password (optional)", password), error, onceLabel, go);
        body.append(result);
        expiry.focus();
    }
    linksButton.onclick = async () => {
        const { body, card, close } = openSheet("Your links", linksButton);
        const note = el("p", "files-note", "Loading…");
        note.setAttribute("role", "status");
        body.append(note);
        const r = await call("GET", "/api/files/links");
        if (!card.open) return;
        if (!r.ok) { note.textContent = r.error; return; }
        note.textContent = r.body.links.length ? "The link address is available when you create it." : "You have not made any links yet.";
        const ul = el("ul", "files-links");
        for (const link of r.body.links) {
            const li = el("li", "files-link");
            const details = el("div", "files-link-details");
            const expiration = el("span", "", `${link.name} · ${link.active ? "works until " + stamp.format(new Date(link.expires * 1000)) : "no longer works"}`);
            const count = el("span", "files-chip", `${link.downloads}${link.max_downloads ? " of " + link.max_downloads : ""} ${link.downloads === 1 ? "download" : "downloads"}`);
            details.append(expiration, count);
            if (link.protected) details.append(el("span", "files-chip", "Password"));
            li.append(details);
            if (link.active) {
                const revoke = el("button", "files-quiet", "Revoke"); revoke.type = "button"; revoke.setAttribute("aria-label", `Revoke link to ${link.name}`);
                revoke.onclick = async () => {
                    if (revoke.hasAttribute("aria-disabled")) return;
                    revoke.setAttribute("aria-disabled", "true");
                    const done = await call("DELETE", `/api/files/links/${link.id}`);
                    if (!card.open) return;
                    if (!done.ok) { revoke.removeAttribute("aria-disabled"); note.textContent = done.error; return; }
                    const hadFocus = document.activeElement === revoke;
                    expiration.textContent = `${link.name} · no longer works`;
                    revoke.remove();
                    note.textContent = `Revoked the link to ${link.name}.`;
                    if (hadFocus || document.activeElement === document.body) (ul.querySelector(".files-quiet:not([aria-disabled])") ?? close).focus();
                };
                li.append(revoke);
            }
            ul.append(li);
        }
        body.append(ul);
    };

    tabs.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const keys = Object.keys(tabButtons), next = keys[(keys.indexOf(space) + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length];
        navigate(next, "", tabButtons[next]);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && menu && !sheet) {
            event.stopPropagation();
            closeMenu(true);
        }
    }, { signal: life.signal });

    drawLocation();
    load();
    return {
        progress: showProgress,
        close() { life.abort(); closeMenu(); closeSheet(); root.remove(); }
    };
}
