import { fixed, locale, serverError, text as t } from "./strings.js";

import { createServiceStatus } from "./service-status.js";
import { movieDialog } from "./movie-audio-ui.js";

const gib = 1024 ** 3;
// Download times assume this connection; the real speed depends on the server's line and on how many people share the file.
export const ASSUMED_MBPS = 100;

function number(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolution(title) {
    const height = title.match(/\b(4320|2160|1440|1080|720|576|540|480)[pi]\b/i)?.[1];
    if (height) return Number(height);
    if (/\b8K\b/i.test(title)) return 4320;
    if (/\b(?:4K|UHD)\b/i.test(title)) return 2160;
    if (/\bFHD\b/i.test(title)) return 1080;
    return /(?<!DTS[ ._-])\bHD\b/i.test(title) ? 720 : 0;
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
        name: t("Sound: ") + [format?.[1], suffix].filter(Boolean).join(" ")
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

const sourceBadges = new Map([
    ["knaben", ["K", "#176b70"]],
    ["limetorrents", ["L", "#52731a"]],
    ["the pirate bay", ["TPB", "#57382a"]],
    ["1337x", ["13", "#a34313"]],
    ["therarbg", ["R", "#234a91"]],
    ["eztv", ["E", "#654490"]],
    ["ncore", ["n", "#a12f43"]],
    ["kickasstorrents.ws", ["KA", "#2f6b3a", "Kickass"]],
    ["kickasstorrents.to", ["KA", "#2f6b3a", "Kickass"]],
    ["uindex", ["U", "#3d5a99"]],
    ["torrentdownload", ["TD", "#7a4a1e"]]
]);
const sourcePalette = ["#16675a", "#344e82", "#754274", "#795022", "#375c4a", "#654b70"];

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
export function releaseSeasons(title) {
    const range = title.match(/\bS(\d{1,3})[ ._]*[-–][ ._]*S?(\d{1,3})\b/i) ||
        title.match(/\b(?:seasons?|series)[ ._-]*(\d{1,3})[ ._-]*(?:-|–|to)[ ._-]*(\d{1,3})\b/i);
    if (range && Number(range[1]) <= Number(range[2])) return [Number(range[1]), Number(range[2])];
    const single = title.match(/\bS(\d{1,3})\b/i) ||
        title.match(/\b(?:season|(?:complete|full)[ ._-]+series)[ ._-]*(\d{1,3})\b/i);
    return single ? [Number(single[1]), Number(single[1])] : null;
}

export function releaseKind(title, catalogue = []) {
    const episode = title.match(/\bS(\d{1,3})[ ._-]*E(\d{1,3})\b/i) || title.match(/\b(\d{1,3})x(\d{2,3})\b/);
    if (episode) return `One episode, S${String(Number(episode[1])).padStart(2, "0")}E${String(Number(episode[2])).padStart(2, "0")}`;
    const span = releaseSeasons(title);
    if (span) {
        const [first, last] = span;
        if (first === last) return t("Season {0}", first);
        if (catalogue.length && catalogue.every(number => number >= first && number <= last)) return "Complete series";
        return t("Seasons {0} to {1}", first, last);
    }
    return /\b(?:(?:complete|full)[ ._-]+series|teljes[ ._-]+sorozat)\b/i.test(title) ? "Complete series" : "";
}

const TIERS = [
    ["8k", "8K", "Eight times HD picture; most are upscaled from 4K or less"],
    ["4k-remux", "4K HDR or Remux", "HDR, Dolby Vision or original 4K disc video"],
    ["4k-bluray", "4K Blu-ray", "Compressed 4K disc video"],
    ["4k-web", "4K Web", "4K streaming copy"],
    ["remux", "1080p Remux", "Original HD disc video"],
    ["bluray", "1080p Blu-ray", "Compressed HD disc video"],
    ["web", "1080p Web", "HD streaming copy"],
    ["hd", "720p", "Smaller HD picture"],
    ["tv", "SD", "Standard-definition video"],
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
    const tv = /\b(?:[hp]dtv|tvrip)\b/i.test(title);
    const dvd = /\b(?:dvd(?:[ ._-]?rip)?|dvd[59])\b/i.test(title);
    const sd = /\b(?:xvid|mpeg[ ._-]?4)\b/i.test(title);
    const premium = height >= 2160 && height < 4320 ? /\b(?:DV|DOVI|Dolby[ ._-]?Vision)\b/i.test(title) ? "Dolby Vision" :
        /\b(?:HDR(?:10)?|HLG)\b/i.test(title) ? "HDR" : remux ? t("Remux") : "" : "";
    const source = camera ? "Camera copy" : tv ? "TV" : dvd ? "DVD" : remux ? "Remux" : bluray ? "Blu-ray" : web ? "Web" : "";
    let tier = pictureTier(height);
    if (camera) tier = "poor";
    else if (!height && (source || sd)) tier = "tv";
    else if (premium) {
        tier = videoQualityTier(height, true);
    } else if (height >= 1080 && height < 2160 && remux) {
        tier = "remux";
    } else if (height >= 1080 && height < 4320 && bluray) {
        tier = height >= 2160 ? "4k-bluray" : "bluray";
    }
    if (tier === "unknown" && length > 0 && size > 0) {
        const mbps = size * 8 / (length * 60 * 1e6);
        const steps = [[1.5, "about 480p or lower"], [3.5, "about 720p"], [12, "about 1080p"]];
        const estimate = steps.find(([limit]) => mbps < limit)?.[1]
            ?? (mbps <= 30 ? "high-quality 1080p" : "4K or untouched disc");
        return {tier: "estimated", label: t("Estimated: {0} (from size and length)", estimate), source};
    }
    const picture = height >= 4320 ? "8K" : height >= 2160 ? ["4K", premium].filter(Boolean).join(" ") : height ? `${height}p` : "";
    const label = camera ? t("Camera copy") : [picture || (tier === "tv" ? "SD" : ""), source !== premium && source].filter(Boolean).join(" ")
        || (length > 0 ? t("Size needed to estimate quality") : t("Quality unknown"));
    return {tier, label, source, picture};
}

export function videoQualityTier(height, premium = false) {
    return premium && height >= 2160 && height < 4320 ? "4k-remux" : pictureTier(height);
}

export function ratingBadge(rawRating) {
    if (typeof rawRating !== "string" && typeof rawRating !== "number") return null;
    const rating = String(rawRating).trim().toUpperCase().replace(/^(?:US|GB|HU)[-\s]+/, "");
    const level = /^(?:KN|U|G|TV-Y|TV-G)$/.test(rating) ? "KN" :
        /^(?:6|PG|TV-Y7(?:-FV)?|TV-PG)$/.test(rating) ? "6" :
        /^(?:12A?|PG-13)$/.test(rating) ? "12" :
        /^(?:15|16|R|TV-14)$/.test(rating) ? "16" :
        /^(?:18|NC-17|TV-MA)$/.test(rating) ? "18" : /^(?:X|R18)$/.test(rating) ? "X" : null;
    if (!level) return null;
    const badge = chip("movie-chip movie-age-rating", level === "KN" || level === "X" ? "" : level, level);
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", level === "KN" ? t("Suitable for all ages") : level === "X" ? t("Adults only") : t("Age rating {0}", level));
    return badge;
}

export function formatMinutes(value) {
    if (!(value > 0)) return "";
    const minutes = Math.max(1, Math.round(value));
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return [hours ? t("{0} h", hours) : "", remainder ? t("{0} min", remainder) : ""].filter(Boolean).join(" ");
}

function downloadSeconds(bytes, seeders) {
    if (!(bytes > 0) || !(seeders > 0)) return Infinity;
    const mbps = Math.min(ASSUMED_MBPS, Math.max(1, seeders * 2));
    return bytes * 8 / (mbps * 1e6);
}

export function downloadTime(bytes, seeders) {
    const seconds = downloadSeconds(bytes, seeders);
    return Number.isFinite(seconds) ? t("about {0}", formatMinutes(seconds / 60)) : "";
}

export function availability(seeders) {
    if (seeders == null) return ["unknown", t("Availability unknown")];
    if (seeders >= 5) return ["ok", t("Available")];
    if (seeders >= 1) return ["slow", t("Few sources")];
    return ["none", t("Unavailable")];
}

/** A readable name for the tile: the title, then the year when the release name has one. */
export function displayTitle(name) {
    const spaced = name.replace(/[[(].*?[\])]/g, " ").replace(/[._]+/g, " ");
    const cut = spaced.search(/\b(?:19|20)\d{2}\b|\bS\d{1,3}(?:E\d{1,3})?\b|\b\d{3,4}[pi]\b|\bseasons?[ .-]*\d|\b(?:complete|full)[ .-]+series\b|\bcomplete(?=\s+S\d)|\b(?:[48]k|uhd|fhd|bluray|blu-ray|web[ -]?dl|web[ -]?rip|hdtv|dvdrip|xvid|mpeg4|remux|x26[45]|h26[45])\b|\bHD(?=$|[ -]+(?:web|blu|hdtv|x26[45]|h26[45]))/i);
    const title = (cut > 0 ? spaced.slice(0, cut) : spaced).replace(/\s+/g, " ").trim();
    const year = name.match(/(?:^|[ ._([])((?:19|20)\d{2})(?=[ ._)\]]|$)/)?.[1];
    return (title || name) + (year && cut > 0 ? ` (${year})` : "");
}

const audioMarkers = {
    hu: /\b(?:hun|magyarul|hungarian[ ._-]+audio|magyar[ ._-]+szinkron)\b/i,
    en: /\b(?:eng|english[ ._-]+audio)\b/i
};

function releaseStats(row) {
    const [level, available] = row.site ? ["ok", t("Available")] : availability(row.seeders);
    const cost = (value, thresholds) => Number.isFinite(value) && value > 0
        ? `movie-release-cost movie-release-cost-${["green", "amber", "orange", "red"][thresholds.filter(limit => value > limit).length]}`
        : "";
    const size = row.size / gib;
    const minutes = Math.round(row.seconds / 60);
    return [
        [t("Size"), row.size ? t("{0} GB", fixed(size, 1)) : t("Unknown"), "size", cost(size, [5, 15, 30])],
        [t("Download time"), row.seeders === 0 ? t("May never finish") : downloadTime(row.size, row.seeders) || t("Unknown"),
            "time", cost(Math.max(1, minutes), [10, 30, 60])],
        [t("Availability"), available, "health", "", level]
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
    pills.append(chip("movie-chip movie-release-quality", row.picture, row.quality.tier));
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
    const fields = [t("Hungarian audio"), t("Hungarian subtitles")].map((title, index) => {
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
    const english = document.createElement("div"), englishLabel = chip("", t("English subtitles"));
    english.className = "movie-confirm-option";
    const note = document.createElement("small");
    note.textContent = t("Added automatically");
    englishLabel.append(note);
    const locked = chip("movie-confirm-switch movie-confirm-locked", "");
    locked.setAttribute("aria-hidden", "true");
    english.append(icon(subtitlesPath), englishLabel, locked);
    options.append(english);
    const buttons = document.createElement("div"), cancel = document.createElement("button"), submit = document.createElement("button");
    buttons.className = "movie-confirm-buttons";
    cancel.type = "button";
    cancel.textContent = t("Cancel");
    submit.type = "submit";
    submit.autofocus = true;
    submit.append(icon("M12 3v12m-5-5 5 5 5-5M5 20h14"), t("Download"));
    buttons.append(cancel, submit);
    form.append(options, buttons);
    const dialog = movieDialog(parent, opener, t("Confirm download"), signal,
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
    preferences, save, downloadProgress, watchLink, onResults, onSlowSources, sourceIcon, matchTitle, seriesSeasons, searchButton}) {
    const panel = document.createElement("section");
    panel.className = "movie-releases";
    panel.hidden = true;
    panel.innerHTML = `
        <div class="movie-release-results" hidden>
            <aside class="movie-release-rail" aria-label="${t("Release details")}">
                <div class="movie-release-identity">
                    <span class="movie-art movie-release-poster" aria-hidden="true"><img alt="" decoding="async" referrerpolicy="no-referrer"></span>
                    <div class="movie-release-heading"><h2 tabindex="-1"></h2></div>
                </div>
                <div class="movie-release-legend-wrap">
                    <div class="movie-release-legend" role="group" aria-label="${t("Quality")}"></div>
                    <button type="button" class="movie-release-icon" aria-label="${t("Quality guide")}" aria-expanded="false" aria-controls="movie-release-guide"></button>
                </div>
                <div class="movie-quality-guide movie-release-disclosure" id="movie-release-guide" aria-hidden="true" inert><div><div>
                    <table class="movie-quality-table">
                        <thead><tr><th scope="col">${t("Label")}</th><th scope="col">${t("Meaning")}</th></tr></thead><tbody></tbody>
                    </table>
                    <p class="movie-web-meta">${t("Times assume a {0} Mbps connection.", ASSUMED_MBPS)}</p>
                </div></div></div>
                <p class="movie-web-meta" data-release-availability hidden>${t("Ask the server owner to enable downloads for your profile.")}</p>
            </aside>
            <div class="movie-release-content">
                <p class="movie-source-note movie-release-count" role="status" aria-atomic="true"></p>
                <ul id="movie-release-rows" class="movie-source-list" role="list" aria-label="${t("Release results")}"></ul>
            </div>
        </div>`;
    const results = panel.querySelector(".movie-release-results");
    const heading = panel.querySelector("h2");
    const poster = panel.querySelector(".movie-release-poster");
    const guide = panel.querySelector(".movie-quality-guide");
    const guideButton = panel.querySelector('[aria-controls="movie-release-guide"]');
    const list = panel.querySelector("ul");
    const visibleCount = panel.querySelector(".movie-release-count");
    const canDownload = typeof download === "function";
    panel.querySelector("[data-release-availability]").hidden = canDownload;
    const outage = createServiceStatus({
        detail: t("Reconnect to search for releases."), label: t("Retry release lookup"), retry: load,
        focus: () => results.hidden ? searchButton : heading, automatic: true
    });
    panel.prepend(outage.card);
    let rows = [], busy = false, matches = [], details = {}, identity = {}, usedPoster;
    const artworkLookups = new Map();
    const titleParts = name => {
        const year = /^(.*) \((\d{4})\)$/.exec(name);
        const text = year?.[1] ?? name;
        const title = text.replace(/\s+(?:(?:full|teljes)[ ._-]+(?:hun|eng|movie|film)|hun|eng|magyarul)$/i, "").trim();
        return {title: title || text, year: year?.[2]};
    };
    const searched = titleParts(displayTitle(cleanResultTitle(term)));
    const sharesPoster = row => [searched.title, identity.title, details.hungarian_title].some(name =>
        name && searchTitle(name) === row.artKey) &&
        (!row.artTitle.year || !(identity.year ?? searched.year) ||
            Number(row.artTitle.year) === Number(identity.year ?? searched.year));
    const tiers = [["all", t("All")], ["8k", "8K"], ["4k-remux", "4K HDR or Remux"], ["4k-web", "4K"], ["web", "1080p"],
        ["hd", "720p"], ["tv", "SD"], ["poor", t("Camera copy")], ["unknown", t("Unknown")]];
    const tierOrder = new Map(tiers.map(([tier], index) => [tier, index]));
    const legend = panel.querySelector(".movie-release-legend");
    let selectedTier = "all";
    const tierButtons = new Map(tiers.map(([tier, label]) => {
        const entry = document.createElement("button");
        entry.type = "button";
        entry.className = "movie-release-tier movie-release-quality";
        entry.dataset.level = tier;
        entry.setAttribute("aria-controls", list.id);
        const count = chip("movie-release-tier-count", "0");
        entry.append(label, " ", count);
        legend.append(entry);
        entry.addEventListener("click", () => {
            entry.focus({preventScroll: true});
            selectedTier = selectedTier === tier ? "all" : tier;
            filterRows();
        });
        return [tier, entry];
    }));
    function filterRows(added = 0) {
        let count = 0;
        for (const row of list.children) {
            row.hidden = selectedTier !== "all" && row.dataset.tier !== selectedTier;
            if (!row.hidden) count++;
        }
        for (const [tier, entry] of tierButtons) entry.setAttribute("aria-pressed", String(tier === selectedTier));
        const total = count === 1 ? "1 result" : count ? t("{0} results", count) : t("No results at this quality");
        const message = added ? `${added} ${added === 1 ? "result" : "results"} added. ${total}` : total;
        if (visibleCount.textContent !== message) visibleCount.textContent = message;
    }
    function toggleDisclosure(button, content) {
        const open = content.toggleAttribute("data-expanded");
        button.setAttribute("aria-expanded", String(open));
        content.setAttribute("aria-hidden", String(!open));
        content.toggleAttribute("inert", !open);
    }
    guideButton.append(icon("M12 11v5m0-8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"));
    guideButton.addEventListener("click", () => toggleDisclosure(guideButton, guide));

    const guideTable = guide.querySelector("tbody");
    for (const [id, label, meaning] of TIERS) {
        const row = guideTable.insertRow();
        row.insertCell().append(chip("movie-chip movie-release-quality", t(label), id));
        row.insertCell().textContent = t(meaning);
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

    function loadRowArtwork() {
        for (const row of rows) {
            if (row.site === "YouTube") continue;
            if (sharesPoster(row)) {
                row.setArtwork(identity);
                continue;
            }
            const key = row.artKey;
            if (!artworkLookups.has(key) && artworkLookups.size < 6)
                artworkLookups.set(key, matchTitle(row.artTitle.title).catch(() => null));
            void artworkLookups.get(key)?.then(reply => {
                if (signal.aborted || !panel.isConnected || sharesPoster(row)) return;
                const exact = Array.isArray(reply?.matches) ? reply.matches.filter(match =>
                    typeof match?.title === "string" && searchTitle(match.title) === row.artKey &&
                    (!row.artTitle.year || Number(match.year) === Number(row.artTitle.year))) : [];
                const narrowed = exact.length > 1 && (row.episodes || releaseKind(row.title)) ?
                    exact.filter(match => match.kind === "tv") : exact;
                if (narrowed.length === 1) row.setArtwork(narrowed[0], true);
            });
        }
    }

    list.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        const row = event.target.closest(".movie-release");
        const visible = [...list.children].filter(item => !item.hidden);
        const next = visible[visible.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
        const target = next?.querySelector(event.target.matches(".movie-release-file") ? ".movie-release-file" :
            event.target.matches("a") ? "a" : ".movie-release-action") ?? next?.querySelector(".movie-release-action");
        if (!target) return;
        event.preventDefault();
        target.focus();
    });

    function renderRow(row, index) {
        const item = document.createElement("li");
        item.className = "movie-release";
        item.dataset.tier = row.tier;
        const youtube = row.site === "YouTube";
        if (youtube) item.dataset.source = row.site;
        const art = chip("movie-art movie-release-row-poster", "");
        const image = document.createElement("img");
        art.setAttribute("aria-hidden", "true");
        art.append(image);
        image.alt = "";
        image.decoding = "async";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        const sourceBlock = document.createElement("div");
        sourceBlock.className = "movie-release-block";
        sourceBlock.append(chip("movie-chip movie-release-quality", row.picture, row.quality.tier));
        const head = document.createElement("div"), title = document.createElement("h3");
        head.className = "movie-release-head";
        title.className = "movie-release-title";
        title.textContent = row.name;
        const badges = document.createElement("div");
        badges.className = "movie-release-top";
        appendSoundChip(badges, row.sound, icon);
        if (row.kind) badges.append(chip("movie-release-kind", t(row.kind)));
        if (row.source && !row.picture.endsWith(row.source)) badges.append(chip("movie-release-source", row.source));
        if (row.audio.includes("hu")) badges.append(chip("movie-release-kind", t("Hungarian audio listed")));
        const provider = row.site || row.indexer;
        if (provider) {
            const key = provider.toLowerCase();
            const [monogram, color, label = provider] = sourceBadges.get(key) ??
                [[...provider.toUpperCase()][0], sourcePalette[titleHue(key) % sourcePalette.length]];
            const source = document.createElement("div");
            source.className = "movie-release-indexer";
            source.id = `movie-release-indexer-${index}`;
            const disc = chip("movie-release-indexer-badge", "");
            disc.setAttribute("aria-hidden", "true");
            if (youtube) {
                disc.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="5" width="21" height="14" rx="4.5" fill="#FF0033"/><path d="M10 8.8v6.4l5.4-3.2z" fill="#fff"/></svg>';
            } else {
                disc.style.setProperty("--movie-source-color", color);
                const fallback = chip("movie-release-indexer-monogram", monogram);
                disc.append(fallback);
                if (Number.isInteger(row.indexerId) && row.indexerId > 0 && sourceIcon) {
                    const favicon = document.createElement("img");
                    favicon.alt = "";
                    favicon.hidden = true;
                    favicon.onload = () => { favicon.hidden = false; fallback.hidden = true; };
                    favicon.onerror = () => { favicon.hidden = true; fallback.hidden = false; };
                    disc.append(favicon);
                    void sourceIcon(row.indexerId).then(url => {
                        if (!signal.aborted && /^data:image\/(?:png|x-icon);base64,/.test(url)) favicon.src = url;
                    });
                }
            }
            source.append(chip("movie-visually-hidden", t("From ")), disc, chip("movie-release-indexer-name", label));
            item.setAttribute("aria-describedby", source.id);
            sourceBlock.append(source);
        }
        if (youtube) {
            const seconds = row.video.duration ?? row.video.seconds;
            const ratio = seconds / (details.runtime_minutes * 60);
            if (ratio > 0 && Number.isFinite(ratio) && !details.runtime_estimated) {
                const same = ratio >= .9 && ratio <= 1.1;
                const what = details.kind === "tv" ? (details.season == null ? "series" : "season") : "film";
                badges.append(chip("movie-youtube-match", same ? t("Same length") : `${ratio < .9 ? t("Shorter") : t("Longer")} than the ${what}`,
                    same ? "same" : "different"));
            }
            const views = row.video.view_count;
            const meta = [row.video.uploader || row.video.channel, formatMinutes(seconds / 60),
                Number.isFinite(views) ? t(views === 1 ? "{0} view" : "{0} views", views.toLocaleString(locale() ?? "en")) : ""].filter(Boolean).join(", ");
            if (meta) head.append(chip("movie-web-meta", meta));
        }
        head.prepend(title, badges);

        const file = document.createElement("button"), raw = document.createElement("div");
        file.type = "button";
        file.className = "movie-release-file movie-release-icon";
        file.setAttribute("aria-label", t("File name for {0}", row.name));
        file.setAttribute("aria-expanded", "false");
        raw.id = `movie-release-file-${index}`;
        raw.className = "movie-release-name movie-release-disclosure";
        raw.setAttribute("aria-hidden", "true");
        raw.setAttribute("inert", "");
        file.setAttribute("aria-controls", raw.id);
        file.append(icon("M5 9l7 7 7-7"));
        file.addEventListener("click", () => toggleDisclosure(file, raw));
        const rawContent = document.createElement("div"), rawName = document.createElement("div");
        rawName.textContent = row.fileName;
        rawContent.append(rawName);
        raw.append(rawContent);
        const warnings = [row.mismatch ? t("This file is unusually small for a 1080p video of this length.") : "",
            row.size > 40 * gib ? t("This file uses over 40 GB of server space.") : ""].filter(Boolean);
        if (warnings.length) head.append(chip("movie-release-note", warnings.join(" ")));
        if (!youtube) head.append(file);

        const stat = ([name, value, className, tone, level]) => {
            const cell = document.createElement("div");
            cell.className = `movie-release-stat movie-release-${className}`;
            cell.append(chip("movie-release-stat-label", name), chip(`movie-release-stat-value ${tone}`, value, level));
            return cell;
        };
        const [size, time, health] = releaseStats(row).map(stat);
        time.title = t("Estimated from size and the number of people sharing the file, assuming a {0} Mbps connection.", ASSUMED_MBPS);
        if (row.seeders !== null) health.title = `${row.seeders} ${row.seeders === 1 ? "person shares" : "people share"} this file`;

        const action = document.createElement("button"), progress = document.createElement("progress");
        const receipt = chip("movie-release-receipt movie-visually-hidden", "");
        receipt.setAttribute("role", "status");
        action.type = "button";
        action.className = "movie-release-action";
        progress.className = "movie-release-progress";
        progress.max = 1;
        progress.setAttribute("aria-label", t("Download progress for {0}", row.name));
        progress.hidden = true;
        const label = () => youtube ? row.name : row.episodes ? `${row.name}, ${row.kind}`
            : `${row.name}, ${row.quality.label}, ${row.size ? t("{0} GB", fixed(row.size / gib, 1)) : t("size unknown")}`;
        const allowed = canDownload && (row.guid || row.site && (row.url || row.episodes));
        const actionLabel = chip("movie-release-action-label", "");
        action.append(icon("M12 3v12m-5-5 5 5 5-5M5 20h14"), actionLabel);
        row.updateProgress = () => {
            if (!row.sent) return;
            const fraction = downloadProgress(row);
            if (fraction != null) progress.value = fraction;
        };
        const updateAction = () => {
            const text = row.sent ? t("Added") : row.pending ? t("Sending…") : row.failed ? t("Try again") : t("Download");
            actionLabel.textContent = text;
            action.setAttribute("aria-label", `${text} ${label()}`);
            if (!allowed || row.pending || row.sent) action.setAttribute("aria-disabled", "true");
            else action.removeAttribute("aria-disabled");
            if (allowed && row.guid && !row.site && !row.sent) action.setAttribute("aria-haspopup", "dialog");
            else action.removeAttribute("aria-haspopup");
            progress.hidden = !row.sent;
            row.updateProgress();
        };
        if (!allowed) action.title = canDownload ? t("Search again to get a download reference.") : t("Ask the server owner to enable downloads for your profile.");
        updateAction();
        const send = async (selectedIdentity, options, close) => {
            row.pending = true;
            receipt.classList.add("movie-visually-hidden");
            receipt.textContent = "";
            updateAction();
            let reply;
            try { reply = await download(row, options, selectedIdentity, action, close); } catch {}
            if (signal.aborted) return;
            row.pending = false;
            row.sent = reply?.state === "sent";
            row.failed = !row.sent;
            updateAction();
            receipt.classList.toggle("movie-visually-hidden", row.sent);
            receipt.textContent = row.sent ? (reply.opened ? "" : t("Added {0} to the download queue.", row.name))
                : serverError(reply, t("Could not confirm the download. Return to Movies & TV and check Downloading before trying again."));
        };
        action.addEventListener("click", () => {
            // A closed dialog can still be waiting for its close event.
            if (action.getAttribute("aria-disabled") === "true" || panel.querySelector("dialog[open]")) return;
            const selectedIdentity = releaseIdentity();
            if (row.site) { action.focus(); void send(selectedIdentity); }
            else downloadOptions(panel, action, signal, selectedIdentity, row,
                {icon, chainImages, palette, preferences, save,
                    download: (options, close) => send(selectedIdentity, options, close)});
        });
        const actions = document.createElement("div");
        actions.className = "movie-release-actions";
        if (youtube) actions.append(watchLink(row.url));
        actions.append(action, progress, receipt);
        const releaseIdentity = () => sharesPoster(row) ? identity : {
            ...row.artTitle, kind: releaseKind(row.title) ? "tv" : "movie", ...row.match, tmdb_id: row.match?.id
        };
        row.setArtwork = (match, alternate = false) => {
            const name = match?.title ?? row.artTitle.title;
            art.dataset.initial = [...name][0]?.toUpperCase() ?? "";
            art.style.setProperty("--art-hue", titleHue(name));
            const source = match?.poster;
            if ((image.getAttribute("src") ?? "") !== (source ?? "")) chainImages(image, source ? [source] : []);
            if (alternate) {
                row.match = match;
                row.name = match.title + (row.episodes ? `, Season ${row.season}` :
                    row.artTitle.year ? ` (${row.artTitle.year})` : "");
                title.textContent = row.name;
                file.setAttribute("aria-label", t("File name for ") + row.name);
                progress.setAttribute("aria-label", t("Download progress for {0}", row.name));
                updateAction();
            }
        };
        if (youtube) row.setArtwork({poster: row.video.thumbnail?.startsWith?.("https://") ? row.video.thumbnail : null});
        else row.setArtwork(sharesPoster(row) ? identity : null);
        item.append(art, sourceBlock, head, size, time, health, actions);
        if (!youtube) item.append(raw);
        return item;
    }
    async function load() {
        if (busy || panel.querySelector("dialog[open]") || rows.some(row => row.pending)) return true;
        busy = true;
        let reply;
        try { reply = await search(); }
        catch { reply = { error: t("Release search is unavailable. Try again.") }; }
        if (signal.aborted || !panel.isConnected) return false;
        if (reply?.error || !Array.isArray(reply?.results)) {
            busy = false;
            panel.hidden = false;
            outage.show();
            return true;
        }
        try {
            const visible = await applyResults(reply.results, false, signal, reply.title_details);
            if (!signal.aborted && panel.isConnected && Number.isInteger(reply.slow_sources) && reply.slow_sources > 0)
                onSlowSources?.(reply.slow_sources);
            return visible;
        } finally { busy = false; }
    }
    async function applyResults(incoming, append, requestSignal, titleDetails) {
        if (!append) {
            details = titleDetails || {};
            updateIdentity();
        }
        const hasSeriesRange = incoming.some(item => {
            if (item?.site || typeof item?.title !== "string") return false;
            const span = releaseSeasons(item.title.replaceAll("_", " "));
            return span && span[0] !== span[1];
        });
        const seasons = hasSeriesRange && identity.kind !== "movie" ? await seriesSeasons(identity).catch(() => []) : [];
        if (requestSignal.aborted || signal.aborted || !panel.isConnected) return false;
        if (!append && (panel.querySelector("dialog[open]") || rows.some(row => row.pending))) return true;
        const previousRows = new Map(rows.map(row => [row.orderKey, row]));
        const distinct = new Map();
        for (const item of incoming) {
            if (typeof item?.title !== "string") continue;
            const title = cleanResultTitle(item.title);
            if (!title) continue;
            const youtube = item.site === "YouTube";
            const episodes = item.site === "Videa" && Array.isArray(item.episodes) && item.episodes.length ? item.episodes : null;
            const tags = title.replaceAll("_", " ");
            const height = number(item.height) || resolution(tags), size = number(item.size);
            const name = youtube ? title : episodes ? `${title}, Season ${item.number}` : displayTitle(title);
            const artTitle = titleParts(episodes ? title : name);
            const artKey = searchTitle(artTitle.title);
            const kind = episodes ? `${episodes.length} ${episodes.length === 1 ? "episode" : "episodes"}`
                : youtube || details.kind === "movie" ? "" : releaseKind(tags, sharesPoster({artKey, artTitle}) ? seasons : []);
            const isSeriesPack = details.kind === "tv" && kind === "Complete series";
            const length = isSeriesPack ? details.series_minutes || (details.season == null ? details.runtime_minutes : null)
                : details.runtime_minutes;
            const lengthEstimated = isSeriesPack ? details.series_estimated ?? details.runtime_estimated : details.runtime_estimated;
            const oneEpisode = kind.startsWith("One episode");
            const comparisonLength = oneEpisode && details.episode_count > 0 ? length / details.episode_count : length;
            const mismatch = !lengthEstimated && !oneEpisode && height === 1080 && comparisonLength > 0
                && size > 0 && size / comparisonLength < 3e6;
            const audio = Object.keys(audioMarkers).filter(language => (episodes || [item]).every(video => audioMarkers[language].test(video?.title)));
            const quality = releaseQuality(youtube || episodes ? "" : tags, height, size, comparisonLength);
            const tier = ["4k-remux", "poor", "tv"].includes(quality.tier) ? quality.tier : videoQualityTier(height);
            const source = quality.tier === "poor" || youtube ? "" : quality.source || (item.site ? t("Web") : "");
            const picture = episodes && height > 0 && item.max_height > height ? `${height}p–${item.max_height}p`
                : quality.tier === "poor" ? quality.label : quality.picture ? quality.picture
                : quality.tier === "tv" ? "SD" : quality.tier === "estimated" ? quality.label : t("Unknown quality");
            const sound = releaseSound(title);
            const seeders = number(item.seeders);
            const indexer = !item.site && typeof item.source === "string" ? item.source.trim() : "";
            const row = { title, fileName: item.title, name, artTitle, artKey,
                season: item.number, seasons: kind ? releaseSeasons(tags) : null,
                height: episodes ? number(item.max_height) || height : height, size, mismatch, kind, audio, episodes, quality,
                tier, picture, source, indexer, sound, video: youtube ? item : null,
                seconds: downloadSeconds(size, seeders), unavailable: !item.site && seeders === 0,
                seeders, guid: item.guid, indexerId: item.indexerId, site: item.site, url: item.url };
            const key = row.site ? `${row.site}\n${row.url}` : `${row.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}\n${row.size ?? 0}`;
            if (append && previousRows.has(key)) continue;
            row.orderKey = key;
            row.sent = previousRows.get(key)?.sent;
            const previous = distinct.get(key);
            const preferReference = canDownload && previous && Boolean(row.guid) !== Boolean(previous.guid);
            if (!previous || (preferReference ? row.guid : (row.seeders ?? -1) > (previous.seeders ?? -1)))
                distinct.set(key, row);
        }
        const added = [...distinct.values()].sort(compare);
        const start = append ? rows.length : 0;
        if (append && !added.length) return false;
        rows = append ? [...rows, ...added] : added;
        if (!append) {
            if (!rows.length && results.contains(document.activeElement)) searchButton.focus({preventScroll: true});
            else if (list.contains(document.activeElement)) heading.focus({preventScroll: true});
        }
        results.hidden = !rows.length;
        panel.hidden = results.hidden && outage.card.hidden;
        for (const [tier, entry] of tierButtons) {
            const count = tier === "all" ? rows.length : rows.filter(row => row.tier === tier).length;
            entry.lastElementChild.textContent = count;
            entry.hidden = !count && ["poor", "unknown"].includes(tier) && !entry.matches(":focus");
            if (entry.hidden && selectedTier === tier) selectedTier = "all";
        }
        const nodes = added.map((row, index) => renderRow(row, start + index));
        if (append) list.append(...nodes);
        else list.replaceChildren(...nodes);
        filterRows(append ? added.length : 0);
        onResults(details, !results.hidden, append);
        requestAnimationFrame(() => {
            if (!signal.aborted && panel.isConnected) loadRowArtwork();
        });
        outage.clear();
        panel.hidden = results.hidden;
        return !panel.hidden;
    }
    function setMatches(list) {
        matches = Array.isArray(list) ? list : [];
        if (!results.hidden) {
            updateIdentity();
            for (const row of rows) if (row.site !== "YouTube" && sharesPoster(row)) row.setArtwork(identity);
        }
    }
    function updateProgress() {
        for (const row of rows) row.updateProgress();
    }
    return {element: panel, load, append: (incoming, requestSignal) => applyResults(incoming, true, requestSignal), setMatches, updateProgress};
}


