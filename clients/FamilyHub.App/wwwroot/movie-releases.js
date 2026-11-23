const gib = 1024 ** 3;
// Download times assume this connection; the real speed depends on the server's line and on how many people share the file.
export const ASSUMED_MBPS = 100;
const FIRST_PAGE = 12;

function number(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolution(title) {
    const height = title.match(/\b(4320|2160|1440|1080|720|576|480)[pi]\b/i)?.[1];
    if (height) return Number(height);
    if (/\b8K\b/i.test(title)) return 4320;
    return /\b(?:4K|UHD)\b/i.test(title) ? 2160 : 0;
}

/** What the release holds when it is a series: one episode, a whole season, or several seasons. */
export function releaseKind(title) {
    if (/\bS\d{1,2}\s*[-–]\s*S?\d{1,2}\b/i.test(title) || /\b(?:complete|full)[ ._-]*(?:series|collection)\b/i.test(title)
        || /\bseasons?[ ._-]*\d+[ ._-]*(?:-|to|&)[ ._-]*\d+\b/i.test(title)) return "Complete series";
    const episode = title.match(/\bS(\d{1,2})[ ._-]*E(\d{1,3})\b/i) || title.match(/\b(\d{1,2})x(\d{2,3})\b/);
    if (episode) return `One episode · S${String(Number(episode[1])).padStart(2, "0")}E${String(Number(episode[2])).padStart(2, "0")}`;
    const season = title.match(/\bS(\d{1,2})\b/i) || title.match(/\bseason[ ._-]*(\d{1,2})\b/i);
    return season ? `Full season ${Number(season[1])}` : "";
}

/** A short quality label (4K, 1080p, ...) and the source it was made from, read from the release name. */
export function releaseQuality(title) {
    const height = resolution(title);
    const picture = height >= 2160 ? "4K" : height ? `${height}p` : "";
    const hdr = /\b(?:HDR10\+?|HDR|DV|Dolby[ ._-]?Vision)\b/i.test(title) ? "HDR" : "";
    let source = "";
    if (/\b(?:CAM|HDCAM|TS|HDTS|TELESYNC|TELECINE)\b/i.test(title)) source = "Camera copy";
    else if (/\bremux\b/i.test(title)) source = "Remux";
    else if (/\b(?:blu-?ray|bdrip|brrip)\b/i.test(title)) source = "Blu-ray";
    else if (/\b(?:web-?dl|webrip|web)\b/i.test(title)) source = "Web";
    else if (/\b(?:hdtv|pdtv|dvdrip)\b/i.test(title)) source = "TV or DVD";
    return { label: [picture, hdr].filter(Boolean).join(" · ") || "Quality unknown", source, poor: source === "Camera copy" || (height > 0 && height < 720) };
}

export function downloadTime(bytes, mbps = ASSUMED_MBPS) {
    if (!(bytes > 0) || !(mbps > 0)) return "";
    const minutes = Math.max(1, Math.round(bytes * 8 / (mbps * 1e6) / 60));
    return minutes < 60 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function health(seeders) {
    if (!seeders) return ["none", seeders === 0 ? "No seeders" : "Seeders unknown"];
    return [seeders >= 5 ? "good" : "low", `${seeders} ${seeders === 1 ? "seeder" : "seeders"}`];
}

export function buildReleaseSearch(search, signal, requestsEnabled) {
    const panel = document.createElement("section");
    panel.className = "movie-releases";
    panel.hidden = true;
    panel.innerHTML = `
        <p class="movie-source-note" role="status"></p>
        <button type="button" hidden>Retry release lookup</button>
        <details class="movie-source-details" hidden>
            <summary>Releases</summary>
            <p class="movie-web-meta" data-release-availability hidden>Your profile cannot request downloads, so this list is for reference.</p>
            <p class="movie-web-meta">Times assume a ${ASSUMED_MBPS} Mbps connection.</p>
            <ul class="movie-source-list" aria-label="Release results"></ul>
            <button type="button" class="movie-release-more" hidden>Show all releases</button>
        </details>`;
    const retry = panel.querySelector("button");
    const options = panel.querySelector("details");
    const summary = options.querySelector("summary");
    const more = panel.querySelector(".movie-release-more");
    options.querySelector("[data-release-availability]").hidden = !!requestsEnabled;
    const status = panel.querySelector('[role="status"]');
    const list = panel.querySelector("ul");
    let rows = [], unavailable = 0, busy = false, complete = false, showAll = false;

    function chip(className, text, level) {
        const node = document.createElement("span");
        node.className = className;
        node.textContent = text;
        if (level) node.dataset.level = level;
        return node;
    }

    function render() {
        if (busy || !complete) return;
        // Healthy 1080p and better first, then smaller pictures, then files nobody is sharing.
        const group = row => !row.seeders ? 2 : row.height >= 1080 && !row.quality.poor ? 0 : 1;
        const sorted = rows.slice().sort((a, b) => group(a) - group(b) || b.height - a.height || b.seeders - a.seeders || (a.size ?? 1e18) - (b.size ?? 1e18));
        const shown = showAll ? sorted : sorted.slice(0, FIRST_PAGE);
        list.replaceChildren(...shown.map((row, index) => {
            const item = document.createElement("li");
            item.className = "movie-release";
            const top = document.createElement("div");
            top.className = "movie-release-top";
            if (index === 0 && group(row) === 0 && row.seeders >= 5) top.append(chip("movie-release-pick", "Recommended"));
            top.append(chip("movie-release-quality", row.quality.label, row.quality.poor ? "poor" : ""));
            if (row.kind) top.append(chip("movie-release-kind", row.kind));
            const [level, seeding] = health(row.seeders);
            top.append(chip("movie-release-health", seeding, level));
            const name = document.createElement("strong");
            name.className = "movie-release-name";
            name.textContent = row.title;
            const facts = document.createElement("p");
            facts.className = "movie-release-facts";
            const parts = [row.size ? `${(row.size / gib).toFixed(1)} GB` : "Size unknown"];
            if (row.size && row.seeders) parts.push(`${downloadTime(row.size)} to download`);
            if (row.quality.source) parts.push(row.quality.source);
            facts.textContent = parts.join(" · ");
            item.append(top, name, facts);
            return item;
        }));
        more.hidden = showAll || sorted.length <= FIRST_PAGE;
        more.textContent = `Show all ${sorted.length} releases`;
        summary.textContent = sorted.length === 1 ? "1 release" : `${sorted.length} releases`;
    }

    more.addEventListener("click", () => {
        showAll = true;
        render();
        // Focus moves to the first newly shown release, so the button's removal never drops it to the page.
        const next = list.querySelector(`li:nth-child(${FIRST_PAGE + 1}) strong`);
        if (next) { next.tabIndex = -1; next.focus(); } else summary.focus();
    });
    async function load() {
        if (busy) return true;
        busy = true;
        retry.setAttribute("aria-disabled", "true");
        complete = false;
        showAll = false;
        if (!retry.hidden) status.textContent = "Checking releases…";
        let reply;
        try { reply = await search(); }
        catch { reply = { error: "Release search is unavailable. Try again." }; }
        if (signal.aborted || !panel.isConnected) return false;
        busy = false;
        retry.removeAttribute("aria-disabled");
        if (reply?.error || !Array.isArray(reply?.results)) {
            status.textContent = reply?.error || "Release search is unavailable. Try again.";
            panel.hidden = retry.hidden = false;
            return true;
        }
        const matches = new Map();
        for (const item of reply.results) {
            const row = { title: item.title, height: resolution(item.title), size: number(item.size),
                seeders: number(item.seeders), kind: releaseKind(item.title), quality: releaseQuality(item.title) };
            const key = `${row.title.toLowerCase()}\n${row.size}`;
            const previous = matches.get(key);
            if (!previous || (row.seeders ?? -1) > (previous.seeders ?? -1)) matches.set(key, row);
        }
        rows = [...matches.values()];
        unavailable = reply.unavailable;
        complete = true;
        const focused = document.activeElement === retry;
        status.textContent = unavailable ? `${unavailable} ${unavailable === 1 ? "source" : "sources"} did not answer.`
            : !rows.length && focused ? "No releases found." : "";
        options.hidden = !rows.length;
        panel.hidden = !rows.length && !unavailable && !focused;
        if (focused) {
            const target = rows.length ? summary : status;
            if (target === status) status.tabIndex = -1;
            target.focus();
        }
        retry.hidden = true;
        render();
        return !panel.hidden;
    }
    retry.addEventListener("click", load);
    return {element: panel, load};
}
