const gib = 1024 ** 3;
// Download times assume this connection; the real speed depends on the server's line and on how many people share the file.
export const ASSUMED_MBPS = 100;
const FIRST_PAGE = 8;

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
        || /\b(?:full[ ._-]+hun|teljes[ ._-]+sorozat)\b/i.test(title)
        || /\bseasons?[ ._-]*\d+[ ._-]*(?:-|to|&)[ ._-]*\d+\b/i.test(title)) return "Complete series";
    const episode = title.match(/\bS(\d{1,2})[ ._-]*E(\d{1,3})\b/i) || title.match(/\b(\d{1,2})x(\d{2,3})\b/);
    if (episode) return `One episode · S${String(Number(episode[1])).padStart(2, "0")}E${String(Number(episode[2])).padStart(2, "0")}`;
    const season = title.match(/\bS(\d{1,2})\b/i) || title.match(/\bseason[ ._-]*(\d{1,2})\b/i);
    return season ? `Full season ${Number(season[1])}` : "";
}

const TIERS = [
    ["4k-remux", "4K Remux", "Original 4K disc video"],
    ["4k-bluray", "4K Blu-ray", "Compressed 4K disc video"],
    ["4k-web", "4K Web", "4K streaming copy"],
    ["remux", "1080p Remux", "Original HD disc video"],
    ["bluray", "1080p Blu-ray", "Compressed HD disc video"],
    ["web", "1080p Web", "HD streaming copy"],
    ["hd", "720p", "Smaller HD picture"],
    ["tv", "TV or DVD", "TV recording or DVD copy"],
    ["poor", "Camera copy", "Filmed in a cinema"]
];

export function cleanResultTitle(value) {
    // Parse only the entity token, so the parser never sees markup from a result.
    const decoded = value.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi,
        entity => new DOMParser().parseFromString("<body>" + entity + "</body>", "text/html").body.textContent);
    return decoded.replace(/<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, "")
        .replace(/\s+/g, " ").trim();
}

function pictureTier(height) {
    if (height >= 2160) return "4k-web";
    if (height >= 1080) return "web";
    if (height >= 720) return "hd";
    return height ? "tv" : "unknown";
}

function releaseQuality(title, height, size, length) {
    const camera = /\b(?:CAM|HDCAM|TS|HDTS|TELESYNC|TELECINE)\b/i.test(title);
    const remux = /\bremux\b/i.test(title);
    const bluray = /\b(?:blu[ ._-]?ray|bdrip|brrip)\b/i.test(title);
    const web = /\b(?:web[ ._-]?dl|web[ ._-]?rip|web)\b/i.test(title);
    const tv = /\b(?:[hp]dtv|dvd[ ._-]?(?:rip)?|dvd[59])\b/i.test(title);
    const source = remux ? "Remux" : bluray ? "Blu-ray" : web ? "Web" : "";
    let tier = pictureTier(height);
    if (camera) tier = "poor";
    else if (tv) tier = "tv";
    else if (source && (!height || height >= 1080)) {
        tier = (height >= 2160 ? "4k-" : "") + (remux ? "remux" : bluray ? "bluray" : "web");
    }
    if (tier === "unknown" && length > 0 && size > 0) {
        const mbps = size * 8 / (length * 60 * 1e6);
        const steps = [[1.5, "about 480p or lower"], [3.5, "about 720p"], [12, "about 1080p"]];
        const estimate = steps.find(([limit]) => mbps < limit)?.[1]
            ?? (mbps <= 30 ? "high-quality 1080p" : "4K or untouched disc");
        return {tier: "estimated", label: `Estimated: ${estimate} (from size and length)`, rank: -1};
    }
    const picture = height >= 2160 ? "4K" : height ? `${height}p` : "";
    const label = camera ? "Camera copy" : tv ? "TV or DVD" : [picture, tier === "hd" ? "" : source].filter(Boolean).join(" ")
        || (length > 0 ? "Size needed to estimate quality" : "Quality unknown");
    const rank = TIERS.findIndex(([id]) => id === tier);
    return {tier, label, rank: rank < 0 ? -2 : TIERS.length - rank - 1};
}

