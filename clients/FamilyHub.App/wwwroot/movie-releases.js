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

const TIERS = {
    uhd: { rank: 6, note: "Ultra HD: the sharpest picture." },
    remux: { rank: 5, note: "Remux: the untouched Blu-ray video. The best picture there is, and a very big file." },
    bluray: { rank: 4, note: "Blu-ray: a compressed copy of the disc, a very good picture." },
    web: { rank: 3, note: "Web: taken from a streaming service." },
    hd: { rank: 2, note: "HD, but smaller and softer than 1080p." },
    tv: { rank: 1, note: "From TV or DVD. A plain picture." },
    poor: { rank: 0, note: "Low quality: a camera copy or a very small picture." }
};

/** The quality tier (drives the colour), a short label such as "1080p Blu-ray", and a plain-words note. */
export function releaseQuality(title) {
    const height = resolution(title);
    const hdr = /\b(?:HDR10\+?|HDR|DV|Dolby[ ._-]?Vision)\b/i.test(title);
    const camera = /\b(?:CAM|HDCAM|TS|HDTS|TELESYNC|TELECINE)\b/i.test(title);
    const remux = /\bremux\b/i.test(title);
    const bluray = /\b(?:blu-?ray|bdrip|brrip)\b/i.test(title);
    const web = /\b(?:web-?dl|webrip|web)\b/i.test(title);
    const tv = /\b(?:hdtv|pdtv|dvdrip)\b/i.test(title);
    const source = camera ? "Camera copy" : remux ? "Remux" : bluray ? "Blu-ray" : web ? "Web" : tv ? "TV or DVD" : "";
    const picture = height >= 2160 ? "4K" : height ? `${height}p` : "";
    let tier = "web";
    if (camera || (height > 0 && height < 576)) tier = "poor";
    else if (height >= 2160) tier = "uhd";
    else if (remux) tier = "remux";
    else if (bluray) tier = "bluray";
    else if (web) tier = "web";
    else if (tv) tier = "tv";
    else if (height >= 1080) tier = "bluray";
    else if (height >= 720) tier = "hd";
    else tier = "tv";
    if (tier === "web" && height > 0 && height < 1080 && height >= 720) tier = "hd";
    const label = height >= 2160
        ? ["4K", hdr ? "HDR" : "", remux ? "Remux" : bluray ? "Blu-ray" : web ? "Web" : ""].filter(Boolean).join(" ")
        : [picture, source].filter(Boolean).join(" ") || "Quality unknown";
    return { tier, label, source, poor: tier === "poor", rank: TIERS[tier].rank, note: TIERS[tier].note };
}

