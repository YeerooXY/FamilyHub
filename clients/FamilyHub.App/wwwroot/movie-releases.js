import { createServiceStatus } from "./service-status.js";
import { movieDialog } from "./movie-audio-ui.js";

const gib = 1024 ** 3;
// Download times assume this connection; the real speed depends on the server's line and on how many people share the file.
export const ASSUMED_MBPS = 100;

function number(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolution(title) {
    const height = title.match(/\b(4320|2160|1440|1080|720|576|480)[pi]\b/i)?.[1];
    if (height) return Number(height);
    if (/\b8K\b/i.test(title)) return 4320;
    return /\b(?:4K|UHD)\b/i.test(title) ? 2160 : 0;
}

const audioFormats = {
    atmos: ["Atmos", "Dolby Atmos"],
    eac3: ["DDP", "Dolby Digital Plus"],
    ac3: ["AC3", "Dolby Digital"],
    truehd: ["TrueHD", "Dolby TrueHD"],
    dtsma: ["DTS-HD MA", "DTS-HD Master Audio"],
    dtshra: ["DTS-HD HRA", "DTS-HD High Resolution Audio"],
    dtsx: ["DTS:X", "DTS:X"],
    dts: ["DTS", "DTS"],
    aac: ["AAC", "AAC"],
    flac: ["FLAC", "FLAC"],
    opus: ["Opus", "Opus"],
    mp3: ["MP3", "MP3"]
};

function soundFormat(codec, channels) {
    const format = Object.prototype.hasOwnProperty.call(audioFormats, codec) ? audioFormats[codec] : null;
    if (!format && !channels) return null;
    const suffix = codec === "atmos" || codec === "dtsx" ? "" : channels;
    return {
        label: [format?.[0], suffix].filter(Boolean).join(" "),
        name: "Sound: " + [format?.[1], suffix].filter(Boolean).join(" ")
    };
}

export function releaseSound(title) {
    if (/\batmos\b/i.test(title)) return soundFormat("atmos");
    if (/\bdts[ ._:-]*x\b/i.test(title)) return soundFormat("dtsx");
    const match = title.match(/\b(dts[ ._-]*hd[ ._-]*(?:ma|hra)|ddp|dd\+|e[ ._-]?ac3|ac3|truehd|dts|aac|flac|opus|mp3)(?:[ ._-]*([12]\.0|[257]\.1)(?!\d|\.\d))?(?![a-z0-9])/i);
    if (!match) return null;
    const marker = match[1].toLowerCase().replace(/[ ._-]/g, "");
    const codec = {ddp: "eac3", "dd+": "eac3", dtshdma: "dtsma", dtshdhra: "dtshra"}[marker] ?? marker;
    return soundFormat(codec, match[2]);
}

export function librarySound(streams) {
    const audio = streams.find(stream => stream.Type === "Audio" && stream.IsDefault) ??
        streams.find(stream => stream.Type === "Audio");
    if (!audio) return null;
    const profile = audio.Profile ?? "";
    const details = [profile, audio.AudioSpatialFormat, audio.DisplayTitle].join(" ");
    const codec = audio.Codec?.toLowerCase();
    const channels = {1: "1.0", 2: "2.0", 6: "5.1", 8: "7.1"}[audio.Channels];
    if (/\batmos\b/i.test(details)) return soundFormat("atmos");
    if (/\bdts[ ._:-]*x\b/i.test(details)) return soundFormat("dtsx");
    if (codec === "dts") {
        if (/^(?:DTS-HD MA|DTS-HD Master Audio)$/i.test(profile)) return soundFormat("dtsma", channels);
        if (/^(?:DTS-HD HRA|DTS-HD High Resolution Audio)$/i.test(profile)) return soundFormat("dtshra", channels);
    }
    return soundFormat(codec, channels);
}

function chip(className, text, level) {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    if (level) node.dataset.level = level;
    return node;
}

export function appendSoundChip(target, sound, icon) {
    if (!sound) return;
    const badge = chip("movie-chip movie-sound-chip", sound.label);
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", sound.name);
    badge.title = sound.name;
    badge.prepend(icon("M11 5 6 9H3v6h3l5 4V5Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12"));
    target.append(badge);
}

/** What the release holds when it is a series: one episode, a whole season, or several seasons. */
export function releaseKind(title) {
    if (/\bS\d{1,3}\s*[-–]\s*S?\d{1,3}\b/i.test(title) || /\b(?:complete|full)[ ._-]*(?:series|collection)\b/i.test(title)
        || /\b(?:full[ ._-]+hun|teljes[ ._-]+sorozat)\b/i.test(title)
        || /\bseasons?[ ._-]*\d+[ ._-]*(?:-|to|&)[ ._-]*\d+\b/i.test(title)) return "Complete series";
    const episode = title.match(/\bS(\d{1,3})[ ._-]*E(\d{1,3})\b/i) || title.match(/\b(\d{1,3})x(\d{2,3})\b/);
    if (episode) return `One episode, S${String(Number(episode[1])).padStart(2, "0")}E${String(Number(episode[2])).padStart(2, "0")}`;
    const season = title.match(/\bS(\d{1,3})\b/i) || title.match(/\bseason[ ._-]*(\d{1,3})\b/i);
    return season ? `Full season ${Number(season[1])}` : "";
}

const TIERS = [
    ["8k", "8K", "Eight times HD picture; most are upscaled from 4K or less"],
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
    if (height >= 4320) return "8k";
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
    const source = camera ? "Camera copy" : tv ? "TV or DVD" : remux ? "Remux" : bluray ? "Blu-ray" : web ? "Web" : "";
    let tier = pictureTier(height);
    if (camera) tier = "poor";
    else if (tv) tier = "tv";
    else if (source && (!height || height >= 1080) && height < 4320) {
        tier = (height >= 2160 ? "4k-" : "") + (remux ? "remux" : bluray ? "bluray" : "web");
    }
    if (tier === "unknown" && length > 0 && size > 0) {
        const mbps = size * 8 / (length * 60 * 1e6);
        const steps = [[1.5, "about 480p or lower"], [3.5, "about 720p"], [12, "about 1080p"]];
        const estimate = steps.find(([limit]) => mbps < limit)?.[1]
            ?? (mbps <= 30 ? "high-quality 1080p" : "4K or untouched disc");
        return {tier: "estimated", label: `Estimated: ${estimate} (from size and length)`, source};
    }
    const picture = height >= 4320 ? "8K" : height >= 2160 ? "4K" : height ? `${height}p` : "";
    const label = camera ? "Camera copy" : tv ? "TV or DVD" : [picture, tier === "hd" ? "" : source].filter(Boolean).join(" ")
        || (length > 0 ? "Size needed to estimate quality" : "Quality unknown");
    return {tier, label, source};
}

export function videoQualityTier(height) {
    return pictureTier(height);
}

export function ratingBadge(rawRating) {
    if (typeof rawRating !== "string" && typeof rawRating !== "number") return null;
    const rating = String(rawRating).trim().toUpperCase().replace(/^(?:US|GB|HU)[-\s]+/, "");
    const level = /^(?:U|G|PG|TV-Y(?:7(?:-FV)?)?|TV-G|6)$/.test(rating) ? "6" :
        /^(?:12A?|PG-13|TV-PG)$/.test(rating) ? "12" :
        /^(?:15|16|R|TV-14)$/.test(rating) ? "16" :
        /^(?:18|NC-17|TV-MA)$/.test(rating) ? "18" : rating === "KN" ? "KN" : null;
    if (!level) return null;
    const badge = chip("movie-chip movie-age-rating", level, level);
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", level === "KN" ? "Rated no age limit" : `Rated ${level}`);
    return badge;
}

export function formatMinutes(value) {
    if (!(value > 0)) return "";
    const minutes = Math.max(1, Math.round(value));
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return [hours ? `${hours} h` : "", remainder ? `${remainder} min` : ""].filter(Boolean).join(" ");
}

function downloadSeconds(bytes, seeders) {
    if (!(bytes > 0) || !(seeders > 0)) return Infinity;
    const mbps = Math.min(ASSUMED_MBPS, Math.max(1, seeders * 2));
    return bytes * 8 / (mbps * 1e6);
}

export function downloadTime(bytes, seeders) {
    const seconds = downloadSeconds(bytes, seeders);
    return Number.isFinite(seconds) ? `about ${formatMinutes(seconds / 60)}` : "";
}

export function availability(seeders) {
    if (seeders == null) return ["unknown", "Availability unknown"];
    if (seeders >= 5) return ["ok", "Available"];
    if (seeders >= 1) return ["slow", "Few sources"];
    return ["none", "Unavailable"];
}

/** A readable name for the tile: the title, then the year when the release name has one. */
export function displayTitle(name) {
    const spaced = name.replace(/[[(].*?[\])]/g, " ").replace(/[._]+/g, " ");
    const cut = spaced.search(/\b(?:19|20)\d{2}\b|\bS\d{1,3}(?:E\d{1,3})?\b|\b(?:2160|1440|1080|720|576|480)[pi]\b|\bseasons?\b|\bcomplete\b|\b(?:uhd|bluray|blu-ray|web-?dl|webrip|hdtv|remux)\b/i);
    const title = (cut > 0 ? spaced.slice(0, cut) : spaced).replace(/\s+/g, " ").trim();
    const year = name.match(/(?:^|[ ._([])((?:19|20)\d{2})(?=[ ._)\]]|$)/)?.[1];
    return (title || name) + (year && cut > 0 ? ` (${year})` : "");
}

const audioMarkers = {
    hu: /\b(?:hun|magyarul|hungarian[ ._-]+audio|magyar[ ._-]+szinkron)\b/i,
    en: /\b(?:eng|english[ ._-]+audio)\b/i
};

function releaseStats(row) {
    const [level, available] = row.site ? ["ok", "Available"] : availability(row.seeders);
    const cost = (value, thresholds) => Number.isFinite(value) && value > 0
        ? `movie-release-cost movie-release-cost-${["green", "amber", "orange", "red"][thresholds.filter(limit => value > limit).length]}`
        : "";
    const size = row.size / gib;
    const minutes = Math.round(row.seconds / 60);
    return [
        ["Size", row.size ? `${size.toFixed(1)} GB` : "Unknown", "size", cost(size, [5, 15, 30])],
        ["Download time", row.seeders === 0 ? "May never finish" : downloadTime(row.size, row.seeders) || "Unknown",
            "time", cost(Math.max(1, minutes), [10, 30, 60])],
        ["Availability", available, "health", "", level]
    ];
}

function downloadOptions(parent, opener, signal, identity, row, {icon, chainImages, palette, preferences, save, download}) {
    const form = document.createElement("form");
    form.className = "movie-confirm-form";
    const summary = document.createElement("div"), art = document.createElement("span"), poster = document.createElement("img");
    summary.className = "movie-confirm-summary";
    art.className = "movie-art movie-confirm-poster";
    art.setAttribute("aria-hidden", "true");
    poster.alt = "";
    poster.referrerPolicy = "no-referrer";
    chainImages(poster, identity.poster ? [identity.poster] : []);
    art.append(poster);
    const info = document.createElement("div"), title = document.createElement("h2");
    info.className = "movie-confirm-info";
    title.textContent = identity.title;
    title.className = "movie-confirm-title";
    const year = identity.year || row.name.match(/\((\d{4})\)$/)?.[1];
    if (year) title.append(chip("movie-confirm-year", year));
    const rating = ratingBadge(identity.official_rating);
    if (rating) title.append(rating);
    const pills = document.createElement("div"), stats = document.createElement("div");
    pills.className = stats.className = "movie-confirm-line";
    appendSoundChip(pills, row.sound, icon);
    pills.append(chip("movie-chip movie-release-quality", row.picture, row.tier));
    for (const [, value, name, tone, level] of releaseStats(row)) {
        const cell = chip(`movie-release-${name}`, "");
        cell.append(chip(`movie-release-stat-value ${tone}`, value, level));
        stats.append(cell);
    }
    info.append(title, pills, stats);
    summary.append(art, info);
    form.append(summary);
    const options = document.createElement("div");
    options.className = "movie-confirm-options";
    const audioPath = "M11 5 6 9H3v6h3l5 4V5Zm4 4a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12";
    const subtitlesPath = "M4 5h16v11H9l-5 4V5Zm4 5h8M8 13h5";
    const defaults = preferences();
    const fields = ["Hungarian audio", "Hungarian subtitles"].map((title, index) => {
        const label = document.createElement("label"), input = document.createElement("input");
        label.className = "movie-confirm-option";
        input.type = "checkbox";
        input.setAttribute("role", "switch");
        input.checked = defaults[index];
        const visual = chip("movie-confirm-switch", "");
        visual.setAttribute("aria-hidden", "true");
        label.append(icon(index ? subtitlesPath : audioPath), chip("", title), input, visual);
        options.append(label);
        return input;
    });
    const english = document.createElement("div"), englishLabel = chip("", "English subtitles");
    english.className = "movie-confirm-option";
    const note = document.createElement("small");
    note.textContent = "Added automatically";
    englishLabel.append(note);
    const locked = chip("movie-confirm-switch movie-confirm-locked", "");
    locked.setAttribute("aria-hidden", "true");
    english.append(icon(subtitlesPath), englishLabel, locked);
    options.append(english);
    const buttons = document.createElement("div"), cancel = document.createElement("button"), submit = document.createElement("button");
    buttons.className = "movie-confirm-buttons";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    submit.type = "submit";
    submit.autofocus = true;
    submit.append(icon("M12 3v12m-5-5 5 5 5-5M5 20h14"), "Download");
    buttons.append(cancel, submit);
    form.append(options, buttons);
    const dialog = movieDialog(parent, opener, "Confirm download", signal,
        {content: form, initialFocus: submit, className: "movie-download-confirm"});
    void palette(identity.backdrop).then(colors => {
        if (colors) {
            dialog.style.setProperty("--movie-hero-start", colors[0]);
            dialog.style.setProperty("--movie-hero-end", colors[1]);
        }
    });
    let pending = false;
    cancel.onclick = () => { if (!pending) dialog.close(); };
    dialog.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
    dialog.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        if (pending || (event.shiftKey ? event.target === fields[0] : event.target === submit)) {
            event.preventDefault();
            (pending || event.shiftKey ? submit : fields[0]).focus();
        }
    });
    const choices = () => fields.map(input => input.checked);
    for (const field of fields) field.addEventListener("change", () => save(choices()));
    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (pending) return;
        pending = true;
        submit.focus({preventScroll: true});
        submit.setAttribute("aria-disabled", "true");
        cancel.disabled = true;
        fields.forEach(field => { field.disabled = true; });
        await download(choices(), () => { if (dialog.open) dialog.close(); });
        if (dialog.open) dialog.close();
    });
}

