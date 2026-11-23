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

export function buildReleaseSearch(search) {
    const panel = document.createElement("details");
    panel.className = "movie-releases";
    panel.innerHTML = `
        <summary>Release search</summary>
        <form role="search" aria-label="Releases">
            <label class="movie-release-query">Title <input name="query" type="search" maxlength="120" required></label>
            <button type="submit">Search releases</button>
        </form>
        <div class="movie-release-settings">
            <label>Assumed upload (Mbps) <input name="speed" type="number" min="0.1" step="0.1" value="10"></label>
            <label>Upload time budget (hours) <input name="budget" type="number" min="0.1" step="0.1" value="24"></label>
            <span>Share ratio target <strong>2.0×</strong></span>
        </div>
        <p class="movie-web-meta">Upload times assume a steady rate. Peers determine the actual speed.</p>
        <p role="status"></p>
        <ul class="movie-web-list" aria-label="Release results"></ul>`;
    const form = panel.querySelector("form");
    const summary = panel.querySelector("summary");
    const searchButton = form.querySelector("button");
    const query = form.elements.query;
    const speed = panel.querySelector('[name="speed"]');
    const budget = panel.querySelector('[name="budget"]');
    const status = panel.querySelector('[role="status"]');
    const list = panel.querySelector("ul");
    let rows = [], unavailable = 0, busy = false, complete = false;

    summary.addEventListener("click", () => {
        if (document.activeElement === document.body || panel.contains(document.activeElement)) summary.focus();
    });

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
        list.replaceChildren(...sorted.map(row => {
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
            item.append(stats, upload);
            return item;
        }));
        const result = sorted.length ? `${sorted.length} ${sorted.length === 1 ? "release" : "releases"}` : "No releases found. Try another title.";
        status.textContent = unavailable ? `${result} · ${unavailable} ${unavailable === 1 ? "source" : "sources"} unavailable` : result;
    }

    speed.addEventListener("input", render);
    budget.addEventListener("input", render);
    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy) return;
        const term = query.value.trim();
        if (term.length < 2) { status.textContent = "Enter at least two characters."; return; }
        if (document.activeElement === query || document.activeElement === document.body) searchButton.focus();
        busy = true;
        searchButton.setAttribute("aria-disabled", "true");
        complete = false;
        list.replaceChildren();
        status.textContent = "Searching releases…";
        let reply;
        try { reply = await search(term); }
        catch { reply = { error: "Release search is unavailable. Try again." }; }
        if (!panel.isConnected) return;
        busy = false;
        searchButton.removeAttribute("aria-disabled");
        if (reply?.error || !Array.isArray(reply?.results)) {
            status.textContent = reply?.error || "Release search is unavailable. Try again.";
            return;
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
        render();
    });
    return panel;
}
