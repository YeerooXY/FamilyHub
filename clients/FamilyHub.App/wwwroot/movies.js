import { fixed, serverError, text as t } from "./strings.js";

import { buildPlayerUi, clock, watchPlayerIdle } from "./movie-player-ui.js";
import { addAudioDialog, audioJobResults, audioJobRunning, audioLanguage as audioLanguageName, movieDialog } from "./movie-audio-ui.js";
import { movieAudioSync } from "./movie-audio-sync.js";
import { appendSoundChip, buildReleaseSearch, cleanResultTitle, displayTitle, formatMinutes, librarySound, ratingBadge, releaseKind, releaseSeasons, videoQualityTier } from "./movie-releases.js";
import { createServiceStatus } from "./service-status.js";

export { formatMovieBytes } from "./movie-player-ui.js";

// AbortSignal.timeout needs Chromium 103; older televisions (webOS) need this form.
function timeoutSignal(ms) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

function el(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
}

function loadingShape(className, ...children) {
    const node = el("div");
    node.className = className;
    node.append(...children);
    return node;
}

// Movies customisation (round 5): the saved layout, kept per profile on the server and cached on this device.
export const homeRowIds = ["continue", "list", "recent", "series", "movies", "collections", "genres"];
export const homeRowNames = {continue: "Continue watching", list: "My list", recent: "Recently added", series: "Series",
    movies: "Movies", collections: "Collections", genres: "Genres"};
export const titleSectionIds = ["episodes", "related", "cast"];
const titleSectionNames = {episodes: "Episodes", related: "Related", cast: "Cast"};
const uiChoices = {resumeStyle: ["landscape", "poster"], resumePress: ["resume", "title"], titleBackground: ["backdrop", "blurred", "plain"]};
const uiFlags = {banner: true, resumePrompt: true, spoilerBlur: false, oled: false};
const uiKey = viewer => "familyhub:movie-tracks:" + JSON.stringify(viewer) + ":ui";

function ordered(saved, ids) {
    const known = (Array.isArray(saved) ? saved : []).map(entry => entry?.id ?? entry).filter((id, index, all) => ids.includes(id) && all.indexOf(id) === index);
    return [...known, ...ids.filter(id => !known.includes(id))];
}

export function normalizeMovieUi(value) {
    const hidden = new Set((Array.isArray(value?.rows) ? value.rows : []).filter(row => row?.visible === false).map(row => row.id));
    return {
        ...Object.fromEntries(Object.entries(uiFlags).map(([key, fallback]) => [key, typeof value?.[key] === "boolean" ? value[key] : fallback])),
        ...Object.fromEntries(Object.entries(uiChoices).map(([key, list]) => [key, list.includes(value?.[key]) ? value[key] : list[0]])),
        rows: ordered(value?.rows, homeRowIds).map(id => ({id, visible: !hidden.has(id)})),
        titleSections: ordered(value?.titleSections, titleSectionIds),
        revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0
    };
}

export function readMovieUi(viewer) {
    try { return normalizeMovieUi(JSON.parse(localStorage.getItem(uiKey(viewer)))); } catch { return normalizeMovieUi(); }
}

function saveMovieUi(viewer, ui) {
    try { localStorage.setItem(uiKey(viewer), JSON.stringify(ui)); } catch {}
}

// Settings asks Movies Home to open the Customise Home sheet once it has loaded.
export function requestCustomiseHome(viewer) {
    localStorage.setItem(uiKey(viewer) + ":open", "1");
}

const landscapeRow = (id, ui) => id === "recent" || id === "continue" && ui.resumeStyle !== "poster";

function movieLoading(kind, count = 3, ui) {
    const block = (className = "") => loadingShape("movie-loading-block " + className);
    const repeated = (count, make) => Array.from({length: count}, make);
    let parts;
    if (kind === "home") {
        ui ??= normalizeMovieUi();
        const hero = loadingShape("movie-hero", loadingShape("movie-hero-body",
            block("movie-loading-heading"), block("movie-loading-line"), block("movie-loading-action")));
        const cards = format => loadingShape(`movie-shelf movie-loading-${format}`, block("movie-loading-label"),
            loadingShape("movie-shelf-scroll", loadingShape("movie-cards", ...repeated(6, () =>
                loadingShape("movie-loading-card", block("movie-art"), loadingShape("movie-caption", block("movie-loading-line")))))));
        // The first screen holds the banner and two rows, or three rows without a banner.
        const shown = ui.rows.filter(row => row.visible).slice(0, ui.banner ? 2 : 3);
        parts = [...(ui.banner ? [hero] : []), ...shown.map(row => cards(landscapeRow(row.id, ui) ? "landscape" : "portrait"))];
    } else if (kind === "seasons") {
        parts = [loadingShape("movie-season-picker", loadingShape("movie-season-pills",
            ...repeated(3, () => block("movie-loading-pill"))))];
    } else {
        const list = el("ol");
        list.append(...repeated(count, () => {
            const row = el("li");
            row.append(loadingShape("movie-episode-body", block("movie-episode-still"),
                loadingShape("movie-episode-text", block("movie-loading-line"), block("movie-loading-label"),
                    block("movie-loading-progress"))));
            return row;
        }));
        parts = [loadingShape("movie-season", list)];
    }
    const node = loadingShape(
        kind === "home" ? "movie-loading movie-home-skeleton" : kind === "episodes" ? "movie-loading movie-episode-loading" : "movie-loading",
        ...parts);
    node.setAttribute("aria-hidden", "true");
    return node;
}

export function showMovieLoading(host, show = true, viewer) {
    if (show) {
        const status = el("p", t("Loading movies and TV…"));
        status.className = "movie-visually-hidden";
        status.setAttribute("role", "status");
        host.replaceChildren(loadingShape("movie-session-loading", status, movieLoading("home", 3, viewer ? readMovieUi(viewer) : undefined)));
    } else host.querySelector(":scope > .movie-session-loading")?.remove();
}

function searchTitle(text) {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const libraryId = id => /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id ?? "");
const tmdbIdOf = item => String(item?.ProviderIds?.Tmdb ?? item?.ProviderIds?.TMDb ?? "");
const personKeyOf = person => person?.Id || (tmdbIdOf(person) ? "tmdb-" + tmdbIdOf(person) : searchTitle(person?.Name ?? ""));

const languageCodes = {
    hu: ["hu", "hun", "hungarian", "magyar"],
    en: ["en", "eng", "english"]
};

class SubtitleSearchError extends Error {}

function preferredTrack(tracks, language) {
    if (!languageCodes[language]) return undefined;
    const matches = tracks.filter(track => trackLanguage(track) === language);
    return matches.find(track => track.IsDefault) ?? matches[0];
}

function trackLanguage(track) {
    let code = track?.Language?.trim().toLowerCase().split(/[-_]/)[0];
    if (!code || code === "und") code = track?.DisplayTitle?.trim().toLowerCase();
    return Object.keys(languageCodes).find(language => languageCodes[language].includes(code));
}

const textSubtitle = track => track.IsTextSubtitleStream || /^(srt|subrip|ass|ssa|vtt|webvtt)$/i.test(track.Codec ?? "");
const bitmapSubtitle = track => /^(dvdsub|dvd_subtitle|pgs|hdmv_pgs_subtitle|pgssub)$/i.test(track.Codec ?? "");
const filenameStem = path => (path ?? "").split(/[/\\]/).pop().replace(/\.[^.]+$/, "").toLowerCase();

async function subtitleRows(streams, videoPath, readLineCount) {
    const video = filenameStem(videoPath);
    const rows = await Promise.all(Object.keys(languageCodes).reverse().map(async language => {
        const matches = streams.filter(track => track.Type === "Subtitle" && trackLanguage(track) === language);
        const text = matches.filter(textSubtitle);
        if (text.length < 2) return text[0] ?? matches.find(bitmapSubtitle);
        const sidecar = text.find(track => track.FamilyHubSubtitleSidecar) ?? (video && text.find(track => {
            const name = track.Path?.split(/[/\\]/).pop().toLowerCase();
            return name === `${video}.${language}.srt`;
        }));
        if (sidecar) return sidecar;
        const named = video ? text.filter(track => languageCodes[language].some(code =>
            filenameStem(track.Path) === `${video}.${code}`)) : [];
        const candidates = named.length ? named : text;
        if (candidates.length === 1) return candidates[0];
        const counts = await Promise.all(candidates.map(readLineCount));
        return candidates[counts.indexOf(Math.max(...counts))];
    }));
    return rows.filter(Boolean);
}