export function buildReleaseSearch(search, signal, download, {term, screen, icon, searchTitle, titleHue, chainImages, palette,
    preferences, save, downloadProgress, watchLink, onResults}) {
    const panel = document.createElement("section");
    panel.className = "movie-releases";
    panel.hidden = true;
    panel.innerHTML = `
        <div class="movie-release-results" hidden>
            <aside class="movie-release-rail" aria-label="Release details">
                <div class="movie-release-identity">
                    <span class="movie-art movie-release-poster" aria-hidden="true"><img alt="" decoding="async" referrerpolicy="no-referrer"></span>
                    <div class="movie-release-heading"><h2 tabindex="-1"></h2></div>
                </div>
                <div class="movie-release-legend-wrap">
                    <div class="movie-release-legend" role="group" aria-label="Quality"></div>
                    <button type="button" class="movie-release-icon" aria-label="Quality guide" aria-expanded="false" aria-controls="movie-release-guide"></button>
                </div>
                <div class="movie-quality-guide" id="movie-release-guide" hidden>
                    <table class="movie-quality-table">
                        <thead><tr><th scope="col">Label</th><th scope="col">Meaning</th></tr></thead><tbody></tbody>
                    </table>
                    <p class="movie-web-meta">Times assume a ${ASSUMED_MBPS} Mbps connection.</p>
                </div>
                <p class="movie-web-meta" data-release-availability hidden>Ask the server owner to enable downloads for your profile.</p>
            </aside>
            <div class="movie-release-content">
                <p class="movie-source-note movie-release-empty" role="status" hidden>No releases found. Try another title.</p>
                <ul class="movie-source-list" role="list" aria-label="Release results"></ul>
            </div>
        </div>`;
    const results = panel.querySelector(".movie-release-results");
    const heading = panel.querySelector("h2");
    const poster = panel.querySelector(".movie-release-poster");
    const guide = panel.querySelector(".movie-quality-guide");
    const guideButton = panel.querySelector('[aria-controls="movie-release-guide"]');
    const list = panel.querySelector("ul");
    const empty = panel.querySelector(".movie-release-empty");
    const canDownload = typeof download === "function";
    panel.querySelector("[data-release-availability]").hidden = canDownload;
    const outage = createServiceStatus({
        detail: "Reconnect to search for releases.", label: "Retry release lookup", retry: load,
        focus: () => heading, automatic: true
    });
    panel.prepend(outage.card);
    let rows = [], busy = false, matches = [], details = {}, identity = {}, usedPoster;
    const tiers = [["8k", "8K"], ["4k-remux", "4K Remux"], ["4k-web", "4K"], ["web", "1080p"], ["hd", "720p and below"]];
    const tierOrder = new Map(tiers.map(([tier], index) => [tier, index]));
    const legend = panel.querySelector(".movie-release-legend");
    const tierCounts = new Map(tiers.map(([tier, label]) => {
        const entry = chip("movie-release-tier movie-release-quality", label, tier);
        const count = chip("movie-release-tier-count", "0");
        entry.append(" ", count);
        legend.append(entry);
        return [tier, count];
    }));
    guideButton.append(icon("M12 11v5m0-8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"));
    guideButton.title = "Quality guide";
    guideButton.addEventListener("click", () => {
        guide.hidden = !guide.hidden;
        guideButton.setAttribute("aria-expanded", String(!guide.hidden));
        guideButton.focus({preventScroll: true});
    });

    const guideTable = guide.querySelector("tbody");
    for (const [id, label, meaning] of TIERS) {
        const row = guideTable.insertRow();
        row.insertCell().append(chip("movie-release-quality", label, id));
        row.insertCell().textContent = meaning;
    }

    function updateIdentity() {
        const cleanTerm = cleanResultTitle(term);
        const name = details.title || displayTitle(cleanTerm);
        const normalized = searchTitle(name);
        const kind = details.kind || (releaseKind(cleanTerm) ? "tv" : "");
        const exact = matches.filter(item => typeof item?.title === "string" &&
            (!kind || item.kind === kind) &&
            (!details.year || !item.year || Number(item.year) === Number(details.year)) &&
            (normalized === searchTitle(item.title) || normalized === searchTitle(`${item.title} ${item.year}`)));
        const match = exact.find(item => Number(item.id) === Number(details.tmdb_id)) ?? (exact.length === 1 ? exact[0] : null);
        const nameYear = !details.title && /^(.*) \((\d{4})\)$/.exec(name);
        const title = match?.title || nameYear?.[1] || name;
        const year = match?.year || details.year || nameYear?.[2];
        heading.textContent = year ? `${title} (${year})` : title;
        heading.parentElement.querySelector(".movie-age-rating")?.remove();
        const badge = ratingBadge(details.official_rating);
        if (badge) heading.after(badge);
        identity = {...match, ...details, title, year, kind: kind || match?.kind,
            tmdb_id: details.tmdb_id ?? match?.id, poster: details.poster || match?.poster,
            backdrop: details.backdrop || match?.backdrop};
        const posterUrl = identity.poster;
        poster.dataset.initial = [...title][0]?.toUpperCase() ?? "";
        poster.style.setProperty("--art-hue", titleHue(title));
        if (posterUrl !== usedPoster) {
            usedPoster = posterUrl;
            chainImages(poster.firstElementChild, posterUrl ? [posterUrl] : []);
        }
    }

    function compare(a, b) {
        return Number(a.unavailable) - Number(b.unavailable) ||
            Number(a.height > screen.height) - Number(b.height > screen.height) ||
            tierOrder.get(a.tier) - tierOrder.get(b.tier) ||
            (a.size || Infinity) - (b.size || Infinity) || a.seconds - b.seconds ||
            (a.orderKey < b.orderKey ? -1 : Number(a.orderKey > b.orderKey));
    }

    list.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        const row = event.target.closest(".movie-release");
        const next = event.key === "ArrowDown" ? row?.nextElementSibling : row?.previousElementSibling;
        if (!next) return;
        event.preventDefault();
        next.querySelector(event.target.matches(".movie-release-file") ? ".movie-release-file" : ".movie-release-action").focus();
    });

    function renderRow(row, index) {
        const item = document.createElement("li");
        item.className = "movie-release";
        item.dataset.tier = row.tier;
        const quality = chip("movie-release-quality movie-release-block", row.picture, row.tier);
        if (row.source) quality.append(" ", chip("movie-release-source", row.source));
        const head = document.createElement("div"), title = document.createElement("h3");
        head.className = "movie-release-head";
        title.className = "movie-release-title";
        title.textContent = row.name;
        const badges = document.createElement("div");
        badges.className = "movie-release-top";
        appendSoundChip(badges, row.sound, icon);
        if (row.kind) badges.append(chip("movie-release-kind", row.kind));
        if (row.site) badges.append(chip("movie-release-kind", row.site));
        if (row.audio.includes("hu")) badges.append(chip("movie-release-kind", "Hungarian audio listed"));
        head.append(title, badges);

        const file = document.createElement("button"), raw = document.createElement("div");
        file.type = "button";
        file.className = "movie-release-file movie-release-icon";
        file.setAttribute("aria-label", `File name for ${row.name}`);
        file.setAttribute("aria-expanded", "false");
        raw.id = `movie-release-file-${index}`;
        raw.className = "movie-release-name";
        raw.hidden = true;
        file.setAttribute("aria-controls", raw.id);
        file.append(icon("M5 9l7 7 7-7"));
        file.addEventListener("click", () => {
            raw.hidden = !raw.hidden;
            file.setAttribute("aria-expanded", String(!raw.hidden));
            file.focus({preventScroll: true});
        });
        raw.textContent = row.fileName;
        if (row.site === "YouTube") raw.append(watchLink(row.url));
        const warnings = [row.mismatch ? "This file is unusually small for a 1080p video of this length." : "",
            row.size > 40 * gib ? "This file uses over 40 GB of server space." : ""].filter(Boolean);
        if (warnings.length) head.append(chip("movie-release-note", warnings.join(" ")));
        head.append(file);

        const stat = ([name, value, className, tone, level]) => {
            const cell = document.createElement("div");
            cell.className = `movie-release-stat movie-release-${className}`;
            cell.append(chip("movie-release-stat-label", name), chip(`movie-release-stat-value ${tone}`, value, level));
            return cell;
        };
        const [size, time, health] = releaseStats(row).map(stat);
        time.title = `Estimated from size and the number of people sharing the file, assuming a ${ASSUMED_MBPS} Mbps connection.`;
        if (row.seeders !== null) health.title = `${row.seeders} ${row.seeders === 1 ? "person shares" : "people share"} this file`;

        const action = document.createElement("button"), progress = document.createElement("progress");
        const receipt = chip("movie-release-receipt movie-visually-hidden", "");
        receipt.setAttribute("role", "status");
        action.type = "button";
        action.className = "movie-release-action";
        progress.className = "movie-release-progress";
        progress.max = 1;
        progress.setAttribute("aria-label", `Download progress for ${row.name}`);
        progress.hidden = true;
        const label = row.episodes ? `${row.name}, ${row.kind}`
            : `${row.name}, ${row.quality.label}, ${row.size ? (row.size / gib).toFixed(1) + " GB" : "size unknown"}`;
        const allowed = canDownload && (row.guid || row.site && (row.url || row.episodes));
        const actionLabel = chip("movie-release-action-label", "");
        action.append(icon("M12 3v12m-5-5 5 5 5-5M5 20h14"), actionLabel);
        row.updateProgress = () => {
            if (!row.sent) return;
            const fraction = downloadProgress(row);
            if (fraction != null) progress.value = fraction;
        };
        const updateAction = () => {
            const text = row.sent ? "Added" : row.pending ? "Sending…" : row.failed ? "Try again" : "Download";
            actionLabel.textContent = text;
            action.setAttribute("aria-label", `${text} ${label}`);
            if (!allowed || row.pending || row.sent) action.setAttribute("aria-disabled", "true");
            else action.removeAttribute("aria-disabled");
            if (allowed && row.guid && !row.site && !row.sent) action.setAttribute("aria-haspopup", "dialog");
            else action.removeAttribute("aria-haspopup");
            progress.hidden = !row.sent;
            row.updateProgress();
        };
        if (!allowed) action.title = canDownload ? "Search again to get a download reference." : "Ask the server owner to enable downloads for your profile.";
        updateAction();
        const send = async (options, close) => {
            row.pending = true;
            receipt.classList.add("movie-visually-hidden");
            receipt.textContent = "";
            updateAction();
            let reply;
            try { reply = await download(row, options, identity, action, close); } catch {}
            if (signal.aborted) return;
            row.pending = false;
            row.sent = reply?.state === "sent";
            row.failed = !row.sent;
            updateAction();
            receipt.classList.toggle("movie-visually-hidden", row.sent);
            receipt.textContent = row.sent ? (reply.opened ? "" : `Added ${row.name} to the download queue.`)
                : reply?.error || "Could not confirm the download. Return to Movies & TV and check Downloading before trying again.";
        };
        action.addEventListener("click", () => {
            // A closed dialog can still be waiting for its close event.
            if (action.getAttribute("aria-disabled") === "true" || panel.querySelector("dialog[open]")) return;
            if (row.site) { action.focus(); void send(); }
            else downloadOptions(panel, action, signal, identity, row,
                {icon, chainImages, palette, preferences, save, download: send});
        });
        const actions = document.createElement("div");
        actions.className = "movie-release-actions";
        actions.append(action, progress, receipt);
        item.append(quality, head, size, time, health, actions, raw);
        return item;
    }
    async function load() {
        if (busy) return true;
        busy = true;
        let reply;
        try { reply = await search(); }
        catch { reply = { error: "Release search is unavailable. Try again." }; }
        if (signal.aborted || !panel.isConnected) return false;
        busy = false;
        if (reply?.error || !Array.isArray(reply?.results)) {
            panel.hidden = false;
            outage.show();
            return true;
        }
        details = reply.title_details || {};
        const distinct = new Map();
        for (const item of reply.results) {
            if (typeof item?.title !== "string") continue;
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
            const audio = Object.keys(audioMarkers).filter(language => (episodes || [item]).every(video => audioMarkers[language].test(video?.title)));
            const quality = releaseQuality(episodes ? "" : title, height, size, comparisonLength);
            const tier = quality.tier === "4k-remux" ? quality.tier :
                ["poor", "tv", "estimated", "unknown"].includes(quality.tier) ? "hd" : videoQualityTier(height);
            const source = quality.source || (item.site ? "Web" : "");
            const picture = episodes && height > 0 && item.max_height > height ? `${height}p–${item.max_height}p`
                : quality.tier === "estimated" ? quality.label : height ? (height >= 4320 ? "8K" : height >= 2160 ? "4K" : `${height}p`) : "Unknown quality";
            const name = episodes ? `${title}, Season ${item.number}` : displayTitle(title);
            const sound = releaseSound(title);
            const seeders = number(item.seeders);
            const row = { title, fileName: item.title, name, season: item.number, height: episodes ? number(item.max_height) || height : height, size, mismatch, kind, audio, episodes, quality,
                tier: tier === "unknown" ? "hd" : tier, picture, source, sound,
                seconds: downloadSeconds(size, seeders), unavailable: !item.site && seeders === 0,
                seeders, guid: item.guid, indexerId: item.indexerId, site: item.site, url: item.url };
            const key = row.site ? `${row.site}\n${row.url}` : `${row.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}\n${Math.round((row.size || 0) / 1e8)}`;
            row.orderKey = key;
            const previous = distinct.get(key);
            const preferReference = canDownload && previous && Boolean(row.guid) !== Boolean(previous.guid);
            if (!previous || (preferReference ? row.guid : (row.seeders ?? -1) > (previous.seeders ?? -1)))
                distinct.set(key, row);
        }
        rows = [...distinct.values()].sort(compare);
        results.hidden = panel.hidden = !rows.length && outage.card.hidden;
        updateIdentity();
        for (const [tier, count] of tierCounts) count.textContent = rows.filter(row => row.tier === tier).length;
        list.replaceChildren(...rows.map(renderRow));
        empty.hidden = rows.length > 0;
        onResults(details, !results.hidden);
        outage.clear();
        return !panel.hidden;
    }
    function setMatches(list) {
        matches = Array.isArray(list) ? list : [];
        if (!results.hidden) updateIdentity();
    }
    function updateProgress() {
        for (const row of rows) row.updateProgress();
    }
    return {element: panel, load, setMatches, updateProgress};
}