export function downloadTime(bytes, mbps = ASSUMED_MBPS) {
    if (!(bytes > 0) || !(mbps > 0)) return "";
    const minutes = Math.max(1, Math.round(bytes * 8 / (mbps * 1e6) / 60));
    return minutes < 60 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** How easy the file is to get, in words. The number of people sharing it stays in the tooltip. */
export function availability(seeders) {
    if (seeders === null || seeders === undefined) return ["unknown", "Availability unknown"];
    if (seeders >= 100) return ["great", "Very easy to get"];
    if (seeders >= 20) return ["good", "Easy to get"];
    if (seeders >= 5) return ["ok", "Available"];
    if (seeders >= 1) return ["slow", "Slow, few sources"];
    return ["none", "Hard to get"];
}

/** A readable name for the tile: the title, then the year when the release name has one. */
export function displayTitle(name) {
    const spaced = name.replace(/[[(].*?[\])]/g, " ").replace(/[._]+/g, " ");
    const cut = spaced.search(/\b(?:19|20)\d{2}\b|\bS\d{1,2}(?:E\d{1,3})?\b|\b(?:2160|1440|1080|720|576|480)[pi]\b|\bseasons?\b|\bcomplete\b|\b(?:uhd|bluray|blu-ray|web-?dl|webrip|hdtv|remux)\b/i);
    const title = (cut > 0 ? spaced.slice(0, cut) : spaced).replace(/\s+/g, " ").trim();
    const year = name.match(/(?:^|[ ._([])((?:19|20)\d{2})(?=[ ._)\]]|$)/)?.[1];
    return (title || name) + (year && cut > 0 ? ` (${year})` : "");
}

const SORTS = [
    ["best", "Best match"],
    ["quality", "Quality"],
    ["size", "Smallest file"],
    ["speed", "Easiest to get"]
];

export function buildReleaseSearch(search, signal, requestsEnabled, download = null) {
    const panel = document.createElement("section");
    panel.className = "movie-releases";
    panel.hidden = true;
    panel.innerHTML = `
        <p class="movie-source-note" role="status"></p>
        <button type="button" hidden>Retry release lookup</button>
        <details class="movie-source-details" hidden>
            <summary>Releases</summary>
            <div class="movie-release-tools" role="group" aria-label="Sort releases"></div>
            <p class="movie-web-meta" data-release-availability hidden>Downloading is not switched on for your profile. Ask the server owner to turn it on.</p>
            <p class="movie-web-meta">Times assume a ${ASSUMED_MBPS} Mbps connection.</p>
            <ul class="movie-source-list" aria-label="Release results"></ul>
            <button type="button" class="movie-release-more" hidden>Show all releases</button>
        </details>`;
    const retry = panel.querySelector("button");
    const options = panel.querySelector("details");
    const summary = options.querySelector("summary");
    const more = panel.querySelector(".movie-release-more");
    const tools = panel.querySelector(".movie-release-tools");
    const canDownload = typeof download === "function";
    options.querySelector("[data-release-availability]").hidden = canDownload;
    const status = panel.querySelector('[role="status"]');
    const list = panel.querySelector("ul");
    let rows = [], unavailable = 0, busy = false, complete = false, showAll = false, sortBy = "best";

    const sortButtons = SORTS.map(([id, label]) => {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.textContent = label;
        choice.dataset.sort = id;
        choice.addEventListener("click", () => { sortBy = id; showAll = false; render(); });
        tools.append(choice);
        return choice;
    });

    function chip(className, text, level) {
        const node = document.createElement("span");
        node.className = className;
        node.textContent = text;
        if (level) node.dataset.level = level;
        return node;
    }

    function compare(a, b) {
        // Healthy releases first, so a perfect copy that nobody shares never leads the list.
        const group = row => !row.seeders ? 2 : row.quality.rank >= 3 ? 0 : 1;
        const quality = b.quality.rank - a.quality.rank || b.height - a.height;
        const speed = (b.seeders ?? -1) - (a.seeders ?? -1);
        const size = (a.size ?? 1e18) - (b.size ?? 1e18);
        if (sortBy === "quality") return quality || speed || size;
        if (sortBy === "size") return size || quality;
        if (sortBy === "speed") return speed || quality;
        return group(a) - group(b) || quality || speed || size;
    }

    function render() {
        if (busy || !complete) return;
        for (const choice of sortButtons) choice.setAttribute("aria-pressed", String(choice.dataset.sort === sortBy));
        const sorted = rows.slice().sort(compare);
        const shown = showAll ? sorted : sorted.slice(0, FIRST_PAGE);
        list.replaceChildren(...shown.map((row, index) => {
            const item = document.createElement("li");
            item.className = "movie-release";
            item.dataset.tier = row.quality.tier;
            const head = document.createElement("div");
            head.className = "movie-release-head";
            const heading = document.createElement("h3");
            heading.className = "movie-release-title";
            heading.textContent = displayTitle(row.title);
            const badges = document.createElement("div");
            badges.className = "movie-release-top";
            if (sortBy === "best" && index === 0 && row.seeders >= 20 && row.quality.rank >= 3) badges.append(chip("movie-release-pick", "Recommended"));
            badges.append(chip("movie-release-quality", row.quality.label, row.quality.tier));
            if (row.kind) badges.append(chip("movie-release-kind", row.kind));
            head.append(heading, badges);

            const [level, words] = availability(row.seeders);
            const stats = document.createElement("dl");
            stats.className = "movie-release-stats";
            const stat = (label, value, extra) => {
                const cell = document.createElement("div");
                const term = document.createElement("dt"), detail = document.createElement("dd");
                term.textContent = label;
                detail.textContent = value;
                if (extra) detail.dataset.level = extra;
                cell.append(term, detail);
                stats.append(cell);
                return detail;
            };
            stat("Size", row.size ? `${(row.size / gib).toFixed(1)} GB` : "Unknown");
            stat("Download time", row.size && row.seeders ? downloadTime(row.size) : "Not known");
            const detail = stat("Availability", words, level);
            if (row.seeders !== null) detail.title = `${row.seeders} ${row.seeders === 1 ? "person shares" : "people share"} this file`;

            const note = document.createElement("p");
            note.className = "movie-release-note";
            note.textContent = row.quality.note + (row.size > 40 * gib ? " Big files use a lot of server space." : "");

            const name = document.createElement("strong");
            name.className = "movie-release-name";
            name.textContent = row.title;

            const action = document.createElement("button");
            action.type = "button";
            action.className = "movie-release-action";
            action.textContent = "Download";
            action.setAttribute("aria-label", `Download ${displayTitle(row.title)}, ${row.quality.label}, ${row.size ? (row.size / gib).toFixed(1) + " GB" : "size unknown"}`);
            if (!canDownload) {
                action.setAttribute("aria-disabled", "true");
                action.title = "Downloading is not switched on for your profile.";
            }
            action.addEventListener("click", async () => {
                if (!canDownload || action.getAttribute("aria-disabled") === "true") return;
                action.setAttribute("aria-disabled", "true");
                action.textContent = "Starting…";
                const reply = await Promise.resolve(download(row)).catch(() => ({ error: "Could not start the download. Try again." }));
                action.textContent = reply?.error ? "Try again" : "Added to the server";
                if (reply?.error) { action.removeAttribute("aria-disabled"); status.textContent = reply.error; }
            });
            item.append(head, stats, note, name, action);
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
        const next = list.querySelector(`li:nth-child(${FIRST_PAGE + 1}) .movie-release-title`);
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