// Browser errors can include the stream URL. Keep only known media diagnostic words.
const mediaErrorWords = /\b(?:media_err_(?:aborted|network|decode|src_not_supported)|pipeline_error_(?:decode|network|initialization_failed)|demuxer_error_(?:could_not_open|could_not_parse|no_supported_streams)|decode|decoder|decoding|demuxer|pipeline|media|video|audio|error|failed|failure|format|unsupported|supported|stream|network|aborted|source|invalid|could|not|no|to|open|parse|initialize)\b/gi;
function mediaErrorMessage(message) {
    return (String(message ?? "").slice(0, 512).replace(/\S*[/=?&#@%\\]\S*|\S*:\S+/g, " ").match(mediaErrorWords) ?? [])
        .join(" ").slice(0, 160);
}

const externalDts = track => track?.IsExternal && /^(?:dts|dca)(?:$|[-_])/i.test(track.Codec ?? "");

const labels = { default: "Default", hu: "Hungarian", en: "English", off: "Off" };
const preferencesKey = viewer => "familyhub:movie-tracks:" + JSON.stringify(viewer);
const downloadActivityKey = viewer => preferencesKey(viewer) + ":downloading";
const downloadPollInterval = 5000;
const runningMovieDownloads = items => items.filter(item => !Array.isArray(item?.results) && Number.isFinite(item?.progress) &&
    item.progress >= 0 && item.progress < 1 &&
    ["Waiting", "Downloading", "Almost done", "Stalled"].includes(item.state));
function rememberDownloadActivity(viewer, downloading) {
    try {
        if (downloading) localStorage.setItem(downloadActivityKey(viewer), String(Date.now()));
        else localStorage.removeItem(downloadActivityKey(viewer));
    } catch {}
}

export function watchHubDownloads(indicator, viewer, app) {
    let lastActive = 0;
    try { lastActive = Number(localStorage.getItem(downloadActivityKey(viewer))); } catch {}
    let pending = lastActive > Date.now() - 30 * 86400000;
    const life = new AbortController();
    let timer, reading = false;
    indicator.hidden = !pending;
    const visible = () => pending && !life.signal.aborted && !document.hidden && indicator.isConnected;
    const schedule = delay => {
        clearTimeout(timer);
        if (visible()) timer = setTimeout(check, delay);
    };
    async function check() {
        if (!visible() || reading) return;
        reading = true;
        try {
            const reply = await app.invokeMethodAsync("HubMovieDownloads");
            if (visible() && reply?.available && Array.isArray(reply.items)) {
                if (!reply.items.length && Date.now() - lastActive < 3100) return;
                pending = runningMovieDownloads(reply.items).length > 0;
                indicator.hidden = !pending;
                rememberDownloadActivity(viewer, pending);
            }
        } catch {}
        finally { reading = false; schedule(downloadPollInterval); }
    }
    document.addEventListener("visibilitychange", () => schedule(0), {signal: life.signal});
    schedule(0);
    return {close() { life.abort(); clearTimeout(timer); }};
}
const dataChoices = ["auto", "full", "good", "saver", "lowest"];
const screenChoices = ["auto", "1080", "1440", "2160", "4320", "projector"];
const homeBackgrounds = {
    violet: ["#302052", "#121126"], blue: ["#173f5c", "#101b32"], green: ["#234637", "#111e24"],
    amber: ["#603b26", "#261c25"], red: ["#551f36", "#201221"], slate: ["#34374d", "#151925"]
};
const dataLimits = {
    good: { bitrate: 2500000, height: 720 },
    saver: { bitrate: 1000000, height: 480, audioBitrate: 96000 },
    lowest: { bitrate: 500000, height: 360, audioBitrate: 96000 }
};

export function movieQualityEstimates(original) {
    const label = value => t("About {0} GB per hour", fixed(value, 1));
    const estimates = Object.fromEntries(Object.entries(dataLimits).map(([choice, {bitrate}]) =>
        [choice, label(Math.round(bitrate * 36 / 8_000_000) / 10)]));
    estimates.auto = estimates.saver;
    if (Number.isFinite(original) && original >= 0) estimates.full = label(original);
    return estimates;
}

function videoRange(track) {
    const range = track?.VideoRangeType || track?.VideoRange;
    if (/^(HDR|HLG|DOVI|DolbyVision)/i.test(range ?? "") || /^HDR$/i.test(track?.VideoRange ?? "") ||
        /^(smpte2084|arib-std-b67)$/i.test(track?.ColorTransfer ?? ""))
        return "HDR";
    if (/^SDR$/i.test(range ?? "") || /^SDR$/i.test(track?.VideoRange ?? "")) return "SDR";
    return "";
}

const conversionReasons = {
    VideoRangeTypeNotSupported: t("HDR to SDR"),
    VideoCodecNotSupported: t("Unsupported video codec"),
    AudioCodecNotSupported: t("Unsupported audio codec"),
    SubtitleCodecNotSupported: t("Unsupported subtitle format"),
    VideoResolutionNotSupported: t("Screen resolution limit"),
    ContainerBitrateExceedsLimit: t("Bitrate limit"),
    VideoBitrateNotSupported: t("Bitrate limit"),
    AudioChannelsNotSupported: t("Audio channel limit"),
    ContainerNotSupported: t("Unsupported file format")
};

function normalizeMoviePreferences(prefs) {
    return {
        audio: ["hu", "en"].includes(prefs?.audio) ? prefs.audio : "default",
        backupAudio: ["hu", "en"].includes(prefs?.backupAudio) && prefs.backupAudio !== prefs.audio ? prefs.backupAudio : "none",
        subtitles: ["off", "hu", "en"].includes(prefs?.subtitles) ? prefs.subtitles : "default",
        dataSaver: dataChoices.includes(prefs?.dataSaver) ? prefs.dataSaver : "auto",
        screen: screenChoices.includes(prefs?.screen) ? prefs.screen : "auto",
        ...(prefs?.autoSkipIntro === true ? {autoSkipIntro: true} : {}),
        ...(prefs?.autoSkipRecap === true ? {autoSkipRecap: true} : {}),
        ...(prefs?.autoNext === false ? {autoNext: false} : {}),
        ...(prefs?.parentalGuide === true ? {parentalGuide: true} : {}),
        ...(typeof prefs?.downloadAudio === "boolean" ? {downloadAudio: prefs.downloadAudio} : {}),
        ...(typeof prefs?.downloadSubtitles === "boolean" ? {downloadSubtitles: prefs.downloadSubtitles} : {}),
        ...(["preset", "backdrop"].includes(prefs?.backgroundStyle) ? {backgroundStyle: prefs.backgroundStyle} : {}),
        ...(prefs?.layoutPreview === true ? {layoutPreview: true} : {}),
        ...(prefs?.ratings === false ? {ratings: false} : {}),
        ...(prefs?.chapterMarks === false ? {chapterMarks: false} : {}),
        ...(prefs?.seekPictures === false ? {seekPictures: false} : {}),
        ...(Object.prototype.hasOwnProperty.call(homeBackgrounds, prefs?.homeBackground) ? {homeBackground: prefs.homeBackground} : {})
    };
}

export function shuffledEpisodes(items, random = Math.random) {
    const shuffle = rows => {
        for (let i = rows.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [rows[i], rows[j]] = [rows[j], rows[i]];
        }
        return rows;
    };
    return [...shuffle(items.filter(item => !item.UserData?.Played)), ...shuffle(items.filter(item => item.UserData?.Played))];
}

export function movieScreen(choice) {
    const {width, height} = window.screen;
    const ratio = window.devicePixelRatio || 1;
    const reported = {
        width: Math.round(Math.max(width, height) * ratio),
        height: Math.round(Math.min(width, height) * ratio)
    };
    if (choice === "auto" && reported.width > 0 && reported.height > 0) return reported;
    const limit = choice === "projector" ? 4320 : Number(choice) || 1080;
    return {width: Math.round(limit * 16 / 9), height: limit};
}

export function readMoviePreferences(viewer) {
    try {
        return normalizeMoviePreferences(JSON.parse(localStorage.getItem(preferencesKey(viewer))));
    } catch {
        return normalizeMoviePreferences();
    }
}

export function saveMoviePreferences(viewer, prefs) {
    try {
        localStorage.setItem(preferencesKey(viewer), JSON.stringify(normalizeMoviePreferences(prefs)));
        return true;
    } catch {
        return false;
    }
}

export function moviePreviewLibrary(now = Date.now()) {
    const series = ["Signal House", "Low Country", "Public Record", "The Glass District", "Cinder Coast", "North Platform",
        "After the Crossing", "Blue County", "The Last Orchard", "Field Notes", "Gull Station", "Between Tides"];
    const films = ["Midnight Meridian", "Paper Moons", "Northbound Ferry", "A Room in September", "Letters from Mars",
        "Winter Circuit", "The Second Coast", "Lantern Road", "Prism City", "A Map of Small Things",
        "The Far Orchard", "Dust and Water", "Radio Atlas", "A Quiet Harbor", "Long Range", "The Borrowed Train",
        "Night Signals", "Orchid Street", "Old Quarry", "The Tenth Bridge", "Red Moon Motel", "Snow on the Pier",
        "The Blue Hour", "Copper Fields", "Flight of the Kestrel", "Last Train to June", "Fox Island", "The Tide Clock",
        "Cities in the Sky", "Sunday Market", "A River in Winter", "Glass Engine", "Orbit Nine", "The Violin Case",
        "Fallow Ground", "Deepwater Archive", "The Third Eclipse", "Mile Marker", "Alpine Radio", "Plum Season"];
    const genres = ["Science Fiction", "Drama", "Adventure", "Thriller", "Fantasy"];
    const make = (names, Type) => names.map((Name, index) => ({
        Id: `preview-${Type}-${index}`, Name: `${Name} (Demo)`, Type,
        Overview: Name === "Midnight Meridian" ? "A night dispatcher traces a distress call to a closed station. The caller gives her the number of the next train and tells her to stop it before midnight." : undefined,
        Genres: [genres[index % genres.length]], ProductionYear: 2001 + index % 25, Demo: true,
        RunTimeTicks: Type === "Movie" ? 80 * 6e8 : undefined,
        DateCreated: new Date(now - (Type === "Movie" && index >= 32 ? index - 31 : 30 + index) * 86400000).toISOString(),
        UserData: {IsFavorite: index >= 1 && index <= 4, PlayedPercentage: index % 6 === 0 ? 20 + index : 0},
        ImageTags: index % 4 ? {Primary: `preview-${index % 3}`} : {},
        BackdropImageTags: index % 4 || index === 0 ? [`preview-${(index + 1) % 3}`] : [],
        People: index % 3 ? [{Name: "Morgan Vale", Role: "Alex", Type: "Actor"}] : []
    }));
    const movies = make(films, "Movie"), shows = make(series, "Series");
    const collections = make(["Meridian Films", "Harbor Stories", "The Orbit Collection"], "BoxSet");
    return [...movies, ...shows, ...collections.map((item, index) => ({...item,
        ChildIds: movies.filter((_, position) => position % 3 === index).slice(0, 5).map(movie => movie.Id)}))];
}

// hls.js is a classic UMD script. It never reached the app through import() (hls_loaded=False in every transcode
// failure on Windows and Android, 26 Nov), so load it the way the web player does, with a script element.
let hlsLoading;
function loadHls() {
    if (globalThis.Hls) return Promise.resolve();
    hlsLoading ??= new Promise(resolve => {
        const script = document.createElement("script");
        script.src = new URL("vendor/hls.light.min.js", document.baseURI).href;
        script.onload = script.onerror = () => resolve();
        document.head.append(script);
    }).then(() => globalThis.Hls ? undefined : import("./vendor/hls.light.min.js").catch(() => {}))
      .then(() => { if (!globalThis.Hls) hlsLoading = undefined; });
    return hlsLoading;
}

export function openMovies(host, session, app, viewer, homeBudget = 9500) {
    const preview = !session;
    const previewItems = preview ? moviePreviewLibrary().map((item, index) => ({
        ...item, UserData: {...item.UserData, LastPlayedDate: new Date(Date.now() - index * 86400000).toISOString()}
    })) : [];
    const previewNextUp = previewItems.filter(item => item.Type === "Series").slice(0, 2).map((item, index) => ({
        ...item, Id: item.Id + "-episode", Type: "Episode", SeriesId: item.Id, SeriesName: item.Name,
        Name: ["The Crossing", "First Light"][index], ParentIndexNumber: 1, IndexNumber: index + 2,
        UserData: {LastPlayedDate: new Date(1000).toISOString()}
    }));
    if (preview) session = {url: "https://layout-preview.invalid/", media_url: "https://layout-preview.invalid/", user: "preview"};
    const base = new URL(session.url.replace(/\/?$/, "/"));
    const mediaBase = new URL(session.media_url);
    if (!preview && (mediaBase.protocol !== "https:" || mediaBase.origin !== new URL(viewer.server).origin)) throw Error("Invalid movie media origin");
    const life = new AbortController();
    let video, current, selection = 0, active = true, reports = Promise.resolve();
    const pendingReportsByItem = new Map();
    const url = (path, params = {}) => {
        const target = new URL(path.replace(/^\/+/, ""), base);
        if (target.origin !== base.origin) throw Error("Invalid movie URL");
        for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
        return target;
    };
    const request = async (path, params, body, signal = life.signal) => {
        const activeSignal = signal ?? timeoutSignal(8000);
        if (activeSignal.aborted) throw new DOMException(t("Movie request cancelled"), "AbortError");
        if (preview) {
            if (body || !["Items", "UserItems/Resume", "Shows/NextUp", "Genres"].includes(path)) throw Error("Unavailable in layout preview");
            const group = previewItems.find(item => item.Id === params.parentId)?.ChildIds;
            const items = path === "Shows/NextUp" ? previewNextUp :
                path === "Genres" ? [...new Set(previewItems.flatMap(item => item.Genres))].map(Name => ({Name})) :
                previewItems.filter(item => (!params.includeItemTypes || params.includeItemTypes.split(",").includes(item.Type)) &&
                    (!group || group.includes(item.Id)) && (!params.genres || item.Genres.includes(params.genres)) &&
                    (!params.isFavorite || item.UserData.IsFavorite) &&
                    (!params.searchTerm || searchTitle(item.Name).includes(searchTitle(params.searchTerm))) &&
                    (path !== "UserItems/Resume" || item.UserData.PlayedPercentage > 0));
            if (params.sortBy === "DateCreated") items.sort((a, b) => b.DateCreated.localeCompare(a.DateCreated));
            const start = params.startIndex ?? 0;
            return {Items: items.slice(start, start + (params.limit ?? items.length)), TotalRecordCount: items.length};
        }
        const query = new URLSearchParams(params).toString();
        let abort;
        const cancelled = new Promise((_resolve, reject) => {
            abort = () => reject(new DOMException(t("Movie request cancelled"), "AbortError"));
            activeSignal.addEventListener("abort", abort, {once: true});
        });
        try {
            const json = await Promise.race([app.invokeMethodAsync("MovieLibrary", path, query, body ?? null), cancelled]);
            const reply = JSON.parse(json);
            if (!Object.prototype.hasOwnProperty.call(reply, "result")) throw Error("Jellyfin request failed");
            return reply.result;
        } finally {
            activeSignal.removeEventListener("abort", abort);
        }
    };
    const mediaUrl = (path, params) => {
        const original = url(path.startsWith(base.pathname) ? path.slice(base.pathname.length) : path, params);
        if (!original.pathname.startsWith(base.pathname)) throw Error("Invalid movie media path");
        for (const key of Array.from(original.searchParams.keys())) {
            if (/^(?:api[_-]?key|token|access[_-]?token|x-emby-token|x-mediabrowser-token)$/i.test(key)) original.searchParams.delete(key);
        }
        const target = new URL(original.pathname.slice(base.pathname.length), mediaBase);
        if (!target.href.startsWith(mediaBase.href)) throw Error("Invalid movie media path");
        target.search = original.search;
        return target;
    };
    async function withinMovieLoad(run, signal, budget = 9500) {
        const bounded = new AbortController();
        const cancel = () => bounded.abort();
        const timer = setTimeout(cancel, budget);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, {once: true});
        try { return await run(bounded.signal); }
        finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    }
    const searchLibrary = (path, params, body, signal) =>
        withinMovieLoad(bounded => request(path, params, body, bounded), signal);
    // Limit repeated reports while keeping the initial and forced attempts distinct.
    const lastNote = new Map();
    const send = (kind, method, title, minutes, diagnostics = null) =>
        Promise.resolve(app.invokeMethodAsync("MovieEvent", kind, method ?? "", title ?? "", minutes ?? null, diagnostics)).catch(() => {});
    const note = (kind, method = "", diagnostics = null) => {
        const key = kind + ":" + method + ":" + (diagnostics?.forced ?? diagnostics?.reason ?? "");
        if (!active || performance.now() - (lastNote.get(key) ?? -6e4) < 6e4) return;
        lastNote.set(key, performance.now());
        send(kind, method, "", null, diagnostics);
    };
    const noteLookupFailure = (kind, error, method) => note(kind, method, {
        reason: error?.name === "AbortError" ? "timeout" : error instanceof SyntaxError || error instanceof TypeError
            ? "invalid_response" : "request_failed"
    });
    const status = el("p");
    status.setAttribute("role", "status");
    status.className = "movie-load-status";
    const shelfStatus = el("p");
    shelfStatus.className = "movie-visually-hidden";
    shelfStatus.setAttribute("role", "status");
    const relatedFailures = [t("Related films are unavailable"), t("Related series are unavailable")];
    const player = el("section"), library = el("div");
    player.className = "movie-player";
    player.tabIndex = -1;
    player.setAttribute("aria-label", t("Movie player"));
    const preferenceViewer = viewer ?? [base.origin, session.user];
    // Customisation: this device's cached copy paints first, then the profile's saved copy on the server replaces it.
    let movieUi = readMovieUi(preferenceViewer), uiChanged = () => {}, uiNotice = null, uiNoticeChanged = () => {};
    let uiSaving = Promise.resolve(), queuedUiSaves = 0, uiConflict = null;
    const applyThemeUi = () => {
        host.dataset.movieOled = String(movieUi.oled);
        document.body.dataset.movieOled = String(movieUi.oled);
    };
    life.signal.addEventListener("abort", () => { delete document.body.dataset.movieOled; }, {once: true});
    applyThemeUi();
    function adoptUi(preferences) {
        const next = normalizeMovieUi({...preferences?.movie_ui, revision: preferences?.movie_ui_revision});
        const same = JSON.stringify({...next, revision: 0}) === JSON.stringify({...movieUi, revision: 0});
        if (same && next.revision === movieUi.revision) return false;
        movieUi = next;
        saveMovieUi(preferenceViewer, movieUi);
        applyThemeUi();
        // A new revision alone changes nothing on screen, so the sheet is not rebuilt under the user's hands.
        if (!same) uiChanged();
        return !same;
    }
    function setUiNotice(text, actions = []) {
        uiNotice = text ? {text, actions} : null;
        uiNoticeChanged();
    }
    // A failed layout save keeps the change on this device and reports why, so the server log shows the cause.
    function uiSaveFailed(reason, retry) {
        note("layout-sync-failed", "", {reason});
        setUiNotice(t("Could not save this to the server. It is kept on this device."), [[t("Try saving again"), retry]]);
    }
    async function readServerUi() {
        if (preview) return null;
        try {
            const reply = JSON.parse(await app.invokeMethodAsync("MovieProfilePreferences", null));
            if (reply?.preferences) return reply.preferences;
            if (reply?.error) note("layout-sync-failed", "", {reason: "request_failed"});
        } catch (error) { noteLookupFailure("layout-sync-failed", error); }
        return null;
    }
    // Only the changed keys are sent, so a setting changed on another device is kept. A list order carries the
    // revision the user saw: when it is stale the current layout is shown and the user confirms the change again.
    function saveUi(changes) {
        movieUi = normalizeMovieUi({...movieUi, ...changes});
        saveMovieUi(preferenceViewer, movieUi);
        applyThemeUi();
        uiChanged();
        if (preview) return Promise.resolve(true);
        queuedUiSaves++;
        return uiSaving = uiSaving.then(() => sendUi(changes)).finally(() => { queuedUiSaves--; });
    }
    async function sendUi(changes) {
        const lists = "rows" in changes || "titleSections" in changes;
        const retry = () => void saveUi(changes);
        try {
            const reply = JSON.parse(await app.invokeMethodAsync("MovieProfilePreferences",
                {movie_ui: changes, ...(lists ? {movie_ui_revision: movieUi.revision} : {})}));
            if (reply?.preferences) {
                uiConflict = null;
                // Later saves are still queued: keep their optimistic state and only take the new revision.
                if (queuedUiSaves === 1) adoptUi(reply.preferences);
                else if (Number.isSafeInteger(reply.preferences.movie_ui_revision)) {
                    movieUi = {...movieUi, revision: reply.preferences.movie_ui_revision};
                    saveMovieUi(preferenceViewer, movieUi);
                }
                setUiNotice("");
                return true;
            }
            if (reply?.status === 409) {
                const current = await readServerUi();
                if (current) adoptUi(current);
                note("layout-sync-failed", "", {reason: "conflict"});
                uiConflict = changes;
                setUiNotice(current ? t("Your layout changed on another device. The current layout is shown.")
                    : t("Your layout changed on another device. Reopen this sheet to load it."),
                current ? [[t("Apply my change again"), () => { uiConflict = null; void saveUi(changes); }],
                    [t("Keep the current layout"), () => { uiConflict = null; setUiNotice(""); }]] : []);
                return false;
            }
            throw Object.assign(Error("layout save failed"), {reason: "request_failed"});
        } catch (error) {
            uiSaveFailed(error?.reason ?? (error instanceof SyntaxError ? "invalid_response" : "request_failed"), retry);
            return false;
        }
    }
    const connection = navigator.connection;
    let connectionRevision = 0, autoHintShown = false;
    async function currentConnection() {
        const native = await app.invokeMethodAsync("MovieConnectionKind").catch(() => null);
        if (native === "cellular" || native === "wifi") return {kind: native, saveData: native === "cellular"};
        const type = connection?.type;
        const kind = type === "cellular" ? "cellular" : type === "wifi" || type === "ethernet" ? "wifi" : "unknown";
        return {kind, saveData: kind === "cellular" || connection?.saveData};
    }
    const qualityFor = (choice, network) => choice === "auto" ? (network.saveData ? "saver" : "full") : choice;
    function connectionChanged() {
        connectionRevision++;
        resetHeroTrailer();
        scheduleHero();
        return current?.refreshQuality();
    }
    connection?.addEventListener?.("change", connectionChanged, { signal: life.signal });
    host.replaceChildren(status, shelfStatus, player, library);
    const call = async (method, ...args) => {
        if (preview) throw Error(t("Unavailable in layout preview"));
        return JSON.parse(await app.invokeMethodAsync(method, ...args));
    };
    const boundedCall = (signal, method, ...args) => withinMovieLoad(async bounded => {
        if (bounded.aborted) throw bounded.reason;
        let cancel;
        const stopped = new Promise((_resolve, reject) => {
            cancel = () => reject(bounded.reason);
            bounded.addEventListener("abort", cancel, {once: true});
        });
        try { return await Promise.race([call(method, ...args), stopped]); }
        finally { bounded.removeEventListener("abort", cancel); }
    }, signal);
    function addAudio(item, opener, parent, signal, language) {
        addAudioDialog({parent, opener, item, signal, language, onJob: () => scheduleDownloads(0),
            call: async (method, ...args) => {
                const reply = await call(method, ...args);
                if (method === "MovieAddAudio" && reply?.id) pendingAudioJobs.add(reply.id);
                return reply;
            }});
    }
    function select(name, options) {
        const label = el("label", name), pick = el("select");
        for (const [value, text] of options) pick.add(new Option(text, value));
        label.append(pick);
        return pick;
    }
    function button(label, run) {
        const b = el("button", label);
        b.type = "button";
        b.addEventListener("click", run);
        return b;
    }
    // Try each artwork URL in turn; leave the element empty when none loads.
    function chainImages(img, urls, onExhausted) {
        const next = urls[Symbol.iterator]();
        const advance = () => {
            const image = next.next();
            if (image.done) {
                img.removeAttribute("src");
                img.onerror = null;
                onExhausted?.();
            } else img.src = image.value;
        };
        img.onerror = advance;
        advance();
    }
    const icon = path => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("class", "movie-icon");
        const shape = document.createElementNS(svg.namespaceURI, "path");
        shape.setAttribute("d", path);
        svg.append(shape);
        return svg;
    };
    const playPath = "M7 4.5v15l12-7.5z";
    const searchPath = "M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z";
    const detailsPath = "M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z";
    const removePath = "m9 9 6 6m0-6-6 6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z";
    const heartPath = "M20.8 5.6a4.8 4.8 0 0 0-6.8 0l-2 2-2-2a4.8 4.8 0 0 0-6.8 6.8L12 21l8.8-8.6a4.8 4.8 0 0 0 0-6.8Z";
    const quietMotion = () => document.body.dataset.effects === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const backdropPalettes = new Map();
    function backdropPalette(src) {
        if (!src) return Promise.resolve(null);
        if (!backdropPalettes.has(src)) backdropPalettes.set(src, new Promise(resolve => {
            const image = new Image();
            image.crossOrigin = "anonymous";
            image.referrerPolicy = "no-referrer";
            image.onerror = () => resolve(null);
            image.onload = () => {
                try {
                    const canvas = el("canvas");
                    canvas.width = canvas.height = 24;
                    const context = canvas.getContext("2d");
                    context.drawImage(image, 0, 0, 24, 24);
                    const {data} = context.getImageData(0, 0, 24, 24);
                    const colors = [[0, 0, 0, 0], [0, 0, 0, 0]];
                    for (let i = 0; i < data.length; i += 4) {
                        const [r, g, b] = data.subarray(i, i + 3);
                        const weight = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
                        const color = colors[Number(r > b)];
                        color[0] += r * weight;
                        color[1] += g * weight;
                        color[2] += b * weight;
                        color[3] += weight;
                    }
                    resolve(colors.map(([r, g, b, weight], index) => weight > 0
                        ? `rgb(${Math.round(r / weight)}, ${Math.round(g / weight)}, ${Math.round(b / weight)})`
                        : ["#8a63ff", "#b767b9"][index]));
                } catch { resolve(null); }
            };
            image.src = src;
        }));
        return backdropPalettes.get(src);
    }
    const playbackNotice = el("div"), playbackMessage = el("p");
    let noticeTimer, noticeOpener;
    function clearPlaybackNotice() {
        if (playbackNotice.contains(document.activeElement))
            (noticeOpener?.isConnected && !noticeOpener.closest("[hidden]") ? noticeOpener : browse).focus({preventScroll: true});
        clearTimeout(noticeTimer);
        playbackNotice.hidden = true;
        playbackMessage.textContent = "";
        noticeOpener = undefined;
    }
    const dismissNotice = button("", clearPlaybackNotice);
    dismissNotice.setAttribute("aria-label", t("Dismiss playback notice"));
    dismissNotice.append(icon("m6 6 12 12M18 6 6 18"));
    playbackNotice.className = "movie-playback-notice";
    playbackNotice.hidden = true;
    playbackMessage.setAttribute("role", "status");
    playbackNotice.append(icon("M12 8v5m0 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"), playbackMessage, dismissNotice);
    host.append(playbackNotice);
    function scheduleNoticeDismissal() {
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
            if (!playbackNotice.contains(document.activeElement)) clearPlaybackNotice();
        }, 8000);
    }
    playbackNotice.addEventListener("focusout", scheduleNoticeDismissal);
    life.signal.addEventListener("abort", () => clearTimeout(noticeTimer), {once: true});
    function showPlaybackNotice(message, opener) {
        status.textContent = "";
        noticeOpener = opener;
        playbackNotice.hidden = false;
        playbackMessage.textContent = message;
        scheduleNoticeDismissal();
    }
    function report(action, playback, media) {
        const runtime = playback.source.RunTimeTicks || playback.item.RunTimeTicks || media.duration * 1e7;
        if (playback.item.Type === "Trailer" || isShortMovie(runtime)) return;
        const data = { ItemId: playback.item.Id, MediaSourceId: playback.source.Id,
            PlaySessionId: playback.id, PositionTicks: Math.round(media.currentTime * 1e7),
            IsPaused: media.paused, CanSeek: media.seekable.length > 0, PlayMethod: playback.method };
        const pending = reports.then(() => request("Sessions/Playing" + action, {fhUsage: playback.usageId}, data, null))
            .then(playback.updateUsage)
            .catch(() => { if (active) { status.textContent = t("Watch progress could not be saved."); note("progress-save-failed", playback.method); } })
            .finally(() => {
                if (pendingReportsByItem.get(data.ItemId) === pending) pendingReportsByItem.delete(data.ItemId);
            });
        pendingReportsByItem.set(data.ItemId, pending);
        reports = pending;
    }
    // Episodes of a series for the Episodes sheet and the next episode.
    async function localEpisodes(id, signal, season) {
        const items = [];
        let startIndex = 0, page;
        do {
            page = await request(`Shows/${encodeURIComponent(id)}/Episodes`, {
                userId: session.user, enableUserData: true, isMissing: false, startIndex, limit: 100,
                fields: "MediaStreams,Overview,ProviderIds",
                ...(season == null ? {} : {season})
            }, undefined, signal);
            if (!Array.isArray(page?.Items)) throw new TypeError("Invalid episodes");
            items.push(...page.Items.filter(item => !item.IsMissing && item.LocationType !== "Virtual"));
            startIndex += page.Items.length;
        } while (page.Items.length && startIndex < page.TotalRecordCount);
        return items;
    }
    function seriesEpisodes(item) {
        return withinMovieLoad(signal => localEpisodes(item.SeriesId, signal), life.signal).then(items => items.sort((a, b) =>
            (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0)));
    }
    // The Android WebView relies on the full-window layout and MovieScreen for landscape and system bars.
    const nativeFullscreen = host.dataset.nativeFullscreen === "true";
    let fullscreenRequest = null;
    let windowFullscreen = false, leavingPlayer = false;
    const appFullscreen = () => nativeFullscreen && !!document.querySelector(".app-header.app-fullscreen");
    const isFullscreen = () => nativeFullscreen ? windowFullscreen && !appFullscreen() :
        (document.fullscreenElement ?? document.webkitFullscreenElement) === player;
    if (nativeFullscreen) window.addEventListener("chrome-refresh", event => {
        if (typeof event.detail !== "boolean") return;
        windowFullscreen = event.detail;
        player.dispatchEvent(new Event("movie-fullscreenchange"));
    }, {signal: life.signal});
    function setFullscreen(on) {
        if (on && leavingPlayer) return Promise.resolve(false);
        if (fullscreenRequest) return fullscreenRequest;
        if (on === isFullscreen()) return Promise.resolve(true);
        fullscreenRequest = (async () => {
            if (nativeFullscreen) windowFullscreen = await app.invokeMethodAsync("MovieWindowFullscreen", on) === true;
            else if (on) await (player.requestFullscreen ?? player.webkitRequestFullscreen)?.call(player, { navigationUI: "hide" });
            else await (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
            return isFullscreen() === on;
        })().catch(() => false).finally(() => { fullscreenRequest = null; });
        return fullscreenRequest;
    }
    function enterPlayer() {
        leavingPlayer = false;
        player.classList.add("movie-expanded");
        document.documentElement.classList.add("movie-expanded-page");
        if (!nativeFullscreen) void setFullscreen(true);
        screen.orientation?.lock?.("landscape").catch(() => {});
        // The Android app turns the screen to landscape and hides the system bars; a browser ignores the call.
        Promise.resolve(app.invokeMethodAsync("MovieScreen", true)).catch(() => {});
    }
    // Resolves once the browser has left fullscreen: elements outside the fullscreen player cannot take focus before.
    async function leavePlayer() {
        leavingPlayer = true;
        await fullscreenRequest;
        await setFullscreen(false);
        player.classList.remove("movie-expanded");
        document.documentElement.classList.remove("movie-expanded-page");
        screen.orientation?.unlock?.();
        Promise.resolve(app.invokeMethodAsync("MovieScreen", false)).catch(() => {});
    }
    const subtitleAttempts = new Set();
    let playerLife = null;
    let playerItem, playerOpener, resumeRequest, guideStarted = false, streamId, playerInfo, shuffleQueue;
    async function closePlayback(keepFocus = false, fromHistory = false) {
        if (!playerItem) return;
        resumeRequest?.abort();
        const opener = playerOpener;
        playerItem = playerOpener = streamId = playerInfo = shuffleQueue = undefined;
        const closing = ++selection;
        await leavePlayer();
        if (!active || closing !== selection) return;
        library.hidden = false;
        toolbar.hidden = !!seriesView;
        if (!keepFocus) {
            const replacement = opener?.isConnected && !opener.closest("[hidden]") ? opener :
                seriesView?.section.querySelector("[data-episode-id], .movie-hero-play:not([hidden])") ??
                seriesView?.section.querySelector("h2") ?? browse;
            replacement.focus({preventScroll: true});
        }
        stop();
        if (!fromHistory) publishNavigation("back");
        const closedSelection = selection;
        await reports;
        if (active && closedSelection === selection) void reloadResume();
    }
    function stop() {
        selection++;
        if (current?.started) {
            report("/Stopped", current, video);
            if (current.item.Type !== "Trailer") send("stopped", current.method, current.item.Name, Math.floor(video.currentTime / 60));
        }
        const playback = current;
        const hls = playback?.hls;
        current = null;
        hls?.destroy();
        if (video) { video.pause(); video.removeAttribute("src"); video.load(); video = null; }
        if (playback) void playback.sampleUsage();
        playerLife?.abort();
        playerLife = null;
        player.replaceChildren();
    }
    const isShortMovie = ticks => ticks > 0 && ticks < 120 * 1e7;
    const savedPosition = (item, fresh) => ((fresh?.UserData ?? item.UserData)?.PlaybackPositionTicks ?? 0) / 1e7;
    async function readResume(item, signal) {
        await pendingReportsByItem.get(item.Id);
        return withinMovieLoad(bounded => request("Items/" + item.Id, {userId: session.user}, undefined, bounded), signal)
            .then(fresh => fresh ?? item).catch(error => {
                if (!signal.aborted) noteLookupFailure("resume-position-unavailable", error);
                return item;
            });
    }
    function chooseResume(item, opener, signal, position, total) {
        return new Promise(resolve => {
            const content = el("div"), details = el("div"), bar = el("span"), fill = el("span"), actions = el("div");
            const resume = button(t("Resume"), () => dialog.close("resume"));
            const restart = button(t("Start over"), () => dialog.close("restart"));
            const close = button(t("Close"), () => dialog.close());
            close.className = "movie-resume-close";
            actions.className = "movie-resume-actions";
            actions.append(resume, restart);
            bar.className = "movie-progress";
            bar.setAttribute("aria-hidden", "true");
            fill.style.width = (position / total * 100) + "%";
            bar.append(fill);
            const left = Math.round((total - position) / 60);
            const timeLeft = el("p", left < 1 ? t("Less than a minute left") : t("About {0} left", plural(left, "minute")));
            const question = el("p", t("Pick up where you left off?"));
            question.id = "movie-resume-question";
            timeLeft.id = "movie-resume-remaining";
            details.append(el("h2", t("Welcome back")), question, bar, timeLeft);
            const summary = el("div");
            summary.className = "movie-resume-summary";
            summary.append(cardArtwork(item), details);
            content.append(close, summary, actions);
            const dialog = movieDialog(player.contains(opener) ? player : host, opener, t("Welcome back"), signal,
                {content, initialFocus: resume, className: "movie-audio-dialog movie-resume-dialog"});
            dialog.setAttribute("aria-describedby", `${question.id} ${timeLeft.id}`);
            dialog.addEventListener("close", () => resolve(dialog.returnValue), {once: true});
            signal.addEventListener("abort", () => resolve(""), {once: true});
            dialog.addEventListener("keydown", event => {
                if (innerWidth >= 1920 && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                    const buttons = [close, resume, restart];
                    const next = buttons[buttons.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1)];
                    if (next) { event.preventDefault(); next.focus(); }
                }
            });
        });
    }
    async function play(item, opener, options = {}) {
        cancelSlowSearch?.();
        if (!active || preview || item.Demo) return;
        resumeRequest?.abort();
        const { audioIndex, position, paused, sourceId, burnedSubtitle } = options;
        const attempt = options.askResume && position == null ? new AbortController() : null;
        resumeRequest = attempt;
        const requestSignal = attempt?.signal ?? life.signal;
        const forceTranscode = options.forceTranscode || burnedSubtitle != null;
        let rev = selection, opened = false;
        const prefs = readMoviePreferences(preferenceViewer);
        prefs.dataSaver = options.dataSaver ?? prefs.dataSaver;
        const opening = t("Opening ") + item.Name + "…";
        function openPlayer() {
            opened = true;
            clearPlaybackNotice();
            const previous = playerItem;
            if (options.shuffle || previous?.Id !== item.Id) shuffleQueue = options.shuffle;
            if (previous?.Id !== item.Id) playerInfo = undefined;
            else if (current) playerInfo = current.playbackInfoState?.();
            if (!previous || item.Type === "Movie" && previous.Id !== item.Id) guideStarted = false;
            if (previous?.Id !== item.Id || !streamId)
                streamId = Array.from(crypto.getRandomValues(new Uint8Array(16)), part => part.toString(16).padStart(2, "0")).join("");
            playerItem = item;
            playerOpener = opener;
            if (!options.fromHistory && previous?.Id !== item.Id) publishNavigation(previous ? "replace" : "open");
            if (player.contains(document.activeElement)) player.focus({ preventScroll: true });
            stop();
            rev = selection;
            if (player.classList.contains("movie-expanded")) {
                status.textContent = "";
                const loading = el("p", opening);
                loading.className = "movie-ui-message movie-ui-line";
                loading.setAttribute("role", "status");
                player.append(loading);
                playerLife = new AbortController();
                watchPlayerIdle(player, playerLife.signal);
            } else status.textContent = opening;
        }
        if (!attempt) openPlayer();
        else if (!playerItem) status.textContent = opening;
        const media = el("video");
        // Chromium-based players (Android WebView, Windows WebView2, Chrome, Edge) answer "maybe" for HLS, but their
        // built-in HLS player rejects our transcodes (media error 4 on every transcoded film: owner phone and Windows,
        // 26 Nov). Wherever Media Source exists on a Chromium engine, hls.js does the work; Safari and iOS keep native HLS.
        const chromiumEngine = /\b(?:Chrome|Chromium|Edg|EdgA|OPR)\//.test(navigator.userAgent);
        const nativeHls = !!media.canPlayType("application/vnd.apple.mpegurl") &&
            !(globalThis.MediaSource && chromiumEngine);
        let failure = t("The server did not return playback information.");
        let method = forceTranscode ? "Transcode" : "", selectedAudio, httpStatus, hlsError;
        const diagnostics = () => ({
            mediaCode: media.error?.code ?? null, mediaMessage: mediaErrorMessage(media.error?.message),
            hlsType: hlsError?.type ?? "", hlsDetails: hlsError?.details ?? "", hlsFatal: hlsError?.fatal ?? null,
            audioIndex: selectedAudio ?? audioIndex ?? null, hlsLoaded: !!globalThis.Hls,
            httpStatus: httpStatus ?? null, forced: !!forceTranscode
        });
        const captureStatus = (context, status) => {
            if ((context?.type === "manifest" || context?.type === "level" || context?.type === "audioTrack" || context?.frag)
                && status >= 100 && status <= 599) httpStatus = status;
        };
        try {
            if (!nativeHls && !globalThis.Hls && (globalThis.MediaSource || globalThis.ManagedMediaSource))
                await loadHls();
            const network = connectionRevision;
            let playbackConnection = await currentConnection();
            const quality = qualityFor(prefs.dataSaver, playbackConnection);
            if (!active || rev !== selection || requestSignal.aborted) return;
            const limit = dataLimits[quality];
            const configuredScreen = movieScreen(prefs.screen);
            const maxHeight = Math.min(configuredScreen.height, limit?.height ?? Infinity);
            const Hls = nativeHls ? null : globalThis.Hls;
            const hls = nativeHls || Hls?.isSupported();
            const profile = { Name: "FamilyHub web video",
                DirectPlayProfiles: [{ Type: "Video", Container: "mp4,m4v", VideoCodec: "h264", AudioCodec: "aac,mp3" }],
                TranscodingProfiles: [{ Type: "Video", Context: "Streaming", Protocol: hls ? "hls" : "http",
                    Container: hls ? "ts" : "mp4", VideoCodec: "h264", AudioCodec: "aac" }],
                SubtitleProfiles: [{ Format: "vtt", Method: t("External") }, ...(burnedSubtitle == null ? [] :
                    ["dvdsub", "dvd_subtitle", "pgs", "pgssub", "hdmv_pgs_subtitle"].map(Format => ({ Format, Method: t("Encode") })))] };
            const condition = (Property, Value) => ({ Condition: "LessThanEqual", Property, Value: String(Value), IsRequired: true });
            profile.CodecProfiles = [{ Type: "Video", Codec: "h264",
                Conditions: [condition(t("Height"), maxHeight), condition(t("Width"), configuredScreen.width)] }];
            if (limit) {
                profile.MaxStreamingBitrate = limit.bitrate;
                if (limit.audioBitrate) {
                    profile.TranscodingProfiles[0].MaxAudioChannels = "2";
                    profile.TranscodingProfiles[0].EnableAudioVbrEncoding = false;
                    profile.CodecProfiles.push({ Type: "VideoAudio", Codec: "aac",
                        Conditions: [condition("AudioBitrate", limit.audioBitrate), condition("AudioChannels", 2)] });
                }
            }
            let toneMap = false;
            const playbackInfo = (sourceId, index, signal) => request("Items/" + item.Id + "/PlaybackInfo", {userId: session.user}, {
                UserId: session.user, DeviceProfile: profile,
                ...(sourceId ? {MediaSourceId: sourceId, SubtitleStreamIndex: burnedSubtitle ?? -1} : {}),
                ...(index != null ? {AudioStreamIndex: index} : {}),
                ...(limit ? { MaxStreamingBitrate: limit.bitrate } : {}),
                ...(limit || forceTranscode || toneMap ? { AllowVideoStreamCopy: false } : {}),
                ...(limit || forceTranscode ? { AllowAudioStreamCopy: false } : {}),
                ...(limit?.audioBitrate ? { MaxAudioChannels: 2 } : {}),
                EnableDirectPlay: !forceTranscode && !limit && !toneMap && index == null,
                EnableDirectStream: !forceTranscode && !limit && !toneMap,
                EnableTranscoding: true }, signal);
            const [resultInfo, freshItem] = await Promise.all([
                withinMovieLoad(signal => playbackInfo(sourceId, forceTranscode ? audioIndex : undefined, signal), requestSignal),
                position == null ? readResume(item, requestSignal) : null
            ]);
            if (!active || rev !== selection || requestSignal.aborted) return;
            let result = resultInfo;
            if (result) failure = result.ErrorCode === "NoCompatibleStream" ? t("The server found no compatible stream.") :
                t("The server did not provide a playable version.");
            let source = result?.MediaSources?.[0];
            if (!source) throw Error();
            const inputVideo = source.MediaStreams?.find(track => track.Type === "Video" && !track.IsExternal);
            const inputRange = videoRange(inputVideo);
            toneMap = matchMedia("(dynamic-range: high)").matches === false && inputRange === "HDR";
            if (toneMap) {
                failure = t("The server could not prepare an SDR stream.");
                result = await withinMovieLoad(signal => playbackInfo(source.Id, forceTranscode ? audioIndex : undefined, signal), requestSignal);
                if (!active || rev !== selection || requestSignal.aborted) return;
                source = result?.MediaSources?.[0];
                if (!source?.TranscodingUrl) throw Error();
            }
            const runtime = source.RunTimeTicks || freshItem?.RunTimeTicks || item.RunTimeTicks;
            let resume = position ?? (isShortMovie(runtime) ? 0 : savedPosition(item, freshItem));
            if (attempt) {
                const promptOpener = options.promptOpener ?? opener;
                if (!promptOpener?.isConnected || promptOpener.closest("[hidden]")) return;
                const total = runtime / 1e7;
                if (resume > 120 && resume < total * .95 && movieUi.resumePrompt) {
                    const choice = await chooseResume(item, promptOpener, requestSignal, resume, total);
                    if (!choice || !active || rev !== selection || requestSignal.aborted) return;
                    if (choice === "restart") resume = 0;
                }
                if (resumeRequest === attempt) resumeRequest = undefined;
                openPlayer();
            }
            if (freshItem) item = {...item, RunTimeTicks: runtime, OfficialRating: freshItem.OfficialRating || item.OfficialRating};
            const audioLanguage = prefs.audio;
            const audio = (source.MediaStreams || []).filter(s => s.Type === "Audio");
            const internalAudio = audio.filter(track => !track.IsExternal);
            if (freshItem?.OriginalLanguage && freshItem.OriginalLanguage !== item.OriginalLanguage)
                item = {...item, OriginalLanguage: freshItem.OriginalLanguage};
            const originalCode = source.OriginalLanguage ?? item.OriginalLanguage;
            const originalName = audioLanguageName(originalCode);
            const knownOriginalLanguage = trackLanguage({Language: originalCode}) ??
                (originalName !== "Language unknown" ? "original" : undefined);
            const original = audio.find(track => track.IsOriginal) ?? (knownOriginalLanguage
                ? internalAudio.find(track => knownOriginalLanguage === "original" ? audioLanguageName(track.Language) === originalName
                    : trackLanguage(track) === knownOriginalLanguage)
                : internalAudio.find(track => /\boriginal\b/i.test(track.DisplayTitle ?? "")));
            const originalLanguage = trackLanguage(original) ??
                (audioLanguageName(original?.Language) !== "Language unknown" ? "original" : knownOriginalLanguage);
            const preferredAudio = preferredTrack(audio, audioLanguage === "default" ? "en" : audioLanguage) ??
                (audioLanguage === "default" ? undefined : preferredTrack(audio, prefs.backupAudio));
            const defaultAudio = audio.find(track => track.Index === source.DefaultAudioStreamIndex)?.Index ??
                audio.find(track => track.IsDefault)?.Index ?? audio[0]?.Index;
            const defaultSubtitle = source.DefaultSubtitleStreamIndex;
            const requestedAudio = audioIndex ?? preferredAudio?.Index ?? original?.Index ?? internalAudio[0]?.Index ?? audio[0]?.Index;
            selectedAudio = forceTranscode ? audioIndex ?? defaultAudio : defaultAudio;
            const canDirect = !forceTranscode && !limit && !toneMap;
            let direct = canDirect && source.SupportsDirectPlay;
            // A static stream leaves audio selection to the browser. Ask Jellyfin to select the track on multi-audio files.
            const customAudio = audio[0]?.IsExternal || audio.length > 1 &&
                (audioLanguage !== "default" || audioIndex != null || requestedAudio !== defaultAudio || requestedAudio !== audio[0]?.Index ||
                    audio.some(track => track.IsDefault && track.Index !== requestedAudio))
                ? requestedAudio : undefined;
            const selectedTrack = audio.find(track => track.Index === (requestedAudio ?? defaultAudio));
            if (!forceTranscode && externalDts(selectedTrack))
                return play(item, opener, {...options, audioIndex: selectedTrack.Index, sourceId: source.Id, forceTranscode: true, position: resume});
            if ((!forceTranscode && customAudio != null) || (!toneMap && !sourceId && !direct && defaultSubtitle >= 0)) {
                const playback = await withinMovieLoad(signal => playbackInfo(source.Id, customAudio, signal), life.signal).catch(() => null);
                if (!active || rev !== selection) return;
                const configured = playback?.MediaSources?.[0];
                if (configured?.TranscodingUrl || (canDirect && configured?.SupportsDirectPlay && customAudio == null)) {
                    selectedAudio = customAudio ?? configured.DefaultAudioStreamIndex ?? defaultAudio;
                    direct = canDirect && configured.SupportsDirectPlay && customAudio == null;
                    result = playback;
                    source = configured;
                } else if (customAudio != null || !direct && defaultSubtitle >= 0) {
                    if (forceTranscode) throw Error();
                    return play(item, opener, {...options, audioIndex: requestedAudio ?? defaultAudio, sourceId: source.Id, forceTranscode: true, position: resume});
                }
            }
            const reasons = Array.isArray(source.TranscodeReasons) ? source.TranscodeReasons.filter(reason => typeof reason === "string") : [];
            const remux = reasons.length ? reasons.every(reason => reason === "ContainerNotSupported") :
                source.SupportsDirectStream !== false;
            method = direct ? "DirectPlay" : canDirect && remux ? "DirectStream" : "Transcode";
            const path = direct ? "Videos/" + item.Id + "/stream" : source.TranscodingUrl;
            if (!path && !forceTranscode)
                return play(item, opener, {...options, audioIndex: requestedAudio ?? defaultAudio, sourceId: source.Id, forceTranscode: true, position: resume});
            if (!path) throw Error();
            const stream = mediaUrl(path, {mediaSourceId: source.Id, playSessionId: result.PlaySessionId});
            if (direct) stream.searchParams.set("static", "true");
            else {
                for (const [key, ceiling] of [["maxWidth", configuredScreen.width], ["maxHeight", maxHeight]]) {
                    let capped = ceiling;
                    for (const name of [...stream.searchParams.keys()]) {
                        if (name.toLowerCase() !== key.toLowerCase()) continue;
                        for (const value of stream.searchParams.getAll(name)) {
                            const size = Number(value);
                            if (Number.isSafeInteger(size) && size > 0) capped = Math.min(capped, size);
                        }
                        stream.searchParams.delete(name);
                    }
                    stream.searchParams.set(key, capped);
                }
            }
            const usageId = streamId;
            stream.searchParams.set("fhUsage", usageId);
            if (!direct && !hls && resume > 0) {
                await leavePlayer();
                if (!active || rev !== selection) return;
                note("cannot-resume");
                library.hidden = false;
                toolbar.hidden = !!seriesView;
                opener?.focus();
                showPlaybackNotice(t("This device cannot resume this video. Continue on another device."), opener);
                stop();
                playerItem = playerOpener = undefined;
                publishNavigation("back");
                return;
            }
            let ui, receivedBytes = null, usagePending;
            const playback = { item, source, id: result.PlaySessionId, dataSaver: prefs.dataSaver, method, usageId,
                updateUsage(snapshot) {
                    const bytes = snapshot?.bytes;
                    if (!Number.isSafeInteger(bytes) || bytes < 0 || (receivedBytes != null && bytes <= receivedBytes)) return;
                    receivedBytes = bytes;
                    ui?.updatePlaybackInfo();
                },
                sampleUsage() {
                    return usagePending ??= request("MediaUsage", {}, {stream: usageId}, timeoutSignal(1500))
                        .then(snapshot => {
                            if (!Number.isSafeInteger(snapshot?.bytes)) throw new TypeError(t("Missing byte count"));
                            playback.updateUsage(snapshot);
                        })
                        .catch(error => noteLookupFailure("media-usage-unavailable", error, method))
                        .finally(() => { usagePending = undefined; });
                }
            };
            const usageReady = playback.sampleUsage();
            const back = button(t("Back to movies"), () => closePlayback());
            const subtitleUrl = (track, revision) => mediaUrl(`Videos/${item.Id}/${source.Id}/Subtitles/${track.Index}/Stream.vtt`,
                {fhUsage: usageId, ...(revision ? {timingRevision: revision} : {})});
            const subtitleCounts = new Map();
            function readLineCount(track) {
                if (Number.isFinite(track.LineCount) && track.LineCount >= 0) return track.LineCount;
                const key = track.Path || track.Index;
                if (!subtitleCounts.has(key)) subtitleCounts.set(key, withinMovieLoad(async signal => {
                    const response = await fetch(subtitleUrl(track), {signal, referrerPolicy: "no-referrer"});
                    if (!response.ok) return 0;
                    const vtt = await response.text();
                    return vtt.split(/\r?\n[ \t]*\r?\n/).reduce((count, block) => {
                        const lines = block.split(/\r?\n/);
                        const timing = lines.findIndex(line => /^\d[\d:.]+\s+-->\s+\d/.test(line));
                        return timing < 0 ? count : count + lines.slice(timing + 1).filter(line => line.trim()).length;
                    }, 0);
                }, life.signal, 2500).catch(() => { subtitleCounts.delete(key); return 0; }));
                return subtitleCounts.get(key);
            }
            const subtitles = await subtitleRows(source.MediaStreams ?? [], source.Path ?? item.Path, readLineCount);
            if (!active || rev !== selection) return;
            const deviceLanguage = navigator.language?.split("-")[0].toLowerCase();
            const subtitleLanguage = languageCodes[prefs.subtitles] ? prefs.subtitles : deviceLanguage === "hu" ? "hu" : "en";
            const selectedAudioTrack = audio.find(track => track.Index === selectedAudio);
            const wantsSubtitles = (prefs.subtitles === "hu" || prefs.subtitles === "en") &&
                prefs.audio !== "hu" && trackLanguage(selectedAudioTrack) !== "hu";
            let initialSubtitle = (wantsSubtitles ? preferredTrack(subtitles, subtitleLanguage)?.Index : undefined) ?? -1;
            const wantedSubtitle = options.subtitleIndex ?? initialSubtitle;
            if (burnedSubtitle == null && subtitles.some(track => track.Index === wantedSubtitle && !textSubtitle(track)))
                return play(item, opener, {...options, audioIndex: selectedAudio, sourceId: source.Id, position: resume,
                    burnedSubtitle: wantedSubtitle});
            const audioPick = select(t("Audio track"), []);
            const alternateAudio = originalLanguage === "hu" ? audio.filter(track => track !== original) : audio;
            const audioLanguages = originalLanguage === "en" ? ["en", "hu"] : ["original", "en", "hu"];
            for (const language of audioLanguages) {
                let track;
                if (language === "original") track = original;
                else if (language === "en" && originalLanguage === "en" && original) track = original;
                else if (alternateAudio.includes(selectedAudioTrack) && trackLanguage(selectedAudioTrack) === language)
                    track = selectedAudioTrack;
                else track = preferredTrack(alternateAudio, language);
                if (!track) continue;
                const option = new Option(language === "original" ? t("Original") : t(labels[language]), track.Index);
                option.dataset.language = language;
                audioPick.add(option);
            }
            audioPick.value = String(selectedAudio);
            audioPick.onchange = () => {
                const index = Number(audioPick.value);
                const keepBitmap = playback.subtitleOverride != null || trackLanguage(audio.find(track => track.Index === index)) !== "hu";
                return play(item, opener, { sheet: "audio", audioIndex: index,
                    position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                    subtitleIndex: playback.subtitleOverride, burnedSubtitle: keepBitmap ? burnedSubtitle : undefined,
                    dataSaver: playback.dataSaver, forceTranscode: options.forceTranscode,
                    sourceId: forceTranscode ? source.Id : undefined });
            };
            const subtitlePick = select(t("Subtitle track"), [[-1, t("Off")]]);
            const notice = el("p");
            notice.setAttribute("role", "status");
            media.controls = false; media.playsInline = true; media.preload = "metadata";
            media.className = "movie-video";
            media.crossOrigin = "anonymous";
            media.referrerPolicy = "no-referrer";
            media.setAttribute("aria-label", item.Name);
            const textTracks = new Map();
            function addSubtitleTrack(s, revision) {
                const track = el("track"); track.kind = "subtitles"; track.label = s.DisplayTitle || s.Language || t("Subtitles");
                track.srclang = s.Language || "und";
                track.src = subtitleUrl(s, revision);
                media.append(track);
                textTracks.set(s.Index, track.track);
            }
            function removeSubtitleTrack(index) {
                const track = textTracks.get(index);
                if (!track) return;
                track.mode = "disabled";
                [...media.querySelectorAll("track")].find(node => node.track === track)?.remove();
                textTracks.delete(index);
            }
            function populateSubtitles() {
                subtitlePick.replaceChildren(new Option(t("Off"), -1));
                for (const track of subtitles) {
                    const option = new Option(t(labels[trackLanguage(track)]), track.Index);
                    option.dataset.language = trackLanguage(track);
                    subtitlePick.add(option);
                    if (textSubtitle(track) && !textTracks.has(track.Index)) addSubtitleTrack(track);
                }
            }
            populateSubtitles();
            const watchGuide = prefs.parentalGuide && !guideStarted && ["Movie", "Episode"].includes(item.Type);
            const guideRating = item.OfficialRating || (item.Type === "Episode" && seriesView?.item.Id === item.SeriesId
                ? seriesView.item.OfficialRating : undefined);
            let guideLookup;
            playback.setSubtitles = (index) => {
                playback.subtitleOverride = index;
                const selected = index ?? initialSubtitle;
                const activeSubtitle = burnedSubtitle === selected || textTracks.has(selected) ? selected : -1;
                for (const [trackIndex, track] of textTracks)
                    track.mode = trackIndex === activeSubtitle ? "hidden" : "disabled"; // hidden: the player draws the cues itself
                subtitlePick.value = String(activeSubtitle);
                const audioFallback = audioIndex == null && audioLanguage !== "default" && (!preferredAudio || preferredAudio.Index !== selectedAudio);
                notice.textContent = [
                    audioFallback ? t("{0} audio unavailable. Using the default track.", t(labels[audioLanguage])) : "",
                    audioIndex != null && audioIndex !== selectedAudio ? t("Selected audio track unavailable. Using the default track.") : ""
                ].filter(Boolean).join(" ");
            };
            function chooseSubtitle(index, override) {
                const burn = subtitles.find(track => track.Index === index && !textSubtitle(track))?.Index;
                if (burn !== burnedSubtitle) {
                    const position = metadataLoaded || media.currentTime > 0 ? media.currentTime : resume;
                    return play(item, opener, { sheet: "audio", focusSubtitle: true,
                        sourceId: source.Id, audioIndex: selectedAudio, subtitleIndex: index, burnedSubtitle: burn,
                        forceTranscode: options.forceTranscode, position,
                        paused: media.paused, dataSaver: playback.dataSaver });
                }
                playback.setSubtitles(override);
            }
            subtitlePick.onchange = () => {
                const index = Number(subtitlePick.value);
                return chooseSubtitle(index, index);
            };
            current = playback; video = media;
            let metadataLoaded = false;
            media.onloadedmetadata = () => {
                if (current !== playback) return;
                playback.setSubtitles(playback.subtitleOverride);
                if (!metadataLoaded && resume > 0 && resume < media.duration) media.currentTime = resume;
                metadataLoaded = true;
            };
            let last = performance.now();
            const progress = () => {
                if (current !== playback || !playback.started || media.ended) return;
                last = performance.now();
                report("/Progress", playback, media);
            };
            media.onplaying = () => {
                if (current !== playback) return;
                if (!playback.started) {
                    playback.started = true;
                    last = performance.now();
                    report("", playback, media);
                    if (item.Type !== "Trailer") send("started", playback.method, item.Name, Math.floor(media.currentTime / 60));
                    app.invokeMethodAsync("MovieStarted").catch(() => {});
                    if (guideLookup) void guideLookup.then(guide => {
                        if (current !== playback || guideStarted || media.ended) return;
                        guideStarted = true;
                        ui.startGuide(ratingBadge(guideRating || guide?.Rating), guide?.Categories);
                    });
                }
                status.textContent = "";
            };
            media.ontimeupdate = () => {
                if (!media.paused && !media.seeking && performance.now() - last >= 15000) progress();
            };
            media.onpause = progress;
            media.onseeked = progress;
            media.onended = () => {
                if (current !== playback || !playback.started) return;
                report("/Stopped", playback, media);
                playback.started = false;
            };
            let recovering = false;
            const failed = (type = hlsError?.type) => {
                if (current !== playback || recovering) return;
                note("playback-error", playback.method, diagnostics());
                const retry = {audioIndex: selectedAudio, subtitleIndex: playback.subtitleOverride, burnedSubtitle, dataSaver: playback.dataSaver,
                    position: metadataLoaded ? media.currentTime : resume, paused: playback.started && media.paused,
                    sourceId: source.Id, forceTranscode: true};
                const code = media.error?.code;
                if (!forceTranscode && (direct || playback.method === "DirectStream" || code === 3 || code === 4 || type === "mediaError")) {
                    recovering = true;
                    void play(item, opener, retry);
                    return;
                }
                const reason = code === 2 || type === "networkError" ? t("The video stream stopped responding.") :
                    code === 3 || code === 4 || type === "mediaError" ? t("The video stream could not be decoded.") :
                    t("The server stream could not start.");
                ui?.showFailure(reason, () => play(item, opener, retry));
            };
            media.onerror = () => failed(null);
            if (!direct && !nativeHls && hls) {
                const Loader = Hls.DefaultConfig?.loader;
                const config = {startPosition: resume, enableWorker: false};
                if (Loader) config.loader = class extends Loader {
                    load(context, settings, callbacks) {
                        const {onSuccess, onError} = callbacks;
                        super.load(context, settings, {...callbacks,
                            onSuccess(response, stats, request, network) {
                                captureStatus(request, network?.status ?? response.code ?? 200);
                                onSuccess(response, stats, request, network);
                            },
                            onError(response, request, network, stats) {
                                captureStatus(request, network?.status || response.code);
                                onError(response, request, network, stats);
                            }
                        });
                    }
                };
                playback.hls = new Hls(config);
                playback.hls.on(Hls.Events.ERROR, (_event, data) => {
                    const type = Object.values(Hls.ErrorTypes ?? {}).includes(data.type) ? data.type : "";
                    const details = Object.values(Hls.ErrorDetails ?? {}).includes(data.details) ? data.details : "";
                    hlsError = {type, details, fatal: !!data.fatal};
                    const status = data.response?.code ?? data.networkDetails?.status;
                    if (status >= 100 && status <= 599) httpStatus = status;
                    if (data.fatal) failed(data.type);
                });
            }
            const numbered = item.ParentIndexNumber != null && item.IndexNumber != null;
            playerLife?.abort();
            playerLife = new AbortController();
            const playerSignal = playerLife.signal;
            for (const type of ["suspend", "ended"])
                media.addEventListener(type, playback.sampleUsage, {signal: playerSignal});
            const audioSync = audio.some(track => track.Index === selectedAudio && track.IsExternal) ?
                movieAudioSync(media, {signal: playerSignal, stream: stream.href,
                    Hls: playback.hls ? Hls : null, report: message => ui?.say(message),
                    useAudioElement: element => ui?.useAudioElement(element),
                    key: preferencesKey(preferenceViewer) + ":sync:" + item.Id}) : null;
            const subtitleItem = /^[a-f\d]{32}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(source.Id) ? source.Id : item.Id;
            const subtitlePath = `Items/${encodeURIComponent(subtitleItem)}`;
            const remote = subtitlePath + "/RemoteSearch/Subtitles/";
            const timingJobs = new Map();
            let timingPanelOpen = false, timingTimer, timingRequest, timingErrors = 0;
            const timingTrack = code => subtitles.find(track => trackLanguage(track) === code);
            function watchTiming(track, newDownload = false) {
                if (track.FamilyHubSubtitleSidecar && (newDownload || track.FamilyHubSubtitleTiming?.state === "running")) {
                    const code = trackLanguage(track);
                    if (!timingJobs.has(code)) timingJobs.set(code, "running");
                }
            }
            subtitles.forEach(track => watchTiming(track));
            const syncFailure = code => t("Could not resync the {0} subtitles. Try again later.", t(labels[code]));
            function scheduleTimingPoll() {
                if (!timingPanelOpen || playerSignal.aborted || timingTimer || timingRequest ||
                    ![...timingJobs.values()].includes("running")) return;
                timingTimer = setTimeout(pollTiming, 5000);
            }
            async function pollTiming() {
                timingTimer = undefined;
                const watching = [...timingJobs].filter(([, state]) => state === "running").map(([code]) => code);
                const pending = {};
                timingRequest = pending;
                let reply;
                try {
                    reply = JSON.parse(await app.invokeMethodAsync("MovieSubtitleTiming", subtitleItem));
                    if (timingRequest !== pending) return;
                    if (!reply || reply.error) throw Error(t("Subtitle timing unavailable"));
                    timingErrors = 0;
                } catch {
                    if (timingRequest !== pending) return;
                    if (++timingErrors < 3) {
                        timingRequest = undefined;
                        scheduleTimingPoll();
                        return;
                    }
                    reply = {};
                }
                if (timingRequest !== pending || playerSignal.aborted) return;
                timingRequest = undefined;
                const notices = [];
                for (const code of watching) {
                    const timing = reply[code];
                    if (timing?.state === "running") continue;
                    timingJobs.delete(code);
                    const track = timingTrack(code);
                    if (track) track.FamilyHubSubtitleTiming = timing ?? {method: track.FamilyHubSubtitleTiming?.method, state: "failed"};
                    if (timing?.state === "idle" && track?.FamilyHubSubtitleSidecar) {
                        removeSubtitleTrack(track.Index);
                        addSubtitleTrack(track, Date.now());
                        playback.setSubtitles(playback.subtitleOverride);
                        notices.push(t("{0} subtitles resynced", t(labels[code])));
                    } else notices.push(syncFailure(code));
                }
                if (notices.length) ui.subtitleStatus(notices.join(" "), searchingSubtitles || undefined);
                ui.syncSubtitles();
                scheduleTimingPoll();
            }
            const subtitleSync = {
                timing(code) {
                    const track = timingTrack(code);
                    return track && {sidecar: track.FamilyHubSubtitleSidecar,
                        method: track.FamilyHubSubtitleTiming?.method,
                        running: timingJobs.has(code)};
                },
                panel(open) {
                    timingPanelOpen = open;
                    if (open) scheduleTimingPoll();
                    else {
                        clearTimeout(timingTimer);
                        timingTimer = timingRequest = undefined;
                        timingErrors = 0;
                    }
                },
                async run(code) {
                    if (timingJobs.has(code) || playerSignal.aborted) return;
                    timingJobs.set(code, "starting");
                    ui.subtitleStatus("", searchingSubtitles || undefined);
                    try {
                        const reply = JSON.parse(await app.invokeMethodAsync("MovieSyncSubtitle", subtitleItem, code));
                        if (playerSignal.aborted) return;
                        if (reply?.state !== "running") throw Error("Subtitle sync unavailable");
                        timingJobs.set(code, "running");
                        scheduleTimingPoll();
                    } catch {
                        timingJobs.delete(code);
                        if (!playerSignal.aborted) ui.subtitleStatus(syncFailure(code), searchingSubtitles || undefined);
                    }
                }
            };
            playerSignal.addEventListener("abort", () => subtitleSync.panel(false), {once: true});
            const subtitleSearch = {
                message(error) {
                    return error instanceof SubtitleSearchError ? error.message : t("Could not search for subtitles. Try again.");
                },
                async find(language, automatic = false) {
                    let results;
                    try {
                        results = await searchLibrary(remote + language, {}, undefined, playerSignal);
                    } catch {
                        if (playerSignal.aborted) return null;
                    }
                    const matches = Array.isArray(results)
                        ? results.filter(result => typeof result?.Id === "string" && result.Id) : [];
                    if (matches.length) return matches;
                    await this.add(null, language, automatic);
                    return null;
                },
                async add(result, language, automatic = false) {
                    const readTracks = async () => {
                        const fresh = await searchLibrary(subtitlePath, {userId: session.user}, undefined, playerSignal);
                        return (fresh.MediaSources?.find(candidate => candidate.Id === source.Id)?.MediaStreams
                            ?? fresh.MediaStreams ?? []).filter(stream => stream.Type === "Subtitle");
                    };
                    const code = language === "hun" ? "hu" : "en";
                    const existing = result ? await readTracks() : [...subtitles];
                    let saved;
                    if (result) await searchLibrary(remote + encodeURIComponent(result.Id), {}, {}, playerSignal);
                    else {
                        if (playerSignal.aborted) return;
                        try {
                            saved = JSON.parse(await app.invokeMethodAsync("MovieFetchSubtitle", subtitleItem, code));
                        } catch {
                            throw new SubtitleSearchError(t("The server did not respond to the subtitle request. Try again."));
                        }
                        if (playerSignal.aborted) return;
                        if (saved?.error === "Subtitle provider is not set up")
                            throw new SubtitleSearchError(saved.error + ". Ask an admin to configure the OpenSubtitles API key.");
                        if (typeof saved?.error === "string" && saved.error)
                            throw new SubtitleSearchError(saved.error);
                        if (saved?.added !== true)
                            throw new SubtitleSearchError(t("The server did not respond to the subtitle request. Try again."));
                    }
                    for (let attempt = 0; attempt < 12 && !playerSignal.aborted; attempt++) {
                        if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
                        if (playerSignal.aborted) return;
                        let refreshed;
                        try {
                            refreshed = await readTracks();
                        } catch (error) {
                            if (!saved) throw error;
                            break;
                        }
                        const matching = refreshed.filter(track => track.IsExternal && textSubtitle(track) && trackLanguage(track) === code);
                        const added = matching.filter(track => !existing.some(old =>
                            old.Path && track.Path ? old.Path === track.Path : old.Index === track.Index));
                        const track = added[0] ?? (saved?.existing ? matching[0] : null);
                        if (!track || playerSignal.aborted) continue;
                        const ranked = await subtitleRows(refreshed, source.Path ?? item.Path, readLineCount);
                        if (playerSignal.aborted) return;
                        const prior = subtitles.find(stream => stream.Index === Number(subtitlePick.value));
                        for (const stream of subtitles) {
                            if (ranked.some(candidate => candidate.Index === stream.Index && candidate.Path === stream.Path)) continue;
                            removeSubtitleTrack(stream.Index);
                        }
                        subtitles.splice(0, subtitles.length, ...ranked);
                        ranked.forEach(stream => watchTiming(stream, saved?.existing === false && trackLanguage(stream) === code));
                        scheduleTimingPoll();
                        populateSubtitles();
                        const addedIndex = preferredTrack(subtitles, code)?.Index ?? -1;
                        if (automatic && playback.subtitleOverride == null) {
                            initialSubtitle = addedIndex;
                            if (chooseSubtitle(addedIndex, undefined)) return;
                        } else {
                            const retained = prior && subtitles.find(stream => prior.Path
                                ? prior.Path === stream.Path : prior.Index === stream.Index && trackLanguage(prior) === trackLanguage(stream));
                            const selected = (retained ?? preferredTrack(subtitles, trackLanguage(prior)))?.Index ?? -1;
                            if (playback.subtitleOverride == null) initialSubtitle = selected;
                            if (chooseSubtitle(selected, playback.subtitleOverride == null ? undefined : selected)) return;
                        }
                        ui.syncSubtitles();
                        return;
                    }
                    if (saved?.refresh_pending)
                        throw new SubtitleSearchError(t("Subtitles were saved. Jellyfin could not refresh this title. Retry or ask an admin to check the library."));
                    if (saved) throw new SubtitleSearchError(t("Subtitles were saved. Give the library a moment, then retry or reopen the video."));
                    throw Error(t("Subtitle track unavailable"));
                }
            };
            let searchingSubtitles;
            subtitleSearch.run = async (language, automatic = false) => {
                if (!languageCodes[language] || searchingSubtitles || playerSignal.aborted || preferredTrack(subtitles, language)) return;
                const subtitleCode = language === "hu" ? "hun" : "eng";
                const name = t(labels[language]);
                searchingSubtitles = language;
                ui.subtitleStatus(t("Searching for {0} subtitles", name), language);
                let best;
                try {
                    const found = await subtitleSearch.find(subtitleCode, automatic);
                    if (playerSignal.aborted) return;
                    if (found) {
                        best = found.sort((a, b) => (b.DownloadCount ?? 0) - (a.DownloadCount ?? 0) ||
                            (b.CommunityRating ?? 0) - (a.CommunityRating ?? 0))[0];
                        await subtitleSearch.add(best, subtitleCode, automatic);
                    }
                    if (!playerSignal.aborted) ui.subtitleStatus(t("Found"));
                } catch (error) {
                    if (!playerSignal.aborted) ui.subtitleStatus(best
                        ? t("Could not add subtitles. Try again or ask an admin to check subtitle permissions and storage.")
                        : subtitleSearch.message(error));
                } finally {
                    searchingSubtitles = undefined;
                }
            };
            function autoSubtitles() {
                if (source.FamilyHubSubtitleImport) return;
                if (!wantsSubtitles || options.subtitleIndex != null || preferredTrack(subtitles, subtitleLanguage)) return;
                const key = preferencesKey(preferenceViewer) + ":autosub:" + item.Id + ":" + subtitleLanguage;
                let tried = subtitleAttempts.has(key);
                try {
                    tried ||= sessionStorage.getItem(key) === "1";
                    if (!tried) sessionStorage.setItem(key, "1");
                } catch { /* The in-memory attempt still covers this Movies view. */ }
                if (tried) return;
                subtitleAttempts.add(key);
                void subtitleSearch.run(subtitleLanguage, true);
            }
            let qualityChange = 0;
            playback.refreshQuality = async () => {
                const change = ++qualityChange;
                const nextConnection = await currentConnection();
                if (current !== playback || change !== qualityChange) return;
                playbackConnection = nextConnection;
                ui.updatePlaybackInfo();
                await usagePending;
                if (current !== playback || change !== qualityChange) return;
                void playback.sampleUsage();
                const nextQuality = qualityFor(playback.dataSaver, nextConnection);
                if (nextQuality !== quality)
                    return play(item, opener, {
                        dataSaver: "auto", sheet: ui.openSheetName(), audioIndex, subtitleIndex: playback.subtitleOverride, burnedSubtitle,
                        position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                        forceTranscode: options.forceTranscode, sourceId: forceTranscode ? source.Id : undefined
                    });
            };
            const output = new Map([...stream.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
            const outputCodec = output.get("videocodec")?.split(",")[0].toLowerCase();
            const inputCodec = typeof inputVideo?.Codec === "string" ? inputVideo.Codec.toLowerCase() : "";
            const encodedVideo = toneMap || limit || forceTranscode || method === "Transcode" && outputCodec && outputCodec !== "copy" &&
                (outputCodec !== inputCodec || reasons.some(reason => reason.startsWith("Video")));
            const reason = toneMap ? t("HDR to SDR") : limit ? t("Streaming quality limit") : burnedSubtitle != null ? t("Subtitles added to the video") :
                reasons.map(value => Object.prototype.hasOwnProperty.call(conversionReasons, value) ? conversionReasons[value] : "").find(Boolean) ||
                (forceTranscode && externalDts(selectedTrack) ? t("Unsupported audio codec") : t("Playback compatibility"));
            const fallbackHeight = encodedVideo && inputVideo?.Height ? Math.min(inputVideo.Height, maxHeight) : inputVideo?.Height;
            const maxChannels = Number(output.get("transcodingmaxaudiochannels") ?? output.get("maxaudiochannels"));
            const channels = Math.min(selectedAudioTrack?.Channels ?? 0,
                limit?.audioBitrate ? 2 : maxChannels > 0 && method === "Transcode" ? maxChannels : Infinity);
            ui = buildPlayerUi({ media, surface: player, back, signal: playerSignal, subtitleSearch, subtitleSync, itemId: item.Id,
                fullscreenEnabled: nativeFullscreen || document.fullscreenEnabled || document.webkitFullscreenEnabled, isFullscreen, setFullscreen, appFullscreen,
                title: numbered ? `S${item.ParentIndexNumber}:E${item.IndexNumber} “${item.Name}”` : item.Name,
                kicker: item.SeriesName, description: item.Overview, audioPick, subtitlePick, audioSync, notice, burnedSubtitle, originalLanguage,
                autoSkipIntro: prefs.autoSkipIntro, autoSkipRecap: prefs.autoSkipRecap, autoNext: prefs.autoNext !== false,
                chapterMarks: prefs.chapterMarks !== false,
                chapterFailed: reason => note("chapters-unavailable", method, {reason}),
                previewFailed: reason => note("seek-preview-unavailable", method, {reason}),
                segmentSeekFailed: () => note("segment-seek-failed", method),
                sampleUsage: playback.sampleUsage,
                playbackInfo: () => ({
                    playback: {DirectPlay: t("Direct play"), DirectStream: t("Direct stream"), Transcode: t("Converted")}[method],
                    reason: method === "Transcode" ? reason : "",
                    video: [
                        (media.videoHeight || fallbackHeight) ? `${media.videoHeight || fallbackHeight}p` : "",
                        (encodedVideo ? outputCodec && outputCodec !== "copy" ? outputCodec : "h264" : inputCodec).toUpperCase(),
                        encodedVideo ? "SDR" : inputRange
                    ].filter(Boolean).join(", "),
                    audio: [
                        selectedAudioTrack && audioLanguageName(selectedAudioTrack.Language ?? trackLanguage(selectedAudioTrack)),
                        ({1: t("Mono"), 2: t("Stereo"), 6: "5.1", 8: "7.1"})[channels] ?? (channels > 0 ? t("{0} channels", channels) : "")
                    ].filter(Boolean).join(", "),
                    bytes: receivedBytes,
                    connection: ({cellular: t("Mobile data"), wifi: "Wi-Fi"})[playbackConnection.kind]
                }),
                styleKey: preferencesKey(preferenceViewer) + ":subtitle-style",
                findAudio: (opener, language) => addAudio(item, opener, player, playerSignal, language) });
            playback.showJobToast = ui.hint;
            playback.playbackInfoState = ui.playbackInfoState;
            player.replaceChildren(media, ui.root);
            enterPlayer();
            playback.setSubtitles(options.subtitleIndex);
            ui.syncSubtitles();
            autoSubtitles();
            if (["Movie", "Episode"].includes(item.Type)) {
                const metadata = (kind, reportKind) => withinMovieLoad(signal => request(`${kind}/${item.Id}`, {}, undefined, signal), playerSignal)
                    .catch(error => { if (!playerSignal.aborted) noteLookupFailure(reportKind, error, method); });
                void metadata("MediaSegments", "segments-unavailable").then(segments => {
                    if (!playerSignal.aborted) ui.setSegments(segments);
                });
                if (watchGuide) guideLookup = metadata("ParentalGuide", "parental-guide-unavailable");
                const chapterMediaId = libraryId(source.Id) ? source.Id : item.Id;
                const readImages = async () => {
                    const data = await searchLibrary("Items", {ids: [...new Set([chapterMediaId, item.Id])].join(","),
                        userId: session.user, recursive: true, fields: prefs.seekPictures === false ? "Chapters" : "Chapters,Trickplay",
                        enableImages: false, limit: 2}, undefined, playerSignal);
                    if (!Array.isArray(data?.Items)) throw new TypeError("Invalid seek images");
                    const detail = data.Items.find(row => row.Id === item.Id);
                    const version = data.Items.find(row => row.Id === chapterMediaId);
                    const chapters = (Array.isArray(version?.Chapters) ? version.Chapters : []).slice(0, 500)
                        .map((chapter, index) => ({time: chapter?.StartPositionTicks / 1e7,
                            name: chapter?.Name?.trim() || t("Chapter {0}", index + 1),
                            image: /^[\w-]{1,100}$/.test(chapter?.ImageTag ?? "") && libraryId(chapterMediaId)
                                ? mediaUrl(`Items/${chapterMediaId}/Images/Chapter/${index}`, {tag: chapter.ImageTag, maxWidth: 320}).href : null}))
                        .filter(chapter => Number.isFinite(chapter.time) && chapter.time >= 0).sort((a, b) => a.time - b.time);
                    const manifest = detail?.Trickplay?.[source.Id] ?? version?.Trickplay?.[chapterMediaId];
                    const images = prefs.seekPictures === false ? undefined : Object.values(manifest ?? {}).find(info =>
                        [info?.Width, info?.Height, info?.TileWidth, info?.TileHeight, info?.ThumbnailCount, info?.Interval].every(n => Number.isSafeInteger(n) && n > 0) &&
                        info.Width >= 10 && info.Width < 10000 && info.TileWidth * info.TileHeight <= 1000);
                    if (!playerSignal.aborted) ui.setSeekImages(chapters, images && libraryId(item.Id) && {
                        width: images.Width, height: images.Height, columns: images.TileWidth, rows: images.TileHeight,
                        interval: images.Interval, count: images.ThumbnailCount,
                        url: index => mediaUrl(`Videos/${item.Id}/Trickplay/${images.Width}/${index}.jpg`,
                            chapterMediaId !== item.Id ? {mediaSourceId: chapterMediaId} : {}).href
                    });
                };
                void readImages().catch(error => { if (!playerSignal.aborted) noteLookupFailure("chapters-unavailable", error, method); });
            }
            if (item.Type === "Episode" && item.SeriesId) {
                const shuffled = shuffleQueue;
                (shuffled ? Promise.resolve(shuffled) : seriesEpisodes(item)).then(list => {
                    if (current !== playback) return;
                    const season = item.ParentIndexNumber == null ? [...list] :
                        list.filter(episode => episode.ParentIndexNumber === item.ParentIndexNumber);
                    if (shuffled) season.sort((a, b) => (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
                    ui.setEpisodes(season, item.Id, (next, promptOpener) => play(next, opener, {askResume: true, promptOpener}));
                    const index = list.findIndex(episode => episode.Id === item.Id);
                    const after = index < 0 ? undefined : list[index + 1];
                    ui.setNext(after, next => play(next, opener, {shuffle: shuffled}), after && cardArtwork(after));
                }).catch(error => {
                    if (!playerSignal.aborted) noteLookupFailure("next-episode-unavailable", error, method);
                });
            }
            if (item.Type === "Trailer") media.addEventListener("ended", () => void closePlayback(), {signal: playerSignal});
            ui.playButton.focus();
            ui.reopenSheet(options.sheet, options.focusSubtitle);
            if (playerInfo) ui.reopenPlaybackInfo(playerInfo);
            library.hidden = true;
            toolbar.hidden = true;
            if (quality === "saver" && prefs.dataSaver === "auto" && !autoHintShown) {
                autoHintShown = true;
                const key = preferencesKey(preferenceViewer) + ":data-saver-hint";
                let seen = false;
                try { seen = !!localStorage.getItem(key); localStorage.setItem(key, "1"); } catch {}
                if (!seen) ui.hint(t("Switched to Saver on mobile data."));
            }
            status.textContent = "";
            const startMedia = () => {
                if (paused || current !== playback || recovering) return;
                media.play().catch(error => {
                    if (current !== playback || recovering) return;
                    if (error?.name === "NotSupportedError") failed("mediaError");
                    else if (!media.error) ui.say(t("Press play to start."));
                });
            };
            // Register before loading the media so the first range or HLS segment is counted.
            await usageReady;
            if (current !== playback) return;
            if (playback.hls) {
                playback.hls.once(Hls.Events.MANIFEST_PARSED, startMedia);
                playback.hls.loadSource(stream.href);
                playback.hls.attachMedia(media);
            } else {
                media.src = stream;
                startMedia();
            }
            if (network !== connectionRevision) void playback.refreshQuality();
        } catch {
            if (active && rev === selection && !requestSignal.aborted) {
                if (!opened) {
                    note("open-failed", method, diagnostics());
                    if (current) current.showJobToast?.(failure + " Try again.");
                    else showPlaybackNotice(failure + " Try again.", opener);
                    return;
                }
                await leavePlayer();
                if (!active || rev !== selection) return;
                note("open-failed", method, diagnostics());
                library.hidden = false;
                toolbar.hidden = !!seriesView;
                opener?.focus();
                showPlaybackNotice(failure, opener);
                stop();
                playerItem = playerOpener = undefined;
                publishNavigation("back");
            }
        } finally {
            attempt?.abort();
            if (attempt && resumeRequest === attempt) {
                resumeRequest = undefined;
                if (!opened && status.textContent === opening) status.textContent = "";
            }
        }
    }
    function progressOf(item) {
        if (isShortMovie(item.RunTimeTicks)) return 0;
        const data = item.UserData;
        if (data?.PlayedPercentage > 0) return Math.round(data.PlayedPercentage);
        return item.RunTimeTicks > 0 && data?.PlaybackPositionTicks > 0
            ? Math.round(data.PlaybackPositionTicks / item.RunTimeTicks * 100) : 0;
    }
    // A title without artwork gets its own colour from its name, so a row of unposted titles stays tellable apart.
    function titleHue(text) {
        let h = 7;
        for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
        return String(h);
    }
    const plural = (count, unit) => t(count === 1 ? "{0} " + unit : "{0} " + unit + "s", count);
    const tmdbAttribution = t("This product uses the TMDB API but is not endorsed or certified by TMDB.");
    const chip = text => {
        const node = el("span", text);
        node.className = "movie-chip";
        return node;
    };
    const titleKey = item => item.SeriesId || item.Id;
    const playedAt = item => Date.parse(item.UserData?.LastPlayedDate) || 0;
    function seriesCardItem(item) {
        if (!item.SeriesId) return item;
        return { ...item, Id: item.SeriesId, Name: item.SeriesName || item.Name, Type: "Series", SeriesName: undefined,
            ProviderIds: undefined, MediaStreams: undefined, MediaSources: undefined, LocalTrailerCount: undefined,
            ImageTags: { Primary: item.SeriesPrimaryImageTag, Thumb: item.SeriesThumbImageTag },
            BackdropImageTags: undefined, ParentThumbItemId: undefined, ParentPrimaryImageItemId: undefined };
    }

    let seriesView, detailNumber = 0;
    function publishNavigation(action) {
        if (preview) return;
        const route = seriesView || playerItem ? JSON.stringify({detail: seriesView?.item,
            season: seriesView?.historySeason, player: playerItem}) : null;
        Promise.resolve(app.invokeMethodAsync("MovieNavigationChanged", route, action)).catch(() => {});
    }
    function closeSeries(focus, fromHistory = false, keepFocus = false) {
        if (!seriesView) return;
        clearPlaybackNotice();
        if (relatedFailures.includes(status.textContent)) status.textContent = "";
        const { section, opener, controller, fromResults, scrollTop, parent, job } = seriesView;
        seriesView = parent;
        controller.abort();
        if (parent) {
            parent.section.hidden = false;
            if (!keepFocus) {
                const target = opener.dataset.downloadRow === undefined
                    ? opener.isConnected && !opener.closest("[hidden]") ? opener :
                        [...parent.section.querySelectorAll("[data-person-id]")].find(node => node.dataset.personId === opener.dataset.personId
                            && !node.closest("[hidden]")) ?? parent.section.querySelector("h2")
                    :
                    downloadTray.hidden ? parent.section.querySelector("h2") : downloadToggle;
                target?.focus({preventScroll: true});
            }
            section.remove();
            scrollHost.scrollTop = scrollTop;
            if (!fromHistory) publishNavigation("back");
            return;
        }
        browse.hidden = fromResults;
        results.hidden = false;
        results.getAnimations?.().forEach(animation => animation.cancel());
        results.classList.remove("movie-results-leaving");
        results.inert = false;
        toolbar.hidden = false;
        if (!fromResults) resetHomeShelves();
        const destination = fromResults ? results : browse;
        destination.classList.add("movie-screen-entry");
        let target = focus || (opener.dataset.downloadRow !== undefined && !downloadTray.hidden ? downloadToggle : opener);
        if (!keepFocus) {
            if (!focus && target === opener && (!opener.isConnected || opener.closest("[hidden], [inert]"))) {
                const candidates = [...destination.querySelectorAll(".movie-card, .movie-continue-menu-button, .movie-hero-details")]
                    .filter(node => node.dataset.itemId === opener.dataset.itemId && !node.closest("[hidden], [inert]"));
                const kind = opener.matches(".movie-card") ? ".movie-card" :
                    opener.matches(".movie-continue-menu-button") ? ".movie-continue-menu-button" : ".movie-hero-details";
                const replacement = !fromResults && job && opener.hasAttribute("data-pending-download") &&
                    browseShelves.flatMap(shelf => shelf.items).map(seriesCardItem)
                        .find(item => sameDownloadedTitle(job.item, item));
                target = candidates.find(node => node.matches(kind)) ?? candidates[0] ??
                    (replacement && [...browse.querySelectorAll(".movie-card")].find(node =>
                        node.dataset.titleKey === replacement.Id)) ?? (fromResults ? submit : browse);
            }
            if (!fromResults && !focus) {
                const tile = target.closest(".movie-resume-card") ?? target.closest(".movie-card");
                tile?.closest(".movie-shelf-lane")?.revealCard?.(tile, true);
            }
            target.focus({preventScroll: true});
        }
        section.remove();
        scrollHost.scrollTop = scrollTop;
        if (!keepFocus && !focus && fromResults && target !== opener && target.matches(".movie-card"))
            target.scrollIntoView({block: "nearest", inline: "nearest"});
        if (!fromHistory) publishNavigation("back");
    }
    const trailers = new Map();
    function rememberTrailer(key, trailer) {
        if (trailers.size >= 80) trailers.delete(trailers.keys().next().value);
        trailers.set(key, trailer);
        return trailer;
    }
    async function localTrailerFor(item, signal) {
        if (!libraryId(item.Id) || item.LocalTrailerCount === 0) return null;
        const key = "local:" + item.Id;
        if (trailers.has(key)) return trailers.get(key);
        const rows = await searchLibrary(`Items/${item.Id}/LocalTrailers`, {}, undefined, signal);
        if (!Array.isArray(rows)) throw new TypeError("Invalid trailer list");
        const local = rows.find(row => libraryId(row.Id) && !row.IsMissing && row.LocationType !== "Virtual");
        return rememberTrailer(key, local ? {...local, Type: "Trailer", Name: item.Name + " trailer"} : null);
    }
    async function trailerFor(item, signal) {
        if (preview || !item || signal.aborted) return null;
        let id = tmdbIdOf(item);
        const kind = item.Type === "Series" ? "tv" : "movie";
        const key = [item.Id, kind, id].join(":");
        if (trailers.has(key)) return trailers.get(key);
        let localFailure;
        try {
            const local = await localTrailerFor(item, signal);
            if (local) return {local};
        } catch (error) {
            if (signal.aborted) return null;
            noteLookupFailure("trailer-unavailable", error);
            localFailure = error;
        }
        if (!id && libraryId(item.Id)) {
            try {
                const detail = await searchLibrary(`Items/${item.Id}`, {userId: session.user}, undefined, signal);
                id = tmdbIdOf(detail);
            } catch (error) {
                if (signal.aborted) return null;
                localFailure ??= error;
            }
        }
        if (!/^[1-9]\d{0,9}$/.test(id)) {
            if (localFailure) throw localFailure;
            return null;
        }
        const reply = await boundedCall(signal, "MovieTrailer", kind, id);
        if (!reply || reply.youtube !== null && !/^[A-Za-z0-9_-]{11}$/.test(reply.youtube ?? ""))
            throw new TypeError("Invalid trailer");
        const trailer = reply.youtube ? {youtube: reply.youtube} : null;
        if (!trailer && localFailure) throw localFailure;
        return rememberTrailer(key, trailer);
    }
    function youtubeWatch(watchUrl, label = t("Watch on YouTube")) {
        const link = el("a", t(label));
        link.className = "movie-source-action";
        link.append(icon(label === "Trailer" ?
            "M4.5 6h15A2.5 2.5 0 0 1 22 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 15.5v-7A2.5 2.5 0 0 1 4.5 6ZM10 9l5 3-5 3Z" :
            "M13 5h6v6m0-6-9 9m6-1v5H6V8h5"));
        if (typeof watchUrl !== "string" || !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(watchUrl)) return link;
        link.href = watchUrl;
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        link.onclick = event => {
            event.preventDefault();
            link.focus();
            Promise.resolve(app.invokeMethodAsync("MovieOpenLink", watchUrl))
                .catch(() => window.open(watchUrl, "_blank", "noopener,noreferrer"));
        };
        return link;
    }
    function openPerson(actor, opener, fromHistory = false, keepFocus = false) {
        const parent = seriesView, fromResults = parent?.fromResults ?? browse.hidden;
        const controller = new AbortController(), signal = controller.signal;
        const section = el("section"), heading = el("h2", actor.Name), profile = el("aside"), body = el("div");
        const back = button("", () => closeSeries()), bio = el("p"), facts = el("dl");
        const message = el("p"), shelves = el("div");
        const retry = button(t("Retry person details"), () => void load());
        let biography = "", excerpt = "";
        const expand = button(t("Read full biography"), () => {
            const open = expand.getAttribute("aria-expanded") === "true";
            expand.setAttribute("aria-expanded", String(!open));
            expand.textContent = open ? t("Read full biography") : t("Show less biography");
            bio.textContent = open ? excerpt : biography;
            bio.classList.toggle("movie-person-bio-clipped", open);
        });
        heading.id = "movie-person-" + ++detailNumber;
        heading.tabIndex = -1;
        section.setAttribute("aria-labelledby", heading.id);
        section.className = "movie-series movie-person-page";
        body.className = "movie-person-body";
        back.className = "movie-title-back";
        back.setAttribute("aria-label", t("Back from ") + actor.Name);
        back.append(icon("M19 12H5m7-7-7 7 7 7"));
        const portrait = cardArtwork({...actor, TmdbPoster: actor.TmdbPortrait, ImageTags: {Primary: actor.PrimaryImageTag}});
        profile.append(portrait, facts);
        bio.id = heading.id + "-bio";
        expand.setAttribute("aria-expanded", "false");
        expand.setAttribute("aria-controls", bio.id);
        bio.hidden = expand.hidden = retry.hidden = true;
        message.setAttribute("role", "status");
        body.append(heading, bio, expand, message, retry, shelves);
        section.append(back, profile, body);
        section.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); closeSeries(); }
        });
        const view = {item: actor, section, opener, controller, fromResults, parent, scrollTop: scrollHost.scrollTop};
        seriesView = view;
        catalogue.append(section);
        if (!keepFocus) heading.focus({preventScroll: true});
        if (parent) parent.section.hidden = true;
        toolbar.hidden = browse.hidden = results.hidden = true;
        scrollHost.scrollTop = 0;
        setDownloadPanel(false);
        if (!fromHistory) publishNavigation("open");
        let busy = false, owned, person;
        async function load() {
            if (busy || signal.aborted) return;
            busy = true;
            retry.setAttribute("aria-disabled", "true");
            message.textContent = t("Loading credits…");
            await withinMovieLoad(async bounded => {
                const libraryCredits = async () => {
                    const items = [];
                    let page, startIndex = 0;
                    do {
                        page = await request("Items", {userId: session.user, includeItemTypes: "Movie,Series", recursive: true,
                            fields: "ProviderIds,MediaStreams", sortBy: "PremiereDate,SortName", sortOrder: "Descending",
                            ...(libraryId(actor.Id) ? {personIds: actor.Id} : {person: actor.Name}),
                            startIndex, limit: 100}, undefined, bounded);
                        if (!Array.isArray(page?.Items)) throw new TypeError("Invalid person credits");
                        items.push(...page.Items.filter(row => !row.IsMissing && row.LocationType !== "Virtual"));
                        startIndex += page.Items.length;
                    } while (page.Items.length && startIndex < page.TotalRecordCount);
                    return items;
                };
                const metadata = async () => {
                    let id = tmdbIdOf(actor);
                    if (!id && libraryId(actor.Id)) {
                        const detail = await request(`Items/${actor.Id}`, {userId: session.user}, undefined, bounded);
                        id = tmdbIdOf(detail);
                        if (!id && detail?.Overview) return {biography: detail.Overview, films: []};
                    }
                    if (!/^[1-9]\d{0,9}$/.test(id)) return {films: []};
                    const reply = await boundedCall(bounded, "MoviePerson", id);
                    if (!Array.isArray(reply?.films)) throw Error("Invalid person details");
                    return reply;
                };
                await Promise.all([
                    owned ? null : libraryCredits().then(rows => { owned = rows; }).catch(error => {
                        if (!signal.aborted) noteLookupFailure("person-unavailable", error);
                    }),
                    person ? null : metadata().then(detail => { person = detail; }).catch(error => {
                        if (!signal.aborted) noteLookupFailure("person-unavailable", error);
                    })
                ]);
            }, signal);
            if (signal.aborted) return;
            busy = false;
            retry.removeAttribute("aria-disabled");
            if (owned && person && document.activeElement === retry) heading.focus({preventScroll: true});
            retry.hidden = Boolean(owned && person);
            message.textContent = !owned ? t("Could not check your library. Try again.") :
                !person ? t("Could not load the biography and credits. Try again.") : "";
            if (person && !facts.childElementCount) {
                if (person.portrait) chainImages(portrait.querySelector("img"), [person.portrait, portrait.querySelector("img").src].filter(Boolean));
                for (const [label, value] of [[t("Born"), person.born], [t("Known for"), person.known_for]]) {
                    if (value) facts.append(el("dt", label), el("dd", value));
                }
                if (person.biography) {
                    biography = person.biography;
                    const shortened = biography.length > 250;
                    const wordEnd = biography.lastIndexOf(" ", 250);
                    excerpt = shortened ? biography.slice(0, wordEnd > 0 ? wordEnd : 250) + "…" : biography;
                    bio.textContent = excerpt;
                    bio.hidden = false;
                    expand.hidden = !shortened;
                    bio.classList.toggle("movie-person-bio-clipped", !expand.hidden);
                }
            }
            if (!owned) return;
            if (shelves.childElementCount) { renderMore(); return; }
            const inLibrary = el("section"), rows = el("div");
            inLibrary.className = "movie-shelf";
            inLibrary.dataset.format = "person";
            inLibrary.append(el("h3", t("In your library")));
            rows.className = "movie-cards";
            rows.append(...owned.map(item => card(item, "person")));
            if (owned.length) {
                const lane = shelfLane(rows, t("In your library"), signal);
                inLibrary.append(lane.lane);
                shelves.append(inLibrary);
                lane.update();
            } else {
                inLibrary.append(el("p", t("No titles in your library.")));
                shelves.append(inLibrary);
            }
            renderMore();
        }
        function renderMore() {
            if (!owned || !person || shelves.querySelector(".movie-person-films")) return;
            const localIds = new Set(owned.filter(item => item.Type === "Movie").map(tmdbIdOf));
            const localNames = new Set(owned.filter(item => item.Type === "Movie" && !tmdbIdOf(item))
                .map(item => searchTitle(item.Name) + ":" + item.ProductionYear));
            const films = person.films.filter(film => !localIds.has(String(film.id)) &&
                !localNames.has(searchTitle(film.title) + ":" + film.year));
            if (!films.length) return;
            const more = el("section"), list = el("ul");
            more.className = "movie-person-films";
            list.setAttribute("role", "list");
            more.append(el("h3", t("More films")), list);
            for (const film of films) {
                const row = el("li"), message = el("p");
                message.setAttribute("role", "status");
                row.append(cardArtwork({Id: "tmdb-" + film.id, Name: film.title, TmdbPoster: film.poster}),
                    el("strong", film.title));
                if (film.year) row.append(el("small", film.year));
                if (session.requests_enabled) {
                    const action = requestTitleAction(film, null, message, row);
                    if (action) row.append(action);
                    row.append(message);
                }
                list.append(row);
            }
            shelves.append(more);
        }
        void load();
    }
    function openSeries(item, opener, preferredSeason, fromHistory = false, keepFocus = false, handoff) {
        cancelSlowSearch?.();
        const original = item;
        item = {...item};
        const section = el("section"), heading = el("h2", item.Name), summary = el("p"), list = el("div");
        const back = button("", () => closeSeries());
        back.className = "movie-title-back";
        back.setAttribute("aria-label", t("Back to titles"));
        back.append(icon("M19 12H5m7-7-7 7 7 7"));
        const controller = new AbortController(), signal = controller.signal;
        const parent = seriesView, fromResults = parent?.fromResults ?? browse.hidden;
        const isSeries = item.Type === "Series", isCollection = item.Type === "BoxSet";
        section.className = "movie-series movie-screen-entry " +
            (isSeries ? "movie-show-detail" : isCollection ? "movie-collection-detail" : "movie-film-detail");
        heading.id = "movie-series-title-" + ++detailNumber;
        section.setAttribute("aria-labelledby", heading.id);
        heading.tabIndex = -1;
        summary.setAttribute("role", "status");
        list.className = "movie-season-list";
        const intro = el("div"), actions = el("div");
        const overview = el("p", item.Overview), facts = el("div"), detailStatus = el("p");
        overview.hidden = !item.Overview;
        facts.className = "movie-title-facts";
        detailStatus.className = "movie-favorite-status";
        detailStatus.setAttribute("role", "status");
        intro.className = "movie-title-intro";
        actions.className = "movie-title-actions movie-hero-actions";
        const text = el("div");
        text.className = "movie-title-text";
        text.append(heading, facts, actions, overview, detailStatus);
        intro.append(cardArtwork(item), text);
        let episodesColumn, updateEpisodeScroll, observeEpisodeScroll;
        if (isSeries) {
            const columns = el("div"), info = el("div");
            episodesColumn = el("div");
            columns.className = "movie-show-columns";
            info.className = "movie-show-info";
            episodesColumn.className = "movie-show-episodes";
            episodesColumn.setAttribute("role", "region");
            episodesColumn.setAttribute("aria-label", t("Episodes and related series"));
            updateEpisodeScroll = () => {
                const scrollable = episodesColumn.scrollHeight - episodesColumn.clientHeight > 1;
                if (!scrollable && document.activeElement === episodesColumn) heading.focus({preventScroll: true});
                episodesColumn.tabIndex = scrollable ? 0 : -1;
                episodesColumn.toggleAttribute("data-more-below", scrollable &&
                    episodesColumn.scrollHeight - episodesColumn.scrollTop - episodesColumn.clientHeight > 1);
            };
            episodesColumn.addEventListener("scroll", updateEpisodeScroll, {passive: true, signal});
            list.addEventListener("keydown", event => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !event.target.matches("button.movie-episode-body") ||
                    !["ArrowDown", "ArrowUp"].includes(event.key)) return;
                const controls = [...list.querySelectorAll("button.movie-episode-body")];
                const next = controls[controls.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1)];
                if (!next) return;
                event.preventDefault();
                next.focus();
            }, {signal});
            if (globalThis.ResizeObserver) {
                const resize = new ResizeObserver(updateEpisodeScroll);
                resize.observe(episodesColumn);
                resize.observe(list);
                observeEpisodeScroll = related => resize.observe(related);
                signal.addEventListener("abort", () => resize.disconnect(), {once: true});
            } else window.addEventListener("resize", updateEpisodeScroll, {signal});
            info.append(intro);
            episodesColumn.append(summary, list);
            columns.append(info, episodesColumn);
            section.append(back, columns);
        } else {
            const header = el("header");
            header.className = "movie-series-header";
            header.append(intro);
            if (isCollection) {
                header.prepend(back);
                section.append(header, list);
            } else {
                section.append(back, header, list);
            }
        }
        let updateDescription;
        if (!isSeries && !isCollection) {
            const description = el("div");
            description.className = "movie-film-description";
            overview.id = heading.id + "-description";
            const read = button("", () => {
                const expanded = read.getAttribute("aria-expanded") !== "true";
                read.setAttribute("aria-expanded", String(expanded));
                read.setAttribute("aria-label", expanded ? t("Show less") : t("Show full description"));
                description.toggleAttribute("data-expanded", expanded);
            });
            read.className = "movie-description-more";
            read.setAttribute("aria-controls", overview.id);
            read.setAttribute("aria-expanded", "false");
            read.setAttribute("aria-label", t("Show full description"));
            read.append(icon("m5 9 7 7 7-7"));
            read.hidden = true;
            overview.classList.add("movie-film-overview");
            overview.replaceWith(description);
            description.append(overview, read);
            updateDescription = () => {
                if (section.hidden) return;
                const height = overview.scrollHeight;
                const collapsedHeight = Math.round(3 * parseFloat(getComputedStyle(overview).lineHeight));
                const clipped = !overview.hidden && height > collapsedHeight;
                description.style.setProperty("--movie-description-height", height + "px");
                if (!clipped && document.activeElement === read) heading.focus({preventScroll: true});
                read.hidden = !clipped;
            };
            if (globalThis.ResizeObserver) {
                const resize = new ResizeObserver(updateDescription);
                resize.observe(overview);
                signal.addEventListener("abort", () => resize.disconnect(), {once: true});
            } else window.addEventListener("resize", updateDescription, {signal});
        }
        section.addEventListener("keydown", event => {
            if (event.key === "Escape" && !event.target.closest("dialog, select")) { event.stopPropagation(); closeSeries(); }
        });
        const job = handoff?.job ?? trackedDownloads.get(item.Id) ??
            [...downloadRows.values()].find(row => row.job?.item.Id === item.Id)?.job;
        const view = { item, job, historySeason: preferredSeason, section, opener, controller, fromResults, parent, scrollTop: scrollHost.scrollTop };
        const staged = Boolean(handoff);
        section.hidden = staged;
        catalogue.append(section);
        const show = (focus = heading) => {
            const leaving = staged && fromResults && !quietMotion() && typeof results.animate === "function" &&
                !results.hidden && !parent;
            if (leaving) {
                results.style.top = results.offsetTop + "px";
                results.classList.add("movie-results-leaving");
            }
            seriesView = view;
            if (!fromHistory) publishNavigation("open");
            status.textContent = "";
            section.hidden = false;
            updateEpisodeScroll?.();
            updateDescription?.();
            handoff?.close();
            if (parent) parent.section.hidden = true;
            browse.classList.remove("movie-screen-entry");
            results.classList.remove("movie-screen-entry");
            toolbar.hidden = true;
            browse.hidden = true;
            if (leaving) {
                results.inert = true;
                const animation = results.animate([{opacity: 1}, {opacity: 0}], {duration: 230, easing: "ease-out", fill: "forwards"});
                const clean = () => {
                    results.hidden = Boolean(seriesView);
                    results.inert = false;
                    results.classList.remove("movie-results-leaving");
                    results.style.removeProperty("top");
                    animation.cancel();
                };
                animation.finished.then(clean, clean);
            } else results.hidden = true;
            if (isCollection) section.scrollIntoView({block: "start"});
            else scrollHost.scrollTop = 0;
            if (!keepFocus) focus.focus({preventScroll: true});
            setDownloadPanel(false);
        };
        if (!staged) show();

        if (isCollection) {
            shelf(t("Titles"), "Movie,Series", false, list, "", signal, {params: {parentId: item.Id}});
            return;
        }
        const demo = preview || item.Demo;
        const playButton = playAction(isSeries ? null : item, true);
        const favorite = demo || job ? null : favoriteAction(item, detailStatus, original);
        playButton.prepend(icon(playPath));
        let selectedMovie = isSeries ? null : item, continuing, removed;
        const remove = button("", () => {
            if (!continuing) return;
            remove.focus({preventScroll: true});
            void dismissContinue(continuing, remove, detailStatus, entry => {
                removed = entry.Id;
                selectedMovie = entry;
                if (document.activeElement === remove) playButton.focus({preventScroll: true});
                view.syncContinue();
            });
        });
        remove.className = "movie-continue-remove";
        remove.setAttribute("aria-label", removeContinueLabel);
        remove.append(icon(removePath));
        remove.hidden = true;
        if (!demo) actions.append(playButton, remove, ...[favorite].filter(Boolean));
        view.syncContinue = () => {
            if (demo || job || signal.aborted) return;
            continuing = resumeShelf.items.find(entry => titleKey(entry) === titleKey(item));
            const next = continuing ?? selectedMovie;
            if (continuing) removed = undefined;
            if (!continuing && document.activeElement === remove)
                (next ? playButton : heading).focus({preventScroll: true});
            remove.hidden = !continuing;
            playButton.setMovie(next, Boolean(continuing), next?.Id === removed || next?.FamilyHubResumeHidden);
        };
        view.syncContinue();
        if (!demo && !job && !isSeries && session.downloads_enabled) list.before(audioJobSlot(item));
        const trackStatus = el("p");
        if (job) {
            trackStatus.className = "movie-download-tracks";
            trackStatus.hidden = true;
            actions.after(trackStatus);
        }
        let lastAnnounced = -1, localTitle, lookingUp = false;
        const updateJob = () => {
            if (!job) return;
            const jobEntry = queueEntry(job);
            const percent = downloadPercent(jobEntry);
            const tracks = Array.isArray(jobEntry?.fetching) ? jobEntry.fetching : [];
            trackStatus.textContent = tracks.length ? t("Fetching ") + tracks.join(" and ") :
                percent === 100 && !localTitle && !isSeries ? t("Waiting for the library") : "";
            trackStatus.hidden = !trackStatus.textContent;
            if (!isSeries) {
                playButton.setDownload(percent, localTitle);
                if (percent === 100 && !localTitle && !lookingUp && !section.hidden) {
                    lookingUp = true;
                    void downloadedLibraryTitle(item, signal).then(found => {
                        if (signal.aborted || !found) return;
                        localTitle = found;
                        playButton.setDownload(100, found);
                        if (!tracks.length) trackStatus.hidden = true;
                    }).finally(() => { lookingUp = false; });
                }
            }
            const step = Math.floor(percent / 10);
            if (seriesView === view && step > lastAnnounced) {
                if (lastAnnounced >= 0) homeStatus.textContent = percent === 100
                    ? t("{0} download complete.", item.Name) : t("{0}, {1}% downloaded.", item.Name, step * 10);
                lastAnnounced = step;
            }
        };
        view.updateDownload = () => updateJob();
        if (job && !isSeries) view.shouldPollLibrary = () => downloadPercent(queueEntry(job)) === 100 && !localTitle;
        updateJob();
        let backdrop, backdropKey;
        section.dataset.titleBackground = movieUi.titleBackground;
        const updateBackdrop = () => {
            if (movieUi.titleBackground === "plain") return;
            const key = JSON.stringify([item.TmdbBackdrop, backdropSources(item), innerWidth > 1920]);
            if (key === backdropKey) return;
            backdropKey = key;
            const art = movieBackdrop(item);
            if (backdrop) backdrop.replaceWith(art); else section.prepend(art);
            backdrop = art;
        };
        const cast = el("div");
        let stopCastLayout;
        signal.addEventListener("abort", () => stopCastLayout?.(), {once: true});
        intro.after(cast);
        // The section order from Customise Home. The default leaves the page as it is: the cast beside the intro.
        const placeSections = related => {
            const order = movieUi.titleSections;
            if (order.join() === titleSectionIds.join()) return;
            const column = episodesColumn ?? list, base = order.indexOf(isSeries ? "episodes" : "related");
            column.classList.add("movie-sections-ordered");
            column.append(cast);
            cast.style.order = order.indexOf("cast") - base;
            if (related) related.style.order = order.indexOf("related") - base;
        };
        placeSections();
        function updateDetails() {
            const background = movieUi.titleBackground === "plain" ? homeBackgrounds.slate : backgroundFor(item);
            section.style.setProperty("--movie-hero-start", background[0]);
            section.style.setProperty("--movie-hero-end", background[1]);
            updateBackdrop();
            if (!isSeries || job) setTitleLogo(item, heading);
            overview.textContent = item.Overview ?? "";
            overview.hidden = !item.Overview;
            updateDescription?.();
            renderTitleFacts(item, facts);
            stopCastLayout?.();
            stopCastLayout = renderCast(item, cast);
        }
        updateDetails();
        largeBackdrop.addEventListener?.("change", updateBackdrop, {signal});
        const prepareSignal = handoff?.signal ?? signal;
        const details = job ? loadDownloadMetadata(item, prepareSignal).then(detail => {
            if (!detail || prepareSignal.aborted) return;
            Object.assign(item, detail);
            if (detail.TmdbPoster && detail.TmdbPoster !== job.item.TmdbPoster) {
                job.item.TmdbPoster = detail.TmdbPoster;
                if (trackedDownloads.get(job.item.Id) === job) saveDownloads();
                placeBrowseCards();
            }
            intro.firstElementChild.replaceWith(cardArtwork(item));
            updateDetails();
        }) : demo ? Promise.resolve() : searchLibrary("Items", {
            userId: session.user, ids: item.Id, includeItemTypes: item.Type, recursive: true, limit: 1,
            fields: "Overview,Genres,ProviderIds,People" + (isSeries ? "" : ",MediaStreams"),
            enableUserData: true, enableImages: true, enableImageTypes: "Primary,Thumb,Backdrop,Logo", imageTypeLimit: 1
        }, undefined, signal).catch(() => null).then(reply => {
            const detail = Array.isArray(reply?.Items) && reply.Items.find(candidate => candidate.Id === item.Id);
            if (signal.aborted || !detail) return;
            const posterChanged = detail.ImageTags?.Primary && detail.ImageTags.Primary !== item.ImageTags?.Primary;
            Object.assign(item, {...detail, UserData: {...detail.UserData, ...item.UserData}});
            if (posterChanged) intro.firstElementChild.replaceWith(cardArtwork(item));
            if (!isSeries) view.syncContinue();
            markFavorite(favorite, isFavorite(item));
            updateDetails();
        });
        if (!demo) void Promise.resolve(details).catch(() => {}).then(() => loadRatings(item, signal))
            .then(found => { if (found && !signal.aborted) updateDetails(); }).catch(() => {});
        if (!demo) {
            let busy = false;
            const retry = button(t("Retry trailer lookup"), () => void loadTrailer());
            retry.hidden = true;
            actions.append(retry);
            async function loadTrailer() {
                if (signal.aborted || busy) return;
                busy = true;
                retry.setAttribute("aria-disabled", "true");
                try {
                    const found = await trailerFor(item, signal);
                    if (signal.aborted) return;
                    const trailer = found?.local ? button(t("Trailer"), () => void play(found.local, trailer)) :
                        found?.youtube ? youtubeWatch("https://www.youtube.com/watch?v=" + found.youtube, "Trailer") : null;
                    if (trailer) {
                        trailer.classList.add("movie-title-trailer");
                        if (found.local) trailer.prepend(icon(playPath));
                        else trailer.setAttribute("aria-label", t("Trailer on YouTube"));
                        retry.before(trailer);
                    }
                    if (detailStatus.textContent === t("Could not check for a trailer. Try again.")) detailStatus.textContent = "";
                    if (document.activeElement === retry) (trailer ?? heading).focus({preventScroll: true});
                    retry.remove();
                } catch (error) {
                    if (signal.aborted) return;
                    noteLookupFailure("trailer-unavailable", error);
                    retry.hidden = false;
                    detailStatus.textContent = t("Could not check for a trailer. Try again.");
                } finally {
                    busy = false;
                    retry.removeAttribute("aria-disabled");
                }
            }
            void Promise.resolve(details).catch(() => {}).then(loadTrailer);
        }
        const reveal =async (data, mainAction) => {
            if (!staged) return;
            await Promise.race([Promise.resolve(data).then(() => preloadDetailImages(section, prepareSignal)).catch(() => {}), handoff.deadline]);
            if (handoff.cancelled() || !active || seriesView !== parent) {
                controller.abort();
                section.remove();
                return false;
            }
            if (handoff.expired) for (const image of section.querySelectorAll("img[src]")) {
                if (image.complete) continue;
                image.onload = image.onerror = null;
                image.removeAttribute("src");
                delete image.dataset.loading;
            }
            handoff.finish();
            section.classList.add("movie-download-entry");
            show(mainAction());
            if (handoff.announce) homeStatus.textContent = t("{0} opened. Download started.", item.Name);
            view.updateDownload();
            return true;
        };
        if (!staged && job) updateJob();
        let relatedReady = details;
        if (!demo) {
            const relatedFailure = relatedFailures[Number(isSeries)];
            const relatedTitle = t("More like this");
            const related = el("section"), relatedHeader = el("div"), relatedHeading = el("h2", relatedTitle);
            const action = button("", () => {
                action.focus({preventScroll: true});
                void retry();
            });
            action.className = "movie-title-retry";
            action.setAttribute("aria-label", relatedFailure + ". Retry");
            action.append(icon("M20 7v5h-5M4 17v-5h5m-5 0a8 8 0 0 1 14-5l2 5m0 0a8 8 0 0 1-14 5l-2-5"));
            action.hidden = related.hidden = true;
            related.className = "movie-shelf";
            related.dataset.format = "related";
            relatedHeader.className = "movie-related-header";
            relatedHeader.append(relatedHeading, action);
            related.append(relatedHeader);
            (episodesColumn ?? list).append(related);
            placeSections(related);
            observeEpisodeScroll?.(related);
            let loaded = false;
            action.addEventListener("blur", () => {
                if (!loaded) return;
                action.hidden = true;
                related.hidden = !related.querySelector(".movie-shelf-lane");
            });
            const retry = async (requestSignal = signal) => {
                if (loaded || action.getAttribute("aria-disabled") === "true") return;
                action.setAttribute("aria-disabled", "true");
                try {
                    const found = await loadRelated(item, related, relatedTitle, requestSignal, signal);
                    if (requestSignal.aborted) return;
                    loaded = true;
                    if (status.textContent === relatedFailure) status.textContent = "";
                    action.hidden = document.activeElement !== action;
                    related.hidden = !found && action.hidden;
                } catch {
                    if (requestSignal.aborted) return;
                    related.hidden = action.hidden = false;
                    if (!section.hidden && status.textContent !== relatedFailure) status.textContent = relatedFailure;
                } finally {
                    action.setAttribute("aria-disabled", String(loaded));
                    updateEpisodeScroll?.();
                }
            };
            relatedReady = job ? Promise.all([details, retry(prepareSignal)]) :
                details.then(() => !prepareSignal.aborted && retry(prepareSignal));
        }
        if (!isSeries) return reveal(relatedReady, () => job ? playButton : heading);
        if (demo) return;

        const seasons = el("div"), lane = el("div"), pills = new Map();
        seasons.className = "movie-season-picker";
        seasons.hidden = true;
        lane.className = "movie-season-pills";
        lane.setAttribute("role", "group");
        lane.setAttribute("aria-label", t("Seasons"));
        const seasonOutline = el("span");
        seasonOutline.className = "movie-season-outline";
        seasonOutline.setAttribute("aria-hidden", "true");
        seasonOutline.hidden = true;
        lane.append(seasonOutline);
        const arrows = [-1, 1].map(direction => {
            const arrow = button("", () => {
                if (arrow.getAttribute("aria-disabled") === "true") return;
                lane.scrollBy({left: direction * lane.clientWidth * .8, behavior: quietMotion() ? "auto" : "smooth"});
            });
            arrow.className = "movie-season-arrow";
            arrow.setAttribute("aria-label", direction < 0 ? t("Previous seasons") : t("Next seasons"));
            arrow.append(icon(direction < 0 ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"));
            return arrow;
        });
        seasons.append(arrows[0], lane, arrows[1]);
        list.before(seasons);
        const available = new Map(), pictures = new Map();
        let episodes = null, metadata = null, tmdbId, revision = 0, busy = false, selectedSeason;
        const shuffle = button(t("Shuffle episodes"), () => {
            const list = shuffledEpisodes(episodes ?? []);
            if (list.length) void play(list[0], shuffle, {shuffle: list});
        });
        shuffle.prepend(icon("M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c5 0 7-12 12-12h3m-4-4 4 4-4 4"));
        shuffle.hidden = true;
        actions.append(shuffle);
        const seasonFocus = () => pills.get(selectedSeason) ?? heading;
        function updateSeasonArrows() {
            const selected = pills.get(selectedSeason);
            seasonOutline.hidden = !selected;
            if (selected) {
                seasonOutline.style.width = selected.offsetWidth + "px";
                seasonOutline.style.transform = `translateX(${selected.offsetLeft}px)`;
            }
            const room = lane.scrollWidth - lane.clientWidth;
            if (room <= 1 && arrows.includes(document.activeElement)) seasonFocus().focus({preventScroll: true});
            seasons.dataset.overflow = String(room > 1);
            arrows[0].setAttribute("aria-disabled", String(lane.scrollLeft < 1));
            arrows[1].setAttribute("aria-disabled", String(lane.scrollLeft >= room - 1));
            for (const arrow of arrows) arrow.tabIndex = arrow.getAttribute("aria-disabled") === "true" ? -1 : 0;
        }
        lane.addEventListener("scroll", updateSeasonArrows, {passive: true, signal});
        if (globalThis.ResizeObserver) {
            const resize = new ResizeObserver(updateSeasonArrows);
            resize.observe(lane);
            signal.addEventListener("abort", () => resize.disconnect(), {once: true});
        } else window.addEventListener("resize", updateSeasonArrows, {signal});
        function selectSeason(number) {
            selectedSeason = number;
            for (const [n, pill] of pills) pill.setAttribute("aria-pressed", String(n === number));
            updateSeasonArrows();
        }
        const libraryOutage = createServiceStatus({
            detail: t("Reconnect to check your library for episodes."), label: t("Retry library check"),
            retry: () => load(false), focus: seasonFocus, automatic: true
        });
        const metadataOutage = createServiceStatus({
            detail: t("Reconnect to load the full season list."), label: t("Retry season lookup"),
            retry: () => load(false), focus: seasonFocus, automatic: true
        });
        const episodeOutage = createServiceStatus({
            detail: t("Reconnect to load episode details."), label: t("Retry episode data"),
            retry: () => choose(selectedSeason), focus: seasonFocus, automatic: true
        });
        list.after(libraryOutage.card, metadataOutage.card, episodeOutage.card);
        const episodeStatus = el("p");
        episodeStatus.className = "movie-visually-hidden";
        episodeStatus.setAttribute("role", "status");
        list.before(episodeStatus);
        const seasonLoading = movieLoading("seasons");
        seasonLoading.hidden = true;
        seasons.after(seasonLoading);
        const local = async bounded => {
            if (!job) return localEpisodes(item.Id, bounded);
            localTitle ??= await downloadedLibraryTitle(item, bounded);
            return localTitle ? localEpisodes(localTitle.Id, bounded) : [];
        };
        const tmdb = async bounded => {
            if (!item.ProviderIds?.Tmdb) await details;
            return seriesCatalogue(item.Name, item.ProductionYear, item.ProviderIds?.Tmdb, bounded);
        };
        async function loadSeason(number, bounded) {
            if (number == null || !tmdbId || pictures.has(number) || !available.has(number)) return;
            const reply = await boundedCall(bounded, "MovieSeasonEpisodes", tmdbId, number).catch(() => null);
            if (!bounded.aborted && Array.isArray(reply?.episodes)) pictures.set(number, reply.episodes);
        }
        function renderSeason(number) {
            const season = available.get(number);
            const owned = season?.episodes.length ? season.episodes : job ? [] : episodes ?? [];
            selectedMovie = owned.find(episode => hasResumePosition(episode) && !episode.FamilyHubResumeHidden) ??
                owned.find(episode => !episode.UserData?.Played) ?? owned[0];
            if (!selectedMovie && !continuing && document.activeElement === playButton) seasonFocus().focus({preventScroll: true});
            if (job) playButton.setMovie(selectedMovie);
            else view.syncContinue();
            const focus = document.activeElement;
            const focused = list.contains(focus);
            const key = focused && focus.dataset.episodeId;
            list.querySelector(".movie-season")?.stopRatings?.();
            const nodes = season ? [seasonRow(item, number, season, episodes !== null, pictures.get(number), job, pills.get(number), signal)] : [];
            if (!episodes && !job) libraryOutage.show(); else libraryOutage.clear();
            if (episodes && !metadata && !job) metadataOutage.show(); else metadataOutage.clear();
            if (episodes && metadata && season && tmdbId && !pictures.has(number) && !job) episodeOutage.show();
            else episodeOutage.clear();
            if (focused) seasonFocus().focus({preventScroll: true});
            list.replaceChildren(...nodes);
            updateEpisodeScroll?.();
            if (focused) {
                const same = key ? [...list.querySelectorAll("[data-episode-id]")].find(node =>
                    node.dataset.episodeId === key) : null;
                (same ?? seasonFocus()).focus({preventScroll: true});
            }
        }
        async function choose(number) {
            if (!pills.has(number)) return;
            selectSeason(number);
            const change = ++revision;
            list.setAttribute("aria-busy", "true");
            list.setAttribute("data-season-switch", "");
            const waiting = !pictures.has(number) && tmdbId;
            if (waiting) {
                if (list.contains(document.activeElement)) seasonFocus().focus({preventScroll: true});
                const previous = list.querySelector(".movie-season[data-season]");
                if (previous) previous.inert = true;
            if (episodeStatus.textContent !== t("Loading episodes…")) episodeStatus.textContent = t("Loading episodes…");
                const timer = setTimeout(() => {
                    if (signal.aborted || change !== revision || list.querySelector(".movie-episode-loading")) return;
                    const count = previous?.querySelector("ol").childElementCount || 3;
                    list.append(movieLoading("episodes", count));
                }, 250);
                try {
                    await withinMovieLoad(bounded => loadSeason(number, bounded), signal);
                } finally {
                    clearTimeout(timer);
                }
            }
            if (signal.aborted || change !== revision) return;
            renderSeason(number);
            list.hidden = false;
            summarize();
            list.removeAttribute("aria-busy");
            list.removeAttribute("data-season-switch");
            if (!waiting || pictures.has(number)) {
                const count = list.querySelector(".movie-season > ol")?.childElementCount ?? 0;
                episodeStatus.textContent = plural(count, "episode") + " loaded";
            } else episodeStatus.textContent = "";
        }
        function summarize() {
            summary.textContent = episodes && metadata && !available.size ? t("No seasons available.") : "";
        }
        async function load(quiet, requestSignal = signal) {
            if (busy || signal.aborted || list.hasAttribute("data-season-switch")) return;
            busy = true;
            let episodeLoading;
            if (!quiet) {
                summary.textContent = t("Loading seasons…");
                list.setAttribute("aria-busy", "true");
                if (seasons.hidden) seasonLoading.hidden = false;
                if (!list.firstChild) {
                    episodeLoading = movieLoading("episodes");
                    list.append(episodeLoading);
                }
            }
            try {
                await withinMovieLoad(async bounded => {
                    const [localItems, catalogueData] = await Promise.all([
                        job && downloadPercent(queueEntry(job)) < 100 && !quiet ? [] : local(bounded).catch(() => null),
                        metadata ? null : tmdb(bounded).catch(() => null)
                    ]);
                    if (bounded.aborted) return;
                    const changed = localItems && JSON.stringify(localItems) !== JSON.stringify(episodes);
                    if (localItems) episodes = localItems;
                    else if (!bounded.aborted) note("shuffle-unavailable", "", {reason: "request_failed"});
                    if (!episodes?.length && document.activeElement === shuffle) heading.focus({preventScroll: true});
                    shuffle.hidden = !episodes?.length;
                    if (Array.isArray(catalogueData?.seasons)) {
                        metadata = catalogueData.seasons;
                        tmdbId = Number.isInteger(catalogueData.series_id) ? catalogueData.series_id : null;
                    }
                    if (quiet && !changed && !catalogueData?.seasons) return;
                    available.clear();
                    for (const entry of metadata ?? []) {
                        if (Number.isInteger(entry?.number) && entry.number > 0)
                            available.set(entry.number, {total: entry.episode_count, episodes: []});
                    }
                    if (job && preferredSeason && !available.has(preferredSeason))
                        available.set(preferredSeason, {total: job.episodeCount, episodes: []});
                    for (const episode of episodes ?? []) {
                        const number = episode.ParentIndexNumber;
                        if (!Number.isInteger(number) || number < 0) continue;
                        if (!available.has(number)) available.set(number, {episodes: []});
                        available.get(number).episodes.push(episode);
                    }
                    const firstMount = selectedSeason == null;
                    const selected = selectedSeason ?? preferredSeason;
                    const seasonWithProgress = episodes?.find(episode => progressOf(episode) > 0 && !episode.UserData?.Played)?.ParentIndexNumber;
                    const owned = [...available].filter(([, season]) => season.episodes.length).map(([number]) => number);
                    const numbers = [...available.keys()].sort((a, b) => a - b);
                    const number = available.has(selected) ? selected : seasonWithProgress ?? Math.min(...owned, Infinity);
                    const first = available.has(number) ? number : numbers[0];
                    const change = revision;
                    await loadSeason(first, bounded);
                    if (bounded.aborted || change !== revision || list.hasAttribute("data-season-switch")) return;
                    const removedFocus = lane.contains(document.activeElement) && !numbers.some(n => pills.get(n) === document.activeElement);
                    if (removedFocus) heading.focus({preventScroll: true});
                    for (const [n, pill] of pills) {
                        if (available.has(n)) continue;
                        pill.remove();
                        pills.delete(n);
                    }
                    let next = seasonOutline.nextElementSibling;
                    for (const n of numbers) {
                        if (!pills.has(n)) pills.set(n, button(n ? t("Season {0}", n) : t("Specials"), () => {
                            pills.get(n).focus({preventScroll: true});
                            if (selectedSeason !== n) {
                                seriesView.historySeason = n;
                                publishNavigation("replace");
                                void choose(n);
                            }
                        }));
                        const pill = pills.get(n);
                        if (pill !== next) lane.insertBefore(pill, next);
                        next = pill.nextElementSibling;
                    }
                    seasons.hidden = !numbers.length;
                    selectSeason(first);
                    if (removedFocus) seasonFocus().focus({preventScroll: true});
                    if (firstMount && first != null && first !== numbers[0])
                        lane.scrollLeft = pills.get(first).offsetLeft;
                    updateSeasonArrows();
                    renderSeason(first);
                    summarize();
                    view.updateDownload();
                }, requestSignal);
            } finally {
                busy = false;
                seasonLoading.hidden = true;
                episodeLoading?.remove();
                if (!list.hasAttribute("data-season-switch")) list.removeAttribute("aria-busy");
            }
        }
        view.refreshProgress = () => load(true);
        if (job) view.shouldPollLibrary = () => {
            if (downloadPercent(queueEntry(job)) !== 100) return false;
            const season = available.get(job.season);
            if (job.episode) return !season?.episodes.some(episode => episode.IndexNumber === job.episode);
            return !season?.episodes.length || season.total > season.episodes.length;
        };
        view.updateDownload = () => {
            updateJob();
            for (const [number, pill] of pills) {
                const entry = seasonDownload(searchTitle(item.Name), number, job);
                pill.toggleAttribute("data-downloading", Boolean(entry));
                if (entry) pill.style.setProperty("--download-fill", downloadPercent(entry) + "%");
            }
            const row = list.querySelector(".movie-season[data-season]");
            if (row) updateSeasonState(row, job, pills.get(Number(row.dataset.season)));
        };
        if (job && preferredSeason != null) {
            available.set(preferredSeason, {total: job.episodeCount, episodes: []});
            const pill = button(preferredSeason ? t("Season {0}", preferredSeason) : t("Specials"), () => void choose(preferredSeason));
            pills.set(preferredSeason, pill);
            lane.append(pill);
            seasons.hidden = false;
            selectSeason(preferredSeason);
            episodes = [];
            renderSeason(preferredSeason);
            view.updateDownload();
        }
        const ready = Promise.all([relatedReady, load(false, prepareSignal)]);
        return reveal(ready, seasonFocus);
    }
    function hasResumePosition(item) {
        return item && !isShortMovie(item.RunTimeTicks) && !item.UserData?.Played &&
            (item.UserData?.PlaybackPositionTicks > 0 || progressOf(item) > 0);
    }
    function playAction(item, titlePage = false, hero = false) {
        let start, direct;
        const action = button("", () => {
            if (item && action.getAttribute("aria-disabled") !== "true")
                void play(item, action, start ? {position: 0} : {askResume: !direct});
        });
        const label = el("span"), where = el("small"), words = document.createTextNode("");
        where.className = "movie-continue-position";
        where.hidden = true;
        label.append(words, where);
        action.append(label);
        action.setMovie = (movie, continuing = false, fromStart = false) => {
            item = movie;
            start = fromStart;
            action.hidden = !item;
            const resume = !start && (continuing || hasResumePosition(item));
            // The hero and the title page's "Continue from …" button already say where playback resumes: no second question.
            direct = (hero || titlePage) && resume;
            const text = resume ? titlePage ? t("Continue") : t("Resume") : t("Play");
            if (words.data !== text) words.data = text;
            where.hidden = !titlePage || !resume;
            if (where.hidden) {
                action.removeAttribute("aria-label");
                return;
            }
            const episode = item.Type === "Episode" && Number.isInteger(item.ParentIndexNumber) && Number.isInteger(item.IndexNumber)
                ? t("S{0} E{1}", item.ParentIndexNumber, item.IndexNumber) : "";
            const ticks = item.UserData?.PlaybackPositionTicks ||
                (item.RunTimeTicks ?? 0) * (item.UserData?.PlayedPercentage ?? 0) / 100;
            const location = [episode, ticks > 0 && t("from {0}", clock(ticks / 1e7))].filter(Boolean).join(" ");
            if (where.textContent !== location) where.textContent = location;
            where.hidden = !location;
            action.setAttribute("aria-label", location ? `${text} ${location}` : text);
        };
        action.setMovie(item);
        action.className = "movie-hero-play";
        action.setDownload = (percent, movie) => {
            const running = percent < 100;
            const wasRunning = action.hasAttribute("data-downloading");
            action.toggleAttribute("data-downloading", running);
            action.style.setProperty("--download-fill", percent + "%");
            if (running !== wasRunning) action.firstElementChild.replaceWith(icon(running ? downloadPath : playPath));
            if (running) {
                const text = percent + "%";
                if (words.data !== text) words.data = text;
                where.hidden = true;
                action.setAttribute("aria-label", t("Downloading ") + Math.floor(percent / 10) * 10 + "%");
            } else {
                action.setMovie(movie || item);
            }
            if (running || !movie) action.setAttribute("aria-disabled", "true");
            else action.removeAttribute("aria-disabled");
        };
        return action;
    }
    const downloadPath = "M12 3v12m-5-5 5 5 5-5M5 20h14";
    const streamsOf = item => (item.MediaStreams?.length ? item.MediaStreams : item.MediaSources?.[0]?.MediaStreams) ?? [];
    const videoOf = item => streamsOf(item).find(stream => stream.Type === "Video");
    function libraryQuality(item) {
        const video = videoOf(item);
        const height = video?.Width >= 7680 ? Math.max(video.Height || 0, 4320) :
            video?.Width >= 3840 ? Math.max(video.Height || 0, 2160) : video?.Height;
        if (!(height > 0)) return null;
        const range = video.VideoRangeType ?? video.VideoRange ?? "";
        const detail = height < 2160 ? "" : /dovi|dolby.?vision/i.test(range) ? "Dolby Vision" :
            /hdr|hlg/i.test(range) ? "HDR" : /\bremux\b/i.test(video.DisplayTitle ?? "") ? t("Remux") : "";
        const badge = chip([height >= 4320 ? "8K" : height >= 2160 ? "4K" : height + "p", detail].filter(Boolean).join(" "));
        badge.classList.add("movie-release-quality");
        badge.dataset.level = videoQualityTier(height, detail);
        return badge;
    }
    function titleFacts(item, rating) {
        const runtime = formatMinutes(item.RunTimeTicks / 6e8);
        const facts = document.createDocumentFragment();
        facts.append(...[item.ProductionYear && el("span", item.ProductionYear), rating, runtime && el("span", runtime),
            libraryQuality(item)].filter(Boolean));
        appendSoundChip(facts, librarySound(streamsOf(item)), icon);
        return facts;
    }
    function renderTitleFacts(item, facts) {
        facts.replaceChildren(titleFacts(item, ratingBadge(item.OfficialRating)));
        const genres = (item.Genres ?? []).slice(0, 3);
        if (item.Type === "Series" && genres.length) facts.append(el("span", genres.join(", ")));
        for (const rating of item.MovieRatings ?? []) {
            const path = ratingIcons[rating.source];
            if (!path) continue;
            const badge = chip(rating.value);
            badge.classList.add("movie-rating-chip");
            badge.setAttribute("role", "img");
            badge.setAttribute("aria-label", `${rating.name} ${rating.value}`);
            badge.prepend(icon(path));
            facts.append(badge);
        }
    }
    // Single-colour marks on the 24 px grid, drawn for this app; no logo files.
    const ratingIcons = {
        imdb: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM7 10v4m3.5 0v-4l1.75 2.25L14 10v4m2-4v4",
        tomatoes: "M12 9c-4.4 0-8 2.7-8 6.5S7.6 21 12 21s8-1.7 8-5.5S16.4 9 12 9ZM12 9V4M8.5 6l3.5 2 3.5-2",
        metacritic: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM7.5 16V8l4.5 5 4.5-5v8"
    };
    // Scores are optional: a missing key, a switched-off preference or any failure leaves the page without chips.
    async function loadRatings(item, signal) {
        if (preview || signal.aborted || item.MovieRatings || readMoviePreferences(preferenceViewer).ratings === false) return false;
        const imdb = String(item.ProviderIds?.Imdb ?? item.ProviderIds?.IMDb ?? "");
        const tmdb = String(item.ProviderIds?.Tmdb ?? item.ProviderIds?.TMDb ?? "");
        const kind = item.Type === "Series" ? "tv" : item.Type === "Episode" ? "episode" : "movie";
        if (!/^tt\d{1,10}$/.test(imdb) && !(kind !== "episode" && /^[1-9]\d{0,9}$/.test(tmdb))) return false;
        const reply = await boundedCall(signal, "MovieRatings", kind, /^tt\d{1,10}$/.test(imdb) ? imdb : "", tmdb).catch(() => null);
        if (signal.aborted || !Array.isArray(reply?.ratings)) {
            if (kind === "episode" && !signal.aborted) note("episode-ratings-unavailable", "", {reason: "request_failed"});
            return false;
        }
        item.MovieRatings = reply.ratings;
        return reply.ratings.length > 0;
    }
    function setTitleLogo(item, heading, name = item.Name) {
        const tag = item.TmdbLogo ?? item.ImageTags?.Logo;
        if (heading.dataset.logo === (tag ?? "") && heading.textContent === name) return;
        heading.dataset.logo = tag ?? "";
        const text = el("span", name);
        heading.replaceChildren(text);
        if (!tag) return;
        const logo = el("img");
        logo.alt = "";
        logo.hidden = true;
        logo.className = "movie-hero-logo";
        logo.referrerPolicy = "no-referrer";
        logo.onload = () => { logo.hidden = false; text.classList.add("movie-visually-hidden"); };
            chainImages(logo, [item.TmdbLogo ?? imageSource(item.Id, "Logo", tag, 640)]);
        heading.append(logo);
    }
    function renderCast(item, target) {
        const isSeries = item.Type === "Series";
        const actors = (item.People ?? []).filter(person => person.Type === "Actor" && person.Name?.trim());
        if (!isSeries) actors.length = Math.min(actors.length, 6);
        target.classList.toggle("movie-cast", Boolean(actors.length));
        if (!actors.length) {
            if (target.contains(document.activeElement)) target.closest(".movie-series").querySelector("h2").focus({preventScroll: true});
            target.replaceChildren();
            return;
        }
        const names = el("ul");
        names.setAttribute("role", "list");
        names.setAttribute("aria-label", t("Cast"));
        for (const actor of actors) {
            const row = el("li"), portrait = el("span");
            const person = {...actor, Type: "Person"};
            const action = preview ? el("div") : button("", () => openPerson(person, action));
            action.className = "movie-cast-action";
            if (action.tagName === "BUTTON") action.dataset.personId = personKeyOf(actor);
            portrait.className = "movie-cast-portrait";
            portrait.setAttribute("aria-hidden", "true");
            portrait.style.setProperty("--art-hue", titleHue(actor.Name));
            const initials = actor.Name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join("").toUpperCase();
            portrait.append(el("span", initials));
            if (actor.TmdbPortrait || actor.Id && actor.PrimaryImageTag) {
                const photo = el("img");
                photo.alt = "";
                photo.loading = "lazy";
                photo.referrerPolicy = "no-referrer";
                chainImages(photo, [actor.TmdbPortrait ?? imageSource(actor.Id, "Primary", actor.PrimaryImageTag, isSeries ? 320 : 200)]);
                portrait.append(photo);
            }
            action.append(portrait, el("strong", actor.Name));
            if (actor.Role) action.append(el("span", actor.Role));
            row.append(action);
            names.append(row);
        }
        const focusedActor = target.contains(document.activeElement)
            ? document.activeElement.querySelector("strong")?.textContent : undefined;
        target.append(names);
        if (focusedActor) {
            const replacement = [...names.children].find(actor => actor.querySelector("strong").textContent === focusedActor);
            ((replacement ?? names.firstElementChild).querySelector("button") ??
                target.closest(".movie-series").querySelector("h2")).focus({preventScroll: true});
        }
        if (target.firstElementChild !== names) target.firstElementChild.remove();
        if (!isSeries) return;
        const cast = [...names.children];
        const fit = () => {
            if (!names.clientWidth) return;
            const columns = getComputedStyle(names).gridTemplateColumns.split(" ").length;
            let shown = Math.min(columns * 2, cast.length);
            if (getComputedStyle(target).containerType === "size") {
                for (const actor of cast.slice(0, shown)) actor.hidden = false;
                const bottom = target.getBoundingClientRect().bottom;
                if (cast[shown - 1].getBoundingClientRect().bottom > bottom) shown = Math.min(columns, shown);
                if (cast[shown - 1].getBoundingClientRect().bottom > bottom) shown = 0;
            }
            const focused = document.activeElement;
            if (focused.closest("li")?.parentElement === names && cast.indexOf(focused.closest("li")) >= shown)
                (cast[shown - 1]?.querySelector("button") ?? target.closest(".movie-series").querySelector("h2")).focus({preventScroll: true});
            cast.forEach((actor, index) => { actor.hidden = index >= shown; });
        };
        const resize = globalThis.ResizeObserver ? new ResizeObserver(fit) : null;
        if (resize) { resize.observe(names); resize.observe(target); }
        else window.addEventListener("resize", fit);
        fit();
        return () => {
            resize?.disconnect();
            window.removeEventListener("resize", fit);
        };
    }
    async function loadRelated(item, section, title, signal, viewSignal) {
        const id = String(item.ProviderIds?.Tmdb ?? item.ProviderIds?.TMDb ?? "");
        if (!/^[1-9]\d{0,9}$/.test(id) || signal.aborted) return;
        const kind = item.Type === "Series" ? "tv" : "movie";
        const reply = await boundedCall(signal, "MovieRelated", id, kind);
        if (!Array.isArray(reply?.matches)) {
            // Older servers only accept film recommendations.
            if (kind === "tv" && reply?.error === "Choose a film from the library.") return;
            throw Error("Invalid related titles");
        }
        const libraryMatches = Array.isArray(reply.library_matches) ? reply.library_matches : [];
        const matches = [...libraryMatches, ...reply.matches];
        if (!matches.length || signal.aborted) return;
        const owned = new Map(), matchedTitle = new Map();
        const index = movie => {
            if (movie.Type !== item.Type || movie.Id === item.Id || movie.IsMissing || movie.LocationType === "Virtual") return;
            const providerId = String(movie.ProviderIds?.Tmdb ?? movie.ProviderIds?.TMDb ?? "");
            if (providerId) owned.set(providerId, movie);
            else if (movie.ProductionYear)
                matchedTitle.set(searchTitle(movie.Name) + ":" + movie.ProductionYear, movie);
        };
        for (const shelf of browseShelves) shelf.items.forEach(index);
        if (!trackedDownloads.has(item.Id) && matches.some(match => !owned.has(String(match.id)))) {
            await withinMovieLoad(async bounded => {
                let startIndex = 0, page;
                do {
                    page = await request("Items", {userId: session.user, recursive: true, includeItemTypes: item.Type,
                        fields: "ProviderIds,MediaStreams", enableImages: true, enableImageTypes: "Primary,Thumb,Backdrop,Logo",
                        imageTypeLimit: 1, sortBy: "SortName", startIndex, limit: 100}, undefined, bounded);
                    if (!Array.isArray(page?.Items)) throw Error("Invalid library page");
                    page.Items.forEach(index);
                    startIndex += page.Items.length;
                } while (page.Items.length && startIndex < page.TotalRecordCount &&
                    matches.some(match => !owned.has(String(match.id))));
            }, signal);
        }
        if (signal.aborted) return;
        const rows = el("div");
        rows.className = "movie-cards";
        for (const match of matches) {
            const local = owned.get(String(match.id)) ?? matchedTitle.get(searchTitle(match.title) + ":" + match.year);
            if (!local && libraryMatches.includes(match)) continue;
            const pick = local ? card(local, "related") : card({
                Name: match.title, Id: "tmdb-" + match.id, Type: item.Type, ProductionYear: match.year
            }, "related", () => {
                query.value = match.title.slice(0, query.maxLength).trimEnd();
                startSearch(true);
            });
            if (!local) chainImages(pick.querySelector("img"), [match.backdrop, match.poster].filter(Boolean));
            rows.append(pick);
        }
        if (!rows.childElementCount) return;
        const {lane, update} = shelfLane(rows, title, viewSignal, true);
        section.append(lane);
        section.hidden = false;
        update();
        return true;
    }
    function seasonRow(item, number, {episodes, total}, libraryKnown, catalogueEpisodes, job, pill, signal) {
        const row = el("section"), header = el("div"), items = el("ol");
        row.className = "movie-season";
        row.dataset.season = number;
        row.dataset.seriesKey = searchTitle(item.Name);
        row.dataset.itemId = item.Id;
        header.className = "movie-season-header";
        row.append(header, items);
        if (!episodes.length && libraryKnown) {
            header.append(button(t("Find season ") + number, () => {
                const suffix = " S" + String(number).padStart(2, "0");
                query.value = item.Name.slice(0, query.maxLength - suffix.length).trimEnd() + suffix;
                startSearch(true);
            }));
        }
        const catalogue = new Map((catalogueEpisodes ?? []).map(episode => [episode.number, episode]));
        const rows = episodes.map(episode => {
            const index = episode.IndexNumber;
            const details = catalogue.get(index);
            if (index != null) catalogue.delete(index);
            return {index, episode, details};
        });
        for (const [index, details] of catalogue) rows.push({index, details});
        if (job && !catalogueEpisodes && total > 0) {
            for (let index = 1; index <= Math.min(total, 100); index++)
                if (!rows.some(row => row.index === index)) rows.push({index});
        }
        rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const showRatings = readMoviePreferences(preferenceViewer).ratings !== false;
        const ratingEntries = new Map();
        const addRating = target => {
            const {episode, showScore} = ratingEntries.get(target);
            ratingEntries.delete(target);
            void loadRatings(episode, signal).then(found => {
                if (found && target.isConnected && !signal.aborted) {
                    const rating = episode.MovieRatings[0];
                    showScore(rating.name, rating.value);
                }
            });
        };
        const ratingObserver = showRatings && globalThis.IntersectionObserver ? new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting && ratingEntries.has(entry.target)) {
                ratingObserver.unobserve(entry.target);
                addRating(entry.target);
            }
        }) : null;
        if (ratingObserver) {
            row.stopRatings = () => {
                ratingObserver.disconnect();
                ratingEntries.clear();
                signal.removeEventListener("abort", row.stopRatings);
            };
            signal.addEventListener("abort", row.stopRatings, {once: true});
        }
        for (const {index, episode, details} of rows) {
            const entry = el("li"), frame = el("span"), content = el("span");
            const action = episode ? button("", () => play(episode, action, {askResume: true})) : el("div");
            action.className = "movie-episode-body";
            entry.dataset.episode = index ?? "";
            if (episode) entry.dataset.episodeState = episode.UserData?.Played && !isShortMovie(episode.RunTimeTicks) ? "watched" : "ready";
            frame.className = "movie-episode-still";
            frame.setAttribute("aria-hidden", "true");
            if (movieUi.spoilerBlur && entry.dataset.episodeState !== "watched" && !(episode && progressOf(episode) > 0)) frame.dataset.spoiler = "";
            const image = el("img"), tag = episode?.ImageTags?.Primary ?? episode?.ImageTags?.Thumb;
            const localStill = tag && url(`Items/${encodeURIComponent(episode.Id)}/Images/${episode.ImageTags.Primary ? "Primary" : "Thumb"}`,
                {tag, maxWidth: 400}).href;
            image.alt = "";
            image.loading = "lazy";
            image.decoding = "async";
            chainImages(image, [localStill, details?.still].filter(Boolean));
            frame.append(image);
            const name = [details?.name, episode?.Name].find(value => value?.trim() && !/^(?:\d+\.\s*)?episode\s*\d*$/i.test(value.trim())) ??
                (index == null ? t("Episode") : t("Episode {0}", index));
            content.className = "movie-episode-text";
            const title = el("strong");
            if (index != null && name !== `Episode ${index}`) {
                const prefix = el("span", index + ". ");
                prefix.className = "movie-episode-number";
                title.append(prefix);
            }
            title.append(name);
            const runtime = formatMinutes(episode?.RunTimeTicks / 6e8 || details?.runtime);
            const quality = episode && libraryQuality(episode);
            const facts = el("span");
            facts.className = "movie-episode-facts";
            facts.append(title);
            if (runtime) facts.append(el("span", runtime));
            const ratingChip = showRatings ? el("span") : null;
            if (ratingChip) {
                const showScore = (source, value) => {
                    ratingChip.hidden = !value;
                    ratingChip.textContent = value ? `${source} ${value}` : "";
                };
                ratingChip.className = "movie-episode-rating";
                const rating = episode?.MovieRatings?.[0];
                showScore(rating?.name ?? "TMDB", rating?.value ?? (details?.rating > 0 ? details.rating.toFixed(1) : ""));
                facts.append(ratingChip);
                if (episode && !episode.MovieRatings && /^tt\d{1,10}$/.test(episode.ProviderIds?.Imdb ?? episode.ProviderIds?.IMDb ?? "")) {
                    ratingEntries.set(action, {episode, showScore});
                    if (ratingObserver) ratingObserver.observe(action);
                    else queueMicrotask(() => addRating(action));
                }
            }
            content.append(facts);
            const overview = episode?.Overview?.trim() || details?.overview?.trim();
            const description = overview && el("span", overview);
            if (description) {
                description.className = "movie-episode-overview";
                content.append(description);
            }
            action.append(frame, content);
            if (quality) action.append(quality);
            if (episode) {
                action.dataset.episodeId = episode.Id;
                const played = entry.dataset.episodeState === "watched", percent = played ? 100 : Math.max(0, Math.min(100, progressOf(episode)));
                const progress = el("progress");
                progress.max = 100;
                progress.value = percent;
                progress.setAttribute("aria-hidden", "true");
                content.append(progress);
                action.setAttribute("aria-label", percent > 0 ? `${name}, ${played ? "watched" : percent + "% watched"}` : title.textContent);
                const descriptions = [description, quality, ratingChip].filter(Boolean);
                if (descriptions.length) action.setAttribute("aria-describedby", descriptions.map(node => {
                    node.id = `movie-episode-description-${++detailNumber}`;
                    return node.id;
                }).join(" "));
            } else if (libraryKnown) {
                const marker = el("span", t("Not in library"));
                marker.className = "movie-episode-marker";
                content.append(marker);
            }
            if (job) {
                const indicator = el("span");
                indicator.className = "movie-episode-download-icon";
                indicator.setAttribute("aria-hidden", "true");
                if (episode) indicator.append(icon("m5 12 4 4L19 6"));
                action.append(indicator);
            }
            entry.append(action);
            if (episode && session.downloads_enabled) entry.append(audioJobSlot(episode));
            items.append(entry);
        }
        updateSeasonState(row, job, pill);
        return row;
    }
    // Keep season download status on the pill and update the affected episode rows.
    function updateSeasonState(row, job, pill) {
        const number = Number(row.dataset.season), key = row.dataset.seriesKey;
        const found = seasonDownload(key, number, job);
        const hasEpisodes = Boolean(row.querySelector("[data-episode-state=ready], [data-episode-state=watched]"));
        const find = row.querySelector(".movie-season-header > button:not(.movie-hero-play)");
        const importing = !hasEpisodes && job && jobIncludesSeason(job, number) && downloadPercent(queueEntry(job)) === 100;
        let state;
        if (found) {
            const percent = downloadPercent(found);
            const remaining = downloadRemaining(found);
            const eta = remaining ? `, ${remaining}` : "";
            state = t("Downloading {0}%{1}", percent, eta);
        } else if (importing) state = t("Waiting for the library");
        if (pill) {
            if (state) pill.setAttribute("aria-description", state);
            else pill.removeAttribute("aria-description");
        }
        if (find) {
            if ((found || importing) && find === document.activeElement) pill?.focus({preventScroll: true});
            find.hidden = Boolean(found || importing);
        }
        for (const marker of row.querySelectorAll(".movie-episode-marker")) {
            const entry = marker.closest("li");
            const target = job?.episode;
            const downloading = found && (!target || Number(entry.dataset.episode) === target);
            const text = downloading ? t("Downloading") : t("Not in library");
            if (marker.textContent !== text) marker.textContent = text;
            if (job) entry.dataset.episodeState = downloading ? "downloading" : "missing";
        }
    }

    let downloadItems = [];
    const downloadsKey = preferencesKey(preferenceViewer) + ":downloads";
    const trackedDownloads = new Map();
    if (session.downloads_enabled) try {
        for (const job of JSON.parse(localStorage.getItem(downloadsKey)) ?? [])
            if (typeof job?.item?.Id === "string" && typeof job.release === "string" && job.expires > Date.now())
                trackedDownloads.set(job.item.Id, job);
    } catch {}
    function saveDownloads() {
        try { localStorage.setItem(downloadsKey, JSON.stringify([...trackedDownloads.values()].slice(-40))); } catch {}
    }
    const downloadPercent = entry => Math.min(entry?.progress >= 1 ? 100 : 99,
        Math.max(0, Math.round((entry?.progress || 0) * 100)));
    function downloadRemaining(entry) {
        if (!Number.isFinite(entry.eta) || entry.eta < 0 || !["Downloading", "Almost done"].includes(entry.state)) return "";
        const minutes = Math.max(1, Math.ceil(entry.eta / 60));
        const rounded = minutes >= 600 ? Math.round(minutes / 60) * 60 : minutes;
        return t("about {0} left", minutes > 90 ? formatMinutes(rounded) : minutes + " min");
    }
    const releaseSeason = name => /(?:^|[^a-z0-9])s(\d{1,3})(?:e(\d{1,3}))?(?![a-z0-9])|season[ ._-]*(\d{1,3})(?!\d)/i.exec(name);
    function seriesCatalogue(name, year, id, signal) {
        const prefix = "tmdb:tv:title:" + (/^\d{4}$/.test(String(year)) ? year : "") + ":";
        const term = /^[1-9]\d{0,9}$/.test(String(id)) ? "tmdb:tv:" + id : prefix + name.slice(0, 120 - prefix.length);
        return boundedCall(signal, "MovieMatches", term);
    }
    function jobIncludesSeason(job, season) {
        return job.allSeasons || (job.seasons ? season >= job.seasons[0] && season <= job.seasons[1] : season === job.season);
    }
    function sameDownloadedTitle(a, b) {
        const aId = a.ProviderIds?.Tmdb ?? a.ProviderIds?.TMDb;
        const bId = b.ProviderIds?.Tmdb ?? b.ProviderIds?.TMDb;
        if (aId && bId) return a.Type === b.Type && String(aId) === String(bId);
        return (!a.ProductionYear || !b.ProductionYear || b.SeriesId || String(a.ProductionYear) === String(b.ProductionYear)) &&
            searchTitle(a.Name) === searchTitle(b.Name);
    }
    function queueEntry(job) {
        return downloadItems.find(entry => !Array.isArray(entry?.results) && typeof entry?.name === "string" &&
            searchTitle(entry.name) === searchTitle(job.release)) ?? job.last;
    }
    function seasonDownload(key, number, job) {
        if (job && jobIncludesSeason(job, number)) {
            const entry = queueEntry(job);
            if (downloadPercent(entry) < 100) return entry ?? {progress: 0};
        }
        return downloadItems.find(entry => {
            if (typeof entry?.name !== "string" || entry.state === "Finished" || !(entry.progress < 1)) return false;
            const name = searchTitle(entry.name);
            if (name !== key && !name.startsWith(key + " ")) return false;
            const tags = entry.name.replaceAll("_", " ");
            const span = releaseSeasons(tags);
            if (span) return number >= span[0] && number <= span[1];
            const wanted = releaseSeason(tags);
            return wanted && Number(wanted[1] ?? wanted[3]) === number;
        });
    }
    async function downloadedLibraryTitle(item, signal) {
        const id = String(item.ProviderIds?.Tmdb ?? "");
        const page = await searchLibrary("Items", {userId: session.user, searchTerm: item.Name,
            includeItemTypes: item.Type, recursive: true, fields: "ProviderIds,MediaStreams", limit: 30}, undefined, signal).catch(() => null);
        const rows = (Array.isArray(page?.Items) ? page.Items : []).filter(row => row?.Type === item.Type && !row.IsMissing && row.LocationType !== "Virtual" &&
            (!item.ProductionYear || !row.ProductionYear || Number(item.ProductionYear) === Number(row.ProductionYear)));
        return rows.find(row => id && String(row.ProviderIds?.Tmdb ?? row.ProviderIds?.TMDb ?? "") === id) ??
            rows.find(row => (!id || !(row.ProviderIds?.Tmdb ?? row.ProviderIds?.TMDb)) && searchTitle(row.Name) === searchTitle(item.Name));
    }
    async function loadDownloadMetadata(item, signal) {
        let id = String(item.ProviderIds?.Tmdb ?? "");
        const kind = item.Type === "Series" ? "tv" : "movie";
        if (!id) {
            const reply = await boundedCall(signal, "MovieMatches", item.Name.slice(0, 120)).catch(() => null);
            const match = Array.isArray(reply?.matches) && reply.matches.find(row =>
                row.kind === kind && typeof row.title === "string" && searchTitle(row.title) === searchTitle(item.Name) &&
                (!item.ProductionYear || Number(row.year) === item.ProductionYear));
            if (match) id = String(match.id);
        }
        if (!/^[1-9]\d{0,9}$/.test(id)) return null;
        const reply = await boundedCall(signal, "MovieTitleDetails", kind, id).catch(() => null);
        if (!reply?.title) return null;
        return {
            ProviderIds: {...item.ProviderIds, Tmdb: id},
            Overview: reply.overview || item.Overview, Genres: reply.genres || item.Genres,
            TmdbPoster: reply.poster || item.TmdbPoster, TmdbBackdrop: reply.backdrop || item.TmdbBackdrop,
            TmdbLogo: reply.logo, People: (Array.isArray(reply.cast) ? reply.cast : []).map(actor => ({
                Type: "Actor", Name: actor.name, Role: actor.role, TmdbPortrait: actor.portrait, ProviderIds: {Tmdb: actor.tmdb}
            }))
        };
    }
    async function preloadDetailImages(section, signal) {
        if (signal.aborted) return;
        await Promise.all([...section.querySelectorAll("img[src]")].map(img => {
            img.loading = "eager";
            if (img.complete && img.naturalWidth) return img.decode?.().catch(() => {});
            return new Promise(resolve => {
                img.addEventListener("load", () => Promise.resolve(img.decode?.()).catch(() => {}).then(resolve), {once: true, signal});
                const check = () => { if (!img.getAttribute("src") || img.complete) resolve(); };
                img.addEventListener("error", () => queueMicrotask(check), {signal});
                check();
                signal.addEventListener("abort", resolve, {once: true});
            });
        }));
    }
    async function openDownloadedTitle(job, opener, sourceSignal, close = () => {}, announce = false) {
        const preparation = new AbortController();
        const fromResults = browse.hidden;
        const stop = () => preparation.abort();
        sourceSignal.addEventListener("abort", stop, {once: true});
        const handoff = {
            signal: preparation.signal, close, announce, job,
            cancelled: () => sourceSignal.aborted || !opener.isConnected || browse.hidden !== fromResults,
            finish: stop
        };
        let timer;
        handoff.deadline = new Promise(resolve => {
            timer = setTimeout(() => { handoff.expired = true; resolve(); }, 4000);
            preparation.signal.addEventListener("abort", resolve, {once: true});
        });
        try {
            return await openSeries(job.item, opener, job.season, false, false, handoff);
        } finally {
            clearTimeout(timer);
            sourceSignal.removeEventListener("abort", stop);
            stop();
        }
    }
    const releaseTail = /^(?:(?:19|20)\d\d|s\d{1,3}(?:e\d{1,3})?|seasons?|complete|full series|\d{3,4}[pi]|bluray|web(?:rip|dl)?|hdtv|dvdrip|xvid|mpeg4|x26[45]|h26[45])\b/;
    function downloadRing() {
        const ring = icon(downloadPath);
        ring.classList.add("movie-download-ring");
        for (const className of ["movie-download-ring-track", "movie-download-ring-fill"]) {
            const circle = document.createElementNS(ring.namespaceURI, "circle");
            circle.setAttribute("class", className);
            circle.setAttribute("cx", "12");
            circle.setAttribute("cy", "12");
            circle.setAttribute("r", "10.5");
            circle.setAttribute("pathLength", "100");
            ring.append(circle);
        }
        return ring;
    }
    function updateCardDownload(card, job) {
        const badge = card.querySelector(".movie-download-badge");
        const key = card.dataset.downloadKey;
        const matches = job ? [] : downloadItems.filter(item => {
            if (typeof item?.name !== "string") return false;
            const name = searchTitle(item.name);
            if (name === key) return true;
            if (!name.startsWith(key + " ")) return false;
            const suffix = name.slice(key.length + 1);
            if (!releaseTail.test(suffix)) return false;
            const year = /^(?:19|20)\d\d\b/.exec(suffix)?.[0];
            if (year && card.dataset.downloadYear && year !== card.dataset.downloadYear) return false;
            const season = card.dataset.downloadSeason;
            const span = season !== undefined ? releaseSeasons(item.name.replaceAll("_", " ")) : null;
            if (span) return Number(season) >= span[0] && Number(season) <= span[1];
            const tag = season !== undefined ? releaseSeason(suffix) : null;
            return !tag || (Number(tag[1] ?? tag[3]) === Number(season) &&
                (!tag[2] || !card.dataset.downloadEpisode || Number(tag[2]) === Number(card.dataset.downloadEpisode)));
        });
        const download = job ? queueEntry(job) ?? {progress: 0} : runningMovieDownloads(matches)[0];
        badge.hidden = !download;
        const bar = badge.nextElementSibling;
        bar.hidden = !download;
        const percent = downloadPercent(download);
        const label = download ? `Downloading, ${Math.floor(percent / 10) * 10}%` : "";
        const description = badge.lastElementChild;
        if (description.textContent !== label) description.textContent = label;
        if (download) card.setAttribute("aria-describedby", description.id);
        else card.removeAttribute("aria-describedby");
        badge.style.setProperty("--download-percent", percent);
        bar.firstElementChild.style.transform = `scaleX(${percent / 100})`;
    }
    let cardDownloadNumber = 0;
    function attachCardDownload(card, artwork, title, episode, job) {
        if (!session.downloads_enabled) return;
        card.dataset.downloadKey = searchTitle(title.Name);
        if (title.Type === "Movie" && title.ProductionYear) card.dataset.downloadYear = String(title.ProductionYear);
        if (Number.isInteger(episode?.ParentIndexNumber)) card.dataset.downloadSeason = String(episode.ParentIndexNumber);
        if (Number.isInteger(episode?.IndexNumber)) card.dataset.downloadEpisode = String(episode.IndexNumber);
        const badge = el("span"), bar = el("span"), description = el("span");
        badge.className = "movie-download-badge";
        badge.setAttribute("aria-hidden", "true");
        bar.className = "movie-download-progress";
        description.className = "movie-visually-hidden";
        description.id = "movie-card-download-" + ++cardDownloadNumber;
        bar.setAttribute("aria-hidden", "true");
        bar.append(el("span"));
        badge.append(downloadRing(), description);
        artwork.append(badge, bar);
        updateCardDownload(card, job);
    }
    const previewArt = ["movie-art/movie.jpg", "movie-art/movie-alt.jpg", "movie-art/episode.jpg"];
    function imageSource(id, type, tag, maxWidth) {
        if (preview) return previewArt[Number(tag.at(-1))];
        return url(`Items/${encodeURIComponent(id)}/Images/${type}`, {tag, maxWidth}).href;
    }
    function cardArtwork(item, preferLandscape = false) {
        const poster = el("img");
        poster.alt = "";
        poster.loading = "lazy";
        poster.decoding = "async";
        poster.referrerPolicy = "no-referrer";
        const series = [
            [item.SeriesId, "Thumb", item.SeriesThumbImageTag],
            [item.ParentThumbItemId, "Thumb", item.ParentThumbImageTag],
            [item.ParentBackdropItemId, "Backdrop", item.ParentBackdropImageTags?.[0]],
            [item.SeriesId, "Primary", item.SeriesPrimaryImageTag],
            [item.ParentPrimaryImageItemId, "Primary", item.ParentPrimaryImageTag]
        ];
        const primary = [item.Id, "Primary", item.ImageTags?.Primary];
        const landscape = [
            [item.Id, "Thumb", item.ImageTags?.Thumb],
            [item.Id, "Backdrop", item.BackdropImageTags?.[0]]
        ];
        const candidates = preferLandscape ? [...landscape, ...series, primary] : [primary, ...landscape, ...series];
        const images = new Set([item.TmdbPoster, ...candidates.filter(([id, , tag]) => id && tag).map(([id, type, tag]) =>
            imageSource(id, type, tag, 480))].filter(Boolean));
        chainImages(poster, [...images]);
        const artwork = el("span");
        artwork.className = "movie-art";
        artwork.setAttribute("aria-hidden", "true");
        artwork.style.setProperty("--art-hue", titleHue(item.SeriesName || item.Name));
        artwork.dataset.initial = [...(item.SeriesName || item.Name).trim()][0]?.toUpperCase() ?? "";
        artwork.append(poster);
        return artwork;
    }
    function backdropSources(item) {
        return [[item.Id, "Backdrop", item.BackdropImageTags?.[0]],
            [item.ParentBackdropItemId, "Backdrop", item.ParentBackdropImageTags?.[0]],
            [item.Id, "Thumb", item.ImageTags?.Thumb],
            [item.Id, "Primary", item.ImageTags?.Primary]].filter(([id, , tag]) => id && tag);
    }
    function movieBackdrop(item, onSettled) {
        const art = el("img");
        art.alt = "";
        art.decoding = "async";
        art.referrerPolicy = "no-referrer";
        art.className = "movie-hero-art";
        const style = readMoviePreferences(preferenceViewer).backgroundStyle;
        const width = innerWidth > 1920 ? 3840 : 1920;
        const remote = item.TmdbBackdrop?.replace(/^(https:\/\/image\.tmdb\.org\/t\/p\/)(?:w\d+|original)\//,
            (_, base) => base + (width > 1920 ? "original/" : innerWidth <= 780 ? "w780/" : "w1280/"));
        const sources = style === "preset" ? [] : [remote, ...backdropSources(item).filter(([, type]) => type === "Backdrop")
            .map(([id, type, tag]) => imageSource(id, type, tag, width))].filter(Boolean);
        const settle = () => {
            delete art.dataset.loading;
            onSettled?.();
        };
        if (sources.length) {
            art.dataset.loading = "";
            art.addEventListener("load", settle, {once: true});
        }
        chainImages(art, sources, settle);
        return art;
    }
    const newTitle = item => {
        const age = Date.now() - Date.parse(item.DateCreated);
        return age >= 0 && age < 14 * 86400000;
    };
    const removeContinueLabel = t("Remove from Continue watching");
    let closeContinueMenu;
    const removingContinue = new Set();
    async function dismissContinue(item, control, message, done) {
        const key = titleKey(item);
        if (removingContinue.has(key)) return;
        removingContinue.add(key);
        control.setAttribute("aria-disabled", "true");
        message.textContent = "";
        try {
            if (item.FamilyHubNextUp) {
                await request("Shows/NextUp", {}, {seriesId: item.SeriesId, episodeId: item.Id}, null);
            } else {
                await request(`UserItems/${encodeURIComponent(item.Id)}/HideFromResume`, {hide: true},
                    {positionTicks: item.UserData?.PlaybackPositionTicks ?? 0}, null);
            }
            if (!active) return;
            const {cards, items, heading} = resumeShelf;
            const tile = cards.get(key);
            resumeShelf.items = items.filter(entry => titleKey(entry) !== key);
            cards.delete(key);
            if (tile?.contains(document.activeElement)) {
                const visible = [...tile.parentElement.children].filter(node => !node.inert);
                const index = visible.indexOf(tile);
                const next = visible[index + 1] ?? visible[index - 1];
                if (next) tile.closest(".movie-shelf-lane").revealCard(next, true);
                (next?.querySelector(".movie-card") ?? heading).focus({preventScroll: true});
            }
            done?.(item);
            homeStatus.textContent = t("Removed {0} from Continue watching", item.SeriesName || item.Name);
            if (tile?.isConnected && !tile.closest("[hidden]") && !quietMotion() && tile.animate) {
                tile.inert = true;
                const width = tile.offsetWidth + "px";
                const collapse = tile.animate([{width, flexBasis: width, opacity: 1},
                    {width: 0, flexBasis: 0, opacity: 0}], {duration: 150, easing: "ease-out", fill: "forwards"});
                await collapse.finished.catch(() => {});
                collapse.cancel();
            }
            if (active) renderHome();
        } catch {
            if (active) message.textContent = t("Could not remove this title. Try again.");
        } finally {
            removingContinue.delete(key);
            control.removeAttribute("aria-disabled");
        }
    }
    document.addEventListener("pointerdown", event => closeContinueMenu?.(true, event.target), {signal: life.signal});
    window.addEventListener("resize", () => closeContinueMenu?.(true), {signal: life.signal});

    // The three-dots menu shared by Continue watching cards and the Home banner.
    function continueMenu(item, name, openInfo, beforeOpen) {
        const menu = el("div");
        menu.className = "movie-continue-menu";
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", t("Options for {0}", name));
        menu.hidden = true;
        const more = button("", () => {
            if (more.getAttribute("aria-disabled") === "true") return;
            if (!menu.hidden) return close(true);
            closeContinueMenu?.();
            beforeOpen?.();
            menu.hidden = false;
            menu.style.left = menu.style.top = "0px";
            const origin = menu.getBoundingClientRect();
            const bounds = more.getBoundingClientRect();
            const width = document.documentElement.clientWidth;
            const left = Math.max(8, Math.min(bounds.right - origin.width, width - origin.width - 8));
            const top = bounds.bottom + origin.height + 4 <= window.innerHeight
                ? bounds.bottom + 4 : Math.max(8, bounds.top - origin.height - 4);
            menu.style.left = left - origin.left + "px";
            menu.style.top = top - origin.top + "px";
            more.setAttribute("aria-expanded", "true");
            closeContinueMenu = close;
            remove.focus({preventScroll: true});
        });
        more.setAttribute("aria-label", t("More options for {0}", name));
        more.setAttribute("aria-haspopup", "menu");
        more.setAttribute("aria-expanded", "false");
        more.append(icon("M12 5h.01M12 12h.01M12 19h.01"));
        function close(restoreFocus = false, outside) {
            if (outside && (menu.contains(outside) || more.contains(outside))) return;
            closeContinueMenu = undefined;
            if (restoreFocus && menu.contains(document.activeElement)) {
                more.focus({preventScroll: true});
                if (outside) requestAnimationFrame(() => {
                    if (document.activeElement === document.body && more.isConnected && !more.closest("[hidden], [inert]"))
                        more.focus({preventScroll: true});
                });
            }
            menu.hidden = true;
            more.setAttribute("aria-expanded", "false");
        }
        const remove = button(removeContinueLabel, () => {
            close(true);
            void dismissContinue(item, more, continueError);
        });
        const info = button(t("More info"), () => {
            close(true);
            openInfo();
        });
        remove.prepend(icon(removePath));
        info.prepend(icon(detailsPath));
        for (const action of [remove, info]) {
            action.setAttribute("role", "menuitem");
            action.tabIndex = -1;
        }
        menu.append(remove, info);
        menu.addEventListener("keydown", event => {
            if (event.key === "Escape") close(true);
            else if (event.key === "ArrowUp" || event.key === "ArrowDown")
                (event.target === remove ? info : remove).focus({preventScroll: true});
            else return;
            event.preventDefault();
            event.stopPropagation();
        });
        menu.addEventListener("focusout", event => {
            if (!menu.hidden && !menu.contains(event.relatedTarget)) close();
        });
        return {more, menu};
    }

    function card(item, format, findRelease, pendingDownload) {
        const title = seriesCardItem(item);
        const continuing = format === "resume";
        const continuingEpisode = continuing && item.Type === "Episode";
        const display = continuingEpisode ? item : title;
        const name = continuingEpisode ? item.SeriesName || title.Name : display.Name;
        const episodeLabel = continuingEpisode ? [
            Number.isInteger(item.IndexNumber) && (Number.isInteger(item.ParentIndexNumber)
                ? `S${item.ParentIndexNumber} E${item.IndexNumber}` : t("Episode {0}", item.IndexNumber)),
            item.Name
        ].filter(Boolean).join(", ") : "";
        const b = button("", () => {
            if (pendingDownload) {
                if (b.getAttribute("aria-busy") === "true") return;
                b.focus({preventScroll: true});
                b.setAttribute("aria-busy", "true");
                void openDownloadedTitle(pendingDownload.job, b, life.signal)
                    .catch(() => { homeStatus.textContent = t("Could not open the download. Try again."); })
                    .finally(() => b.removeAttribute("aria-busy"));
            } else if (findRelease) findRelease();
            else if (continuing && !preview && !item.Demo && movieUi.resumePress !== "title") void play(item, b);
            else openSeries(title, b, item.ParentIndexNumber);
        });
        b.className = "movie-card";
        if (pendingDownload) b.dataset.pendingDownload = "";
        b.dataset.itemId = display.Id;
        b.dataset.titleKey = titleKey(item);
        if (title.ProductionYear) b.dataset.year = String(title.ProductionYear);
        const artwork = cardArtwork(display, ["resume", "recent", "related"].includes(format) && !(continuing && movieUi.resumeStyle === "poster"));
        // An episode the viewer has not seen would otherwise show its still.
        if (continuingEpisode && item.FamilyHubNextUp && movieUi.spoilerBlur) artwork.dataset.spoiler = "";
        if (findRelease) {
            const action = el("span");
            action.className = "movie-card-find";
            action.append(icon(searchPath));
            artwork.append(action);
            b.setAttribute("aria-label", t("Find releases for {0}", name));
        } else if (format === "related") {
            const check = el("span");
            check.className = "movie-card-find movie-card-owned";
            check.append(icon("m5 12 4 4L19 6"));
            artwork.append(check);
            b.setAttribute("aria-label", t("{0}, in your library", name));
        }
        const progress = progressOf(item);
        const watched = continuing && (progress > 0 || item.UserData?.PlaybackPositionTicks > 0)
            ? Math.max(1, Math.min(99, progress)) : progress;
        if (watched > 0 && watched < 100) {
            const track = el("span"), fill = el("span");
            track.className = "movie-progress";
            track.setAttribute("aria-hidden", "true");
            fill.style.width = watched + "%";
            track.append(fill);
            artwork.append(track);
        }
        if (continuing) b.setAttribute("aria-label", [name, episodeLabel, watched > 0 && t("{0}% watched", watched)].filter(Boolean).join(", "));
        const caption = el("span"), titleText = el("span", name);
        caption.className = "movie-caption";
        titleText.className = "movie-card-name";
        caption.append(titleText);
        if (episodeLabel) caption.append(el("small", episodeLabel));
        if (format === "person" && title.ProductionYear) caption.append(el("small", String(title.ProductionYear)));
        if (format === "favorites") {
            const heart = el("span");
            heart.className = "movie-card-heart";
            heart.append(icon(heartPath));
            artwork.append(heart);
        }
        if (format === "recent" && newTitle(item)) {
            const badge = el("span", t("New"));
            badge.className = "movie-card-new";
            artwork.append(badge);
            b.setAttribute("aria-label", t("{0}, new", name));
        }
        b.append(artwork, caption);
        if (format === "collections") b.classList.add("movie-card-collection");
        if (!preview && !findRelease && format !== "related")
            attachCardDownload(b, artwork, title, continuingEpisode ? item : undefined, pendingDownload?.job);
        if (!continuing || preview || item.Demo) return b;
        const tile = el("div");
        tile.className = "movie-resume-card";
        const {more, menu} = continueMenu(item, name, () => openSeries(title, more, item.ParentIndexNumber),
            () => tile.closest(".movie-shelf-lane").revealCard(tile, true));
        more.className = "movie-continue-menu-button";
        more.dataset.itemId = title.Id;
        more.dataset.titleKey = titleKey(item);
        tile.append(b, more, menu);
        return tile;
    }
    function shelfLane(rows, title, signal, related = false) {
        const lane = el("div"), viewport = el("div");
        lane.className = "movie-shelf-lane";
        viewport.className = "movie-shelf-scroll";
        lane.append(viewport);
        viewport.append(rows);
        let animation = 0, destination, pageSize = 5;
        const cancel = () => { cancelAnimationFrame(animation); animation = 0; destination = undefined; };
        const maxScroll = () => viewport.scrollWidth - viewport.clientWidth;
        const step = () => rows.firstElementChild ?
            parseFloat(getComputedStyle(rows.firstElementChild).width) + parseFloat(getComputedStyle(rows).columnGap) : 0;
        function slide(target, immediate = false) {
            const from = viewport.scrollLeft;
            cancel();
            destination = Math.max(0, Math.min(target, maxScroll()));
            const finish = () => {
                if (related) {
                    const {first, last} = markVisible();
                    if (!immediate && first && Math.abs(viewport.scrollLeft - from) > 1) {
                        const index = card => Array.prototype.indexOf.call(rows.children, card) + 1;
                        shelfStatus.textContent = t("Showing titles {0} to {1} of {2}.", index(first), index(last), rows.childElementCount);
                    }
                }
                cancel();
            };
            if (immediate || quietMotion() || Math.abs(destination - from) <= 1) {
                viewport.scrollLeft = destination;
                finish();
                return;
            }
            const started = performance.now();
            const tick = now => {
                const t = quietMotion() ? 1 : Math.min(1, (now - started) / (related ? 230 : 410));
                const eased = t * t * (3 - 2 * t);
                viewport.scrollLeft = from + (destination - from) * eased;
                if (t < 1) animation = requestAnimationFrame(tick);
                else finish();
            };
            animation = requestAnimationFrame(tick);
        }
        const arrows = [-1, 1].map(direction => {
            const arrow = button("", () => {
                if (arrow.getAttribute("aria-disabled") !== "true")
                    slide((destination ?? viewport.scrollLeft) + direction * pageSize * step());
            });
            arrow.className = "movie-shelf-arrow";
            arrow.setAttribute("aria-label", (direction < 0 ? t("Previous ") : t("Next ")) + title.toLowerCase());
            arrow.append(icon(direction < 0 ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"));
            return arrow;
        });
        lane.append(...arrows);
        function markVisible() {
            const start = viewport.scrollLeft, end = start + viewport.clientWidth;
            let first, last;
            for (const node of rows.children) {
                const left = node.offsetLeft;
                const full = left >= start - 1 && left + node.offsetWidth <= end + 1;
                node.dataset.edge = full ? "middle" : "peek";
                if (related) node.tabIndex = full ? 0 : -1;
                if (full) { first ??= node; last = node; }
            }
            if (last && last !== first) last.dataset.edge = "last";
            if (first) first.dataset.edge = "first";
            arrows[0].setAttribute("aria-disabled", String(start < 1));
            arrows[1].setAttribute("aria-disabled", String(start >= maxScroll() - 1));
            for (const arrow of arrows) arrow.tabIndex = arrow.getAttribute("aria-disabled") === "true" ? -1 : 0;
            return {first, last};
        }
        function update() {
            if (!CSS.supports("width", "1cqi")) {
                if (catalogue.clientWidth) catalogue.style.setProperty("--movie-row-width", `${catalogue.clientWidth}px`);
                if (viewport.clientWidth) lane.style.setProperty("--movie-row-width", `${viewport.clientWidth}px`);
            }
            pageSize = Number(getComputedStyle(viewport).getPropertyValue("--movie-page-size")) || 5;
            const count = rows.childElementCount;
            const overflow = count > pageSize;
            lane.dataset.overflow = String(overflow);
            rows.style.setProperty("--empty-slots", String(overflow ? (pageSize - count % pageSize) % pageSize : 0));
            if (arrows.includes(document.activeElement) && (!overflow || getComputedStyle(arrows[0]).display === "none"))
                (rows.querySelector(".movie-card") ?? lane.closest("section")?.querySelector("h2") ?? query).focus({preventScroll: true});
            markVisible();
        }
        function reveal(node, immediate = false, nearest = false) {
            if (immediate) cancel();
            const left = node.offsetLeft, start = immediate ? viewport.scrollLeft : destination ?? viewport.scrollLeft;
            if (left >= start - 1 && left + node.offsetWidth <= start + viewport.clientWidth + 1) return;
            const index = Array.prototype.indexOf.call(rows.children, node);
            const target = nearest && !related ? (left < start ? left : left + node.offsetWidth - viewport.clientWidth) :
                Math.floor(index / pageSize) * pageSize * step();
            slide(target, immediate);
        }
        lane.revealCard = (node, nearest) => reveal(node, true, nearest);
        if (related) {
            viewport.addEventListener("mousedown", event => {
                if (event.target.closest('.movie-card[data-edge="peek"]')) event.preventDefault();
            }, {capture: true, signal});
            viewport.addEventListener("click", event => {
                const node = event.target.closest('.movie-card[data-edge="peek"]');
                if (!node) return;
                event.preventDefault();
                event.stopPropagation();
                const direction = node.offsetLeft < viewport.scrollLeft - 1 ? -1 : 1;
                slide((destination ?? viewport.scrollLeft) + direction * pageSize * step());
            }, {capture: true, signal});
        }
        const resize = globalThis.ResizeObserver ? new ResizeObserver(() => { cancel(); update(); }) : null;
        if (resize) resize.observe(viewport);
        else window.addEventListener("resize", update, {signal});
        signal.addEventListener("abort", () => { cancel(); resize?.disconnect(); }, {once: true});
        viewport.addEventListener("scroll", markVisible, {passive: true});
        viewport.addEventListener("pointerdown", cancel);
        viewport.addEventListener("wheel", cancel, {passive: true});
        rows.addEventListener("focusin", event => {
            const tile = event.target.closest(".movie-resume-card") ?? event.target.closest(".movie-card");
            if (tile?.parentElement === rows && !related) reveal(tile);
        });
        lane.addEventListener("keydown", event => {
            if (!arrows.includes(event.target) || !["PageUp", "PageDown"].includes(event.key)) return;
            event.preventDefault();
            arrows[event.key === "PageDown" ? 1 : 0].click();
        });
        return {lane, update, reset: () => { slide(0, true); markVisible(); }};
    }
    const browseShelves = [];
    function resetHomeShelves() {
        for (const shelf of browseShelves) shelf.resetScroll();
    }
    let pendingCards = new Map();
    function placeBrowseCards() {
        const visible = new Map(), placed = new Set();
        const owned = browseShelves.flatMap(shelf => shelf.items.map(seriesCardItem));
        const focused = document.activeElement;
        const pendingTitle = pendingCards.get(focused?.dataset.titleKey)?.job.item;
        const nextPending = new Map();
        const queued = [...downloadRows.values()].map(row => row.job).filter(Boolean);
        for (const entry of pendingCards.values()) {
            const current = downloadItems.find(item => item?.name === entry.job.release);
            if (current?.state !== "Finished" && !(current?.progress >= 1)) continue;
            // The media library can discover a completed file after the transfer ends.
            entry.importUntil ??= Date.now() + 60000;
            if (Date.now() < entry.importUntil) queued.push(entry.job);
        }
        for (const job of trackedDownloads.values()) {
            if (Date.now() - job.queuedAt < 15000 && !job.last && !queued.some(entry => entry.item.Id === job.item.Id))
                queued.unshift(job);
        }
        queued.sort((a, b) => Number(Boolean(b.item.TmdbPoster)) - Number(Boolean(a.item.TmdbPoster)));
        for (const job of queued) {
            if (owned.some(item => sameDownloadedTitle(job.item, item)) ||
                [...nextPending.values()].some(entry => sameDownloadedTitle(job.item, entry.job.item))) continue;
            const saved = [...pendingCards.values()].find(entry => sameDownloadedTitle(job.item, entry.job.item));
            const entry = saved ?? {job};
            const previousPoster = entry.poster;
            const selected = !job.item.TmdbPoster && previousPoster ? {...job, item: {...job.item, TmdbPoster: previousPoster}} : job;
            entry.job = selected;
            entry.poster = selected.item.TmdbPoster;
            entry.node ??= card(selected.item, "recent", undefined, entry);
            if (saved && selected.item.TmdbPoster !== previousPoster)
                chainImages(entry.node.querySelector("img"), selected.item.TmdbPoster ? [selected.item.TmdbPoster] : []);
            updateCardDownload(entry.node, selected);
            nextPending.set(entry.node.dataset.titleKey, entry);
        }
        pendingCards = nextPending;
        const reserved = new Set([...favoriteShelf.cards.keys(), ...recentShelf.cards.keys(), ...collectionsShelf.cards.keys()]);
        const genreCards = new Map();
        for (const shelf of genreShelves) {
            const available = [...shelf.cards.keys()].filter(key => !reserved.has(key)).slice(-8);
            if (available.length < 4 || genreCards.size === 3) continue;
            genreCards.set(shelf, new Set(available));
            for (const key of available) reserved.add(key);
        }
        const inGenre = new Set([...genreCards.values()].flatMap(keys => [...keys]));
        let focusKey, fallback, originalShelf;
        for (const shelf of browseShelves) {
            const {section, heading, rows, cards, more, resume, format} = shelf;
            if (rows.contains(focused)) {
                focusKey = focused.dataset.titleKey;
                fallback = heading;
                originalShelf = shelf;
            } else if (section.contains(focused)) fallback = heading;
            const keep = new Set();
            if (shelf === recentShelf) for (const entry of pendingCards.values()) keep.add(entry.node);
            for (const [key, node] of cards) {
                if (format === "genre" && !genreCards.get(shelf)?.has(key)) continue;
                if (format === "catalogue" && inGenre.has(key)) continue;
                if (!resume && placed.has(key)) continue;
                if (!resume) placed.add(key);
                visible.set(key, node);
                keep.add(node);
            }
            for (const node of [...rows.children])
                if (!keep.has(node)) node.remove();
            let next = rows.firstElementChild;
            for (const node of keep) {
                if (node !== next) rows.insertBefore(node, next);
                next = node.nextElementSibling;
            }
            section.hidden = !keep.size && !shelf.failed && focused !== heading;
            shelf.updateArrows();
        }
        if (fallback && (document.activeElement === document.body || !focused.isConnected || focused.closest("[hidden]"))) {
            const original = originalShelf?.cards.get(focusKey);
            const imported = pendingTitle && owned.find(item => sameDownloadedTitle(pendingTitle, item));
            const replacement = original?.isConnected ? original : visible.get(focusKey) ?? visible.get(imported?.Id);
            const control = replacement?.matches(".movie-resume-card")
                ? replacement.querySelector(focused.matches(".movie-continue-menu-button") ? ".movie-continue-menu-button" : ".movie-card")
                : replacement;
            (control || (!fallback.closest("[hidden]") ? fallback : submit)).focus({preventScroll: true});
        }
    }
    function shelf(title, type, resume = false, parent = browse, term = "", signal = life.signal, extra = {}) {
        const grid = parent !== browse, section = el("section"), heading = el("h2", title), rows = el("div");
        section.className = "movie-shelf";
        rows.className = "movie-cards";
        const format = extra.format ?? (resume ? "resume" : "catalogue");
        section.dataset.format = format;
        const more = button(t("Show more"), () => void load(offset === 0));
        more.className = "movie-more";
        more.setAttribute("aria-label", t("Show more ") + title.toLowerCase());
        heading.tabIndex = -1;
        const cards = new Map();
        const outage = createServiceStatus({
            detail: term ? t("Reconnect to search your movie library.") : t("Reconnect to load this shelf."),
            label: term ? t("Retry library search") : t("Retry ") + title.toLowerCase(),
            retry: () => load(offset === 0), focus: () => section.hidden ? submit : heading, automatic: true
        });
        const state = { section, heading, rows, more, cards, resume, format, updateArrows: () => {}, load, items: [] };
        const lanes = el("div");
        lanes.className = "movie-shelf-lanes";
        section.append(heading, lanes, outage.card, more); parent.append(section);
        if (!grid) {
            browseShelves.push(state);
            const {lane, update, reset} = shelfLane(rows, title, signal);
            lanes.append(lane);
            state.updateArrows = update;
            state.resetScroll = reset;
        }
        let offset = 0, busy = false, searchRow, searchLane;
        async function load(reset, quiet = false, bounded = signal, batch = false) {
            if (busy || !active) return;
            busy = true; more.setAttribute("aria-disabled", "true");
            const previousItems = state.items;
            try {
                const fetchPage = batch ? request : searchLibrary;
                const params = {userId: session.user,
                    recursive:true, includeItemTypes:type, startIndex:reset ? 0 : offset, limit:20, enableUserData:true, enableImages:true, enableImageTypes:"Primary,Thumb,Backdrop,Logo", imageTypeLimit:1,
                    ...(term ? {searchTerm:term, fields:"MediaStreams"} : {}),
                    ...(resume ? {mediaTypes:"Video"} : {sortBy:"SortName",sortOrder:"Ascending"}),
                    ...extra.params};
                const [page, episodes, nextUp] = await Promise.all([
                    extra.page?.() ?? fetchPage(resume ? "UserItems/Resume" : "Items", params, undefined, bounded),
                    // Jellyfin's Resume feed honours hidden library preferences and can be filled by films.
                    resume && !preview ? request("Items", {...params, includeItemTypes: "Episode",
                        filters: "IsResumable", sortBy: "DatePlayed", sortOrder: "Descending"}, undefined, bounded).catch(() => null) : null,
                    resume ? request("Shows/NextUp", {userId: session.user, fields: params.fields, limit: params.limit,
                        enableResumable: false, disableFirstEpisode: true, enableUserData: true}, undefined, bounded).catch(() => null) : null
                ]);
                if (!active || signal.aborted) return;
                // A completed toggle replaces the list while an older shelf request can still be in flight.
                if ((format === "favorites" || resume) && state.items !== previousItems) return;
                if (!Array.isArray(page?.Items)) throw Error("Invalid library page");
                const episodeItems = Array.isArray(episodes?.Items) ? episodes.Items.filter(item => item.Type === "Episode") : [];
                let items = [...page.Items, ...episodeItems].filter(item =>
                    type.split(",").includes(item.Type) && (!extra.accept || extra.accept(item)));
                if (resume) {
                    items = items.filter(item => !isShortMovie(item.RunTimeTicks));
                    items.sort((a, b) => playedAt(b) - playedAt(a));
                    const seen = new Set();
                    items = items.filter(item => {
                        const key = titleKey(item);
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                    const upcoming = [];
                    for (const item of Array.isArray(nextUp?.Items) ? nextUp.Items : []) {
                        if (item.Type !== "Episode" || !item.SeriesId || item.IsMissing || item.LocationType === "Virtual" || isShortMovie(item.RunTimeTicks) ||
                            item.UserData?.Played || seen.has(titleKey(item))) continue;
                        seen.add(titleKey(item));
                        upcoming.push({...item, FamilyHubNextUp: true});
                    }
                    const dated = await Promise.all(upcoming.map(async item => {
                        // The series may have a newer play date than its upcoming episode.
                        const history = preview ? null : await request("Items", {userId: session.user,
                            parentId: item.SeriesId, recursive: true, includeItemTypes: "Episode", filters: "IsPlayed",
                            enableUserData: true, sortBy: "DatePlayed", sortOrder: "Descending", limit: 1
                        }, undefined, bounded).catch(() => null);
                        return [item, Math.max(playedAt(item), playedAt(history?.Items?.[0] ?? {}))];
                    }));
                    if (!active || signal.aborted || bounded.aborted || state.items !== previousItems) return;
                    items = [...items.map(item => [item, playedAt(item)]), ...dated]
                        .sort((a, b) => b[1] - a[1]).slice(0, params.limit).map(([item]) => item);
                }
                if (reset && !grid && state.loaded && !state.failed &&
                    JSON.stringify(state.items.slice(0, items.length)) === JSON.stringify(items) &&
                    (offset > page.Items.length ? quiet : state.items.length === items.length)) return;
                if (reset) { offset = 0; cards.clear(); }
                state.items = reset ? items : [...state.items, ...items];
                const wasFocused = document.activeElement === more;
                let first;
                for (const item of items) {
                    const key = titleKey(item);
                    if (cards.has(key)) continue;
                    const node = card(item, format);
                    node.dataset.titleKey = key;
                    cards.set(key, node);
                    if (grid) {
                        if (!searchRow || searchRow.childElementCount === 10) {
                            searchRow = el("div");
                            searchRow.className = "movie-cards";
                            searchLane = shelfLane(searchRow, `${title}, row ${lanes.childElementCount + 1}`, signal);
                            lanes.append(searchLane.lane);
                        }
                        searchRow.append(node);
                        searchLane.update();
                    }
                    first ??= node;
                }
                offset += page.Items.length;
                more.hidden = extra.singlePage || !page.Items.length || offset >= (page.TotalRecordCount ?? offset);
                more.textContent = t("Show more");
                more.setAttribute("aria-label", t("Show more ") + title.toLowerCase());
                state.loaded = true;
                state.failed = false;
                outage.clear();
                if (!grid && !batch) renderHome();
                if (grid) section.hidden = !cards.size;
                if (term && reset) {
                    searchCount = cards.size;
                    if (!cards.size) {
                        if (!extra.noMatch?.()) { stopSearchProgress(); announceResults(0, true); }
                        if (wasFocused) submit.focus();
                        return;
                    }
                    if (!extra.match || items.some(extra.match) || !extra.noMatch?.()) {
                        stopSearchProgress();
                        announceResults();
                    }
                }
                if (wasFocused) {
                    const firstCard = first?.matches(".movie-card") ? first : first?.querySelector(".movie-card");
                    (firstCard?.isConnected ? firstCard : section.hidden ? submit : heading).focus();
                }
            } catch {
                if (active && !signal.aborted && !quiet) {
                    state.failed = true;
                    section.hidden = false;
                    outage.show();
                    if (document.activeElement === more) outage.card.querySelector("button").focus({preventScroll: true});
                    more.hidden = true;
                    if (!extra.noMatch?.() && term) stopSearchProgress();
                }
            } finally { busy = false; more.removeAttribute("aria-disabled"); }
        }
        more.hidden = true;
        if (grid) void load(true);
        else section.hidden = true;
        return state;
    }
    function externalResults(term, signal, findRelease = false) {
        const panel = el("div");
        panel.className = "movie-external";
        results.append(panel);

        const runtime = el("p"), alternate = el("p");
        runtime.className = alternate.className = "movie-web-meta";
        panel.append(el("h2", t("Search results")), runtime, alternate);
        let externalCount = 0, requestCount = 0, youtubeFailed = false, hasReleases = false;
        let releaseLookup, matchingShelf, moreSearch, emptyAfterSearch = false;
        const sourceIcons = new Map();
        function stopMoreSearch() {
            moreSearch?.abort();
            moreSearch = undefined;
            if (cancelSlowSearch !== stopMoreSearch) return;
            cancelSlowSearch = undefined;
            searchProgress.removeAttribute("data-slow");
            stopSearchProgress();
        }
        signal.addEventListener("abort", stopMoreSearch, {once: true});
        life.signal.addEventListener("abort", stopMoreSearch, {once: true, signal});
        function showDetails(details) {
            if (!details?.title) return;
            const duration = formatMinutes(details.runtime_minutes);
            const title = details.season == null ? details.title : `${details.title}, season ${details.season}`;
            runtime.textContent = duration ? [title, details.episode_count && plural(details.episode_count, "episode"),
                (details.runtime_estimated ? "about " : "") + duration].filter(Boolean).join(", ") : "";
            alternate.textContent = details.hungarian_title ? t("Also searched for ") + details.hungarian_title : "";
        }
        const downloads = el("section"), otherSources = el("details");
        downloads.className = "movie-source";
        downloads.hidden = true;
        otherSources.className = "movie-release-alternatives";
        otherSources.open = true;
        otherSources.append(el("summary", t("Other watch and download options")), downloads);
        const alive = () => active && !signal.aborted && panel.isConnected;
        function showMatchingTitles(list) {
            if (!list.length || !alive() || findRelease) return false;
            const libraryNames = [...results.querySelectorAll(".movie-card-name")];
            const matches = list.filter(item => typeof item?.title === "string" && item.title.trim() && !libraryNames.some(name => {
                const year = name.closest(".movie-card").dataset.year;
                return (!year || !item.year || year === String(item.year)) && searchTitle(name.textContent) === searchTitle(item.title);
            }));
            if (!matches.length) return false;
            const matchShelf = el("section"), credit = el("p", t("Posters and details from TMDB. ") + tmdbAttribution);
            matchShelf.className = "movie-shelf";
            matchShelf.dataset.format = "search";
            credit.className = "movie-source-note movie-matches-credit";
            matchShelf.append(el("h2", t("Find releases")));
            for (let i = 0; i < matches.length; i += 10) {
                const row = el("div");
                row.className = "movie-cards";
                const {lane, update} = shelfLane(row, t("matching titles, row {0}", i / 10 + 1), signal);
                matchShelf.append(lane);
                for (const item of matches.slice(i, i + 10)) {
                    const name = item.year ? `${item.title} (${item.year})` : item.title;
                    const pick = card({Name: name, Type: item.kind === "tv" ? "Series" : "Movie", Id: `match-${item.kind}-${item.id}`}, "search", () => {
                        const season = /\s+(?:season\s+|s)(\d{1,3})$/i.exec(term);
                        query.value = item.kind === "tv" && season ? `${item.title} S${season[1].padStart(2, "0")}`
                            : item.kind === "tv" || !item.year ? item.title : `${item.title} ${item.year}`;
                        startSearch(true);
                    });
                    if (item.poster) chainImages(pick.querySelector("img"), [item.poster]);
                    row.append(pick);
                }
                update();
            }
            externalCount = matches.length;
            if (matches.some(item => item.poster)) matchShelf.append(credit);
            if (panel.hasAttribute("data-release-layout")) otherSources.append(matchShelf);
            else results.insertBefore(matchShelf, panel);
            matchingShelf = matchShelf;
            return true;
        }
        const getMatches = () => call("MovieMatches", term).then(reply => {
            const list = Array.isArray(reply?.matches) ? reply.matches : [];
            if (!alive()) return [];
            release.setMatches(list);
            return list;
        }).catch(() => []);
        const matchingTitles = session.release_search_enabled ?
            getMatches().then(async list => {
                await releaseLookup;
                if (hasReleases) return false;
                return showMatchingTitles(list);
            }) : null;
        const release = buildReleaseSearch(async () => {
            stopMoreSearch();
            const [torrents, videa, youtube] = await Promise.all([
                session.release_search_enabled ? call("MovieReleaseSearch", term).catch(() => null) : null,
                session.downloads_enabled ? call("MovieVideaSearch", term).catch(() => null) : null,
                call("MovieFind", term).catch(() => null)
            ]);
            if (!alive()) return;
            const torrentFailed = session.release_search_enabled && !Array.isArray(torrents?.results);
            const videaFailed = session.downloads_enabled && !Array.isArray(videa?.results);
            youtubeFailed = !Array.isArray(youtube?.results);
            const videos = youtubeFailed ? [] : youtube.results.filter(item =>
                typeof item?.title === "string" && /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(item.url));
            const ids = videos.filter(video => !video.height || !(video.duration ?? video.seconds)).map(video => video.url.slice(-11));
            const metadata = ids.length ? await boundedCall(signal, "MovieYouTubeMetadata", ids).catch(() => null) : null;
            if (!alive()) return;
            if (youtubeFailed) {
                if (youtube?.error === "Searching the web is not set up on this server.")
                    videoOutage.card.querySelector(".service-status-announcement p").textContent = youtube.error;
                videoOutage.show();
            }
            const videaMatches = videaFailed ? [] : videa?.season ? [videa.season] : videa?.results || [];
            const ranked = [
                ...(torrentFailed ? [] : torrents?.results || []),
                ...videaMatches.map(item => ({...item, site: "Videa"})),
                ...videos.map(item => {
                    const details = metadata?.results?.[item.url.slice(-11)];
                    return {...item, ...details, title: item.title, url: item.url, site: "YouTube",
                        height: details?.height || item.height};
                })
            ];
            hasReleases = ranked.some(row => row.site !== "YouTube");
            if (!ranked.length && (torrentFailed || videaFailed) && !torrents?.slow_sources) {
                if (!youtubeFailed) videoOutage.clear();
                return {error: true};
            }
            return {results: ranked, title_details: torrents?.title_details || youtube?.title_details,
                slow_sources: torrents?.slow_sources};
        }, signal, session.downloads_enabled ? async (row, options, identity, opener, close) => {
            const reply = row.episodes
                ? await call("MovieVideaSeasonDownload", row.name, row.episodes)
                : row.site
                ? await call(row.site === "Videa" ? "MovieVideaDownload" : "MovieYouTubeDownload", row.url, row.title)
                : await call("MovieDownload", row.guid, row.indexerId, row.title, ...options);
            if (reply?.state !== "sent") return reply;
            refreshDownloadsAfterGrab();
            if (row.site) return reply;
            const kind = identity.kind || (row.kind ? "tv" : "movie");
            const seasonTag = releaseSeason(row.title.replaceAll("_", " "));
            const season = kind === "tv" ? row.seasons?.[0] ??
                (seasonTag ? Number(seasonTag[1] ?? seasonTag[3]) : identity.season ?? 1) : undefined;
            const name = identity.title || row.name;
            const item = {
                Id: "download-" + kind + "-" + (identity.tmdb_id || searchTitle(name) + "-" + (identity.year || "")),
                Name: name, Type: kind === "tv" ? "Series" : "Movie", ProductionYear: identity.year,
                ProviderIds: {Tmdb: identity.tmdb_id}, OfficialRating: identity.official_rating,
                RunTimeTicks: (identity.runtime_minutes || 0) * 6e8, Overview: identity.overview,
                TmdbPoster: identity.poster, TmdbBackdrop: identity.backdrop
            };
            const job = {item, season, seasons: row.seasons, episode: Number(seasonTag?.[2]) || undefined,
                episodeCount: identity.episode_count, allSeasons: row.kind === "Complete series",
                release: reply.name || row.fileName, queuedAt: Date.now(), expires: Date.now() + 30 * 86400000};
            trackedDownloads.set(item.Id, job);
            saveDownloads();
            if (active) renderDownloadQueue();
            const opened = !signal.aborted && await openDownloadedTitle(job, opener, signal, close, true).catch(() => false);
            return {...reply, opened};
        } : null, {
            term, screen: movieScreen(readMoviePreferences(preferenceViewer).screen), icon, searchTitle, titleHue, chainImages,
            searchButton: submit,
            sourceIcon: indexer => {
                if (!sourceIcons.has(indexer)) sourceIcons.set(indexer,
                    Promise.resolve().then(() => app.invokeMethodAsync("MovieSourceIcon", indexer)).catch(() => ""));
                return sourceIcons.get(indexer);
            },
            onSlowSources: async count => {
                if (!alive() || seriesView || current) return;
                const controller = new AbortController();
                moreSearch = controller;
                cancelSlowSearch = stopMoreSearch;
                const searchId = ++slowSearchNumber;
                const abort = () => { void call("MovieCancelSlowReleases", searchId).catch(() => {}); };
                controller.signal.addEventListener("abort", abort, {once: true});
                searchProgress.setAttribute("data-slow", "");
                searchProgress.classList.add("is-checking");
                searchProgressText.textContent = t("Searching {0}…", plural(count, "more site"));
                try {
                    const reply = await call("MovieSlowReleases", term, searchId);
                    if (!alive() || controller.signal.aborted || !Array.isArray(reply?.results)) return;
                    if (await release.append(reply.results, controller.signal)) {
                        hasReleases = true;
                        emptyAfterSearch = false;
                        message.textContent = "";
                    }
                } catch {
                    // The first set of results stays available while an optional source is unreachable.
                } finally {
                    controller.signal.removeEventListener("abort", abort);
                    if (moreSearch === controller) {
                        moreSearch = undefined;
                        stopMoreSearch();
                        if (emptyAfterSearch) message.textContent = t("No watch or download options found. Try another title.");
                    }
                }
            },
            matchTitle: name => boundedCall(signal, "MovieMatches", name),
            seriesSeasons: async identity => {
                const reply = await seriesCatalogue(identity.title, identity.year, identity.tmdb_id, signal);
                return Array.isArray(reply?.seasons) ? reply.seasons.map(season => season?.number)
                    .filter(number => Number.isInteger(number) && number > 0) : [];
            },
            palette: backdropPalette,
            preferences: () => {
                const prefs = readMoviePreferences(preferenceViewer);
                return [prefs.downloadAudio ?? false, prefs.downloadSubtitles ?? true];
            },
            save: ([downloadAudio, downloadSubtitles]) => saveMoviePreferences(preferenceViewer,
                {...readMoviePreferences(preferenceViewer), downloadAudio, downloadSubtitles}),
            watchLink: youtubeWatch,
            downloadProgress: row => {
                const key = searchTitle(row.episodes ? row.name : row.title);
                return downloadItems.find(item => typeof item?.name === "string" &&
                    searchTitle(item.name) === key && Number.isFinite(item.progress))?.progress;
            },
            onResults: (details, visible, incremental) => {
                showDetails(details);
                if (!youtubeFailed) videoOutage.clear();
                const focused = document.activeElement;
                const matchFocus = hasReleases && matchingShelf?.contains(focused);
                if (matchFocus && !incremental) release.element.querySelector("h2").focus({preventScroll: true});
                if (hasReleases && !incremental) matchingShelf?.remove();
                if (!visible || panel.hasAttribute("data-release-layout")) return;
                const libraryShelf = results.querySelector(":scope > .movie-shelf");
                const otherFocus = otherSources.contains(focused) || libraryShelf?.contains(focused);
                const otherSummary = otherSources.querySelector("summary");
                if (libraryShelf && (!incremental || !libraryShelf.contains(focused))) otherSummary.after(libraryShelf);
                otherSources.open = Boolean(otherFocus);
                panel.setAttribute("data-release-layout", "");
                searchAnnouncement.textContent = "";
                if (!incremental && otherFocus && document.activeElement !== focused) {
                    const next = otherSummary.getClientRects().length ? otherSummary : release.element.querySelector("h2");
                    next.focus({preventScroll: true});
                }
            }
        });
        panel.append(release.element, otherSources);
        updateReleaseProgress = release.updateProgress;
        const message = el("p");
        message.className = "movie-source-note";
        message.setAttribute("role", "status");
        panel.append(message);

        const videoOutage = createServiceStatus({
            title: t("YouTube did not respond"), detail: t("Retry the video search."), label: t("Retry YouTube"),
            retry: release.load, focus: () => release.element.querySelector("li:not([hidden]) a") || submit, automatic: true
        });
        const downloadOutage = createServiceStatus({
            detail: t("Reconnect to search for download options."), label: t("Retry download lookup"),
            retry: findDownloads, focus: () => downloads.querySelector("ul button") || submit, automatic: true
        });
        panel.insertBefore(videoOutage.card, otherSources);
        downloads.append(downloadOutage.card);
        function requestRow(item, season) {
            const row = el("li"), details = el("div"), note = el("p");
            const meta = [item.kind === "tv" ? season == null ? t("Series") : t("Season {0}", season) : t("Movie"), item.year].filter(Boolean);
            row.className = "movie-source-row";
            note.setAttribute("role", "status");
            details.append(el("h3", item.title), el("p", meta.join(", ")), note);
            row.append(details);
            const action = requestTitleAction(item, season, note, row, alive);
            if (action) row.append(action);
            return row;
        }
        async function findDownloads() {
            let reply;
            try { reply = await call("MovieRequestSearch", term); }
            catch { reply = {error: t("Download lookup did not respond.")}; }
            if (!alive()) return false;
            if (reply?.error || !Array.isArray(reply?.results)) {
                downloads.hidden = false;
                downloadOutage.show();
                return true;
            }
            const found = reply.results.slice(0, 12);
            requestCount = found.length;
            showDetails(reply.title_details);
            if (found.length) {
                const heading = el("h2", t("Download options")), rows = el("ul");
                rows.className = "movie-source-list";
                rows.append(...found.map(item => requestRow(item, reply.season)));
                downloads.append(heading, rows);
            }
            downloadOutage.clear();
            downloads.hidden = !found.length;
            return !!found.length;
        }

        startSearchProgress();
        releaseLookup = release.load();
        const searches = [releaseLookup];
        if (matchingTitles) searches.push(matchingTitles);
        if (session.requests_enabled) searches.push(findDownloads());
        void Promise.allSettled(searches).then(states => {
            if (!alive()) return;
            stopSearchProgress();
            if (states.some(state => state.value) || !videoOutage.card.hidden) {
                if (!findRelease) announceResults(externalCount || requestCount);
            } else if (!release.element.querySelector(".movie-release")) {
                emptyAfterSearch = true;
                if (!moreSearch) message.textContent = t("No watch or download options found. Try another title.");
            }
        });
    }

    const form = el("form"), query = el("input"), submit = el("button");
    form.className = "movie-search";
    form.setAttribute("role", "search");
    form.setAttribute("aria-label", t("Movies and TV"));
    query.type = "search";
    query.placeholder = t("Movies, series, or episodes");
    query.setAttribute("aria-label", t("Search movies and TV"));
    query.maxLength = 120;
    query.enterKeyHint = "search";
    submit.setAttribute("aria-label", t("Search"));
    submit.type = "submit";
    submit.append(icon(searchPath));
    const browse = el("div"), results = el("div");
    browse.className = "movie-browse";
    results.className = "movie-search-results";
    const clear = button("", () => clearSearch());
    clear.setAttribute("aria-label", t("Clear"));
    clear.append(icon("M6 6l12 12M18 6 6 18"));
    clear.hidden = true;
    const scrollHost = host.closest(".workspace > main") ?? document.scrollingElement ?? document.documentElement;
    const searchAnnouncement = el("p"), searchProgress = el("p"), searchProgressText = el("span");
    searchProgress.className = "movie-search-progress";
    searchProgressText.setAttribute("role", "status");
    searchProgress.append(searchProgressText);
    searchAnnouncement.className = "movie-visually-hidden";
    searchAnnouncement.setAttribute("role", "status");
    searchAnnouncement.setAttribute("aria-atomic", "true");
    let searchRequest, searchTimer, submittedTerm, homeScrollTop, updateReleaseProgress, searchCount = 0;
    let cancelSlowSearch, slowSearchNumber = 0;
    const requestStates = {
        pending: t("Waiting for approval"), approved: t("Request approved"), failed: t("Request needs attention"),
        available: t("Available in the library"), existing: t("Already requested or available"),
        no_seasons: t("No seasons available to request"), requested: t("Request received")
    };
    function requestTitleAction(item, season, message, row, alive = () => active) {
        const unavailable = item.status === 6 || (season == null && (item.status === 5 || item.kind === "movie" && [2, 3].includes(item.status)));
        if (unavailable) {
            message.textContent = {2: requestStates.pending, 3: t("Requested"), 5: requestStates.available, 6: t("Requests disabled for this title")}[item.status];
            return null;
        }
        const label = item.kind === "movie" ? t("Request download") : season == null ? t("Request all seasons") : t("Request season ") + season;
        const action = button(label, async () => {
            if (action.getAttribute("aria-disabled") === "true") return;
            if (document.activeElement === document.body) action.focus();
            action.setAttribute("aria-disabled", "true");
            message.textContent = t("Sending request…");
            let reply;
            try { reply = await call("MovieRequest", item.kind, item.id, season ?? null); }
            catch { reply = {error: t("Could not confirm the request. Try again.")}; }
            if (!alive() || !row.isConnected) return;
            if (reply?.error || !Object.prototype.hasOwnProperty.call(requestStates, reply?.state)) {
                action.removeAttribute("aria-disabled");
                message.textContent = serverError(reply, t("Could not confirm the request. Try again."));
                return;
            }
            message.textContent = requestStates[reply.state];
            if (document.activeElement === action) { message.tabIndex = -1; message.focus(); }
            action.remove();
        });
        action.className = "movie-source-action";
        action.setAttribute("aria-label", `${label}: ${item.title}${item.year ? ` (${item.year})` : ""}`);
        return action;
    }
    function startSearchProgress() {
        if (searchProgressText.textContent) return;
        searchProgress.classList.add("is-checking");
        searchProgressText.textContent = t("Searching…");
    }
    function stopSearchProgress() {
        if (searchProgress.hasAttribute("data-slow")) return;
        searchProgress.classList.remove("is-checking");
        searchProgressText.textContent = "";
    }
    function announceResults(external = 0, showEmpty = false) {
        if (results.querySelector("[data-release-layout]")) return;
        if (searchAnnouncement.textContent) return;
        const count = searchCount + external;
        searchAnnouncement.classList.toggle("movie-visually-hidden", !showEmpty || count > 0);
        searchAnnouncement.textContent = count ? t("{0} found.", plural(count, "title")) : t("No titles found.");
    }
    function replaceSearchResults() {
        clearTimeout(searchTimer);
        searchRequest?.abort();
        updateReleaseProgress = undefined;
        submittedTerm = undefined;
        if (results.contains(document.activeElement)) submit.focus({preventScroll: true});
        results.replaceChildren();
        searchAnnouncement.textContent = "";
        stopSearchProgress();
        searchCount = 0;
    }
    function resetSearch() {
        while (seriesView) closeSeries(query);
        replaceSearchResults();
        clear.hidden = true;
        browse.hidden = false;
        if (homeScrollTop !== undefined) {
            scrollHost.scrollTop = homeScrollTop;
            resetHomeShelves();
            homeScrollTop = undefined;
        }
    }
    function showSearch() {
        homeScrollTop ??= scrollHost.scrollTop;
        clear.hidden = false;
        browse.hidden = true;
        if (header) scrollHost.scrollTop = 0;
    }
    async function findSeason(title, season, signal) {
        const shows = await searchLibrary("Items", {userId: session.user, recursive: true, includeItemTypes: "Series",
            searchTerm: title, limit: 12}, undefined, signal);
        const matches = shows.Items.filter(item => item.Name.localeCompare(title, undefined, {sensitivity: "base"}) === 0);
        const pages = await withinMovieLoad(bounded => Promise.all(matches.slice(0, 3).map(item => localEpisodes(item.Id, bounded, season))), signal);
        const items = pages.flatMap((page, index) => page.filter(item => item.ParentIndexNumber === season)
            .map(item => ({...item, SeriesId: matches[index].Id, SeriesName: matches[index].Name})));
        return {Items: items, TotalRecordCount: items.length};
    }
    function startSearch(findRelease = false, keepInput = false) {
        const term = query.value.trim();
        if (!findRelease && term && term === submittedTerm) {
            if (!keepInput) submit.focus({preventScroll: true});
            return;
        }
        while (seriesView) closeSeries(submit);
        replaceSearchResults();
        if (!term) { resetSearch(); return; }
        if (!keepInput) submit.focus({preventScroll: true});
        showSearch();
        searchRequest = new AbortController();
        const signal = searchRequest.signal;
        if (findRelease) {
            externalResults(term, signal, true);
            return;
        }
        submittedTerm = term;
        startSearchProgress();
        const season = preview ? null : /^(.+?)\s+(?:season\s+|s)(\d{1,3})$/i.exec(term);
        let searchedOtherSources = false;
        const noMatch = () => {
            if (preview || term.length < 2) return false;
            if (searchedOtherSources) return true;
            searchedOtherSources = true;
            externalResults(term, signal);
            return true;
        };
        shelf(t("In your library"), "Movie,Series,Episode", false, results, term, signal, {
            noMatch, format: "search",
            match: season ? undefined : item => [item.Name, item.SeriesName].some(name => name && searchTitle(name) === searchTitle(term)),
            page: season ? () => findSeason(season[1], Number(season[2]), signal) : undefined
        });
    }
    form.onsubmit = event => {
        event.preventDefault();
        const releaseLayout = Boolean(results.querySelector("[data-release-layout]"));
        startSearch(releaseLayout, releaseLayout && document.activeElement === query);
    };
    query.oninput = event => {
        if (event.isComposing) return;
        if (!query.value.trim()) { resetSearch(); return; }
        replaceSearchResults();
        showSearch();
        searchTimer = setTimeout(() => startSearch(false, true), 350);
    };
    form.append(query, submit, clear);
    const toolbar = el("div");
    toolbar.className = "movie-toolbar";
    toolbar.append(form);
    const catalogue = el("div"), downloadTray = el("div"), downloadsPanel = el("div");
    catalogue.className = "movie-catalogue";
    downloadTray.className = "movie-download-tray";
    downloadTray.hidden = true;
    downloadsPanel.className = "movie-downloads";
    downloadsPanel.id = "movie-downloads-panel";
    downloadsPanel.hidden = true;
    downloadsPanel.setAttribute("role", "dialog");
    downloadsPanel.setAttribute("aria-labelledby", "movie-downloads-title");
    const queue = el("ul"), downloadRows = new Map();
    let downloadRowNumber = 0, downloadPanelRequest;
    const downloadCount = el("span");
    const downloadToggle = button("", () => setDownloadPanel(downloadsPanel.hidden, true));
    const closeDownloads = button(t("Close"), () => setDownloadPanel(false, true));
    downloadToggle.className = "movie-download-toggle";
    downloadToggle.setAttribute("aria-controls", downloadsPanel.id);
    downloadToggle.setAttribute("aria-expanded", "false");
    downloadToggle.setAttribute("aria-haspopup", "dialog");
    downloadCount.className = "movie-download-count";
    downloadCount.setAttribute("aria-hidden", "true");
    downloadToggle.append(downloadRing(), downloadCount);
    function setDownloadPanel(open, focus = false) {
        if (downloadsPanel.hidden === !open) return;
        if (open) downloadPanelRequest = new AbortController();
        else {
            if (focus) downloadToggle.focus({preventScroll: true});
            downloadPanelRequest?.abort();
        }
        downloadsPanel.hidden = !open;
        downloadToggle.setAttribute("aria-expanded", String(open));
        if (open && focus) closeDownloads.focus({preventScroll: true});
        if (!open) positionDownloadTray();
    }
    function positionDownloadTray() {
        if (downloadTray.hidden || !downloadsPanel.hidden || library.hidden) return;
        const playerBar = document.querySelector(".player-bar")?.getBoundingClientRect();
        const playerInset = playerBar?.height && playerBar.top < innerHeight ? innerHeight - playerBar.top : 0;
        downloadTray.style.setProperty("--movie-tray-player", playerInset + "px");
        downloadTray.style.removeProperty("--movie-tray-clearance");
        const rect = downloadToggle.getBoundingClientRect();
        // Leave room for the focused card and shelf arrows before the arrows fade in.
        const blockers = [...catalogue.querySelectorAll('.movie-shelf-arrow[aria-disabled="false"]')];
        if (document.activeElement?.matches(".movie-card")) blockers.push(document.activeElement);
        const overlaps = blockers.map(node => node.getBoundingClientRect()).filter(box =>
            box.width && box.height && box.left < rect.right + 12 && box.right > rect.left - 12)
            .sort((a, b) => b.top - a.top);
        let bottom = rect.bottom;
        for (const box of overlaps) {
            if (box.top < bottom + 12 && box.bottom > bottom - rect.height - 12)
                bottom = Math.max(rect.height + 12, box.top - 12);
        }
        if (bottom !== rect.bottom) downloadTray.style.setProperty("--movie-tray-clearance", rect.bottom - bottom + "px");
    }
    catalogue.append(browse, searchProgress, results, searchAnnouncement);
    if (session.downloads_enabled) {
        const title = el("h2", t("Downloads")), panelHeader = el("div");
        title.id = "movie-downloads-title";
        panelHeader.className = "movie-downloads-header";
        panelHeader.append(title, closeDownloads);
        downloadsPanel.append(panelHeader, queue);
        downloadTray.append(downloadToggle, downloadsPanel);
        document.addEventListener("keydown", event => {
            if (downloadsPanel.hidden) return;
            if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
                event.preventDefault();
                event.stopPropagation();
                setDownloadPanel(false, true);
            } else if (["ArrowDown", "ArrowUp"].includes(event.key) && downloadsPanel.contains(event.target)) {
                const actions = [closeDownloads, ...queue.querySelectorAll("button")];
                const next = actions[actions.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1)];
                if (next) {
                    event.preventDefault();
                    next.focus();
                }
            }
        }, {capture: true, signal: life.signal});
        downloadTray.addEventListener("focusout", event => {
            if (event.relatedTarget && !downloadTray.contains(event.relatedTarget)) setDownloadPanel(false);
        });
        const reposition = {passive: true, signal: life.signal};
        document.addEventListener("scroll", positionDownloadTray, {...reposition, capture: true});
        document.addEventListener("focusin", positionDownloadTray, reposition);
        window.addEventListener("resize", positionDownloadTray, reposition);
        catalogue.addEventListener("transitionend", event => {
            if (event.target.matches(".movie-card, .movie-shelf-arrow")) positionDownloadTray();
        }, reposition);
    }
    const header = document.querySelector(".app-header .header-search");
    (header ?? library).append(toolbar);
    library.append(catalogue);
    if (session.downloads_enabled) library.append(downloadTray);
    const headerBack = document.getElementById("header-back");
    const clearSearch = () => { query.value = ""; query.focus({preventScroll: true}); resetSearch(); };
    headerBack?.addEventListener("click", event => {
        if (preview && seriesView) {
            event.stopPropagation();
            closeSeries();
            return;
        }
        if (toolbar.hidden || !query.value.trim()) return;
        event.stopPropagation();
        clearSearch();
    }, {signal: life.signal});
    document.addEventListener("keydown", event => {
        if (toolbar.hidden || query.disabled || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || document.querySelector("dialog[open]")) return;
        if (event.key === "Escape" && query.value) {
            event.preventDefault();
            clearSearch();
        } else if (event.key === "/" && !event.target.closest?.("input, textarea, select, [contenteditable=true]")) {
            event.preventDefault();
            query.focus({preventScroll: true});
        }
    }, {signal: life.signal});
    life.signal.addEventListener("abort", () => {
        clearTimeout(searchTimer);
        searchRequest?.abort();
        downloadPanelRequest?.abort();
        for (let view = seriesView; view; view = view.parent) view.controller.abort();
        toolbar.remove();
    }, {once:true});

    let queueTimer, checkingQueue = false, refreshAfterGrabAt = 0;
    let audioJobs = [];
    const pendingAudioJobs = new Set(), audioJobItems = new WeakMap();
    const queueVisible = () => session.downloads_enabled && active && !document.hidden && host.isConnected &&
        (!library.hidden || pendingAudioJobs.size > 0);
    function audioJobSlot(item) {
        const slot = el("div");
        slot.className = "movie-title-audio";
        slot.hidden = true;
        audioJobItems.set(slot, item);
        slot.addEventListener("focusout", () => queueMicrotask(() => {
            if (slot.isConnected) updateAudioJobSlot(slot);
        }));
        updateAudioJobSlot(slot);
        return slot;
    }
    function updateAudioJobSlot(slot) {
        if (slot.contains(document.activeElement)) return;
        const {Id, ParentId, SeasonId, Name, Type, IndexNumber} = audioJobItems.get(slot);
        const season = SeasonId ?? ParentId;
        const jobs = new Map();
        for (const item of audioJobs) {
            if (item.state === "Failed") continue;
            const direct = item.item === Id;
            if (!direct && (!season || item.item !== season)) continue;
            const running = audioJobRunning(item);
            const results = item.results.filter(result =>
                (direct || result.title === Name) && (result.refresh_pending || result.can_delete && !running));
            if (!direct && !item.results.some(result => result.title === Name)) continue;
            if (!results.length && (!running || Type === "Episode")) continue;
            const key = JSON.stringify([item.name, item.state, results.map(result => result.title)]);
            if (!jobs.has(key)) jobs.set(key, {...item, results, running});
        }
        const snapshot = JSON.stringify([...jobs.values()]);
        if (slot.dataset.jobs === snapshot) return;
        slot.dataset.jobs = snapshot;
        slot.replaceChildren();
        slot.hidden = !jobs.size;
        for (const job of jobs.values()) {
            const row = el("div");
            row.className = "movie-audio-job";
            row.append(el("strong", job.name), el("span", job.state));
            if (job.running) {
                const progress = el("progress");
                progress.value = Math.max(0, Math.min(1, Number(job.progress) || 0));
                progress.setAttribute("aria-label", job.name);
                row.append(progress);
            }
            if (job.results.length && (!job.running || Type === "Episode")) {
                const results = audioJobResults(job, async (...args) => {
                    try {
                        const reply = await call(...args);
                        if (!reply?.error) scheduleDownloads(3100);
                        return reply;
                    } catch { return {error: t("The server did not respond. Try again.")}; }
                });
                if (Type === "Episode") {
                    const episode = IndexNumber == null ? Name : t("episode {0}, {1}", IndexNumber, Name);
                    for (const remove of results.querySelectorAll("[data-audio-remove]"))
                        remove.setAttribute("aria-label", t("Delete source file for ") + episode);
                }
                row.append(results);
            }
            slot.append(row);
        }
    }
    function scheduleDownloads(delay) {
        clearTimeout(queueTimer);
        if (queueVisible()) queueTimer = setTimeout(updateDownloads, delay);
    }
    function refreshDownloadsAfterGrab() {
        // Let the server's three-second queue cache expire before checking for the new item.
        refreshAfterGrabAt = Date.now() + 3100;
        scheduleDownloads(3100);
    }
    const runningDownloads = () => runningMovieDownloads(downloadItems);
    function renderDownloadQueue() {
        const running = runningDownloads().filter(item => typeof item.name === "string" && item.name.trim());
        const jobs = new Map([...trackedDownloads.values()].map(job => [searchTitle(job.release), job]));
        const shown = new Set(running.map(item => item.name));
        const audioTargets = new Set();
        for (const job of audioJobs) {
            if (!job.item || audioTargets.has(job.item)) continue;
            audioTargets.add(job.item);
            if (audioJobRunning(job)) continue;
            if (job.state !== "Failed" && !job.results.some(result => result.state === "Failed")) continue;
            const key = "audio-job:" + job.id;
            shown.add(key);
            if (downloadRows.has(key)) continue;
            const tile = el("li"), title = el("strong", job.name);
            const detail = el("p", job.error || job.results.find(result => result.error)?.error || t("Could not add audio."));
            const feedback = el("p");
            tile.className = "movie-download-audio-failure";
            title.id = "movie-download-audio-" + ++downloadRowNumber;
            feedback.setAttribute("role", "status");
            const open = button(t("Choose another source"), async () => {
                if (open.getAttribute("aria-busy") === "true") return;
                const signal = downloadPanelRequest.signal;
                open.setAttribute("aria-busy", "true");
                feedback.textContent = "";
                try {
                    const item = await withinMovieLoad(bounded => request(`Items/${encodeURIComponent(job.item)}`, {}, undefined, bounded), signal);
                    if (signal.aborted) return;
                    if (item?.Id !== job.item) throw Error("Title unavailable");
                    addAudio(item, open, downloadsPanel, signal);
                } catch {
                    if (!signal.aborted) feedback.textContent = t("Could not open the audio picker. Try again.");
                } finally { open.removeAttribute("aria-busy"); }
            });
            open.setAttribute("aria-describedby", title.id);
            tile.append(title, detail, open, feedback);
            downloadRows.set(key, {tile, open});
            queue.append(tile);
        }
        const finished = [...downloadRows.keys()].some(release => !shown.has(release));
        for (const entry of running) {
            const release = entry.name;
            const tracked = jobs.get(searchTitle(release));
            const tags = release.replaceAll("_", " ");
            const kind = releaseKind(tags);
            const tag = releaseSeason(tags);
            const span = releaseSeasons(tags);
            const allSeasons = tracked?.allSeasons ?? (kind === "Complete series");
            const first = span?.[0] ?? (tag ? Number(tag[1] ?? tag[3]) : undefined);
            const season = allSeasons ? undefined : tracked?.season ?? first;
            const cleaned = displayTitle(cleanResultTitle(release))
                .replace(/\s+(?:[|–—-]\s*)?(?:full|teljes)\s+(?:film|movie|hun|eng)\b.*$/i, "").trim();
            const year = / \(((?:19|20)\d{2})\)$/.exec(cleaned);
            const name = tracked?.item.Name ?? (year ? cleaned.slice(0, year.index) : cleaned);
            const seasons = tracked?.seasons ?? span;
            const label = season == null ? tracked?.item.Name ?? cleaned : `${name}, ${seasons?.[1] > season ?
                `Seasons ${season} to ${seasons[1]}` : season ? t("Season ") + season : t("Specials")}`;
            let row = downloadRows.get(release);
            if (!row) {
                const tile = el("li"), title = el("strong"), time = el("span"), bar = el("span");
                const open = button("", async () => {
                    if (open.getAttribute("aria-busy") === "true") return;
                    open.setAttribute("aria-busy", "true");
                    try { await openDownloadedTitle(row.job, open, downloadPanelRequest.signal); }
                    catch { homeStatus.textContent = t("Could not open the download. Try again."); }
                    finally { open.removeAttribute("aria-busy"); }
                });
                open.dataset.downloadRow = "";
                bar.className = "movie-download-progress";
                bar.setAttribute("role", "progressbar");
                bar.append(el("span"));
                time.id = "movie-download-time-" + ++downloadRowNumber;
                open.setAttribute("aria-describedby", time.id);
                open.append(title, time);
                tile.append(open, bar);
                row = {tile, open, title, time, bar};
                downloadRows.set(release, row);
                queue.append(tile);
            }
            const job = tracked ?? {
                item: {Id: "download-queue-" + searchTitle(release), Name: name, Type: kind ? "Series" : "Movie",
                    ProductionYear: year ? Number(year[1]) : undefined},
                season, seasons, allSeasons, episode: tag?.[2] ? Number(tag[2]) : undefined, release, last: entry
            };
            row.job = !job.item.TmdbPoster && typeof entry.poster === "string" && entry.poster.startsWith("https://")
                ? {...job, item: {...job.item, TmdbPoster: entry.poster}} : job;
            row.open.dataset.itemId = row.job.item.Id;
            const time = downloadRemaining(entry) || entry.state;
            if (row.title.textContent !== label) {
                row.title.textContent = label;
                row.open.setAttribute("aria-label", label);
                row.bar.setAttribute("aria-label", label + " download progress");
            }
            if (row.time.textContent !== time) row.time.textContent = time;
            const percent = downloadPercent(entry);
            row.bar.setAttribute("aria-valuenow", percent);
            row.bar.firstElementChild.style.transform = `scaleX(${percent / 100})`;
        }
        const count = shown.size;
        if (!count && downloadTray.contains(document.activeElement)) {
            (seriesView?.section.querySelector("h2") ?? (browse.hidden ? submit : browse)).focus({preventScroll: true});
        }
        for (const [release, row] of downloadRows) {
            if (shown.has(release)) continue;
            if (row.tile.contains(document.activeElement)) {
                const next = [...downloadRows].find(([key]) => shown.has(key))?.[1];
                (next?.open ?? closeDownloads).focus({preventScroll: true});
            }
            downloadRows.delete(release);
            row.tile.remove();
        }
        downloadTray.hidden = !count;
        if (!count) setDownloadPanel(false);
        else {
            if (downloadCount.textContent !== String(count)) {
                downloadCount.textContent = count;
            }
            const failed = count - running.length;
            const label = `Downloads, ${running.length} active${failed ? `, ${failed} ${failed === 1 ? "needs" : "need"} attention` : ""}`;
            if (downloadToggle.getAttribute("aria-label") !== label) downloadToggle.setAttribute("aria-label", label);
            const total = running.reduce((sum, entry) => sum + downloadPercent(entry), 0);
            downloadToggle.style.setProperty("--download-percent", running.length ? total / running.length : 0);
            positionDownloadTray();
        }
        rememberDownloadActivity(preferenceViewer, Boolean(count));
        if (homeReady && (pendingCards.size || count || [...trackedDownloads.values()].some(job => job.queuedAt && !job.last)))
            renderHome();
        if (homeReady && (finished || [...pendingCards.values()].some(entry => entry.importUntil))) void refreshHome(true);
    }
    async function updateDownloads(bounded = life.signal) {
        if (!queueVisible() || checkingQueue) return;
        checkingQueue = true;
        if (Date.now() >= refreshAfterGrabAt) refreshAfterGrabAt = 0;
        let reply;
        try { reply = await boundedCall(bounded, "MovieDownloads"); } catch {}
        checkingQueue = false;
        if (!queueVisible()) return;
        const itemsAvailable = reply?.available && Array.isArray(reply.items);
        if (itemsAvailable) downloadItems = reply.items;
        let changed = false;
        const detailJob = seriesView?.job;
        const jobs = new Set(trackedDownloads.values());
        if (detailJob) jobs.add(detailJob);
        for (const job of jobs) {
            const entry = queueEntry(job);
            if (entry && entry !== job.last) {
                const {name, state, progress, fetching} = entry;
                const snapshot = {name, state, progress, fetching};
                if (JSON.stringify(snapshot) !== JSON.stringify(job.last)) {
                    job.last = snapshot;
                    changed ||= trackedDownloads.get(job.item.Id) === job;
                }
            }
        }
        if (changed) saveDownloads();
        updateReleaseProgress?.();
        if (itemsAvailable) {
            audioJobs = downloadItems.filter(item => Array.isArray(item.results));
            for (const job of audioJobs) {
                if (audioJobRunning(job)) pendingAudioJobs.add(job.id);
                else if (pendingAudioJobs.delete(job.id)) {
                    const title = job.results.length === 1 && job.results[0].title;
                    const message = job.state === "Added" ? (title ? t("Audio added to {0}.", title) : t("Audio track added.")) :
                        t("Open Downloads to choose another audio source.");
                    if ((document.fullscreenElement || document.webkitFullscreenElement) === player && current?.showJobToast)
                        current.showJobToast(message);
                    else if (globalThis.FamilyHubNotices?.toast) globalThis.FamilyHubNotices.toast(message);
                    else homeStatus.textContent = message;
                }
            }
        }
        const cards = [...browseShelves.flatMap(shelf => [...shelf.cards.values()]), ...results.querySelectorAll("[data-download-key]")];
        for (const tile of cards) {
            const card = tile.dataset.downloadKey ? tile : tile.querySelector("[data-download-key]");
            if (card?.dataset.downloadKey) updateCardDownload(card);
        }
        if (seriesView) {
            seriesView.updateDownload?.();
            const job = seriesView.job;
            if (job && (seriesView.shouldPollLibrary?.() ||
                downloadPercent(queueEntry(job)) >= (seriesView.lastLibraryCheck ?? 10))) {
                seriesView.lastLibraryCheck = Math.min(100, downloadPercent(queueEntry(job)) + 10);
                void seriesView.refreshProgress?.();
            }
            for (const slot of seriesView.section.querySelectorAll(".movie-title-audio")) updateAudioJobSlot(slot);
        }
        renderDownloadQueue();
        if (refreshAfterGrabAt) scheduleDownloads(Math.max(0, refreshAfterGrabAt - Date.now()));
        else if (pendingAudioJobs.size || !library.hidden && (runningDownloads().length ||
            [...trackedDownloads.values()].some(job => downloadPercent(queueEntry(job)) < 100 || queueEntry(job)?.fetching?.length) ||
            [...pendingCards.values()].some(entry => entry.importUntil) ||
            seriesView?.shouldPollLibrary?.()))
            scheduleDownloads(downloadPollInterval);
    }
    const queueVisibility = () => scheduleDownloads(0);
    const queueObserver = new MutationObserver(queueVisibility);
    queueObserver.observe(library, {attributes: true, attributeFilter: ["hidden"]});
    document.addEventListener("visibilitychange", queueVisibility, {signal: life.signal});
    life.signal.addEventListener("abort", () => { clearTimeout(queueTimer); queueObserver.disconnect(); });
    const skeleton = movieLoading("home", 3, movieUi);
    const empty = el("section"), homeStatus = el("p"), entryFocus = document.activeElement;
    homeStatus.className = "movie-visually-hidden";
    homeStatus.setAttribute("role", "status");
    host.prepend(homeStatus);
    browse.setAttribute("role", "region");
    browse.setAttribute("aria-label", t("Movie library"));
    browse.tabIndex = -1;
    empty.className = "movie-library-empty";
    empty.append(el("h3", t("Your library is empty")), button(t("Search for a title"), () => query.focus()));
    empty.hidden = true;
    const featured = el("section");
    featured.className = "movie-hero";
    featured.hidden = true;
    const heroPager = el("div"), heroStatus = el("p");
    heroPager.className = "movie-hero-pager";
    heroPager.hidden = true;
    heroStatus.className = "movie-visually-hidden";
    heroStatus.setAttribute("role", "status");
    featured.append(heroPager, heroStatus);
    const favoriteStatus = el("p");
    favoriteStatus.className = "movie-favorite-status";
    favoriteStatus.setAttribute("role", "status");
    if (preview) {
        const previewLabel = el("p", t("Demo library"));
        previewLabel.className = "movie-preview-label";
        browse.append(previewLabel);
    }
    browse.append(featured, favoriteStatus);
    const fields = "Overview,Genres,ProviderIds,DateCreated,MediaStreams";
    const titleTypes = "Movie,Series";
    const resumeShelf = shelf(t("Continue watching"), "Movie,Episode", true, browse, "", life.signal,
        {singlePage: true, params: {fields}, accept: item =>
            !item.IsMissing && item.LocationType !== "Virtual" && !item.UserData?.Played &&
            (item.UserData?.PlaybackPositionTicks > 0 || item.UserData?.PlayedPercentage > 0)});
    const continueError = el("p");
    continueError.className = "movie-favorite-status";
    continueError.setAttribute("role", "status");
    resumeShelf.heading.after(continueError);
    resumeShelf.heading.addEventListener("blur", () => {
        if (!resumeShelf.items.length && !resumeShelf.failed) resumeShelf.section.hidden = true;
    });
    const favoriteShelf = shelf(t("My list"), titleTypes, false, browse, "", life.signal,
        {format: "favorites", params: {fields, isFavorite: true}, accept: item => item.UserData?.IsFavorite === true});
    const recentShelf = shelf(t("Recently added"), titleTypes, false, browse, "", life.signal,
        {format: "recent", params: {fields, sortBy: "DateCreated", sortOrder: "Descending", limit: 12}, singlePage: true,
            accept: item => Number.isFinite(Date.parse(item.DateCreated))});
    const tvShelf = shelf(t("Series"), "Series", false, browse, "", life.signal, {params: {fields}});
    const moviesShelf = shelf(t("Movies"), "Movie", false, browse, "", life.signal, {params: {fields}});
    const collectionsShelf = shelf(t("Collections"), "BoxSet", false, browse, "", life.signal,
        {format: "collections", params: {fields}});
    const genreOutage = createServiceStatus({
        detail: t("Reconnect to load movie genres."), label: t("Retry genres"), retry: refreshGenres,
        focus: () => browse, automatic: true
    });
    const genreRetry = genreOutage.card;
    browse.append(genreRetry, empty);
    catalogue.prepend(skeleton);
    browse.hidden = true;
    query.disabled = submit.disabled = true;
    requestAnimationFrame(() => { if (!homeReady && active) homeStatus.textContent = t("Loading movies and TV…"); });
    let genreShelves = [], genresLoaded = false, loadingHome = false, homeReady = false, savingFavorite = false;
    let heroItems = [], heroPick, heroSlide, heroRotation, heroPreload, heroChoice, heroFade, outgoingSlide;
    let heroHovered = false;
    const heroInterval = 9000;
    const heroName = item => item.SeriesName ? `${item.SeriesName}, ${item.Name}` : item.Name;
    const hasBackdrop = item => backdropSources(item).some(([, type]) => type === "Backdrop");
    const heroVisible = () => active && !library.hidden && !browse.hidden && !featured.hidden && movieUi.banner;
    let trailerTimer, trailerLoad, heroTrailer, trailerAttempt, lastHeroInput;
    const canPreviewHero = () => !preview && heroVisible() && heroSlide && !document.hidden && !quietMotion() &&
        !heroChoice && !featured.contains(document.activeElement);
    function resetHeroTrailer() {
        clearTimeout(trailerTimer);
        trailerTimer = undefined;
        trailerLoad?.abort();
        trailerLoad = undefined;
        if (heroTrailer?.tagName === "VIDEO") {
            heroTrailer.pause();
            heroTrailer.removeAttribute("src");
            heroTrailer.load();
        }
        heroTrailer?.remove();
        heroTrailer = undefined;
    }
    function scheduleHeroTrailer() {
        if (!canPreviewHero()) { resetHeroTrailer(); return; }
        if (trailerAttempt === heroSlide || trailerTimer || trailerLoad) return;
        trailerTimer = setTimeout(async () => {
            trailerTimer = undefined;
            if (!canPreviewHero()) return;
            const controller = trailerLoad = new AbortController(), {signal} = controller;
            const slide = heroSlide;
            const stillCurrent = () => !signal.aborted && heroSlide === slide && canPreviewHero();
            try {
                const network = await currentConnection();
                if (!stillCurrent() || network.saveData ||
                    network.kind !== "wifi" && (matchMedia("(pointer: coarse)").matches || /Mobile|Android/i.test(navigator.userAgent))) return;
                const title = seriesCardItem(heroPick);
                const pick = heroPick.Type === "Episode" ? tvShelf.items.find(row => row.Id === title.Id) ?? title : title;
                const found = await localTrailerFor(pick, signal);
                if (!stillCurrent()) return;
                trailerAttempt = slide;
                if (!found) return;
                const media = el("video");
                media.className = "movie-hero-trailer";
                media.tabIndex = -1;
                media.setAttribute("aria-hidden", "true");
                media.hidden = true;
                const finish = () => { if (heroTrailer === media) { resetHeroTrailer(); scheduleHero(); } };
                const failed = () => {
                    if (heroTrailer !== media) return;
                    note("trailer-unavailable", "", {reason: "request_failed"});
                    finish();
                };
                heroTrailer = media;
                slide.append(media);
                media.muted = media.defaultMuted = media.playsInline = true;
                media.addEventListener("playing", () => { if (stillCurrent()) media.hidden = false; }, {once: true, signal});
                media.addEventListener("ended", finish, {once: true, signal});
                media.addEventListener("error", failed, {once: true, signal});
                media.src = mediaUrl(`Videos/${found.Id}/stream.mp4`, {
                    static: false, videoCodec: "h264", audioCodec: "aac", maxWidth: 960, maxHeight: 540, videoBitRate: 1800000
                }).href;
                void media.play().catch(failed);
                trailerTimer = setTimeout(finish, 25000);
                scheduleHero();
            } catch (error) {
                if (stillCurrent()) noteLookupFailure("trailer-unavailable", error);
            } finally {
                if (trailerLoad === controller && !heroTrailer) trailerLoad = undefined;
            }
        }, 4000);
    }
    function heroActivity(event) {
        if (event?.type === "pointermove") {
            const at = `${event.clientX},${event.clientY}`;
            if (at === lastHeroInput) return;
            lastHeroInput = at;
        }
        if (!trailerTimer && !trailerLoad && !heroTrailer) return;
        resetHeroTrailer();
        scheduleHero();
    }

    function preloadHero(item) {
        const key = JSON.stringify([item.Id, backdropSources(item), innerWidth > 1920]);
        if (heroPreload?.key === key) return heroPreload;
        let settle;
        const ready = new Promise(resolve => { settle = resolve; });
        const art = movieBackdrop(item, settle);
        void ready.then(scheduleHero);
        return heroPreload = {key, art, ready};
    }

    function finishHeroFade() {
        if (heroFade) {
            heroFade.onfinish = null;
            heroFade.cancel();
        }
        outgoingSlide?.remove();
        heroFade = outgoingSlide = undefined;
    }

    function cancelHeroRotation() {
        if (!heroRotation) return;
        heroRotation.onfinish = null;
        heroRotation.cancel();
        heroRotation = undefined;
    }

    function scheduleHero() {
        scheduleHeroTrailer();
        const quiet = quietMotion();
        if (!heroVisible() || quiet) finishHeroFade();
        const fill = heroPager.querySelector('[aria-current="true"] .movie-hero-dot-fill');
        if (!active || quiet || heroItems.length < 2 || !fill?.animate) {
            cancelHeroRotation();
            return;
        }
        if (!heroRotation) {
            heroRotation = fill.animate([{transform: "scaleX(0)"}, {transform: "scaleX(1)"}],
                {duration: heroInterval, fill: "both"});
            heroRotation.currentTime = 0;
            heroRotation.onfinish = scheduleHero;
        }
        const paused = !heroVisible() || document.hidden || heroChoice || heroHovered || heroTrailer ||
            featured.contains(document.activeElement);
        if (paused) {
            if (heroRotation.playState === "running") {
                const elapsed = heroRotation.currentTime;
                heroRotation.pause();
                heroRotation.currentTime = elapsed;
            }
            return;
        }
        const index = heroItems.findIndex(item => titleKey(item) === titleKey(heroPick));
        const next = heroItems[(index + 1) % heroItems.length];
        const preload = preloadHero(next);
        if (heroRotation.playState === "paused") heroRotation.play();
        else if (heroRotation.playState === "finished" && !preload.art.hasAttribute("data-loading")) {
            heroPreload = undefined;
            renderHero(next, preload.art, true);
            scheduleHero();
        }
    }

    async function chooseHero(key) {
        const pick = heroItems.find(item => titleKey(item) === key);
        if (!pick) return;
        const choice = heroChoice = {};
        scheduleHero();
        if (key !== titleKey(heroPick)) {
            const preload = preloadHero(pick);
            if (!quietMotion()) await preload.ready;
            if (heroChoice !== choice) return;
            const item = heroItems.find(item => titleKey(item) === key);
            if (item && heroVisible() && !heroSlide.contains(document.activeElement) && preloadHero(item) === preload) {
                heroPreload = undefined;
                renderHero(item, preload.art, !quietMotion());
                heroStatus.textContent = heroName(item);
            }
        }
        heroChoice = undefined;
        cancelHeroRotation();
        scheduleHero();
    }

    const heroObserver = new MutationObserver(scheduleHero);
    for (const node of [library, browse]) heroObserver.observe(node, {attributes: true, attributeFilter: ["hidden"]});
    heroObserver.observe(document.body, {attributes: true, attributeFilter: ["data-effects"]});
    const reducedHeroMotion = matchMedia("(prefers-reduced-motion: reduce)");
    reducedHeroMotion.addEventListener?.("change", scheduleHero, {signal: life.signal});
    document.addEventListener("visibilitychange", scheduleHero, {signal: life.signal});
    for (const type of ["pointermove", "pointerdown", "keydown", "scroll"])
        document.addEventListener(type, heroActivity, {capture: true, passive: true, signal: life.signal});
    for (const type of ["pointerenter", "pointerleave"]) {
        featured.addEventListener(type, event => {
            if (event.pointerType === "touch") return;
            heroHovered = event.type === "pointerenter";
            scheduleHero();
        });
    }
    featured.addEventListener("focusin", scheduleHero);
    featured.addEventListener("focusout", () => queueMicrotask(() => {
        if (heroVisible() && heroItems.length && !heroItems.includes(heroPick) && !heroSlide.contains(document.activeElement)) renderHome();
        else scheduleHero();
    }));
    life.signal.addEventListener("abort", () => {
        heroObserver.disconnect();
        heroPreload = heroChoice = undefined;
        scheduleHero();
    });

    function backgroundFor(item) {
        const preferences = readMoviePreferences(preferenceViewer);
        if (preferences.backgroundStyle === "backdrop") return homeBackgrounds.slate;
        const genre = searchTitle(item.Genres?.[0] || "");
        const presets = {
            "science fiction": "violet", fantasy: "violet", adventure: "blue", mystery: "blue", crime: "blue", documentary: "green",
            animation: "green", comedy: "amber", western: "amber", action: "red", horror: "red", thriller: "red", romance: "red"
        };
        return homeBackgrounds[preferences.homeBackground ?? presets[genre] ?? "slate"];
    }

    function isFavorite(title) {
        return favoriteShelf.items.some(item => item.Id === title.Id) || title.UserData?.IsFavorite === true;
    }
    function markFavorite(button, saved) {
        button.setAttribute("aria-pressed", String(saved));
    }
    function favoriteAction(title, message, original = title) {
        const id = title.Id;
        const favorite = button("", async () => {
            if (savingFavorite) return;
            savingFavorite = true;
            favorite.setAttribute("aria-disabled", "true");
            message.textContent = "";
            const next = favorite.getAttribute("aria-pressed") !== "true";
            try {
                await request(`UserFavoriteItems/${encodeURIComponent(id)}`, {}, {favorite: next}, timeoutSignal(8000));
                if (!active) return;
                title.UserData = {...title.UserData, IsFavorite: next};
                if (original !== title) original.UserData = {...original.UserData, IsFavorite: next};
                for (const shelf of browseShelves) {
                    for (const item of shelf.items) {
                        if (item.Id === id) item.UserData = {...item.UserData, IsFavorite: next};
                    }
                }
                const key = titleKey(title);
                favoriteShelf.cards.delete(key);
                favoriteShelf.items = favoriteShelf.items.filter(item => item.Id !== id);
                if (next) {
                    const node = card(title, "favorites");
                    node.dataset.titleKey = key;
                    favoriteShelf.items.unshift(title);
                    favoriteShelf.cards.set(key, node);
                }
                favoriteShelf.loaded = true;
                for (const node of library.querySelectorAll(".movie-hero-favorite")) {
                    if (node.dataset.favoriteId === id) markFavorite(node, next);
                }
                renderHome();
            } catch {
                if (active) message.textContent = t("Could not update My list. Try again.");
            } finally {
                savingFavorite = false;
                favorite.removeAttribute("aria-disabled");
            }
        });
        favorite.className = "movie-hero-favorite";
        favorite.dataset.favoriteId = id;
        favorite.setAttribute("aria-label", t("My list: ") + title.Name);
        markFavorite(favorite, isFavorite(title));
        favorite.append(icon(heartPath));
        return favorite;
    }

    function renderHome() {
        placeBrowseCards();
        for (let view = seriesView; view; view = view.parent) view.syncContinue?.();
        const resume = resumeShelf.items.find(item => progressOf(item) > 0);
        const candidates = new Map();
        if (resume) candidates.set(titleKey(resume), resume);
        const sources = [recentShelf.items, favoriteShelf.items, genreShelves.flatMap(shelf => shelf.items)];
        const unlistedBackdrop = item => !candidates.has(titleKey(item)) && hasBackdrop(item);
        for (const items of sources) {
            const item = items.find(unlistedBackdrop);
            if (item) candidates.set(titleKey(item), item);
        }
        for (const item of sources.flat()) {
            if (candidates.size === 5) break;
            if (unlistedBackdrop(item)) candidates.set(titleKey(item), item);
        }
        const first = candidates.values().next().value ?? recentShelf.items[0] ?? moviesShelf.items[0] ?? tvShelf.items[0] ?? favoriteShelf.items[0];
        const pick = (heroPick && candidates.get(titleKey(heroPick))) ?? first;
        heroItems = !movieUi.banner ? [] : candidates.size ? [...candidates.values()] : first ? [first] : [];
        empty.hidden = !!pick || !!pendingCards.size || !!browseShelves.some(shelf => shelf.cards.size || shelf.failed) || !genreRetry.hidden;
        if (!pick || !movieUi.banner) {
            if (featured.contains(document.activeElement)) browse.focus({preventScroll: true});
            featured.hidden = true;
            heroSlide?.remove();
            heroSlide = heroPick = undefined;
        } else if (!heroSlide?.contains(document.activeElement) || pick.Id === heroPick?.Id) {
            renderHero(pick);
        }
        const dots = heroItems.length > 1 ? heroItems : [];
        const pagerKey = JSON.stringify(dots.map(item => [titleKey(item), heroName(item)]));
        if (heroPager.dataset.items !== pagerKey) {
            cancelHeroRotation();
            const focused = heroPager.contains(document.activeElement) ? document.activeElement.dataset.itemId : undefined;
            heroPager.dataset.items = pagerKey;
            heroPager.replaceChildren(...dots.map(item => {
                const key = titleKey(item);
                const dot = button("", () => void chooseHero(key));
                const track = el("span"), fill = el("span");
                track.className = "movie-hero-dot";
                track.setAttribute("aria-hidden", "true");
                fill.className = "movie-hero-dot-fill";
                track.append(fill);
                dot.append(track);
                dot.dataset.itemId = key;
                dot.setAttribute("aria-label", t("Show {0}", heroName(item)));
                return dot;
            }));
            heroPager.hidden = !dots.length;
            if (focused) ([...heroPager.children].find(dot => dot.dataset.itemId === focused) ??
                heroPager.firstElementChild ?? heroSlide?.querySelector(".movie-hero-actions button") ?? browse).focus({preventScroll: true});
        }
        updateHeroPager();
        scheduleHero();
    }

    function updateHeroPager() {
        const previous = heroPager.querySelector('[aria-current="true"]');
        const current = [...heroPager.children].find(dot => dot.dataset.itemId === titleKey(heroPick)) ?? null;
        if (previous === current) return;
        const outgoingFill = previous?.querySelector(".movie-hero-dot-fill");
        if (outgoingFill) outgoingFill.style.setProperty("--movie-dot-fill", getComputedStyle(outgoingFill).transform);
        cancelHeroRotation();
        previous?.removeAttribute("aria-current");
        current?.querySelector(".movie-hero-dot-fill").style.removeProperty("--movie-dot-fill");
        current?.setAttribute("aria-current", "true");
    }

    function renderHero(pick, art, crossfade = false) {
        const title = seriesCardItem(pick);
        const existingTitle = pick.Type === "Episode" ? tvShelf.items.find(item => item.Id === title.Id) : pick;
        const favoriteTitle = existingTitle ?? {...title, UserData: undefined};
        const saved = isFavorite(favoriteTitle);
        const background = backgroundFor(pick);
        const identity = JSON.stringify([pick, saved, background, readMoviePreferences(preferenceViewer).backgroundStyle, innerWidth > 1920,
            resumeShelf.items.some(entry => titleKey(entry) === titleKey(pick))]);
        heroPick = pick;
        if (featured.dataset.selection === identity && !featured.hidden) return;
        resetHeroTrailer();
        const focusClass = heroSlide?.contains(document.activeElement) ? document.activeElement.className : "";
        featured.dataset.selection = identity;
        art ??= movieBackdrop(pick);
        const slide = el("div"), body = el("div"), controls = el("div"), actions = el("div");
        slide.className = "movie-hero-slide";
        body.className = "movie-hero-body";
        controls.className = "movie-hero-controls";
        actions.className = "movie-hero-actions";
        slide.style.setProperty("--movie-hero-start", background[0]);
        slide.style.setProperty("--movie-hero-end", background[1]);
        const heading = el("h2");
        heading.id = "movie-featured-title";
        heading.className = "movie-hero-title";
        const logoItem = pick.ImageTags?.Logo ? pick : pick.ParentLogoImageTag ? {Id: pick.ParentLogoItemId, ImageTags: {Logo: pick.ParentLogoImageTag}} : title;
        setTitleLogo(logoItem.Id ? logoItem : title, heading, heroName(pick));
        featured.setAttribute("aria-labelledby", heading.id);
        const facts = titleFacts(pick, ratingBadge(pick.OfficialRating) ?? ratingBadge(existingTitle?.OfficialRating));
        const genres = (pick.Genres ?? []).slice(0, 3);
        if (genres.length) facts.append(el("span", genres.join(", ")));
        body.append(heading);
        if (facts.childElementCount) {
            const meta = el("div");
            meta.className = "movie-hero-meta";
            meta.append(facts);
            body.append(meta);
        }
        if (pick.Overview) {
            const overview = el("p", pick.Overview);
            overview.className = "movie-hero-overview";
            body.append(overview);
        }
        // A banner title from Continue watching gets the same three-dots menu as its card.
        const continuing = !preview && !pick.Demo && resumeShelf.items.some(entry => titleKey(entry) === titleKey(pick));
        let details, menu;
        if (continuing) {
            ({more: details, menu} = continueMenu(pick, heroName(pick), () => openSeries(title, details, pick.ParentIndexNumber)));
            details.className = "movie-hero-details movie-hero-more";
        } else {
            details = button("", () => openSeries(title, details, pick.ParentIndexNumber));
            details.className = "movie-hero-details";
            details.setAttribute("aria-label", pick.Type === "Series" && !preview ? t("Seasons") : t("Details"));
        }
        details.dataset.itemId = titleKey(pick);
        if (!continuing) details.append(icon(detailsPath));
        if (pick.Type !== "Series" && !preview) {
            const play = playAction(pick, true, true);
            play.setAttribute("aria-describedby", heading.id);
            play.prepend(icon(playPath));
            actions.append(play);
        }
        if (!preview) {
            if (pick.Type === "Series") actions.append(details);
            actions.append(favoriteAction(favoriteTitle, favoriteStatus));
        }
        if (preview || pick.Type !== "Series") actions.append(details);
        controls.append(actions);
        if (menu) controls.append(menu);
        body.append(controls);
        const watched = progressOf(pick);
        if (watched > 0 && watched < 100) {
            const track = el("span"), fill = el("span");
            track.className = "movie-progress movie-hero-progress";
            track.setAttribute("aria-hidden", "true");
            fill.style.width = watched + "%";
            track.append(fill);
            controls.append(track);
            const runtime = pick.RunTimeTicks;
            const position = pick.UserData?.PlaybackPositionTicks;
            const remaining = formatMinutes((position > 0 && position < runtime ? runtime - position : runtime * (1 - watched / 100)) / 6e8);
            if (remaining) {
                const time = el("p", t("{0} left", remaining));
                time.className = "movie-hero-time";
                controls.append(time);
            }
        }
        finishHeroFade();
        slide.append(art, body);
        if (crossfade && heroSlide && slide.animate) {
            outgoingSlide = heroSlide;
            outgoingSlide.querySelector(".movie-hero-title").removeAttribute("id");
            outgoingSlide.setAttribute("inert", "");
            outgoingSlide.setAttribute("aria-hidden", "true");
        } else heroSlide?.remove();
        heroSlide = slide;
        featured.prepend(slide);
        featured.hidden = false;
        updateHeroPager();
        if (outgoingSlide) {
            heroFade = slide.animate([{opacity: 0}, {opacity: 1}], {duration: 900, easing: "ease-in-out"});
            heroFade.onfinish = finishHeroFade;
        }
        if (focusClass) (Array.from(actions.children).find(node => node.className === focusClass) ?? details).focus({preventScroll: true});
    }
    async function loadGenres(bounded, quiet) {
        try {
            if (!genresLoaded) {
                const page = await request("Genres", {userId: session.user, includeItemTypes: titleTypes, sortBy: "SortName"}, undefined, bounded);
                if (!Array.isArray(page?.Items)) throw Error("Invalid genres");
                const watched = new Map();
                const watchedTitles = new Map([...moviesShelf.items, ...tvShelf.items, ...resumeShelf.items].map(item => [titleKey(item), item]));
                for (const item of watchedTitles.values()) {
                    const plays = isShortMovie(item.RunTimeTicks) ? 0 :
                        item.UserData?.PlayCount || Number(item.UserData?.Played || progressOf(item) > 0);
                    for (const genre of item.Genres ?? []) {
                        const key = searchTitle(genre);
                        watched.set(key, (watched.get(key) ?? 0) + plays);
                    }
                }
                const names = [...new Map(page.Items.filter(genre => genre.Name).map(({Name}) => [searchTitle(Name), Name])).values()]
                    .sort((a, b) => (watched.get(searchTitle(b)) ?? 0) - (watched.get(searchTitle(a)) ?? 0)).slice(0, 12);
                genreShelves = names.map(name => shelf(name, titleTypes, false, browse, "", life.signal, {
                    format: "genre", singlePage: true, params: {genres: name, fields},
                    accept: item => item.Genres?.some(value => searchTitle(value) === searchTitle(name))
                }));
                for (const shelf of genreShelves) genreRetry.before(shelf.section);
                genresLoaded = true;
                genreOutage.clear();
            }
            await Promise.all(genreShelves.map(shelf => shelf.load(true, quiet, bounded, true)));
        } catch {
            if (!quiet && active) genreOutage.show();
        }
    }
    async function refreshGenres() {
        await withinMovieLoad(signal => loadGenres(signal, false), life.signal);
        if (!active) return;
        renderHome();
    }
    const reloadResume = () => Promise.all([
        withinMovieLoad(signal => resumeShelf.load(true, true, signal, true), life.signal).then(() => { if (active) renderHome(); }),
        seriesView?.refreshProgress?.()
    ]);
    async function refreshHome(quiet = false) {
        if (loadingHome || !active) return;
        loadingHome = true;
        try {
            await withinMovieLoad(bounded => Promise.all([
                Promise.all([resumeShelf, favoriteShelf, recentShelf, tvShelf, moviesShelf, collectionsShelf]
                    .map(shelf => shelf.load(true, quiet, bounded, true))).then(async () => {
                        await loadGenres(bounded, quiet);
                        for (let page = 0; page < 3 && !bounded.aborted; page++) {
                            placeBrowseCards();
                            const missing = [tvShelf, moviesShelf].filter(shelf => shelf.section.hidden && !shelf.more.hidden);
                            if (!missing.length) break;
                            await Promise.all(missing.map(shelf => shelf.load(false, quiet, bounded, true)));
                        }
                    }),
                quiet ? undefined : updateDownloads(bounded),
                quiet ? seriesView?.refreshProgress?.() : undefined
            ]), life.signal, homeReady ? 9500 : homeBudget);
            if (!active) return;
            renderHome();
            if (!homeReady) {
                homeReady = true;
                skeleton.remove();
                browse.hidden = false;
                query.disabled = submit.disabled = false;
                homeStatus.textContent = "";
                if (!document.activeElement?.matches(".header-history[aria-disabled=true]") &&
                    (document.activeElement === entryFocus || document.activeElement === document.body || host.contains(document.activeElement)))
                    browse.focus({preventScroll: true});
                placeBrowseCards();
                try {
                    if (localStorage.getItem(uiKey(preferenceViewer) + ":open")) {
                        localStorage.removeItem(uiKey(preferenceViewer) + ":open");
                        openCustomise(customiseHome);
                    }
                } catch {}
            }
        } finally { loadingHome = false; }
    }
    const refreshOnFocus = () => { if (!document.hidden && !library.hidden && homeReady) void refreshHome(true); };
    window.addEventListener("focus", () => {
        queueVisibility();
        refreshOnFocus();
    }, {signal: life.signal});
    document.addEventListener("visibilitychange", refreshOnFocus, {signal: life.signal});
    // Customise Home: the banner, the order and visibility of rows, and the options for Continue watching and title pages.
    const customiseHome = button(t("Customise"), () => openCustomise(customiseHome));
    customiseHome.className = "movie-customise-home";
    customiseHome.setAttribute("aria-label", t("Customise Home"));
    customiseHome.prepend(icon("M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4"));
    const customiseBar = el("div");
    customiseBar.className = "movie-customise-bar";
    customiseBar.append(customiseHome);
    browse.append(customiseBar);
    let sheetRefresh, appliedCards;
    const rowSections = () => ({
        continue: [resumeShelf.section], list: [favoriteShelf.section], recent: [recentShelf.section],
        series: [tvShelf.section], movies: [moviesShelf.section], collections: [collectionsShelf.section],
        genres: genreShelves.map(shelf => shelf.section)
    });
    function rebuildResumeCards() {
        resumeShelf.cards.clear();
        for (const item of resumeShelf.items) {
            const node = card(item, "resume");
            node.dataset.titleKey = titleKey(item);
            resumeShelf.cards.set(titleKey(item), node);
        }
        placeBrowseCards();
    }
    // Order and visibility only move and mark the shelves. placeBrowseCards still decides which shelves have cards.
    function applyHomeLayout() {
        const focused = document.activeElement, sections = rowSections();
        browse.dataset.bannerOff = String(!movieUi.banner);
        const wanted = movieUi.rows.flatMap(row => sections[row.id]);
        let next = genreRetry;
        for (let index = wanted.length - 1; index >= 0; index--) {
            if (wanted[index].nextElementSibling !== next) browse.insertBefore(wanted[index], next);
            next = wanted[index];
        }
        for (const row of movieUi.rows) for (const section of sections[row.id]) section.dataset.rowHidden = String(!row.visible);
        const cards = movieUi.resumeStyle + movieUi.spoilerBlur;
        resumeShelf.section.dataset.resumeStyle = movieUi.resumeStyle;
        if (appliedCards !== undefined && appliedCards !== cards) rebuildResumeCards();
        appliedCards = cards;
        if (focused?.isConnected && document.activeElement !== focused) focused.focus({preventScroll: true});
    }
    uiChanged = () => {
        applyHomeLayout();
        if (homeReady) renderHome();
        sheetRefresh?.();
    };

    function switchRow(label, checked, change, hiddenLabel) {
        const row = el("label"), input = el("input"), track = el("span");
        row.className = "movie-toggle-row";
        input.type = "checkbox";
        input.setAttribute("role", "switch");
        input.checked = checked;
        if (hiddenLabel) input.setAttribute("aria-label", hiddenLabel);
        input.addEventListener("change", () => change(input.checked));
        track.className = "movie-toggle-track";
        track.setAttribute("aria-hidden", "true");
        row.append(...(label ? [el("span", label)] : []), input, track);
        return {row, input};
    }
    // A list the user can reorder by dragging the handle or with the Up and Down buttons. Focus follows the moved row's handle.
    function reorderList(label, getEntries, save, hint) {
        const list = el("ul");
        list.className = "movie-customise-rows";
        list.setAttribute("aria-label", label);
        // TV: Up and Down move between rows and keep the column (handle, arrows, switch); the first and last rows hand off to the sheet.
        list.addEventListener("keydown", event => {
            if (innerWidth < 1920 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
            const row = event.target.closest?.("li");
            const sibling = event.key === "ArrowUp" ? row?.previousElementSibling : row?.nextElementSibling;
            if (!row || !sibling) return;
            const controls = node => [...node.querySelectorAll("button, input")];
            const column = controls(row).indexOf(event.target);
            const targets = controls(sibling);
            const target = targets[column] && !targets[column].disabled ? targets[column] : targets[0];
            event.preventDefault();
            event.stopPropagation();
            target?.focus({preventScroll: true});
        });
        function render(focusId) {
            const entries = getEntries(), current = document.activeElement?.closest?.("li");
            const kept = list.contains(current) ? [current.dataset.rowId, [...current.querySelectorAll("button, input")].indexOf(document.activeElement)] : null;
            function move(id, step) {
                const index = entries.findIndex(entry => entry.id === id), target = index + step;
                if (target < 0 || target >= entries.length) return;
                const next = [...entries];
                next.splice(target, 0, next.splice(index, 1)[0]);
                save(next);
                render(id);
            }
            list.replaceChildren(...entries.map((entry, index) => {
                const item = el("li"), handle = button("", () => hint(t("Drag this handle, or use the Up and Down buttons."))), name = el("span", entry.name);
                const up = button("", () => move(entry.id, -1)), down = button("", () => move(entry.id, 1));
                item.dataset.rowId = entry.id;
                handle.className = "movie-drag-handle";
                handle.setAttribute("aria-label", t("Drag {0}", entry.name));
                handle.append(icon("M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"));
                up.className = down.className = "movie-row-move";
                up.setAttribute("aria-label", t("Move {0} up", entry.name));
                down.setAttribute("aria-label", t("Move {0} down", entry.name));
                up.append(icon("m6 15 6-6 6 6"));
                down.append(icon("m6 9 6 6 6-6"));
                up.disabled = index === 0;
                down.disabled = index === entries.length - 1;
                // Plain arrows move focus on TV, so they only move the row on smaller screens.
                handle.addEventListener("keydown", event => {
                    if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.ctrlKey || event.metaKey || event.shiftKey ||
                        innerWidth >= 1920 && !event.altKey) return;
                    event.preventDefault();
                    event.stopPropagation();
                    move(entry.id, event.key === "ArrowUp" ? -1 : 1);
                });
                handle.addEventListener("pointerdown", event => {
                    if (event.button > 0 || event.pointerType === "mouse" && event.buttons !== 1) return;
                    event.preventDefault();
                    const drag = new AbortController();
                    item.dataset.dragging = "";
                    document.addEventListener("pointermove", over => {
                        const before = [...list.children].filter(node => node !== item)
                            .find(node => over.clientY < node.getBoundingClientRect().top + node.offsetHeight / 2);
                        if ((before ?? null) !== item.nextElementSibling) list.insertBefore(item, before ?? null);
                    }, {signal: drag.signal});
                    const drop = () => {
                        drag.abort();
                        delete item.dataset.dragging;
                        const ids = [...list.children].map(node => node.dataset.rowId);
                        if (ids.join() !== entries.map(row => row.id).join())
                            save(ids.map(id => entries.find(row => row.id === id)));
                        render(entry.id);
                    };
                    document.addEventListener("pointerup", drop, {once: true, signal: drag.signal});
                    document.addEventListener("pointercancel", drop, {once: true, signal: drag.signal});
                });
                item.append(handle, name, up, down);
                if (entry.visible !== undefined) {
                    const {row} = switchRow("", entry.visible, visible => {
                        save(entries.map(other => other.id === entry.id ? {...other, visible} : other));
                        render();
                    }, t("Show {0}", entry.name));
                    row.className += " movie-row-toggle";
                    item.append(row);
                }
                return item;
            }));
            const find = id => [...list.children].find(node => node.dataset.rowId === id);
            if (focusId) find(focusId)?.querySelector(".movie-drag-handle").focus({preventScroll: true});
            else if (kept) {
                const controls = [...(find(kept[0])?.querySelectorAll("button, input") ?? [])];
                (controls[kept[1]]?.disabled === false ? controls[kept[1]] : controls[0])?.focus({preventScroll: true});
            }
        }
        render();
        return {list, render};
    }
    function openCustomise(opener) {
        const content = el("div"), head = el("header"), close = button(t("Close"), () => dialog.close());
        const notice = el("p"), noticeActions = el("div"), hint = text => { notice.textContent = text; };
        content.className = "movie-customise";
        notice.className = "movie-customise-notice";
        notice.setAttribute("role", "status");
        noticeActions.className = "movie-customise-actions";
        head.append(el("h2", t("Customise Home")), close);
        const section = (name, ...parts) => {
            const group = el("section"), heading = el("h3", name);
            group.append(heading, ...parts);
            return group;
        };
        const banner = switchRow(t("Show the banner"), movieUi.banner, checked => void saveUi({banner: checked}));
        const rows = reorderList(t("Home rows"), () => movieUi.rows.map(row => ({...row, name: t(homeRowNames[row.id])})),
            next => void saveUi({rows: next.map(({id, visible}) => ({id, visible}))}), hint);
        const choice = (name, key, options) => {
            const pick = select(name, options);
            pick.value = movieUi[key];
            pick.addEventListener("change", () => void saveUi({[key]: pick.value}));
            return pick;
        };
        const style = choice(t("Card style"), "resumeStyle", [["landscape", t("Landscape stills")], ["poster", t("Posters")]]);
        const press = choice(t("When pressed"), "resumePress", [["resume", t("Resume")], ["title", t("Open the title page")]]);
        const prompt = switchRow(t("Resume prompt"), movieUi.resumePrompt, checked => void saveUi({resumePrompt: checked}));
        const spoilers = switchRow(t("Blur unwatched episode stills"), movieUi.spoilerBlur, checked => void saveUi({spoilerBlur: checked}));
        const sections = reorderList(t("Title page sections"), () => movieUi.titleSections.map(id => ({id, name: t(titleSectionNames[id])})),
            next => void saveUi({titleSections: next.map(entry => entry.id)}), hint);
        const background = choice(t("Title page background"), "titleBackground", [["backdrop", t("Backdrop")], ["blurred", t("Blurred")], ["plain", t("Plain")]]);
        const oled = switchRow(t("OLED black"), movieUi.oled, checked => void saveUi({oled: checked}));
        const reset = button(t("Reset to default"), () => {
            void saveUi(Object.fromEntries(["banner", "rows", "resumeStyle", "resumePress", "resumePrompt", "spoilerBlur",
                "titleSections", "titleBackground", "oled"].map(key => [key, null])));
            hint(t("Home is back to the default layout."));
            reset.focus({preventScroll: true});
        });
        reset.className = "movie-customise-reset";
        content.append(head,
            banner.row,
            section(t("Home rows"), rows.list),
            section(t("Continue watching"), ...[style, press].map(pick => pick.parentElement), prompt.row, spoilers.row),
            section(t("Title pages"), sections.list, background.parentElement),
            section(t("Appearance"), oled.row),
            notice, noticeActions, reset);
        let shownNotice = false;
        const refreshNotice = () => {
            const hadFocus = noticeActions.contains(document.activeElement);
            if (uiNotice || shownNotice) notice.textContent = uiNotice?.text ?? "";
            shownNotice = Boolean(uiNotice);
            noticeActions.replaceChildren(...(uiNotice?.actions ?? []).map(([label, run]) => button(label, run)));
            if (hadFocus) (noticeActions.firstElementChild ?? reset).focus({preventScroll: true});
        };
        sheetRefresh = () => {
            banner.input.checked = movieUi.banner;
            style.value = movieUi.resumeStyle;
            press.value = movieUi.resumePress;
            prompt.input.checked = movieUi.resumePrompt;
            spoilers.input.checked = movieUi.spoilerBlur;
            background.value = movieUi.titleBackground;
            oled.input.checked = movieUi.oled;
            rows.render();
            sections.render();
        };
        uiNoticeChanged = refreshNotice;
        const dialog = movieDialog(host, opener, t("Customise Home"), life.signal,
            {content, initialFocus: banner.input, className: "movie-audio-dialog movie-customise-dialog"});
        refreshNotice();
        // A bottom sheet closes with a downward swipe from the top of its content.
        let swipeFrom = null;
        dialog.addEventListener("touchstart", event => {
            swipeFrom = dialog.scrollTop <= 0 && !event.target.closest(".movie-drag-handle, select") ? event.touches[0].clientY : null;
        }, {passive: true});
        dialog.addEventListener("touchend", event => {
            if (swipeFrom !== null && event.changedTouches[0].clientY - swipeFrom > 90) dialog.close();
            swipeFrom = null;
        }, {passive: true});
        // On TV the arrow keys move between controls: up and down by row, left and right within a row.
        dialog.addEventListener("keydown", event => {
            const step = {ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0]}[event.key];
            if (!step || innerWidth < 1920 || event.defaultPrevented || event.altKey || event.target.matches("select")) return;
            const controls = [...dialog.querySelectorAll("button:not(:disabled), input, select")];
            const lines = [];
            for (const control of controls) {
                const top = Math.round(control.getBoundingClientRect().top / 8);
                const line = lines.find(entry => Math.abs(entry.top - top) <= 1) ?? lines[lines.push({top, controls: []}) - 1];
                line.controls.push(control);
            }
            const at = lines.findIndex(line => line.controls.includes(event.target));
            if (at < 0) return;
            const column = lines[at].controls.indexOf(event.target);
            const target = step[1] ? lines[at + step[1]]?.controls[Math.min(column, lines[at + step[1]].controls.length - 1)]
                : lines[at].controls[column + step[0]];
            if (!target) return;
            event.preventDefault();
            target.focus({preventScroll: false});
        });
        dialog.addEventListener("close", () => { sheetRefresh = undefined; uiNoticeChanged = () => {}; }, {once: true});
        return dialog;
    }
    applyHomeLayout();
    void readServerUi().then(saved => { if (saved && active) adoptUi(saved); });
    const homeLoad = refreshHome();
    const largeBackdrop = matchMedia("(min-width: 1921px)");
    largeBackdrop.addEventListener?.("change", renderHome, {signal: life.signal});
    // A page key moves to the same position on the next page. Side buttons keep their own focus.
    library.addEventListener("keydown", event => {
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        const page = {PageUp: -5, PageDown: 5}[event.key];
        const details = event.target.closest?.(".movie-continue-menu-button");
        const tile = event.target.closest?.(".movie-resume-card");
        const current = details ? tile.querySelector(".movie-card") : event.target;
        const navigate = ".movie-card, .movie-hero-actions button, .movie-hero-actions a, .movie-download-toggle, .movie-cast-action[data-person-id], .movie-person-page button, .movie-person-page a, .movie-customise-home";
        if ((!arrows && !page) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const catalogue = seriesView?.section ?? (browse.hidden ? results : browse);
        if (!current.matches?.(navigate)) {
            if (innerWidth >= 1920 && arrows?.[1] && current.matches?.(".movie-series h2[tabindex='-1']")) {
                const target = arrows[1] < 0 ? catalogue.querySelector(".movie-title-back") :
                    [...catalogue.querySelectorAll(navigate)].find(node => !node.matches(".movie-title-back") && !node.closest("[hidden], [inert]"));
                if (target) { event.preventDefault(); target.focus(); }
            }
            return;
        }
        if (tile && (details ? arrows?.[1] === 1 : arrows?.[1] === -1)) {
            event.preventDefault();
            (details ? current : tile.querySelector(".movie-continue-menu-button")).focus({preventScroll: true});
            return;
        }
        const groups = [...catalogue.querySelectorAll(".movie-hero:not([hidden]) .movie-hero-slide:not([inert]) .movie-hero-actions, .movie-title-actions, .movie-shelf:not([hidden]):not([data-row-hidden=true]) .movie-cards, .movie-cast ul, .movie-person-films ul")]
            .flatMap(group => {
                const nodes = [...group.querySelectorAll(navigate)].filter(node => !node.closest("[hidden], [inert]"));
                if (innerWidth < 1920 || !group.matches(".movie-cast ul, .movie-person-films ul")) return nodes.length ? [nodes] : [];
                const rows = new Map();
                for (const node of nodes) {
                    const y = node.closest("li").offsetTop;
                    if (!rows.has(y)) rows.set(y, []);
                    rows.get(y).push(node);
                }
                return [...rows.values()];
            });
        if (catalogue.matches(".movie-person-page")) {
            groups.unshift([...catalogue.querySelectorAll(":scope > button, .movie-person-body > button:not([hidden])")]);
        }
        if (catalogue === browse) groups.push([customiseHome]);
        if (!downloadTray.hidden) groups.push([downloadToggle]);
        const index = groups.findIndex(group => group.includes(current));
        if (index < 0) return;
        let target;
        if (page || arrows[0]) {
            const group = groups[index], position = group.indexOf(current) + (page || arrows[0]);
            target = group[page ? Math.min(group.length - 1, Math.max(0, position)) : position];
            if (page) event.preventDefault();
        }
        else {
            const x = current.getBoundingClientRect().left;
            const next = groups[index + arrows[1]];
            target = next?.reduce((best, node) =>
                Math.abs(node.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? node : best);
        }
        if (!target) return;
        event.preventDefault();
        if (target.matches(".movie-card"))
            target.closest(".movie-shelf-lane")?.revealCard?.(target.closest(".movie-resume-card") ?? target);
        target.focus({ preventScroll: true });
        if (arrows?.[1] && target !== downloadToggle)
            (target.closest(".movie-shelf-lane") ?? target).scrollIntoView({block: "nearest"});
    });
    return { connectionChanged, async restoreNavigation(value, keepFocus = false) {
        resumeRequest?.abort();
        await homeLoad;
        if (!active || preview) return;
        const route = value ? JSON.parse(value) : {};
        if (playerItem && playerItem.Id !== route.player?.Id) await closePlayback(keepFocus, true);
        if (!active) return;
        const linked = seriesView?.section.querySelectorAll('.movie-shelf:is([data-format="related"], [data-format="person"]) .movie-card');
        const relatedOpener = [...(linked ?? [])].find(node => node.dataset.itemId === route.detail?.Id);
        const personKey = personKeyOf(route.detail);
        const personOpener = route.detail?.Type === "Person" && [...(seriesView?.section.querySelectorAll("[data-person-id]") ?? [])]
            .find(node => node.dataset.personId === personKey && !node.closest("[hidden]"));
        const isCurrentDetail = seriesView && (route.detail?.Type === "Person"
            ? seriesView.item.Type === "Person" && personKeyOf(seriesView.item) === personKey
            : route.detail && seriesView.item.Type !== "Person" && seriesView.item.Id === route.detail.Id);
        let ancestor = seriesView?.parent;
        while (ancestor && (route.detail?.Type === "Person"
            ? ancestor.item.Type !== "Person" || personKeyOf(ancestor.item) !== personKey
            : !route.detail || ancestor.item.Type === "Person" || ancestor.item.Id !== route.detail.Id)) ancestor = ancestor.parent;
        if (personOpener && !ancestor && !isCurrentDetail)
            openPerson(route.detail, personOpener, true, keepFocus);
        else if (relatedOpener && !ancestor && !isCurrentDetail)
            openSeries(route.detail, relatedOpener, route.season, true, keepFocus);
        else if (seriesView && !isCurrentDetail) {
            while (seriesView && seriesView !== ancestor) closeSeries(undefined, true, keepFocus);
        }
        if (route.detail && !seriesView) {
            const opener = [...library.querySelectorAll("[data-item-id]")].find(node =>
                node.dataset.itemId === route.detail.Id && !node.closest("[hidden]")) ?? browse;
            if (route.detail.Type === "Person") openPerson(route.detail, opener, true, keepFocus);
            else openSeries(route.detail, opener, route.season, true, keepFocus);
        }
        if (route.player && !playerItem) {
            const opener = seriesView?.section.querySelector(".movie-hero-play:not([hidden])") ??
                seriesView?.section.querySelector("h2") ?? browse;
            void play(route.player, opener, {fromHistory: true});
        }
    }, async close() {
        if (!active) return;
        active = false;
        resumeRequest?.abort();
        const leaving = leavePlayer();
        life.abort();
        const playback = current;
        stop();
        await leaving;
        if (playback) await playback.sampleUsage();
        await reports;
        if (!preview) try { await app.invokeMethodAsync("MovieCloseMedia", session.media_ticket); } catch {}
    } };
}
