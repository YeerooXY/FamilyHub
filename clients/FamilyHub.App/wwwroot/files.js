// Files: the family's shared folder and each profile's private folder, with share links.
// This module owns the screen. The .NET side owns the network, the file picker and the clipboard: it answers
// `FilesCall` (JSON endpoints), `FilesUpload`, `FilesDownload`, `FilesCopy` and `FilesShare`.

import { createServiceStatus } from "./service-status.js";

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
const SEARCH = "m21 21-4.3-4.3M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z";
const GRID = "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z";
const ROWS = "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01";
const DOWNLOAD = "M12 3v13m-5-5 5 5 5-5M4 20h16";
const SHARE = "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13";
const TRASH = "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3";
const CLOSE = "m5 5 14 14M19 5 5 19";
const CHECK = "m5 12 5 5L20 7";
const BACK = "m15 5-7 7 7 7";
const FORWARD = "m9 5 7 7-7 7";
const FILE = "M6 3h8l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2ZM14 3v5h5M9 12h6m-6 4h6";
// Each kind has its own colour and icon, drawn by CSS and SVG, so a shelf of files never shows one shared stock image.
const KINDS = {
    image: { ext: "jpg jpeg png gif webp bmp avif", icon: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01" },
    video: { ext: "mp4 mov m4v mkv webm avi", icon: "M4 6h11v12H4zM15 10l5-3v10l-5-3" },
    audio: { ext: "mp3 m4a flac wav ogg opus aac", icon: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0m11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0" },
    pdf: { ext: "pdf", icon: FILE },
    sheet: { ext: "xls xlsx csv ods numbers", icon: "M5 4h14v16H5zM5 10h14M5 15h14M11 4v16" },
    archive: { ext: "zip rar 7z tar gz", icon: "M6 3h12v18H6zM12 3v4m0 2v2m0 2v2" },
    text: { ext: "txt md json log xml yml yaml ini", icon: FILE },
    doc: { ext: "doc docx odt rtf ppt pptx odp pages key", icon: FILE },
};
const TEXT_PREVIEW = new Set("txt md json log xml yml yaml ini csv".split(" "));
const kindOf = (name) => {
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const kind = Object.keys(KINDS).find((key) => KINDS[key].ext.split(" ").includes(ext));
    return { key: kind ?? "file", icon: kind ? KINDS[kind].icon : FILE, ext };
};
const previewKind = (name) => {
    const { key, ext } = kindOf(name);
    return key === "image" ? "image" : TEXT_PREVIEW.has(ext) ? "text" : "";
};
const PREVIEW_LIMIT = { image: 25 * 1024 * 1024, text: 512 * 1024 };
const THUMB_LIMIT = 10 * 1024 * 1024;
const SORTS = [["newest", "Newest first"], ["oldest", "Oldest first"], ["name", "Name A to Z"], ["size", "Largest first"]];
const SORT_BY = {
    newest: (a, b) => b.modified - a.modified,
    oldest: (a, b) => a.modified - b.modified,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    size: (a, b) => b.size - a.size,
};
const VIEW_KEY = "familyhub.files.view";

function blobFromDataUrl(url) {
    const comma = url.indexOf(",");
    const mime = url.slice(5, url.indexOf(";"));
    const binary = atob(url.slice(comma + 1));
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return new Blob([data], { type: mime });
}

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
    let navigation = 0, listing = 0, uploadNavigation, tileCount = 0;
    const selected = new Set();
    const thumbnails = new Map();
    const waiting = [];
    let running = 0, drawing = 0, seen = null;
    let view = "grid";
    try { view = localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { /* storage can be unavailable */ }

    const root = el("div", "files");
    host.replaceChildren(root);

    // The server answers every JSON call as {status, body}. Error text comes from the server, so say it as it is.
    async function call(method, url, json) {
        let reply;
        try { reply = JSON.parse(await app.invokeMethodAsync("FilesCall", method, url, json === undefined ? null : JSON.stringify(json))); }
        catch { return { ok: false, unavailable: true, error: "The server did not answer. Check the connection and try again." }; }
        let body = null;
        try { body = reply.body ? JSON.parse(reply.body) : null; } catch { /* a non-JSON body */ }
        if (reply.status >= 200 && reply.status < 300) return { ok: true, body };
        return { ok: false, unavailable: reply.status === 0 || reply.status >= 500, error: errorText(body?.error) };
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
    const finder = el("div", "files-finder");
    const tools = el("div", "files-tools");
    const searchBox = el("label", "files-search");
    const search = el("input");
    search.type = "search"; search.placeholder = "Search this folder"; search.autocomplete = "off"; search.enterKeyHint = "search";
    search.setAttribute("aria-label", "Search this folder");
    searchBox.append(icon(SEARCH), search);
    const sort = el("select", "files-sort");
    sort.setAttribute("aria-label", "Sort files");
    for (const [value, label] of SORTS) { const o = el("option", "", label); o.value = value; sort.append(o); }
    const views = el("div", "files-views");
    views.setAttribute("role", "group"); views.setAttribute("aria-label", "View");
    const viewButtons = {};
    for (const [key, label, shape] of [["grid", "Grid view", GRID], ["list", "List view", ROWS]]) {
        const b = button("files-view", undefined, shape);
        b.setAttribute("aria-label", label); b.title = label; b.dataset.view = key;
        viewButtons[key] = b; views.append(b);
    }
    tools.append(searchBox, sort, views);
    finder.append(crumbs, tools);
    const status = el("p", "files-status"); status.setAttribute("role", "status");
    const outage = createServiceStatus({
        detail: "Reconnect to load this folder.", label: "Retry folder listing", retry: () => load(),
        focus: () => currentCrumb() || tabButtons[space], automatic: true, fullSection: true
    });
    const progress = el("div", "files-progress"); progress.hidden = true;
    progress.setAttribute("role", "progressbar"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
    const bar = el("span", "files-progress-fill"), thumb = el("span", "files-progress-thumb");
    progress.append(bar, thumb);
    const noMatch = el("p", "files-note");
    noMatch.setAttribute("role", "status");
    const folderHeading = el("h2", "files-heading", "Folders");
    const folders = el("ul", "files-folders");
    folders.setAttribute("aria-label", "Folders");
    const fileHeading = el("h2", "files-heading", "Files");
    const list = el("ul", "files-list");
    list.setAttribute("aria-label", "Files");
    const selbar = el("div", "files-selbar");
    selbar.setAttribute("role", "region"); selbar.setAttribute("aria-label", "Selected files"); selbar.hidden = true;
    const selCount = el("span", "files-count");
    selCount.setAttribute("role", "status");
    const selDownload = button("files-quiet files-icon-button", undefined, DOWNLOAD);
    selDownload.setAttribute("aria-label", "Download selected files"); selDownload.title = "Download";
    const selShare = button("files-quiet", "Share link", SHARE);
    const selDelete = button("files-quiet", "Delete", TRASH);
    const selClear = button("files-quiet files-icon-button", undefined, CLOSE);
    selClear.setAttribute("aria-label", "Clear selection"); selClear.title = "Clear selection";
    selbar.append(selCount, selDownload, selShare, selDelete, selClear);
    const empty = el("div", "files-empty");
    empty.hidden = true;
    const illustration = el("div", "files-empty-art");
    illustration.append(icon(FOLDER));
    const emptyText = el("p");
    emptyText.setAttribute("role", "status");
    const emptyUpload = button("files-primary", "Upload to this folder", UPLOAD);
    empty.append(illustration, emptyText, emptyUpload);
    root.append(toolbar, finder, status, outage.card, progress, noMatch, folderHeading, folders, fileHeading, list, empty, selbar);
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
    // Folders first by name, then files in the chosen order. The search box filters this folder only.
    function shown() {
        const needle = search.value.trim().toLocaleLowerCase();
        const matches = needle ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)) : entries;
        return {
            dirs: matches.filter((entry) => entry.type === "dir").sort(SORT_BY.name),
            files: matches.filter((entry) => entry.type !== "dir").sort(SORT_BY[sort.value]),
            needle,
        };
    }
    function tile(entry) {
        const folder = entry.type === "dir";
        const kind = kindOf(entry.name);
        const row = el("li", folder ? "files-tile files-folder-tile" : `files-tile files-kind-${kind.key}`);
        const main = button("files-name");
        const more = button("files-more", undefined, "M6 12a1 1 0 1 0-2 0 1 1 0 1 0 2 0m7 0a1 1 0 1 0-2 0 1 1 0 1 0 2 0m7 0a1 1 0 1 0-2 0 1 1 0 1 0 2 0");
        main.dataset.name = entry.name;
        main.title = entry.name;
        const art = el("span", folder ? "files-thumb files-folder-icon" : "files-thumb");
        art.append(icon(folder ? FOLDER : kind.icon));
        const name = el("span", "files-label", entry.name);
        const meta = el("span", "files-meta", folder ? "Folder" : bytes(entry.size));
        meta.append(el("span", "", day.format(new Date(entry.modified * 1000))));
        main.append(art, name, meta);
        const preview = !folder && previewKind(entry.name) && entry.size <= PREVIEW_LIMIT[previewKind(entry.name)];
        main.setAttribute("aria-label", folder ? `Open folder ${entry.name}` : preview ? `Preview ${entry.name}` : `Download ${entry.name}`);
        meta.id = `files-meta-${tileCount++}`;
        main.setAttribute("aria-describedby", meta.id);
        main.onclick = () => folder ? navigate(space, here(entry.name)) : preview ? openPreview(entry, main) : download(entry, main);
        more.setAttribute("aria-label", `Actions for ${entry.name}`);
        more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
        more.onclick = () => openMenu(entry, more);
        row.append(main);
        if (!folder) {
            const pick = el("button", "files-pick");
            pick.type = "button"; pick.setAttribute("role", "checkbox");
            pick.setAttribute("aria-label", `Select ${entry.name}`);
            pick.append(el("span", "files-pick-box"));
            pick.firstChild.append(icon(CHECK));
            pick.onclick = () => toggle(entry.name);
            row.append(pick);
            row.classList.toggle("is-selected", selected.has(entry.name));
            pick.setAttribute("aria-checked", String(selected.has(entry.name)));
            if (kind.key === "image" && entry.size <= THUMB_LIMIT) { row.dataset.thumb = "1"; seen?.observe(row); }
        }
        row.append(more);
        row.entry = entry;
        return row;
    }
    function draw() {
        const token = ++drawing;
        seen?.disconnect();
        waiting.length = 0;
        seen = "IntersectionObserver" in window ? new IntersectionObserver((hits) => {
            for (const hit of hits) if (hit.isIntersecting) { seen.unobserve(hit.target); thumbnail(hit.target, token); }
        }, { rootMargin: "240px" }) : null;
        const { dirs, files, needle } = shown();
        folders.replaceChildren(...dirs.map(tile));
        list.replaceChildren(...files.map(tile));
        folderHeading.hidden = !dirs.length;
        fileHeading.hidden = !files.length || !dirs.length;
        root.classList.toggle("files-as-list", view === "list");
        for (const [key, b] of Object.entries(viewButtons)) b.setAttribute("aria-pressed", String(key === view));
        for (const name of [...selected]) if (!entries.some((entry) => entry.name === name)) selected.delete(name);
        drawSelection();
        return { needle, found: dirs.length + files.length };
    }

    // ---- thumbnails: the .NET side fetches the bytes with the signed-in session; small copies are cached per file ----
    function pump() {
        while (running < 2 && waiting.length) {
            const job = waiting.shift();
            running++;
            job().catch(() => {}).finally(() => { running--; pump(); });
        }
    }
    async function readFile(entry, limit) {
        const url = await app.invokeMethodAsync("FilesRead", space, here(entry.name), limit).catch(() => "");
        return url ? blobFromDataUrl(url) : null;
    }
    function thumbnail(node, token) {
        const entry = node.entry;
        const key = `${space}/${here(entry.name)}/${entry.modified}`;
        const place = (url) => {
            if (!url || token !== drawing || !node.isConnected) return;
            const image = el("img", "files-photo");
            image.alt = ""; image.decoding = "async"; image.src = url;
            image.onerror = () => image.remove();
            node.querySelector(".files-thumb").prepend(image);
            node.classList.add("has-photo");
        };
        if (thumbnails.has(key)) { place(thumbnails.get(key)); return; }
        waiting.push(async () => {
            if (token !== drawing) return;
            const blob = await readFile(entry, THUMB_LIMIT);
            if (!blob) return;
            let url = "";
            try {
                const bitmap = await createImageBitmap(blob);
                const scale = Math.min(1, 360 / bitmap.width);
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                bitmap.close?.();
                const small = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
                if (small) url = URL.createObjectURL(small);
            } catch { /* a format this device cannot decode keeps its type tile */ }
            if (url) thumbnails.set(key, url);
            place(url);
        });
        pump();
    }

    // ---- selection ----
    function toggle(name) {
        if (!selected.delete(name)) selected.add(name);
        const row = list.querySelector(`.files-name[data-name="${CSS.escape(name)}"]`)?.parentElement;
        row?.classList.toggle("is-selected", selected.has(name));
        row?.querySelector(".files-pick")?.setAttribute("aria-checked", String(selected.has(name)));
        drawSelection();
    }
    function drawSelection() {
        const count = selected.size;
        selbar.hidden = !count;
        root.classList.toggle("has-selection", count > 0);
        selCount.textContent = count ? `${count} selected` : "";
        selShare.hidden = count !== 1;
    }
    const selectedEntries = () => entries.filter((entry) => selected.has(entry.name));
    function clearSelection(focusBack) {
        const first = [...selected][0];
        selected.clear();
        redraw();
        if (focusBack) (list.querySelector(`.files-name[data-name="${CSS.escape(first ?? "")}"]`) ?? search).focus();
    }
    // The search result message is announced once per pause in typing, never per key.
    function redraw() {
        const { needle, found } = draw();
        noMatch.textContent = needle && !found && entries.length ? `Nothing in this folder matches “${search.value.trim()}”.` : "";
    }
    let typing = 0;
    search.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(redraw, 250); });
    search.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); clearTimeout(typing); redraw(); search.blur(); } });
    sort.addEventListener("change", redraw);
    for (const [key, b] of Object.entries(viewButtons)) {
        b.onclick = () => {
            view = key;
            try { localStorage.setItem(VIEW_KEY, key); } catch { /* storage can be unavailable */ }
            redraw();
        };
    }
    selDownload.onclick = async () => {
        for (const entry of selectedEntries()) await download(entry, selDownload);
    };
    selShare.onclick = () => { const [entry] = selectedEntries(); if (entry) shareSheet(entry, selShare); };
    selDelete.onclick = () => deleteMany(selectedEntries(), selDelete);
    selClear.onclick = () => clearSelection(true);
    function navigate(nextSpace, nextPath, focusTarget) {
        if (space !== nextSpace || path !== nextPath) {
            space = nextSpace; path = nextPath; navigation++;
            closeMenu();
            drawLocation();
            entries = [];
            selected.clear(); search.value = ""; noMatch.textContent = "";
            list.replaceChildren(); folders.replaceChildren();
            folderHeading.hidden = fileHeading.hidden = true;
            drawSelection();
            (focusTarget || currentCrumb()).focus();
            outage.clear();
            empty.hidden = true;
        }
        load({ focusTarget });
    }
    async function load({ focusName, focusTarget = currentCrumb(), notice = "" } = {}) {
        const request = ++listing;
        closeMenu(true);
        const previousFocus = document.activeElement;
        if (outage.card.hidden) status.textContent = "Loading…";
        const r = await call("GET", `/api/files/list?space=${space}&path=${q(path)}`);
        if (life.signal.aborted || request !== listing) return;
        if (r.unavailable) {
            status.textContent = notice;
            outage.show();
            return;
        }
        outage.clear();
        entries = r.ok ? r.body.entries : [];
        status.textContent = r.ok ? notice : [r.error, notice].filter(Boolean).join(" ");
        const isEmpty = r.ok && !entries.length;
        const focused = document.activeElement;
        const focusedRow = focused.closest(".files-tile");
        const moveFocus = focusTarget && !sheet && focused === previousFocus;
        const restoreRow = !moveFocus && focusedRow;
        if (restoreRow) focusName = focusedRow.querySelector(".files-name").dataset.name;
        closeMenu();
        redraw();
        if (moveFocus || focusedRow) {
            const rowButton = focusName && root.querySelector(`.files-name[data-name="${CSS.escape(focusName)}"]`);
            const action = restoreRow && !focused.matches(".files-name") && rowButton?.parentElement.querySelector(".files-more");
            (action || rowButton || focusTarget || currentCrumb()).focus();
        }
        if (!isEmpty && document.activeElement === emptyUpload) upload.focus();
        empty.hidden = !isEmpty;
        emptyText.textContent = isEmpty ? "This folder is empty." : "";
    }

    // Arrow keys move between tiles; Up and Down step by one row of the visible grid, and the list continues into the folders.
    function arrows(event) {
        const tile = event.target.closest(".files-tile");
        if (!tile || menu?.node.contains(event.target)) return;
        const siblings = [...tile.parentElement.children];
        const columns = view === "list" ? 1 : getComputedStyle(tile.parentElement).gridTemplateColumns.split(" ").length;
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        if (!offset) return;
        event.preventDefault();
        const index = siblings.indexOf(tile);
        let next = siblings[index + offset];
        if (!next && offset > 0 && tile.parentElement === folders) next = list.children[0];
        if (!next && offset < 0 && tile.parentElement === list) next = folders.lastElementChild;
        const part = event.target.matches(".files-more") ? ".files-more" : event.target.matches(".files-pick") ? ".files-pick" : ".files-name";
        (next?.querySelector(part) ?? next?.querySelector(".files-name"))?.focus();
    }
    folders.addEventListener("keydown", arrows);
    list.addEventListener("keydown", arrows);

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

    // Deleting a selection asks once, then removes the files one by one and reports any that stayed.
    function deleteMany(chosen, opener) {
        if (!chosen.length) return;
        if (chosen.length === 1) { deleteSheet(chosen[0], opener); return; }
        const { body, card } = openSheet(`Delete ${chosen.length} files`, opener);
        body.append(el("p", "", `These ${chosen.length} files will be deleted for good. Links to them stop working.`));
        const error = message(), go = el("button", "files-danger", "Delete"); go.type = "button";
        const keep = el("button", "files-quiet", "Keep them"); keep.type = "button"; keep.onclick = () => closeSheet(true);
        go.onclick = async () => {
            const location = navigation;
            if (go.hasAttribute("aria-disabled")) return;
            go.setAttribute("aria-disabled", "true");
            const failed = [];
            for (const entry of chosen) {
                const r = await call("DELETE", `/api/files?space=${space}&path=${q(here(entry.name))}`);
                if (!r.ok) failed.push(`${entry.name}: ${r.error}`);
                else selected.delete(entry.name);
            }
            go.removeAttribute("aria-disabled");
            if (life.signal.aborted || location !== navigation) return;
            const removed = chosen.length - failed.length;
            const notice = [removed ? `Deleted ${removed} ${removed === 1 ? "file" : "files"}.` : "", ...failed].filter(Boolean).join(" ");
            const ownsFocus = card.open;
            if (ownsFocus) closeSheet(true);
            const survivor = entries.find((entry) => !chosen.includes(entry) && entry.type === "file");
            await load({ focusName: survivor?.name, focusTarget: ownsFocus ? currentCrumb() : null, notice });
        };
        body.append(error, el("div", "files-buttons"));
        body.lastChild.append(keep, go);
        keep.focus();
    }

    // ---- in-app preview: pictures and plain text open here; every other type downloads ----
    async function openPreview(entry, opener) {
        const siblings = shown().files.filter((file) => previewKind(file.name) && file.size <= PREVIEW_LIMIT[previewKind(file.name)]);
        let at = Math.max(0, siblings.findIndex((file) => file.name === entry.name));
        const { body, card, close } = openSheet(entry.name, opener);
        card.classList.add("files-preview");
        close.setAttribute("aria-label", "Close preview");
        const stage = el("div", "files-stage"), caption = el("p", "files-note");
        stage.setAttribute("role", "img");
        caption.setAttribute("role", "status");
        const previous = button("files-quiet files-icon-button", undefined, BACK), next = button("files-quiet files-icon-button", undefined, FORWARD);
        previous.setAttribute("aria-label", "Previous file"); next.setAttribute("aria-label", "Next file");
        const save = button("files-primary", "Download", DOWNLOAD), share = button("files-quiet", "Share link", SHARE);
        const controls = el("div", "files-preview-actions");
        controls.append(previous, next, el("span", "files-grow"), save, share);
        body.append(stage, caption, controls);
        let urls = [], request = 0;
        const clear = () => { for (const url of urls) URL.revokeObjectURL(url); urls = []; };
        const observer = new MutationObserver(() => { if (!card.isConnected) { clear(); observer.disconnect(); } });
        observer.observe(root, { childList: true });
        async function show() {
            const file = siblings[at] ?? entry, mine = ++request, kind = previewKind(file.name);
            card.setAttribute("aria-label", file.name);
            card.querySelector("h2").textContent = file.name;
            stage.setAttribute("aria-label", file.name);
            stage.replaceChildren(el("p", "files-note", "Loading preview…"));
            caption.textContent = `${bytes(file.size)}, ${day.format(new Date(file.modified * 1000))}${siblings.length > 1 ? `, ${at + 1} of ${siblings.length}` : ""}`;
            previous.setAttribute("aria-disabled", String(at === 0)); next.setAttribute("aria-disabled", String(at >= siblings.length - 1));
            save.onclick = () => download(file, save);
            share.onclick = () => shareSheet(file, share);
            const blob = await readFile(file, PREVIEW_LIMIT[kind]);
            if (mine !== request || !card.isConnected) return;
            clear();
            if (!blob) { stage.replaceChildren(el("p", "files-error", "This file could not be opened here. Download it instead.")); return; }
            if (kind === "image") {
                const url = URL.createObjectURL(blob); urls.push(url);
                const image = el("img", "files-large"); image.alt = file.name; image.src = url;
                image.onerror = () => stage.replaceChildren(el("p", "files-error", "This picture format cannot be shown here. Download it instead."));
                stage.removeAttribute("role"); stage.replaceChildren(image);
            } else {
                const text = await blob.text();
                const pre = el("pre", "files-text", text);
                pre.tabIndex = 0; pre.setAttribute("aria-label", `Contents of ${file.name}`);
                stage.removeAttribute("role"); stage.replaceChildren(pre);
            }
        }
        const step = (by) => {
            const target = at + by;
            if (target < 0 || target >= siblings.length) return;
            at = target; show();
        };
        previous.onclick = () => step(-1); next.onclick = () => step(1);
        card.addEventListener("keydown", (event) => {
            if (event.target.matches("input, select, textarea")) return;
            if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
            else if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
        });
        save.focus();
        await show();
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
        const unavailable = createServiceStatus({
            detail: "Reconnect to load your share links.", label: "Retry share links",
            retry: loadLinks, focus: () => close, automatic: true
        });
        body.append(unavailable.card);
        async function loadLinks() {
            const r = await call("GET", "/api/files/links");
            if (!card.open) return;
            if (r.unavailable) {
                note.textContent = "";
                unavailable.show();
                return;
            }
            unavailable.clear();
            if (!r.ok) { note.textContent = r.error; return; }
            note.textContent = r.body.links.length ? "Copy the address when you create a link." : "You have not made any links yet.";
            const ul = el("ul", "files-links");
            for (const link of r.body.links) {
                const li = el("li", "files-link");
                const details = el("div", "files-link-details");
                const expiration = el("span", "", `${link.name}: ${link.active ? "works until " + stamp.format(new Date(link.expires * 1000)) : "no longer works"}`);
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
                        expiration.textContent = `${link.name}: no longer works`;
                        revoke.remove();
                        note.textContent = `Revoked the link to ${link.name}.`;
                        if (hadFocus || document.activeElement === document.body) (ul.querySelector(".files-quiet:not([aria-disabled])") ?? close).focus();
                    };
                    li.append(revoke);
                }
                ul.append(li);
            }
            body.append(ul);
        }
        await loadLinks();
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
        close() {
            life.abort(); closeMenu(); closeSheet(); seen?.disconnect(); waiting.length = 0;
            for (const url of thumbnails.values()) URL.revokeObjectURL(url);
            thumbnails.clear(); root.remove();
        }
    };
}