export function videoQualityTier(height) {
    return pictureTier(height);
}

export function formatMinutes(value) {
    if (!(value > 0)) return "";
    const minutes = Math.max(1, Math.round(value));
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return [hours ? `${hours} h` : "", remainder ? `${remainder} min` : ""].filter(Boolean).join(" ");
}

export function downloadTime(bytes, seeders) {
    if (!(bytes > 0) || !(seeders > 0)) return "";
    const mbps = Math.min(ASSUMED_MBPS, Math.max(1, seeders * 2));
    return `about ${formatMinutes(bytes * 8 / (mbps * 1e6 * 60))}`;
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

const audioMarkers = {
    hu: /\b(?:hun|magyarul|hungarian[ ._-]+audio|magyar[ ._-]+szinkron)\b/i,
    en: /\b(?:eng|english[ ._-]+audio)\b/i
};

export function buildReleaseSearch(search, signal, download = null, showDetails = () => {}, preferredAudio = "default") {
    const panel = document.createElement("section");
    panel.className = "movie-releases";
    panel.hidden = true;
    panel.innerHTML = `
        <p class="movie-source-note" role="status"></p>
        <button type="button" hidden>Retry release lookup</button>
        <section class="movie-release-results" aria-label="Releases" hidden>
            <h2 tabindex="-1">Releases</h2>
            <div class="movie-release-tools" role="group" aria-label="Sort releases"></div>
            <p class="movie-web-meta" data-release-availability hidden>Downloading is not switched on for your profile. Ask the server owner to turn it on.</p>
            <section class="movie-quality-guide" aria-label="Quality guide">
                <h3>Quality guide</h3>
                <ul class="movie-quality-chips"></ul>
                <p class="movie-web-meta" data-release-timing>Times assume a ${ASSUMED_MBPS} Mbps connection.</p>
            </section>
            <ul class="movie-source-list" aria-label="Release results"></ul>
            <button type="button" class="movie-release-more" hidden>Show all releases</button>
        </section>`;
    const retry = panel.querySelector("button");
    const options = panel.querySelector(".movie-release-results");
    const heading = options.querySelector("h2");
    const more = panel.querySelector(".movie-release-more");
    const tools = panel.querySelector(".movie-release-tools");
    const canDownload = typeof download === "function";
    options.querySelector("[data-release-availability]").hidden = canDownload;
    const timing = options.querySelector("[data-release-timing]");
    const status = panel.querySelector('[role="status"]');
    const list = panel.querySelector(".movie-source-list");
    let rows = [], unavailable = 0, busy = false, complete = false, showAll = false, sortBy = "best";

    const sortButtons = SORTS.map(([id, label]) => {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.textContent = label;
        choice.dataset.sort = id;
        choice.addEventListener("click", () => { choice.focus(); sortBy = id; showAll = false; render(); });
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

    const guide = panel.querySelector(".movie-quality-chips");
    for (const [id, label, meaning] of TIERS) {
        const item = document.createElement("li");
        item.append(chip("movie-release-quality", label, id), document.createTextNode(meaning));
        guide.append(item);
    }
    for (const [seeders, meaning] of [[100, "100 or more sharing"], [20, "20 to 99 sharing"],
        [5, "5 to 19 sharing"], [1, "1 to 4 sharing"], [0, "Nobody sharing"], [null, "No share count"]]) {
        const [level, label] = availability(seeders);
        const item = document.createElement("li");
        item.append(chip("movie-release-availability", label, level), document.createTextNode(meaning));
        guide.append(item);
    }

    function compare(a, b) {
        // Healthy releases first, so a perfect copy that nobody shares never leads the list.
        const group = row => row.site || row.seeders ? 0 : 1;
        const quality = b.height - a.height || b.quality.rank - a.quality.rank;
        const audio = Number(b.audio.includes(preferredAudio)) - Number(a.audio.includes(preferredAudio));
        const speed = (b.seeders ?? -1) - (a.seeders ?? -1);
        const size = (a.size ?? 1e18) - (b.size ?? 1e18);
        if (sortBy === "quality") return quality || speed || size;
        if (sortBy === "size") return size || quality;
        if (sortBy === "speed") return speed || quality;
        return group(a) - group(b) || audio || quality || speed || size;
    }

    function render() {
        if (busy || !complete) return;
        for (const choice of sortButtons) choice.setAttribute("aria-pressed", String(choice.dataset.sort === sortBy));
        const sorted = rows.slice().sort(compare);
        const shown = showAll ? sorted : sorted.slice(0, FIRST_PAGE);
        timing.hidden = !shown.some(row => row.size && row.seeders);
        list.replaceChildren(...shown.map((row, index) => {
            const item = document.createElement("li");
            item.className = "movie-release";
            item.dataset.tier = row.quality.tier;
            const head = document.createElement("div");
            head.className = "movie-release-head";
            const heading = document.createElement("h3");
            heading.className = "movie-release-title";
            heading.textContent = row.name;
            const badges = document.createElement("div");
            badges.className = "movie-release-top";
            if (sortBy === "best" && index === 0 && row.seeders >= 20 && row.quality.rank >= 3) badges.append(chip("movie-release-pick", "Recommended"));
            badges.append(chip("movie-release-quality", row.quality.label, row.quality.tier));
            if (row.kind) badges.append(chip("movie-release-kind", row.kind));
            if (row.site) badges.append(chip("movie-release-kind", row.site));
            if (row.audio.includes("hu")) badges.append(chip("movie-release-kind", "Hungarian audio listed"));
            head.append(heading, badges);

            const [level, words] = row.site ? ["ok", "Direct download"] : availability(row.seeders);
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
            const length = formatMinutes(row.length);
            stat("Length", length ? (row.lengthEstimated ? "About " + length : length) : "Unknown");
            stat("Download time", row.seeders === 0 ? "May never finish" : downloadTime(row.size, row.seeders) || "Unknown",
                row.seeders === 0 ? "none" : undefined);
            const detail = stat("Availability", words, level);
            if (row.seeders !== null) detail.title = `${row.seeders} ${row.seeders === 1 ? "person shares" : "people share"} this file`;

            const note = document.createElement("p");
            note.className = "movie-release-note";
            note.textContent = ["Estimate based on how many people share it",
                row.mismatch ? "This file is unusually small for a 1080p video of this length" : "",
                row.size > 40 * gib ? "This file uses over 40 GB of server space" : ""]
                .filter(Boolean).join(". ") + ".";

            const name = document.createElement("strong");
            name.className = "movie-release-name";
            name.textContent = row.title;

            const action = document.createElement("button");
            action.type = "button";
            action.className = "movie-release-action";
            const label = row.episodes ? `${row.name}, ${row.kind}`
                : `${row.name}, ${row.quality.label}, ${row.size ? (row.size / gib).toFixed(1) + " GB" : "size unknown"}`;
            const sent = document.createElement("p");
            sent.className = "movie-release-sent";
            sent.setAttribute("role", "status");
            sent.textContent = "Sent to the server";
            sent.tabIndex = -1;
            action.textContent = row.pending ? "Sending…" : row.failed ? "Try again" : "Download";
            action.setAttribute("aria-label", `${action.textContent} ${label}`);
            if (!canDownload || !(row.guid || row.site && (row.url || row.episodes))) {
                action.setAttribute("aria-disabled", "true");
                action.title = canDownload ? "Search again to get a download reference." : "Downloading is not switched on for your profile.";
            }
            if (row.pending) action.setAttribute("aria-disabled", "true");
            row.showSent = () => {
                const focused = document.activeElement === action;
                action.replaceWith(sent);
                if (focused) sent.focus();
            };
            row.showError = () => {
                action.textContent = "Try again";
                action.setAttribute("aria-label", `Try again: download ${label}`);
                action.removeAttribute("aria-disabled");
            };
            action.addEventListener("click", async () => {
                if (action.getAttribute("aria-disabled") === "true") return;
                action.focus();
                row.pending = true;
                status.textContent = "";
                action.setAttribute("aria-disabled", "true");
                action.textContent = "Sending…";
                action.setAttribute("aria-label", `Sending ${label}`);
                let reply;
                try { reply = await download(row); } catch {}
                if (signal.aborted) return;
                row.pending = false;
                row.sent = reply?.state === "sent";
                row.failed = !row.sent;
                if (row.sent) row.showSent();
                else {
                    row.showError();
                    status.textContent = reply?.error || "Could not confirm the download. Check On the server before trying again.";
                }
            });
            item.append(head);
            if (!row.episodes) item.append(stats);
            if (!row.site && note.textContent) item.append(note);
            if (!row.episodes) item.append(name);
            item.append(row.sent ? sent : action);
            return item;
        }));
        more.hidden = showAll || sorted.length <= FIRST_PAGE;
    }

    more.addEventListener("click", () => {
        showAll = true;
        render();
        // Focus moves to the first newly shown release, so the button's removal never drops it to the page.
        const next = list.querySelector(`li:nth-child(${FIRST_PAGE + 1}) .movie-release-title`);
        if (next) { next.tabIndex = -1; next.focus(); } else heading.focus();
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
        const details = reply.title_details || {};
        showDetails(details);
        const matches = new Map();
        for (const item of reply.results) {
            if (typeof item.title !== "string") continue;
            const title = cleanResultTitle(item.title);
            if (!title) continue;
            const episodes = item.site === "Videa" && Array.isArray(item.episodes) && item.episodes.length ? item.episodes : null;
            const height = number(item.height) || resolution(title), size = number(item.size);
            const kind = episodes ? `${episodes.length} ${episodes.length === 1 ? "episode" : "episodes"}`
                : details.kind === "movie" ? "" : releaseKind(title);
            const isSeriesPack = details.kind === "tv" && kind === "Complete series";
            const length = isSeriesPack ? details.series_minutes || (details.season == null ? details.runtime_minutes : null)
                : details.runtime_minutes;
            const lengthEstimated = isSeriesPack ? details.series_estimated ?? details.runtime_estimated : details.runtime_estimated;
            const oneEpisode = kind.startsWith("One episode");
            const comparisonLength = oneEpisode && details.episode_count > 0 ? length / details.episode_count : length;
            const mismatch = !lengthEstimated && !oneEpisode && height === 1080 && comparisonLength > 0
                && size > 0 && size / comparisonLength < 3e6;
            const audio = Object.keys(audioMarkers).filter(language => (episodes || [item]).every(video => audioMarkers[language].test(video.title)));
            const quality = releaseQuality(episodes ? "" : title, height, size, comparisonLength);
            if (episodes && height > 0 && item.max_height > height) quality.label = `${height}p–${item.max_height}p`;
            const name = episodes ? `${title} · Season ${item.number}` : displayTitle(title);
            const row = { title, name, height, size, length, lengthEstimated, mismatch, kind, audio, episodes, quality,
                seeders: number(item.seeders), guid: item.guid, indexerId: item.indexerId, site: item.site, url: item.url };
            const key = row.site ? `${row.site}\n${row.url}` : `${row.title.toLowerCase()}\n${row.size}`;
            const previous = matches.get(key);
            const preferReference = canDownload && previous && Boolean(row.guid) !== Boolean(previous.guid);
            if (!previous || (preferReference ? row.guid : (row.seeders ?? -1) > (previous.seeders ?? -1)))
                matches.set(key, row);
        }
        rows = [...matches.values()];
        unavailable = reply.unavailable;
        complete = true;
        const focused = document.activeElement === retry;
        const count = rows.length === 1 ? "1 release found." : rows.length ? `${rows.length} releases found.` : "";
        status.textContent = [count, unavailable ? `${unavailable} ${unavailable === 1 ? "source" : "sources"} did not answer.`
            : !rows.length && focused ? "No releases found." : ""].filter(Boolean).join(" ");
        options.hidden = !rows.length;
        panel.hidden = !rows.length && !unavailable && !focused;
        if (focused) {
            const target = rows.length ? heading : status;
            if (target === status) status.tabIndex = -1;
            target.focus();
        }
        retry.hidden = true;
        render();
        return !panel.hidden;
    }
    retry.addEventListener("click", () => { retry.focus(); load(); });
    return {element: panel, load};
}
