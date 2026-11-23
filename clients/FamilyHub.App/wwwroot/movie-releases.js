const gib = 1024 ** 3;

function number(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolution(title) {
    const height = title.match(/\b(4320|2160|1440|1080|720|576|480)[pi]\b/i)?.[1];
    if (height) return Number(height);
    if (/\b8K\b/i.test(title)) return 4320;
    return /\b(?:4K|UHD)\b/i.test(title) ? 2160 : 0;
}

export function buildReleaseSearch(search, signal, requestsEnabled) {
    const panel = document.createElement("section");
    panel.className = "movie-releases";
    panel.hidden = true;
    panel.innerHTML = `
        <p class="movie-source-note" role="status"></p>
        <button type="button" hidden>Retry release lookup</button>
        <details class="movie-source-details" hidden>
            <summary>Release details</summary>
            <p class="movie-web-meta" data-release-availability hidden>Download requests are unavailable for this profile.</p>
            <div class="movie-release-settings">
                <label>Upload speed (Mbps) <input name="speed" type="number" min="0.1" step="0.1" value="10"></label>
                <label>Time budget (hours) <input name="budget" type="number" min="0.1" step="0.1" value="24"></label>
            </div>
            <p class="movie-web-meta">2.0× upload estimates assume peers are downloading from you at the entered speed.</p>
            <ul class="movie-source-list" aria-label="Release results"></ul>
        </details>`;
    const retry = panel.querySelector("button");
    const options = panel.querySelector("details");
    const summary = options.querySelector("summary");
    options.querySelector("[data-release-availability]").hidden = !!requestsEnabled;
    const speed = panel.querySelector('[name="speed"]');
    const budget = panel.querySelector('[name="budget"]');
    const status = panel.querySelector('[role="status"]');
    const list = panel.querySelector("ul");
    let rows = [], unavailable = 0, busy = false, complete = false;

    function render() {
        if (busy || !complete) return;
        const mbps = speed.valueAsNumber;
        const limit = budget.valueAsNumber;
        const rating = row => {
            if (!row.seeders) return 4;
            if (row.hours === null || !Number.isFinite(limit) || row.hours > limit) return 3;
            if (!row.leechers) return 2;
            return row.height >= 1080 ? 0 : 1;
        };
        const sorted = rows.map(row => ({ ...row, hours: row.size && mbps > 0 ? row.size * 16 / (mbps * 1e6 * 3600) : null }));
        sorted.sort((a, b) => rating(a) - rating(b) || b.height - a.height || b.seeders - a.seeders || a.hours - b.hours);
        list.replaceChildren(...sorted.map((row, index) => {
            const item = document.createElement("li");
            const title = document.createElement("strong");
            title.textContent = row.title;
            item.append(title);
            const stats = document.createElement("p");
            stats.className = "movie-web-meta";
            stats.textContent = [row.height ? `${row.height}p` : "Quality unknown", row.size ? `${(row.size / gib).toFixed(2)} GiB` : "Size unknown",
                `${row.seeders ?? "Unknown"} ${row.seeders === 1 ? "seeder" : "seeders"}`,
                `${row.leechers ?? "unknown"} ${row.leechers === 1 ? "leecher" : "leechers"}`, [...row.sources].join(", ")].filter(Boolean).join(" · ");
            const upload = document.createElement("p");
            upload.className = "movie-web-meta";
            const minutes = Math.max(1, Math.round(row.hours * 60));
            const duration = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
            const time = row.hours === null ? "" : ` · ${duration} at ${mbps} Mbps${limit > 0 && row.hours > limit ? " · Over time budget" : ""}`;
            upload.textContent = row.size ? `Upload ${(row.size * 2 / gib).toFixed(2)} GiB for 2.0×${time}` : "Upload target unavailable";
            if (index === 0 && rating(row) <= 1) {
                const recommended = document.createElement("p");
                recommended.className = "movie-web-meta";
                recommended.textContent = "Best fit for your upload budget";
                item.append(recommended);
            }
            item.append(stats, upload);
            return item;
        }));
        summary.textContent = sorted.length === 1 ? "1 torrent release" : `${sorted.length} torrent releases`;
    }

    speed.addEventListener("input", render);
    budget.addEventListener("input", render);
    async function load() {
        if (busy) return true;
        busy = true;
        retry.setAttribute("aria-disabled", "true");
        complete = false;
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
                seeders: number(item.seeders), leechers: number(item.leechers) };
            const key = `${row.title.toLowerCase()}\n${row.size}`;
            const previous = matches.get(key);
            const sources = previous?.sources ?? new Set();
            if (item.source) sources.add(item.source);
            if (!previous || (row.seeders ?? -1) > (previous.seeders ?? -1)) matches.set(key, { ...row, sources });
        }
        rows = [...matches.values()];
        unavailable = reply.unavailable;
        complete = true;
        const focused = document.activeElement === retry;
        status.textContent = unavailable ? `${unavailable} ${unavailable === 1 ? "indexer" : "indexers"} unavailable.`
            : !rows.length && focused ? "No torrent releases found." : "";
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
