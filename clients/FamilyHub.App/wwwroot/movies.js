import { buildPlayerUi, watchPlayerIdle } from "./movie-player-ui.js";
import { addAudioDialog, audioJobResults, audioJobRunning, audioLanguage as audioLanguageName } from "./movie-audio-ui.js";
import { movieAudioSync } from "./movie-audio-sync.js";
import { ageRatingBadge, appendSoundChip, buildReleaseSearch, cleanResultTitle, formatMinutes, librarySound, releaseSound, videoQualityTier } from "./movie-releases.js";
import { createServiceStatus } from "./service-status.js";

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

function movieLoading(kind) {
    const block = (className = "") => loadingShape("movie-loading-block " + className);
    const repeated = (count, make) => Array.from({length: count}, make);
    let parts;
    if (kind === "home") {
        const hero = loadingShape("movie-hero", loadingShape("movie-hero-body",
            block("movie-loading-heading"), block("movie-loading-line"), block("movie-loading-action")));
        const cards = format => loadingShape(`movie-shelf movie-loading-${format}`, block("movie-loading-label"),
            loadingShape("movie-shelf-scroll", loadingShape("movie-cards", ...repeated(6, () =>
                loadingShape("movie-loading-card", block("movie-art"), loadingShape("movie-caption", block("movie-loading-line")))))));
        parts = [hero, cards("landscape"), cards("portrait")];
    } else if (kind === "seasons") {
        parts = [loadingShape("movie-season-picker", loadingShape("movie-season-pills",
            ...repeated(3, () => block("movie-loading-pill"))))];
    } else {
        const list = el("ol");
        list.append(...repeated(3, () => {
            const row = el("li");
            row.append(loadingShape("movie-episode-body", block("movie-episode-still"),
                loadingShape("movie-episode-text", block("movie-loading-line"), block("movie-loading-label"))));
            return row;
        }));
        parts = [loadingShape("movie-season", loadingShape("movie-season-header",
            block("movie-loading-label"), block("movie-loading-action")), list)];
    }
    const node = loadingShape(kind === "home" ? "movie-loading movie-home-skeleton" : "movie-loading", ...parts);
    node.setAttribute("aria-hidden", "true");
    return node;
}

export function showMovieLoading(host, show = true) {
    if (show) {
        const status = el("p", "Loading movies and TV…");
        status.className = "movie-visually-hidden";
        status.setAttribute("role", "status");
        host.replaceChildren(loadingShape("movie-session-loading", status, movieLoading("home")));
    } else host.querySelector(":scope > .movie-session-loading")?.remove();
}

function searchTitle(text) {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

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

function normalizeMoviePreferences(prefs) {
    return {
        audio: ["hu", "en"].includes(prefs?.audio) ? prefs.audio : "default",
        subtitles: ["off", "hu", "en"].includes(prefs?.subtitles) ? prefs.subtitles : "default",
        dataSaver: dataChoices.includes(prefs?.dataSaver) ? prefs.dataSaver : "auto",
        screen: screenChoices.includes(prefs?.screen) ? prefs.screen : "auto",
        ...(["preset", "backdrop"].includes(prefs?.backgroundStyle) ? {backgroundStyle: prefs.backgroundStyle} : {}),
        ...(prefs?.layoutPreview === true ? {layoutPreview: true} : {}),
        ...(Object.prototype.hasOwnProperty.call(homeBackgrounds, prefs?.homeBackground) ? {homeBackground: prefs.homeBackground} : {})
    };
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
    const previewItems = preview ? moviePreviewLibrary() : [];
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
        if (activeSignal.aborted) throw new DOMException("Movie request cancelled", "AbortError");
        if (preview) {
            if (body || !["Items", "UserItems/Resume", "Genres"].includes(path)) throw Error("Unavailable in layout preview");
            const group = previewItems.find(item => item.Id === params.parentId)?.ChildIds;
            const items = path === "Genres" ? [...new Set(previewItems.flatMap(item => item.Genres))].map(Name => ({Name})) :
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
            abort = () => reject(new DOMException("Movie request cancelled", "AbortError"));
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
        const key = kind + ":" + method + ":" + (diagnostics?.forced ?? "");
        if (!active || performance.now() - (lastNote.get(key) ?? -6e4) < 6e4) return;
        lastNote.set(key, performance.now());
        send(kind, method, "", null, diagnostics);
    };
    const status = el("p");
    status.setAttribute("role", "status");
    status.className = "movie-load-status";
    const relatedFailure = "Related films are unavailable";
    const player = el("section"), library = el("div");
    player.className = "movie-player";
    player.tabIndex = -1;
    player.setAttribute("aria-label", "Movie player");
    const preferenceViewer = viewer ?? [base.origin, session.user];
    const connection = navigator.connection;
    let connectionRevision = 0, autoHintShown = false;
    async function qualityFor(choice) {
        if (choice !== "auto") return choice;
        const native = await app.invokeMethodAsync("MovieConnectionKind").catch(() => null);
        if (native === "cellular" || native === "wifi") return native === "cellular" ? "saver" : "full";
        return connection?.type === "cellular" || connection?.saveData ? "saver" : "full";
    }
    function connectionChanged() {
        connectionRevision++;
        return current?.refreshQuality();
    }
    connection?.addEventListener?.("change", connectionChanged, { signal: life.signal });
    host.replaceChildren(status, player, library);
    const call = async (method, ...args) => {
        if (preview) throw Error("Unavailable in layout preview");
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
    const heartPath = "M20.8 5.6a4.8 4.8 0 0 0-6.8 0l-2 2-2-2a4.8 4.8 0 0 0-6.8 6.8L12 21l8.8-8.6a4.8 4.8 0 0 0 0-6.8Z";
    const quietMotion = () => document.body.dataset.effects === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    dismissNotice.setAttribute("aria-label", "Dismiss playback notice");
    dismissNotice.title = "Dismiss playback notice";
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
        const data = { ItemId: playback.item.Id, MediaSourceId: playback.source.Id,
            PlaySessionId: playback.id, PositionTicks: Math.round(media.currentTime * 1e7),
            IsPaused: media.paused, CanSeek: media.seekable.length > 0, PlayMethod: playback.method };
        const pending = reports.then(() => request("Sessions/Playing" + action, {}, data, null))
            .catch(() => { if (active) { status.textContent = "Watch progress could not be saved."; note("progress-save-failed", playback.method); } })
            .finally(() => {
                if (pendingReportsByItem.get(data.ItemId) === pending) pendingReportsByItem.delete(data.ItemId);
            });
        pendingReportsByItem.set(data.ItemId, pending);
        reports = pending;
    }
    // Episodes of a series, fetched once per series for the Episodes sheet and Next Episode.
    async function localEpisodes(id, signal, season) {
        const items = [];
        let startIndex = 0, page;
        do {
            page = await request(`Shows/${encodeURIComponent(id)}/Episodes`, {
                userId: session.user, enableUserData: true, isMissing: false, startIndex, limit: 100,
                fields: "MediaStreams",
                ...(season == null ? {} : {season})
            }, undefined, signal);
            if (!Array.isArray(page?.Items)) throw Error("Invalid episodes");
            items.push(...page.Items.filter(item => !item.IsMissing && item.LocationType !== "Virtual"));
            startIndex += page.Items.length;
        } while (page.Items.length && startIndex < page.TotalRecordCount);
        return items;
    }
    function seriesEpisodes(item) {
        return withinMovieLoad(signal => localEpisodes(item.SeriesId, signal), life.signal).catch(() => null);
    }
    // The Android WebView relies on the full-window layout and MovieScreen for landscape and system bars.
    const nativeFullscreen = host.dataset.nativeFullscreen === "true";
    let fullscreenRequest = null;
    let windowFullscreen = false, leavingPlayer = false;
    const isFullscreen = () => nativeFullscreen ? windowFullscreen :
        (document.fullscreenElement ?? document.webkitFullscreenElement) === player;
    if (nativeFullscreen) window.addEventListener("chrome-refresh", event => {
        if (typeof event.detail !== "boolean" || windowFullscreen === event.detail) return;
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
    let playerItem, playerOpener;
    async function closePlayback(keepFocus = false, fromHistory = false) {
        if (!playerItem) return;
        const opener = playerOpener;
        playerItem = playerOpener = undefined;
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
            send("stopped", current.method, current.item.Name, Math.floor(video.currentTime / 60));
        }
        const hls = current?.hls;
        current = null;
        hls?.destroy();
        if (video) { video.pause(); video.removeAttribute("src"); video.load(); video = null; }
        playerLife?.abort();
        playerLife = null;
        player.replaceChildren();
    }
    async function play(item, opener, options = {}) {
        if (!active || preview || item.Demo) return;
        clearPlaybackNotice();
        const previous = playerItem;
        playerItem = item;
        playerOpener = opener;
        if (!options.fromHistory && previous?.Id !== item.Id) publishNavigation(previous ? "replace" : "open");
        const { audioIndex, position, paused, sourceId, burnedSubtitle } = options;
        const forceTranscode = options.forceTranscode || burnedSubtitle != null;
        if (player.contains(document.activeElement)) player.focus({ preventScroll: true });
        stop();
        const rev = selection;
        const prefs = readMoviePreferences(preferenceViewer);
        prefs.dataSaver = options.dataSaver ?? prefs.dataSaver;
        const opening = "Opening " + item.Name + "…";
        if (player.classList.contains("movie-expanded")) {
            status.textContent = "";
            const loading = el("p", opening);
            loading.className = "movie-ui-message movie-ui-line";
            loading.setAttribute("role", "status");
            player.append(loading);
            playerLife = new AbortController();
            watchPlayerIdle(player, playerLife.signal);
        } else status.textContent = opening;
        const media = el("video");
        // Chromium-based players (Android WebView, Windows WebView2, Chrome, Edge) answer "maybe" for HLS, but their
        // built-in HLS player rejects our transcodes (media error 4 on every transcoded film: owner phone and Windows,
        // 26 Nov). Wherever Media Source exists on a Chromium engine, hls.js does the work; Safari and iOS keep native HLS.
        const chromiumEngine = /\b(?:Chrome|Chromium|Edg|EdgA|OPR)\//.test(navigator.userAgent);
        const nativeHls = !!media.canPlayType("application/vnd.apple.mpegurl") &&
            !(globalThis.MediaSource && chromiumEngine);
        let failure = "The server did not return playback information.";
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
            const quality = await qualityFor(prefs.dataSaver);
            if (!active || rev !== selection) return;
            const limit = dataLimits[quality];
            const configuredScreen = movieScreen(prefs.screen);
            const maxHeight = Math.min(configuredScreen.height, limit?.height ?? Infinity);
            const Hls = nativeHls ? null : globalThis.Hls;
            const hls = nativeHls || Hls?.isSupported();
            const profile = { Name: "FamilyHub web video",
                DirectPlayProfiles: [{ Type: "Video", Container: "mp4,m4v", VideoCodec: "h264", AudioCodec: "aac,mp3" }],
                TranscodingProfiles: [{ Type: "Video", Context: "Streaming", Protocol: hls ? "hls" : "http",
                    Container: hls ? "ts" : "mp4", VideoCodec: "h264", AudioCodec: "aac" }],
                SubtitleProfiles: [{ Format: "vtt", Method: "External" }, ...(burnedSubtitle == null ? [] :
                    ["dvdsub", "dvd_subtitle", "pgs", "pgssub", "hdmv_pgs_subtitle"].map(Format => ({ Format, Method: "Encode" })))] };
            const condition = (Property, Value) => ({ Condition: "LessThanEqual", Property, Value: String(Value), IsRequired: true });
            profile.CodecProfiles = [{ Type: "Video", Codec: "h264",
                Conditions: [condition("Height", maxHeight), condition("Width", configuredScreen.width)] }];
            if (limit) {
                profile.MaxStreamingBitrate = limit.bitrate;
                if (limit.audioBitrate) {
                    profile.TranscodingProfiles[0].MaxAudioChannels = "2";
                    profile.TranscodingProfiles[0].EnableAudioVbrEncoding = false;
                    profile.CodecProfiles.push({ Type: "VideoAudio", Codec: "aac",
                        Conditions: [condition("AudioBitrate", limit.audioBitrate), condition("AudioChannels", 2)] });
                }
            }
            const playbackInfo = (sourceId, index, signal) => request("Items/" + item.Id + "/PlaybackInfo", {userId: session.user}, {
                UserId: session.user, DeviceProfile: profile,
                ...(sourceId ? {MediaSourceId: sourceId, SubtitleStreamIndex: burnedSubtitle ?? -1} : {}),
                ...(index != null ? {AudioStreamIndex: index} : {}),
                ...(limit ? { MaxStreamingBitrate: limit.bitrate } : {}),
                ...(limit || forceTranscode ? { AllowVideoStreamCopy: false, AllowAudioStreamCopy: false } : {}),
                ...(limit?.audioBitrate ? { MaxAudioChannels: 2 } : {}),
                EnableDirectPlay: !forceTranscode && !limit && index == null, EnableDirectStream: !forceTranscode && !limit,
                EnableTranscoding: true }, signal);
            const readResume = async () => {
                await pendingReportsByItem.get(item.Id);
                if (active && rev === selection)
                    return withinMovieLoad(signal => request("Items/" + item.Id, {userId: session.user}, undefined, signal), life.signal)
                        .catch(() => item);
            };
            const [resultInfo, freshItem] = await Promise.all([
                withinMovieLoad(signal => playbackInfo(sourceId, forceTranscode ? audioIndex : undefined, signal), life.signal),
                position == null ? readResume() : null
            ]);
            if (!active || rev !== selection) return;
            let result = resultInfo;
            const resume = position ?? (freshItem?.UserData?.PlaybackPositionTicks ?? item.UserData?.PlaybackPositionTicks ?? 0) / 1e7;
            if (result) failure = result.ErrorCode === "NoCompatibleStream" ? "The server found no compatible stream." :
                "The server did not provide a playable version.";
            let source = result?.MediaSources?.[0];
            if (!source) throw Error();
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
            const preferredAudio = preferredTrack(audio, audioLanguage === "default" ? "en" : audioLanguage);
            const defaultAudio = audio.find(track => track.Index === source.DefaultAudioStreamIndex)?.Index ??
                audio.find(track => track.IsDefault)?.Index ?? audio[0]?.Index;
            const defaultSubtitle = source.DefaultSubtitleStreamIndex;
            const requestedAudio = audioIndex ?? preferredAudio?.Index ?? original?.Index ?? internalAudio[0]?.Index ?? audio[0]?.Index;
            selectedAudio = forceTranscode ? audioIndex ?? defaultAudio : defaultAudio;
            let direct = !forceTranscode && !limit && source.SupportsDirectPlay;
            // A static stream leaves audio selection to the browser. Ask Jellyfin to select the track on multi-audio files.
            const customAudio = audio[0]?.IsExternal || audio.length > 1 &&
                (audioLanguage !== "default" || audioIndex != null || requestedAudio !== defaultAudio || requestedAudio !== audio[0]?.Index ||
                    audio.some(track => track.IsDefault && track.Index !== requestedAudio))
                ? requestedAudio : undefined;
            const selectedTrack = audio.find(track => track.Index === (requestedAudio ?? defaultAudio));
            if (!forceTranscode && externalDts(selectedTrack))
                return play(item, opener, {...options, audioIndex: selectedTrack.Index, sourceId: source.Id, forceTranscode: true, position: resume});
            if ((!forceTranscode && customAudio != null) || (!sourceId && !direct && defaultSubtitle >= 0)) {
                const playback = await withinMovieLoad(signal => playbackInfo(source.Id, customAudio, signal), life.signal).catch(() => null);
                if (!active || rev !== selection) return;
                const configured = playback?.MediaSources?.[0];
                if (configured?.TranscodingUrl || (!forceTranscode && !limit && configured?.SupportsDirectPlay && customAudio == null)) {
                    selectedAudio = customAudio ?? configured.DefaultAudioStreamIndex ?? defaultAudio;
                    direct = !forceTranscode && !limit && configured.SupportsDirectPlay && customAudio == null;
                    result = playback;
                    source = configured;
                } else if (customAudio != null || !direct && defaultSubtitle >= 0) {
                    if (forceTranscode) throw Error();
                    return play(item, opener, {...options, audioIndex: requestedAudio ?? defaultAudio, sourceId: source.Id, forceTranscode: true, position: resume});
                }
            }
            method = direct ? "DirectPlay" : forceTranscode || limit || source.TranscodeReasons?.length ? "Transcode" : "DirectStream";
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
            if (!direct && !hls && resume > 0) {
                await leavePlayer();
                if (!active || rev !== selection) return;
                note("cannot-resume");
                library.hidden = false;
                toolbar.hidden = !!seriesView;
                opener?.focus();
                showPlaybackNotice("This device cannot resume this video. Continue on another device.", opener);
                stop();
                playerItem = playerOpener = undefined;
                publishNavigation("back");
                return;
            }
            const back = button("Back to movies", () => closePlayback());
            const subtitleUrl = track => mediaUrl(`Videos/${item.Id}/${source.Id}/Subtitles/${track.Index}/Stream.vtt`);
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
            const audioPick = select("Audio track", []);
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
                const option = new Option(language === "original" ? "Original" : labels[language], track.Index);
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
            const subtitlePick = select("Subtitle track", [[-1, "Off"]]);
            const notice = el("p");
            notice.setAttribute("role", "status");
            media.controls = false; media.playsInline = true; media.preload = "metadata";
            media.className = "movie-video";
            media.crossOrigin = "anonymous";
            media.referrerPolicy = "no-referrer";
            media.setAttribute("aria-label", item.Name);
            const textTracks = new Map();
            function addSubtitleTrack(s) {
                const track = el("track"); track.kind = "subtitles"; track.label = s.DisplayTitle || s.Language || "Subtitles";
                track.srclang = s.Language || "und";
                track.src = subtitleUrl(s);
                media.append(track);
                textTracks.set(s.Index, track.track);
            }
            function populateSubtitles() {
                subtitlePick.replaceChildren(new Option("Off", -1));
                for (const track of subtitles) {
                    const option = new Option(labels[trackLanguage(track)], track.Index);
                    option.dataset.language = trackLanguage(track);
                    subtitlePick.add(option);
                    if (textSubtitle(track) && !textTracks.has(track.Index)) addSubtitleTrack(track);
                }
            }
            populateSubtitles();
            const playback = { item, source, id: result.PlaySessionId, dataSaver: prefs.dataSaver, method };
            playback.setSubtitles = (index) => {
                playback.subtitleOverride = index;
                const selected = index ?? initialSubtitle;
                const activeSubtitle = burnedSubtitle === selected || textTracks.has(selected) ? selected : -1;
                for (const [trackIndex, track] of textTracks)
                    track.mode = trackIndex === activeSubtitle ? "hidden" : "disabled"; // hidden: the player draws the cues itself
                subtitlePick.value = String(activeSubtitle);
                const audioFallback = audioIndex == null && audioLanguage !== "default" && (!preferredAudio || preferredAudio.Index !== selectedAudio);
                notice.textContent = [
                    audioFallback ? `${labels[audioLanguage]} audio unavailable. Using the default track.` : "",
                    audioIndex != null && audioIndex !== selectedAudio ? "Selected audio track unavailable. Using the default track." : ""
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
                    send("started", playback.method, item.Name, Math.floor(media.currentTime / 60));
                    app.invokeMethodAsync("MovieStarted").catch(() => {});
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
                if (playback.next) play(playback.next, opener);
            };
            let ui, recovering = false;
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
                const reason = code === 2 || type === "networkError" ? "The video stream stopped responding." :
                    code === 3 || code === 4 || type === "mediaError" ? "The video stream could not be decoded." :
                    "The server stream could not start.";
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
            const audioSync = audio.some(track => track.Index === selectedAudio && track.IsExternal) ?
                movieAudioSync(media, {signal: playerSignal, stream: stream.href,
                    Hls: playback.hls ? Hls : null, report: message => ui?.say(message),
                    useAudioElement: element => ui?.useAudioElement(element),
                    key: preferencesKey(preferenceViewer) + ":sync:" + item.Id}) : null;
            const subtitleItem = /^[a-f\d]{32}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(source.Id) ? source.Id : item.Id;
            const subtitlePath = `Items/${encodeURIComponent(subtitleItem)}`;
            const remote = subtitlePath + "/RemoteSearch/Subtitles/";
            const subtitleSearch = {
                message(error) {
                    return error instanceof SubtitleSearchError ? error.message : "Could not search for subtitles. Try again.";
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
                            throw new SubtitleSearchError("The server did not respond to the subtitle request. Try again.");
                        }
                        if (playerSignal.aborted) return;
                        if (saved?.error === "Subtitle provider is not set up")
                            throw new SubtitleSearchError(saved.error + ". Ask an admin to configure the OpenSubtitles API key.");
                        if (typeof saved?.error === "string" && saved.error)
                            throw new SubtitleSearchError(saved.error);
                        if (saved?.added !== true)
                            throw new SubtitleSearchError("The server did not respond to the subtitle request. Try again.");
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
                            const textTrack = textTracks.get(stream.Index);
                            if (!textTrack) continue;
                            textTrack.mode = "disabled";
                            [...media.querySelectorAll("track")].find(node => node.track === textTrack)?.remove();
                            textTracks.delete(stream.Index);
                        }
                        subtitles.splice(0, subtitles.length, ...ranked);
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
                        throw new SubtitleSearchError("Subtitles were saved. Jellyfin could not refresh this title. Retry or ask an admin to check the library.");
                    if (saved) throw new SubtitleSearchError("Subtitles were saved. Give the library a moment, then retry or reopen the video.");
                    throw Error("Subtitle track unavailable");
                }
            };
            let searchingSubtitles = false;
            subtitleSearch.run = async (language, automatic = false) => {
                if (!languageCodes[language] || searchingSubtitles || playerSignal.aborted || preferredTrack(subtitles, language)) return;
                const subtitleCode = language === "hu" ? "hun" : "eng";
                const name = labels[language];
                searchingSubtitles = true;
                ui.subtitleStatus(`Searching for ${name} subtitles`, language);
                let best;
                try {
                    const found = await subtitleSearch.find(subtitleCode, automatic);
                    if (playerSignal.aborted) return;
                    if (found) {
                        best = found.sort((a, b) => (b.DownloadCount ?? 0) - (a.DownloadCount ?? 0) ||
                            (b.CommunityRating ?? 0) - (a.CommunityRating ?? 0))[0];
                        await subtitleSearch.add(best, subtitleCode, automatic);
                    }
                    if (!playerSignal.aborted) ui.subtitleStatus("Found");
                } catch (error) {
                    if (!playerSignal.aborted) ui.subtitleStatus(best
                        ? "Could not add subtitles. Try again or ask an admin to check subtitle permissions and storage."
                        : subtitleSearch.message(error));
                } finally {
                    searchingSubtitles = false;
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
                if (playback.dataSaver !== "auto") return;
                const change = ++qualityChange;
                const nextQuality = await qualityFor("auto");
                if (current === playback && change === qualityChange && playback.dataSaver === "auto" && nextQuality !== quality)
                    return play(item, opener, {
                        dataSaver: "auto", sheet: ui.openSheetName(), audioIndex, subtitleIndex: playback.subtitleOverride, burnedSubtitle,
                        position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                        forceTranscode: options.forceTranscode, sourceId: forceTranscode ? source.Id : undefined
                    });
            };
            ui = buildPlayerUi({ media, surface: player, back, signal: playerSignal, subtitleSearch, itemId: item.Id,
                fullscreenEnabled: nativeFullscreen || document.fullscreenEnabled || document.webkitFullscreenEnabled, isFullscreen, setFullscreen,
                title: numbered ? `S${item.ParentIndexNumber}:E${item.IndexNumber} “${item.Name}”` : item.Name,
                kicker: item.SeriesName, audioPick, subtitlePick, audioSync, notice, burnedSubtitle, originalLanguage,
                findAudio: (opener, language) => addAudio(item, opener, player, playerSignal, language) });
            playback.showJobToast = ui.hint;
            player.replaceChildren(media, ui.root);
            enterPlayer();
            playback.setSubtitles(options.subtitleIndex);
            ui.syncSubtitles();
            autoSubtitles();
            if (item.Type === "Episode" && item.SeriesId) {
                seriesEpisodes(item).then(list => {
                    if (current !== playback || !list) return;
                    const season = item.ParentIndexNumber == null ? list :
                        list.filter(episode => episode.ParentIndexNumber === item.ParentIndexNumber);
                    ui.setEpisodes(season, item.Id, next => play(next, opener));
                    const index = list.findIndex(episode => episode.Id === item.Id);
                    const after = index < 0 ? undefined : list[index + 1];
                    playback.next = after;
                    ui.setNext(after, next => play(next, opener));
                });
            }
            ui.playButton.focus();
            ui.reopenSheet(options.sheet, options.focusSubtitle);
            library.hidden = true;
            toolbar.hidden = true;
            if (quality === "saver" && prefs.dataSaver === "auto" && !autoHintShown) {
                autoHintShown = true;
                const key = preferencesKey(preferenceViewer) + ":data-saver-hint";
                let seen = false;
                try { seen = !!localStorage.getItem(key); localStorage.setItem(key, "1"); } catch {}
                if (!seen) ui.hint("Switched to Saver on mobile data.");
            }
            status.textContent = "";
            const startMedia = () => {
                if (paused || current !== playback || recovering) return;
                media.play().catch(error => {
                    if (current !== playback || recovering) return;
                    if (error?.name === "NotSupportedError") failed("mediaError");
                    else if (!media.error) ui.say("Press play to start.");
                });
            };
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
            if (active && rev === selection) {
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
        }
    }
    function progressOf(item) {
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
    const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;
    const tmdbAttribution = "This product uses the TMDB API but is not endorsed or certified by TMDB.";
    const chip = text => {
        const node = el("span", text);
        node.className = "movie-chip";
        return node;
    };
    const titleKey = item => item.SeriesId || item.Id;
    const playedAt = item => Date.parse(item.UserData?.LastPlayedDate) || 0;
    function seriesCardItem(item) {
        if (!item.SeriesId || !item.SeriesName) return item;
        return { ...item, Id: item.SeriesId, Name: item.SeriesName, Type: "Series", SeriesName: undefined,
            ProviderIds: undefined, MediaStreams: undefined, MediaSources: undefined,
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
        if (status.textContent === relatedFailure) status.textContent = "";
        const { section, opener, controller, fromResults, scrollTop, parent } = seriesView;
        seriesView = parent;
        controller.abort();
        if (parent) {
            parent.section.hidden = false;
            if (!keepFocus) opener.focus({preventScroll: true});
            section.remove();
            scrollHost.scrollTop = scrollTop;
            if (!fromHistory) publishNavigation("back");
            return;
        }
        browse.hidden = fromResults;
        results.hidden = false;
        toolbar.hidden = false;
        const destination = fromResults ? results : browse;
        destination.classList.add("movie-screen-entry");
        let target = focus || opener;
        if (!keepFocus) {
            if (!focus && (!opener.isConnected || opener.closest("[hidden], [inert]"))) {
                const candidates = [...destination.querySelectorAll(".movie-card, .movie-hero-details")]
                    .filter(node => node.dataset.itemId === opener.dataset.itemId && !node.closest("[hidden], [inert]"));
                const openerIsCard = opener.matches(".movie-card");
                target = candidates.find(node => node.matches(".movie-card") === openerIsCard) ??
                    candidates[0] ?? (fromResults ? submit : browse);
            }
            target.focus({preventScroll: true});
        }
        section.remove();
        scrollHost.scrollTop = scrollTop;
        if (!keepFocus && !focus && target !== opener && target.matches(".movie-card"))
            target.scrollIntoView({block: "nearest", inline: "nearest"});
        if (!fromHistory) publishNavigation("back");
    }
    function openSeries(item, opener, preferredSeason, fromHistory = false, keepFocus = false) {
        const original = item;
        item = {...item};
        const section = el("section"), heading = el("h2", item.Name), summary = el("p"), list = el("div");
        const credit = el("p", "Season data from TMDB. " + tmdbAttribution);
        const back = button("", () => closeSeries());
        back.className = "movie-title-back";
        back.setAttribute("aria-label", "Back to titles");
        back.title = "Back to titles";
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
        credit.className = "movie-matches-credit";
        credit.hidden = true;
        const header = el("header"), intro = el("div"), actions = el("div");
        const overview = el("p", item.Overview), facts = el("div"), detailStatus = el("p");
        overview.hidden = !item.Overview;
        facts.className = "movie-title-facts";
        detailStatus.className = "movie-favorite-status";
        detailStatus.setAttribute("role", "status");
        header.className = "movie-series-header";
        intro.className = "movie-title-intro";
        actions.className = "movie-title-actions movie-hero-actions";
        const text = el("div");
        text.className = "movie-title-text";
        text.append(heading);
        if (isSeries) text.append(actions, overview, facts);
        else text.append(facts, actions, overview);
        text.append(detailStatus);
        intro.append(cardArtwork(item), text);
        if (isSeries) {
            const columns = el("div"), info = el("div"), episodesColumn = el("div");
            columns.className = "movie-show-columns";
            info.className = "movie-show-info";
            episodesColumn.className = "movie-show-episodes";
            info.append(intro);
            episodesColumn.append(summary, list, credit);
            columns.append(info, episodesColumn);
            header.append(back);
            section.append(header, columns);
        } else {
            header.append(back, intro);
            section.append(header, list, credit);
        }
        let updateDescription;
        if (!isSeries && !isCollection) {
            const dialog = el("dialog"), full = el("p"), title = el("h3", "Description");
            dialog.className = "movie-description-dialog";
            title.id = heading.id + "-description";
            dialog.setAttribute("aria-labelledby", title.id);
            const close = button("Close", () => dialog.close());
            const read = button("Read full description", () => {
                full.textContent = overview.textContent;
                dialog.showModal();
            });
            read.className = "movie-description-more";
            read.hidden = true;
            overview.classList.add("movie-film-overview");
            overview.after(read);
            dialog.append(title, full, close);
            section.append(dialog);
            updateDescription = () => {
                if (dialog.open) return;
                const clipped = overview.scrollHeight > overview.clientHeight;
                if (!clipped && document.activeElement === read) heading.focus({preventScroll: true});
                read.hidden = !clipped;
            };
            dialog.addEventListener("close", updateDescription, {signal});
            if (globalThis.ResizeObserver) {
                const resize = new ResizeObserver(updateDescription);
                resize.observe(overview);
                signal.addEventListener("abort", () => resize.disconnect(), {once: true});
            } else window.addEventListener("resize", updateDescription, {signal});
        }
        section.addEventListener("keydown", event => {
            if (event.key === "Escape" && !event.target.closest("dialog, select")) { event.stopPropagation(); closeSeries(); }
        });
        seriesView = { item, historySeason: preferredSeason, section, opener, controller, fromResults, parent, scrollTop: scrollHost.scrollTop };
        if (!fromHistory) publishNavigation("open");
        status.textContent = "";
        catalogue.append(section);
        if (!keepFocus) heading.focus({preventScroll: true});
        if (parent) parent.section.hidden = true;
        browse.classList.remove("movie-screen-entry");
        results.classList.remove("movie-screen-entry");
        toolbar.hidden = true;
        browse.hidden = results.hidden = true;
        if (isCollection) section.scrollIntoView({block: "start"});
        else scrollHost.scrollTop = 0;

        if (isCollection) {
            shelf("Titles", "Movie,Series", false, list, "", signal, {params: {parentId: item.Id}});
            return;
        }
        const demo = preview || item.Demo;
        const playButton = playAction(isSeries ? null : item);
        const favorite = demo ? null : favoriteAction(item, detailStatus, original);
        playButton.prepend(icon(playPath));
        if (favorite) actions.append(playButton, favorite);
        if (!demo && !isSeries && session.downloads_enabled) credit.before(audioJobSlot(item));
        let backdrop, backdropKey;
        const updateBackdrop = () => {
            const key = JSON.stringify([backdropSources(item), innerWidth > 1920]);
            if (key === backdropKey) return;
            backdropKey = key;
            const art = movieBackdrop(item);
            if (backdrop) backdrop.replaceWith(art); else section.prepend(art);
            backdrop = art;
        };
        const cast = el("div");
        intro.after(cast);
        function updateDetails() {
            const background = backgroundFor(item);
            section.style.setProperty("--movie-hero-start", background[0]);
            section.style.setProperty("--movie-hero-end", background[1]);
            updateBackdrop();
            if (!isSeries) setTitleLogo(item, heading);
            overview.textContent = item.Overview ?? "";
            overview.hidden = !item.Overview;
            updateDescription?.();
            if (isSeries) facts.replaceChildren(...[...(item.Genres ?? []).slice(0, 3).map(chip), titleRating(item)].filter(Boolean));
            else renderFilmFacts(item, facts);
            renderCast(item, cast);
        }
        updateDetails();
        largeBackdrop.addEventListener?.("change", updateBackdrop, {signal});
        const details = demo ? Promise.resolve() : searchLibrary("Items", {
            userId: session.user, ids: item.Id, includeItemTypes: item.Type, recursive: true, limit: 1,
            fields: "Overview,Genres,ProviderIds,People" + (isSeries ? "" : ",MediaStreams"),
            enableUserData: true, enableImages: true, enableImageTypes: "Primary,Thumb,Backdrop,Logo", imageTypeLimit: 1
        }, undefined, signal).catch(() => null).then(reply => {
            const detail = Array.isArray(reply?.Items) && reply.Items.find(candidate => candidate.Id === item.Id);
            if (signal.aborted || !detail) return;
            const posterChanged = detail.ImageTags?.Primary && detail.ImageTags.Primary !== item.ImageTags?.Primary;
            Object.assign(item, {...detail, UserData: {...detail.UserData, ...item.UserData}});
            if (posterChanged) intro.firstElementChild.replaceWith(cardArtwork(item));
            if (!isSeries) playButton.setMovie(item);
            markFavorite(favorite, isFavorite(item));
            updateDetails();
        });
        if (!isSeries) {
            if (!demo) {
                const relatedTitle = "More like this";
                const related = el("section"), relatedHeader = el("div"), relatedHeading = el("h2", relatedTitle);
                const action = button("", () => {
                    action.focus({preventScroll: true});
                    void retry();
                });
                action.className = "movie-title-retry";
                action.title = relatedFailure + ". Retry";
                action.setAttribute("aria-label", action.title);
                action.append(icon("M20 7v5h-5M4 17v-5h5m-5 0a8 8 0 0 1 14-5l2 5m0 0a8 8 0 0 1-14 5l-2-5"));
                action.hidden = related.hidden = true;
                related.className = "movie-shelf";
                related.dataset.format = "related";
                relatedHeader.className = "movie-related-header";
                relatedHeader.append(relatedHeading, action);
                related.append(relatedHeader);
                list.append(related);
                let loaded = false;
                action.addEventListener("blur", () => {
                    if (!loaded) return;
                    action.hidden = true;
                    related.hidden = !related.querySelector(".movie-shelf-lane");
                });
                const retry = async () => {
                    if (loaded || action.getAttribute("aria-disabled") === "true") return;
                    action.setAttribute("aria-disabled", "true");
                    try {
                        const found = await loadRelated(item, related, relatedTitle, signal);
                        if (signal.aborted) return;
                        loaded = true;
                        if (status.textContent === relatedFailure) status.textContent = "";
                        action.hidden = document.activeElement !== action;
                        related.hidden = !found && action.hidden;
                    } catch {
                        if (signal.aborted) return;
                        related.hidden = action.hidden = false;
                        if (status.textContent !== relatedFailure) status.textContent = relatedFailure;
                    } finally {
                        action.setAttribute("aria-disabled", String(loaded));
                    }
                };
                void details.then(retry, retry);
            }
            return;
        }
        if (demo) return;

        const seasons = el("div"), lane = el("div"), pills = new Map();
        seasons.className = "movie-season-picker";
        seasons.hidden = true;
        lane.className = "movie-season-pills";
        lane.setAttribute("role", "group");
        lane.setAttribute("aria-label", "Seasons");
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
            arrow.setAttribute("aria-label", direction < 0 ? "Previous seasons" : "Next seasons");
            arrow.append(icon(direction < 0 ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"));
            return arrow;
        });
        seasons.append(arrows[0], lane, arrows[1]);
        list.before(seasons);
        const available = new Map(), pictures = new Map();
        let episodes = null, metadata = null, tmdbId, revision = 0, busy = false, selectedSeason;
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
            const season = available.get(number);
            const owned = season?.episodes.length ? season.episodes : episodes ?? [];
            const next = owned.find(episode => progressOf(episode) > 0 && !episode.UserData?.Played) ??
                owned.find(episode => !episode.UserData?.Played) ?? owned[0];
            if (!next && document.activeElement === playButton) seasonFocus().focus({preventScroll: true});
            playButton.setMovie(next);
        }
        const libraryOutage = createServiceStatus({
            detail: "Reconnect to check your library for episodes.", label: "Retry library check",
            retry: () => load(false), focus: seasonFocus, automatic: true
        });
        const metadataOutage = createServiceStatus({
            detail: "Reconnect to load the full season list.", label: "Retry season lookup",
            retry: () => load(false), focus: seasonFocus, automatic: true
        });
        const episodeOutage = createServiceStatus({
            detail: "Reconnect to load episode details.", label: "Retry episode data",
            retry: () => choose(selectedSeason), focus: seasonFocus, automatic: true
        });
        list.after(libraryOutage.card, metadataOutage.card, episodeOutage.card);
        const seasonLoading = movieLoading("seasons");
        seasonLoading.hidden = true;
        seasons.after(seasonLoading);
        const local = bounded => localEpisodes(item.Id, bounded);
        const tmdb = async bounded => {
            if (!item.ProviderIds?.Tmdb) await details;
            const id = item.ProviderIds?.Tmdb;
            const year = String(item.ProductionYear ?? "");
            const prefix = "tmdb:tv:title:" + (/^\d{4}$/.test(year) ? year : "") + ":";
            const term = /^[1-9]\d{0,9}$/.test(String(id)) ? "tmdb:tv:" + id : prefix + item.Name.slice(0, 120 - prefix.length);
            return boundedCall(bounded, "MovieMatches", term);
        };
        async function loadSeason(number, bounded) {
            if (number == null || !tmdbId || pictures.has(number) || !available.has(number)) return;
            const reply = await boundedCall(bounded, "MovieSeasonEpisodes", tmdbId, number).catch(() => null);
            if (!bounded.aborted && Array.isArray(reply?.episodes)) pictures.set(number, reply.episodes);
        }
        function renderSeason(number) {
            const season = available.get(number);
            const focus = document.activeElement;
            const focused = list.contains(focus);
            const key = focused && focus.dataset.episodeId;
            const nodes = season ? [seasonRow(item, number, season, episodes !== null, pictures.get(number), signal)] : [];
            if (!episodes) libraryOutage.show(); else libraryOutage.clear();
            if (episodes && !metadata) metadataOutage.show(); else metadataOutage.clear();
            if (episodes && metadata && season && tmdbId && !pictures.has(number)) episodeOutage.show();
            else episodeOutage.clear();
            if (focused) seasonFocus().focus({preventScroll: true});
            list.replaceChildren(...nodes);
            if (focused) {
                const same = key ? [...list.querySelectorAll("[data-episode-id]")].find(node =>
                    node.dataset.episodeId === key && node.hasAttribute("data-episode-audio") === focus.hasAttribute("data-episode-audio")) : null;
                (same ?? seasonFocus()).focus({preventScroll: true});
            }
        }
        async function choose(number) {
            if (!pills.has(number)) return;
            selectSeason(number);
            const change = ++revision;
            list.setAttribute("aria-busy", "true");
            const waiting = !pictures.has(number) && tmdbId;
            if (waiting) {
                if (list.contains(document.activeElement)) seasonFocus().focus({preventScroll: true});
                list.replaceChildren(movieLoading("episodes"));
                summary.textContent = "Loading episodes…";
                await withinMovieLoad(bounded => loadSeason(number, bounded), signal);
            }
            if (signal.aborted || change !== revision) return;
            renderSeason(number);
            list.hidden = false;
            summarize();
            list.removeAttribute("aria-busy");
        }
        function summarize() {
            const count = metadata?.length ?? [...available.keys()].filter(number => number > 0).length;
            const total = metadata ? plural(count, "season") : count ? plural(count, "season") + " in your library" : "";
            summary.textContent = total || (episodes && metadata && !available.size ? "No seasons available." : "");
        }
        async function load(quiet) {
            if (busy || signal.aborted) return;
            busy = true;
            let episodeLoading;
            if (!quiet) {
                summary.textContent = "Loading seasons…";
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
                        local(bounded).catch(() => null),
                        metadata ? null : tmdb(bounded).catch(() => null)
                    ]);
                    if (signal.aborted) return;
                    const changed = localItems && JSON.stringify(localItems) !== JSON.stringify(episodes);
                    if (localItems) episodes = localItems;
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
                    if (signal.aborted || change !== revision) return;
                    const removedFocus = lane.contains(document.activeElement) && !numbers.some(n => pills.get(n) === document.activeElement);
                    if (removedFocus) heading.focus({preventScroll: true});
                    for (const [n, pill] of pills) {
                        if (available.has(n)) continue;
                        pill.remove();
                        pills.delete(n);
                    }
                    let next = seasonOutline.nextElementSibling;
                    for (const n of numbers) {
                        if (!pills.has(n)) pills.set(n, button(n ? `Season ${n}` : "Specials", () => {
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
                    credit.hidden = !metadata;
                    renderSeason(first);
                    summarize();
                }, signal);
            } finally {
                busy = false;
                seasonLoading.hidden = true;
                episodeLoading?.remove();
                list.removeAttribute("aria-busy");
            }
        }
        seriesView.refreshProgress = () => load(true);
        void load(false);
    }
    function playAction(item) {
        const action = button("", () => { if (item) void play(item, action); });
        const label = el("span");
        action.append(label);
        action.setMovie = movie => {
            item = movie;
            action.hidden = !movie;
            label.textContent = movie && progressOf(movie) > 0 && !movie.UserData?.Played ? "Resume" : "Play";
        };
        action.setMovie(item);
        action.className = "movie-hero-play";
        return action;
    }
    const streamsOf = item => (item.MediaStreams?.length ? item.MediaStreams : item.MediaSources?.[0]?.MediaStreams) ?? [];
    const videoOf = item => streamsOf(item).find(stream => stream.Type === "Video");
    function libraryQuality(item) {
        const video = videoOf(item);
        const height = video?.Width >= 7680 ? Math.max(video.Height || 0, 4320) :
            video?.Width >= 3840 ? Math.max(video.Height || 0, 2160) : video?.Height;
        if (!(height > 0)) return null;
        const badge = chip(height >= 4320 ? "8K" : height >= 2160 ? "4K" : height + "p");
        badge.classList.add("movie-release-quality");
        badge.dataset.level = videoQualityTier(height);
        return badge;
    }
    function titleFacts(item, rating) {
        const runtime = formatMinutes(item.RunTimeTicks / 6e8);
        return [item.ProductionYear && chip(item.ProductionYear), rating, runtime && chip(runtime), libraryQuality(item)].filter(Boolean);
    }
    function renderFilmFacts(item, facts) {
        facts.replaceChildren(...titleFacts(item, titleRating(item)));
        appendSoundChip(facts, librarySound(streamsOf(item)), icon);
    }
    function titleRating(item) {
        return ageRatingBadge(item.OfficialRating) ??
            (Number.isFinite(item.CommunityRating) && item.CommunityRating > 0 ? chip(item.CommunityRating.toFixed(1)) : null);
    }
    function setTitleLogo(item, heading, name = item.Name) {
        const tag = item.ImageTags?.Logo;
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
        chainImages(logo, [imageSource(item.Id, "Logo", tag, 640)]);
        heading.append(logo);
    }
    function renderCast(item, target) {
        const actors = (item.People ?? []).filter(person => person.Type === "Actor" && person.Name?.trim())
            .slice(0, item.Type === "Series" ? 12 : 6);
        target.classList.toggle("movie-cast", Boolean(actors.length));
        if (!actors.length) { target.replaceChildren(); return; }
        const heading = el("h3", "Cast"), names = el("ul");
        for (const actor of actors) {
            const row = el("li"), portrait = el("span");
            row.tabIndex = 0;
            portrait.className = "movie-cast-portrait";
            portrait.setAttribute("aria-hidden", "true");
            portrait.style.setProperty("--art-hue", titleHue(actor.Name));
            const initials = actor.Name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join("").toUpperCase();
            portrait.append(el("span", initials));
            if (actor.Id && actor.PrimaryImageTag) {
                const photo = el("img");
                photo.alt = "";
                photo.loading = "lazy";
                photo.referrerPolicy = "no-referrer";
                chainImages(photo, [imageSource(actor.Id, "Primary", actor.PrimaryImageTag, 200)]);
                portrait.append(photo);
            }
            row.append(portrait, el("strong", actor.Name));
            if (actor.Role) row.append(el("span", actor.Role));
            names.append(row);
        }
        target.replaceChildren(heading, names);
    }
    async function loadRelated(item, section, title, signal) {
        const id = String(item.ProviderIds?.Tmdb ?? item.ProviderIds?.TMDb ?? "");
        if (!/^[1-9]\d{0,9}$/.test(id) || signal.aborted) return;
        const reply = await boundedCall(signal, "MovieRelated", id);
        if (!Array.isArray(reply?.matches)) throw Error("Invalid related films");
        const libraryMatches = Array.isArray(reply.library_matches) ? reply.library_matches : [];
        const matches = [...libraryMatches, ...reply.matches];
        if (!matches.length || signal.aborted) return;
        const owned = new Map(), matchedTitle = new Map();
        const index = movie => {
            if (movie.Type !== "Movie" || movie.Id === item.Id || movie.IsMissing || movie.LocationType === "Virtual") return;
            const providerId = String(movie.ProviderIds?.Tmdb ?? movie.ProviderIds?.TMDb ?? "");
            if (providerId) owned.set(providerId, movie);
            else if (movie.ProductionYear)
                matchedTitle.set(searchTitle(movie.Name) + ":" + movie.ProductionYear, movie);
        };
        for (const shelf of browseShelves) shelf.items.forEach(index);
        if (matches.some(match => !owned.has(String(match.id)))) {
            await withinMovieLoad(async bounded => {
                let startIndex = 0, page;
                do {
                    page = await request("Items", {userId: session.user, recursive: true, includeItemTypes: "Movie",
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
                Name: match.title, Id: "tmdb-" + match.id, Type: "Movie", ProductionYear: match.year
            }, "related", () => {
                query.value = match.title.slice(0, query.maxLength).trimEnd();
                startSearch(true);
            });
            if (!local) chainImages(pick.querySelector("img"), [match.backdrop, match.poster].filter(Boolean));
            rows.append(pick);
        }
        if (!rows.childElementCount) return;
        const {lane, update} = shelfLane(rows, title, signal);
        const credit = el("p", "Film data from TMDB. " + tmdbAttribution);
        credit.className = "movie-matches-credit";
        section.append(lane, credit);
        section.hidden = false;
        update();
        return true;
    }
    function audioAction(item, signal) {
        const action = button("", event => addAudio(item, event.currentTarget, library, signal));
        action.className = "movie-episode-audio";
        action.title = "Add audio track for " + item.Name;
        action.setAttribute("aria-label", action.title);
        action.setAttribute("aria-haspopup", "dialog");
        action.append(icon("M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"));
        return action;
    }
    function seasonRow(item, number, {episodes, total}, libraryKnown, catalogueEpisodes, signal) {
        const row = el("section"), header = el("div"), counts = el("div"), items = el("ol");
        const state = el("span", episodes.length ? "Available" : libraryKnown ? "Missing" : "Library check failed");
        row.className = "movie-season";
        row.dataset.season = number;
        row.dataset.seriesKey = searchTitle(item.Name);
        header.className = "movie-season-header";
        counts.className = "movie-season-counts";
        state.className = "movie-season-state";
        state.dataset.state = episodes.length ? "available" : libraryKnown ? "missing" : "unknown";
        header.append(state, counts);
        row.append(header, items);
        if (Number.isInteger(total) || episodes.length)
            counts.append(chip(total > episodes.length && episodes.length ? `${episodes.length} of ${total} episodes` :
                plural(Math.max(total ?? 0, episodes.length), "episode")));
        if (episodes.length) {
            episodes.sort((a, b) => (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
            const watched = episodes.filter(episode => episode.UserData?.Played).length;
            counts.append(chip(`${watched} of ${episodes.length} watched`));
        } else if (libraryKnown) {
            header.append(button("Find season " + number, () => {
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
        rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const {index, episode, details} of rows) {
            const entry = el("li"), frame = el("span"), content = el("span");
            const action = episode ? button("", () => play(episode, action)) : el("div");
            action.className = "movie-episode-body";
            entry.dataset.episode = index ?? "";
            frame.className = "movie-episode-still";
            frame.setAttribute("aria-hidden", "true");
            const image = el("img"), tag = episode?.ImageTags?.Primary ?? episode?.ImageTags?.Thumb;
            const localStill = tag && url(`Items/${encodeURIComponent(episode.Id)}/Images/${episode.ImageTags.Primary ? "Primary" : "Thumb"}`,
                {tag, maxWidth: 400}).href;
            image.alt = "";
            image.loading = "lazy";
            image.decoding = "async";
            chainImages(image, [localStill, details?.still].filter(Boolean));
            frame.append(image);
            const name = [details?.name, episode?.Name].find(value => value?.trim() && !/^(?:\d+\.\s*)?episode\s*\d*$/i.test(value.trim())) ??
                (index == null ? "Episode" : `Episode ${index}`);
            content.className = "movie-episode-text";
            const title = el("strong");
            if (index != null && name !== `Episode ${index}`) {
                const prefix = el("span", index + ". ");
                prefix.className = "movie-episode-number";
                title.append(prefix);
            }
            title.append(name);
            content.append(title);
            const runtime = formatMinutes(episode?.RunTimeTicks / 6e8 || details?.runtime);
            const quality = episode && libraryQuality(episode);
            if (runtime || quality) {
                const facts = el("span");
                facts.className = "movie-episode-facts";
                if (runtime) facts.append(runtime);
                if (quality) facts.append(quality);
                content.append(facts);
            }
            action.append(frame, content);
            if (episode) {
                action.dataset.episodeId = episode.Id;
                const played = episode.UserData?.Played, percent = played ? 100 : Math.max(0, Math.min(100, progressOf(episode)));
                const progress = el("progress");
                progress.max = 100;
                progress.value = percent;
                progress.setAttribute("aria-label", `Episode ${index ?? name} watched`);
                content.append(progress);
                if (played || percent > 0) content.append(el("span", played ? "Watched" : percent + "% watched"));
            } else if (libraryKnown) {
                const marker = el("span", "Not in library");
                marker.className = "movie-episode-marker";
                content.append(marker);
            }
            entry.append(action);
            if (episode && session.downloads_enabled) {
                const audio = audioAction(episode, signal);
                audio.dataset.episodeId = episode.Id;
                audio.dataset.episodeAudio = "";
                entry.append(audio, audioJobSlot(episode));
            }
            items.append(entry);
        }
        updateSeasonState(row);
        return row;
    }
    /** Marks a season missing, downloading (with progress) or available from the server's download list. */
    function updateSeasonState(row) {
        const state = row.querySelector(".movie-season-state");
        if (!state || state.dataset.state === "available") return;
        const number = Number(row.dataset.season), key = row.dataset.seriesKey;
        const found = downloadItems.find(entry => {
            if (typeof entry?.name !== "string" || entry.state === "Finished" || !(entry.progress < 1)) return false;
            const name = searchTitle(entry.name);
            if (name !== key && !name.startsWith(key + " ")) return false;
            const wanted = /(?:^|[^a-z0-9])s(\d{1,3})(?:e\d+)?(?![a-z0-9])|season[ ._-]*(\d{1,3})(?!\d)/.exec(entry.name.toLowerCase());
            return wanted && Number(wanted[1] ?? wanted[2]) === number;
        });
        const find = row.querySelector(".movie-season-header > button:not(.movie-hero-play)");
        if (found) {
            const percent = Math.round(Math.max(0, Math.min(1, Number(found.progress) || 0)) * 100);
            const eta = found.eta != null && ["Downloading", "Almost done"].includes(found.state)
                ? `, about ${Math.max(1, Math.ceil(found.eta / 60))} min left` : "";
            state.dataset.state = "downloading";
            const label = `Downloading ${percent}%${eta}`;
            if (state.textContent !== label) state.textContent = label;
            if (find === document.activeElement) {
                state.tabIndex = -1;
                state.focus({preventScroll: true});
            }
            if (find) find.hidden = true;
        } else {
            state.dataset.state = find ? "missing" : "unknown";
            const label = find ? "Missing" : "Library check failed";
            if (state.textContent !== label) state.textContent = label;
            if (find) find.hidden = false;
        }
        for (const marker of row.querySelectorAll(".movie-episode-marker"))
            marker.textContent = found ? "Downloading" : "Not in library";
    }

    let downloadItems = [];
    const releaseTail = /^(?:(?:19|20)\d\d|s\d{1,3}(?:e\d{1,3})?|season|complete|\d{3,4}[pi]|bluray|web|hdtv|dvdrip)\b/;
    function updateCardDownload(card) {
        const badge = card.querySelector(".movie-download-badge");
        const key = card.dataset.downloadKey;
        const matches = downloadItems.filter(item => {
            if (typeof item?.name !== "string") return false;
            const name = searchTitle(item.name);
            return name === key || name.startsWith(key + " ") && releaseTail.test(name.slice(key.length + 1));
        });
        const download = matches.find(item => typeof item.progress === "number" &&
            item.progress >= 0 && item.progress < 1 && item.state !== "Finished");
        // Seeding ratios belong on the server dashboard; cards show only a download in progress.
        badge.hidden = !download;
        const fraction = download ? download.progress : 0;
        const label = download ? `${download.state || "Downloading"} ${Math.round(fraction * 100)}%` : "";
        badge.firstChild.textContent = label;
        badge.lastChild.firstChild.style.transform = label ? `scaleX(${fraction})` : "";
    }
    function attachCardDownload(card, name) {
        if (!session.downloads_enabled) return;
        card.dataset.downloadKey = searchTitle(name);
        const badge = el("span"), bar = el("span");
        badge.className = "movie-download-badge";
        bar.className = "movie-download-progress";
        bar.setAttribute("aria-hidden", "true");
        bar.append(el("span"));
        badge.append(el("span"), bar);
        card.append(badge);
        updateCardDownload(card);
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
        const images = new Set(candidates.filter(([id, , tag]) => id && tag).map(([id, type, tag]) =>
            imageSource(id, type, tag, 480)));
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
        const sources = style === "preset" ? [] : backdropSources(item).filter(([, type]) => type === "Backdrop");
        const settle = () => {
            delete art.dataset.loading;
            onSettled?.();
        };
        if (sources.length) {
            art.dataset.loading = "";
            art.addEventListener("load", settle, {once: true});
        }
        chainImages(art, sources.map(([id, type, tag]) => imageSource(id, type, tag, width)), settle);
        return art;
    }
    const newTitle = item => {
        const age = Date.now() - Date.parse(item.DateCreated);
        return age >= 0 && age < 14 * 86400000;
    };
    function card(item, format, findRelease) {
        const title = seriesCardItem(item);
        const continuingEpisode = format === "resume" && item.Type === "Episode";
        const display = continuingEpisode ? item : title;
        const name = continuingEpisode ? item.SeriesName || title.Name : display.Name;
        const episodeLabel = continuingEpisode && Number.isInteger(item.IndexNumber)
            ? (item.ParentIndexNumber > 0 ? `Season ${item.ParentIndexNumber}, episode ${item.IndexNumber}` :
                `Episode ${item.IndexNumber}`) : "";
        const b = button("", () => {
            if (findRelease) findRelease();
            else if (continuingEpisode && !preview && !item.Demo) void play(item, b);
            else openSeries(title, b, item.ParentIndexNumber);
        });
        b.className = "movie-card";
        b.dataset.itemId = display.Id;
        if (title.ProductionYear) b.dataset.year = String(title.ProductionYear);
        const artwork = cardArtwork(display, ["resume", "recent", "related"].includes(format));
        if (findRelease) {
            const action = el("span");
            action.className = "movie-card-find";
            action.append(icon(searchPath));
            artwork.append(action);
            b.setAttribute("aria-label", `Find releases for ${name}`);
        } else if (format === "related") {
            const check = el("span");
            check.className = "movie-card-find movie-card-owned";
            check.append(icon("m5 12 4 4L19 6"));
            artwork.append(check);
            b.setAttribute("aria-label", `${name}, in your library`);
        }
        const watched = format === "resume" ? Math.max(1, Math.min(99, progressOf(item))) : progressOf(item);
        if (watched > 0 && watched < 100) {
            const track = el("span"), fill = el("span");
            track.className = "movie-progress";
            track.setAttribute("aria-hidden", "true");
            fill.style.width = watched + "%";
            track.append(fill);
            artwork.append(track);
            if (format === "resume") b.setAttribute("aria-label", [name, episodeLabel, `${watched}% watched`].filter(Boolean).join(", "));
        }
        const caption = el("span"), titleText = el("span", name);
        caption.className = "movie-caption";
        titleText.className = "movie-card-name";
        caption.append(titleText);
        if (episodeLabel) caption.append(el("small", episodeLabel));
        if (format === "favorites") {
            const heart = el("span");
            heart.className = "movie-card-heart";
            heart.append(icon(heartPath));
            artwork.append(heart);
        }
        if (format === "recent" && newTitle(item)) {
            const badge = el("span", "New");
            badge.className = "movie-card-new";
            artwork.append(badge);
            b.setAttribute("aria-label", `${name}, new`);
        }
        b.append(artwork, caption);
        if (format === "collections") b.classList.add("movie-card-collection");
        if (!preview && !findRelease && format !== "related") attachCardDownload(b, title.Name);
        return b;
    }
    function shelfLane(rows, title, signal) {
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
        function slide(target) {
            const from = viewport.scrollLeft;
            cancel();
            destination = Math.max(0, Math.min(target, maxScroll()));
            if (quietMotion() || Math.abs(destination - from) <= 1) {
                viewport.scrollLeft = destination;
                destination = undefined;
                return;
            }
            const started = performance.now();
            const tick = now => {
                const t = quietMotion() ? 1 : Math.min(1, (now - started) / 410);
                const eased = t * t * (3 - 2 * t);
                viewport.scrollLeft = from + (destination - from) * eased;
                if (t < 1) animation = requestAnimationFrame(tick);
                else cancel();
            };
            animation = requestAnimationFrame(tick);
        }
        const arrows = [-1, 1].map(direction => {
            const arrow = button("", () => {
                if (arrow.getAttribute("aria-disabled") !== "true")
                    slide((destination ?? viewport.scrollLeft) + direction * 5 * step());
            });
            arrow.className = "movie-shelf-arrow";
            arrow.setAttribute("aria-label", (direction < 0 ? "Previous " : "Next ") + title.toLowerCase());
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
                if (full) { first ??= node; last = node; }
            }
            if (last && last !== first) last.dataset.edge = "last";
            if (first) first.dataset.edge = "first";
            arrows[0].setAttribute("aria-disabled", String(start < 1));
            arrows[1].setAttribute("aria-disabled", String(start >= maxScroll() - 1));
            for (const arrow of arrows) arrow.tabIndex = arrow.getAttribute("aria-disabled") === "true" ? -1 : 0;
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
                (rows.firstElementChild ?? lane.closest("section")?.querySelector("h2") ?? query).focus({preventScroll: true});
            markVisible();
        }
        function reveal(node) {
            const left = node.offsetLeft, start = destination ?? viewport.scrollLeft;
            if (left >= start - 1 && left + node.offsetWidth <= start + viewport.clientWidth + 1) return;
            const index = Array.prototype.indexOf.call(rows.children, node);
            slide(Math.floor(index / pageSize) * pageSize * step());
        }
        const resize = globalThis.ResizeObserver ? new ResizeObserver(() => { cancel(); update(); }) : null;
        if (resize) resize.observe(viewport);
        else window.addEventListener("resize", update, {signal});
        signal.addEventListener("abort", () => { cancel(); resize?.disconnect(); }, {once: true});
        viewport.addEventListener("scroll", markVisible, {passive: true});
        viewport.addEventListener("pointerdown", cancel);
        viewport.addEventListener("wheel", cancel, {passive: true});
        rows.addEventListener("focusin", event => { if (event.target.parentElement === rows) reveal(event.target); });
        lane.addEventListener("keydown", event => {
            if (!arrows.includes(event.target) || !["PageUp", "PageDown"].includes(event.key)) return;
            event.preventDefault();
            arrows[event.key === "PageDown" ? 1 : 0].click();
        });
        return {lane, update};
    }
    const browseShelves = [];
    function placeBrowseCards() {
        const visible = new Map(), placed = new Set();
        const reserved = new Set([...favoriteShelf.cards.keys(), ...recentShelf.cards.keys(), ...collectionsShelf.cards.keys()]);
        const genreCards = new Map();
        for (const shelf of genreShelves) {
            const available = [...shelf.cards.keys()].filter(key => !reserved.has(key)).slice(-8);
            if (available.length < 4 || genreCards.size === 3) continue;
            genreCards.set(shelf, new Set(available));
            for (const key of available) reserved.add(key);
        }
        const inGenre = new Set([...genreCards.values()].flatMap(keys => [...keys]));
        const focused = document.activeElement;
        let focusKey, fallback, originalShelf;
        for (const shelf of browseShelves) {
            const {section, heading, rows, cards, more, resume, format} = shelf;
            if (rows.contains(focused)) {
                focusKey = focused.dataset.titleKey;
                fallback = heading;
                originalShelf = shelf;
            } else if (section.contains(focused)) fallback = heading;
            const keep = new Set();
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
            section.hidden = !keep.size && !shelf.failed;
            shelf.updateArrows();
        }
        if (fallback && (!focused.isConnected || focused.closest("[hidden]"))) {
            const original = originalShelf?.cards.get(focusKey);
            const replacement = original?.isConnected ? original : visible.get(focusKey);
            (replacement || (!fallback.closest("[hidden]") ? fallback : submit)).focus({preventScroll: true});
        }
    }
    function shelf(title, type, resume = false, parent = browse, term = "", signal = life.signal, extra = {}) {
        const grid = parent !== browse, section = el("section"), heading = el("h2", title), rows = el("div");
        section.className = "movie-shelf";
        rows.className = "movie-cards";
        const format = extra.format ?? (resume ? "resume" : "catalogue");
        section.dataset.format = format;
        const more = button("Show more", () => void load(offset === 0));
        more.className = "movie-more";
        more.setAttribute("aria-label", "Show more " + title.toLowerCase());
        heading.tabIndex = -1;
        const cards = new Map();
        const outage = createServiceStatus({
            detail: term ? "Reconnect to search your movie library." : "Reconnect to load this shelf.",
            label: term ? "Retry library search" : "Retry " + title.toLowerCase(),
            retry: () => load(offset === 0), focus: () => section.hidden ? submit : heading, automatic: true
        });
        const state = { section, heading, rows, more, cards, resume, format, updateArrows: () => {}, load, items: [] };
        const lanes = el("div");
        lanes.className = "movie-shelf-lanes";
        section.append(heading, lanes, outage.card, more); parent.append(section);
        if (!grid) {
            browseShelves.push(state);
            const {lane, update} = shelfLane(rows, title, signal);
            lanes.append(lane);
            state.updateArrows = update;
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
                const [page, episodes] = await Promise.all([
                    extra.page?.() ?? fetchPage(resume ? "UserItems/Resume" : "Items", params, undefined, bounded),
                    // Jellyfin's Resume feed honours hidden library preferences and can be filled by films.
                    resume && !preview ? request("Items", {...params, includeItemTypes: "Episode",
                        filters: "IsResumable", sortBy: "DatePlayed", sortOrder: "Descending"}, undefined, bounded).catch(() => null) : null
                ]);
                if (!active || signal.aborted) return;
                // A completed toggle replaces the list while an older shelf request can still be in flight.
                if (format === "favorites" && state.items !== previousItems) return;
                if (!Array.isArray(page?.Items)) throw Error("Invalid library page");
                const episodeItems = Array.isArray(episodes?.Items) ? episodes.Items.filter(item => item.Type === "Episode") : [];
                let items = [...page.Items, ...episodeItems].filter(item =>
                    type.split(",").includes(item.Type) && (!extra.accept || extra.accept(item)));
                if (resume) {
                    items.sort((a, b) => playedAt(b) - playedAt(a));
                    const seen = new Set();
                    items = items.filter(item => {
                        const key = titleKey(item);
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    }).slice(0, params.limit);
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
                more.textContent = "Show more";
                more.setAttribute("aria-label", "Show more " + title.toLowerCase());
                state.loaded = true;
                state.failed = false;
                outage.clear();
                if (!grid && !batch) renderHome();
                if (grid) section.hidden = !cards.size;
                if (term && reset) {
                    searchProgress.hidden = true;
                    searchCount = cards.size;
                    if (!cards.size) {
                        if (!extra.noMatch?.()) announceResults(0, true);
                        if (wasFocused) submit.focus();
                        return;
                    }
                    if (!extra.match || items.some(extra.match) || !extra.noMatch?.()) announceResults();
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
                    if (term) { searchProgress.hidden = true; searchAnnouncement.textContent = ""; }
                    extra.noMatch?.();
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

        const heading = el("h2", "Search results"), runtime = el("p"), alternate = el("p");
        runtime.className = alternate.className = "movie-web-meta";
        runtime.hidden = alternate.hidden = true;
        panel.append(heading, runtime, alternate);
        let titleDetails = {}, videoCards = [], externalCount = 0, requestCount = 0;
        let releaseLookup, matchingShelf;
        function showDetails(details) {
            if (!details?.title) return;
            titleDetails = details;
            const length = formatMinutes(details.runtime_minutes);
            if (length && details.title) {
                const name = details.season == null ? details.title : `${details.title}, season ${details.season}`;
                const count = details.episode_count, estimate = details.runtime_estimated ? "about " : "";
                runtime.textContent = `${name}: ${count ? `${count} ${count === 1 ? "episode" : "episodes"}, ` : ""}${estimate}${length}${count ? " in total" : ""}`;
                runtime.hidden = false;
            }
            if (details.hungarian_title) {
                alternate.textContent = `Also searched: ${details.hungarian_title}`;
                alternate.hidden = false;
            }
            for (const card of videoCards) card.updateMatch();
        }

        // Each source publishes independently. Clearing or replacing the search detaches this panel.
        const web = el("section"), downloads = el("section"), otherSources = el("details");
        web.className = "movie-source movie-youtube";
        downloads.className = "movie-source";
        web.hidden = downloads.hidden = true;
        otherSources.className = "movie-release-alternatives";
        otherSources.open = true;
        otherSources.append(el("summary", "Other watch and download options"), downloads, web);
        const alive = () => active && !signal.aborted && panel.isConnected;
        const wanted = searchTitle(term);
        const matchesTitle = value => {
            const title = searchTitle(value);
            if (!wanted) return false;
            if (title === wanted) return true;
            if (!title.startsWith(wanted + " ")) return false;
            return /^(?:(?:19|20)\d\d\s+)?(?:full|teljes|movie|film|magyarul|hd|4k|1080p)\b/.test(title.slice(wanted.length + 1));
        };
        const youtubeVideos = reply => (Array.isArray(reply?.results) ? reply.results : []).filter(item =>
            typeof item.title === "string" && /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(item.url))
            .map(item => ({...item, title: cleanResultTitle(item.title)})).filter(item => item.title);
        const fullMatch = item => item.label === "full film" && item.seconds >= 70 * 60 && matchesTitle(item.title);
        let youtubeSearch = call("MovieFind", term).catch(() => ({error: "YouTube did not respond."}));
        let youtubeMetadata;
        function enrichVideos(videos) {
            if (youtubeMetadata) return youtubeMetadata;
            const ids = videos.filter(video => !video.height || !(video.duration ?? video.seconds)).map(video => video.url.slice(-11));
            youtubeMetadata = ids.length ? call("MovieYouTubeMetadata", ids).catch(() => null) : Promise.resolve(null);
            return youtubeMetadata;
        }
        function showMatchingTitles(list) {
            if (!list.length || !alive() || findRelease) return false;
            const libraryNames = [...results.querySelectorAll(".movie-card-name")];
            const matches = list.filter(item => typeof item?.title === "string" && item.title.trim() && !libraryNames.some(name => {
                const year = name.closest(".movie-card").dataset.year;
                return (!year || !item.year || year === String(item.year)) && searchTitle(name.textContent) === searchTitle(item.title);
            }));
            if (!matches.length) return false;
            const matchShelf = el("section"), credit = el("p", "Posters and details from TMDB. " + tmdbAttribution);
            matchShelf.className = "movie-shelf";
            matchShelf.dataset.format = "search";
            credit.className = "movie-source-note movie-matches-credit";
            matchShelf.append(el("h2", "Find releases"));
            for (let i = 0; i < matches.length; i += 10) {
                const row = el("div");
                row.className = "movie-cards";
                const {lane, update} = shelfLane(row, `matching titles, row ${i / 10 + 1}`, signal);
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
            results.insertBefore(matchShelf, panel);
            matchingShelf = matchShelf;
            return true;
        }
        const getMatches = () => call("MovieMatches", term).then(reply => {
            const list = Array.isArray(reply?.matches) ? reply.matches : [];
            if (!alive()) return [];
            release?.setMatches(list);
            return list;
        }).catch(() => []);
        const matchingTitles = session.release_search_enabled ?
            getMatches().then(async list => {
                await releaseLookup;
                if (panel.hasAttribute("data-release-layout")) return false;
                return showMatchingTitles(list);
            }) : null;
        const release = session.release_search_enabled || session.downloads_enabled
            ? buildReleaseSearch(async () => {
                const [torrents, videa, youtube] = await Promise.all([
                    session.release_search_enabled ? call("MovieReleaseSearch", term).catch(() => null) : null,
                    session.downloads_enabled ? call("MovieVideaSearch", term).catch(() => null) : null,
                    session.downloads_enabled ? youtubeSearch : null
                ]);
                const torrentFailed = session.release_search_enabled && !Array.isArray(torrents?.results);
                const videaFailed = session.downloads_enabled && !Array.isArray(videa?.results);
                const candidates = youtubeVideos(youtube);
                const videaMatches = videaFailed ? [] : videa?.season ? [videa.season] : videa?.results || [];
                const releaseCandidates = [...(torrentFailed ? [] : torrents?.results || []),
                    ...videaMatches.map(item => ({...item, site: "Videa"}))];
                const videos = releaseCandidates.length || session.release_search_enabled ? candidates.filter(fullMatch) : [];
                const details = videos.some(item => !item.height) && alive() ? await enrichVideos(candidates) : null;
                const ranked = [
                    ...releaseCandidates,
                    ...videos.map(item => ({...item, site: "YouTube", height: item.height || details?.results?.[item.url.slice(-11)]?.height}))
                ];
                if (!ranked.length && (torrentFailed || videaFailed)) {
                    return {error: [torrentFailed && (torrents?.error || "Release lookup did not respond."),
                        videaFailed && (videa?.error || "Videa did not respond.")].filter(Boolean).join(" ")};
                }
                return {results: ranked, title_details: torrents?.title_details || youtube?.title_details, unavailable: (torrents?.unavailable || 0) + Number(torrentFailed) + Number(videaFailed)};
            }, signal, session.downloads_enabled ? async (row, options) => {
                const reply = row.episodes
                    ? await call("MovieVideaSeasonDownload", row.name, row.episodes)
                    : row.site
                    ? await call(row.site === "Videa" ? "MovieVideaDownload" : "MovieYouTubeDownload", row.url, row.title)
                    : await call("MovieDownload", row.guid, row.indexerId, row.title, ...options);
                if (reply?.state === "sent") refreshDownloadsAfterGrab();
                return reply;
            } : null, {
                term, screen: movieScreen(readMoviePreferences(preferenceViewer).screen), icon, searchTitle, titleHue, chainImages,
                watchLink: youtubeWatch,
                downloadProgress: row => {
                    const key = searchTitle(row.episodes ? row.name : row.title);
                    const found = downloadItems.find(item => typeof item?.name === "string" &&
                        searchTitle(item.name) === key && Number.isFinite(item.progress));
                    return found?.progress;
                },
                onResults: (details, visible) => {
                    showDetails(details);
                    if (!visible || panel.hasAttribute("data-release-layout")) return;
                    const focused = document.activeElement;
                    const matchFocus = matchingShelf?.contains(focused);
                    matchingShelf?.remove();
                    const libraryShelf = results.querySelector(":scope > .movie-shelf");
                    const otherFocus = otherSources.contains(focused) || libraryShelf?.contains(focused);
                    const otherSummary = otherSources.querySelector("summary");
                    if (libraryShelf) otherSummary.after(libraryShelf);
                    otherSources.open = Boolean(otherFocus);
                    panel.setAttribute("data-release-layout", "");
                    searchAnnouncement.textContent = "";
                    if (!matchingTitles) void getMatches();
                    if (matchFocus || otherFocus && (document.activeElement !== focused || focused.closest("[data-release-match]"))) {
                        const next = otherSummary.getClientRects().length ? otherSummary : release.element.querySelector("h2");
                        next.focus({preventScroll: true});
                    }
                }
            }) : null;
        if (release) {
            panel.append(release.element);
            updateReleaseProgress = release.updateProgress;
        }
        panel.append(otherSources);
        const message = el("p", "Checking other sources…");
        message.className = "movie-source-note is-checking";
        message.setAttribute("role", "status");
        alternate.after(message);

        const videoOutage = createServiceStatus({
            title: "YouTube did not respond", detail: "Retry the video search.", label: "Retry YouTube",
            retry: () => findVideos(true), focus: () => web.querySelector("a") || submit, automatic: true
        });
        const downloadOutage = createServiceStatus({
            detail: "Reconnect to search for download options.", label: "Retry download lookup",
            retry: findDownloads, focus: () => downloads.querySelector("ul button") || submit, automatic: true
        });
        web.append(videoOutage.card);
        downloads.append(downloadOutage.card);
        function youtubeWatch(watchUrl) {
            const link = el("a", "Watch on YouTube");
            link.className = "movie-source-action";
            link.append(icon("M13 5h6v6m0-6-9 9m6-1v5H6V8h5"));
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
        function videoCard(video) {
            const row = el("li"), art = el("div"), image = el("img"), content = el("div");
            row.className = "movie-release movie-youtube-card";
            if (session.downloads_enabled && fullMatch(video)) row.dataset.releaseMatch = "";
            art.className = "movie-youtube-art";
            image.alt = "";
            image.decoding = "async";
            image.referrerPolicy = "no-referrer";
            image.hidden = true;
            image.onerror = () => { image.hidden = true; };
            art.append(image);
            content.className = "movie-youtube-content";
            const title = el("h3", video.title), badges = el("div"), quality = el("span"), match = el("span"), meta = el("p");
            title.className = "movie-release-title";
            badges.className = "movie-release-top";
            quality.className = "movie-release-quality";
            match.className = "movie-youtube-match";
            badges.append(quality);
            appendSoundChip(badges, releaseSound(video.title), icon);
            badges.append(match);
            const actions = el("div"), link = youtubeWatch(video.url);
            actions.className = "movie-youtube-actions";
            const notice = el("p");
            notice.setAttribute("role", "status");
            notice.className = "movie-release-note";
            const action = button("Download", async () => {
                action.focus();
                if (action.getAttribute("aria-disabled") === "true") return;
                action.setAttribute("aria-disabled", "true");
                setAction("Sending…");
                notice.textContent = "";
                let reply;
                try { reply = await call("MovieYouTubeDownload", video.url, video.title); } catch {}
                if (reply?.state === "sent") refreshDownloadsAfterGrab();
                if (!alive()) return;
                if (reply?.state === "sent") {
                    const focused = action === document.activeElement;
                    const sent = el("p", "Sent to the server");
                    sent.className = "movie-release-sent";
                    sent.setAttribute("role", "status");
                    sent.tabIndex = -1;
                    action.replaceWith(sent);
                    if (focused) sent.focus();
                } else {
                    action.removeAttribute("aria-disabled");
                    setAction("Try again");
                    notice.textContent = reply?.error || "Could not confirm the download. Check Downloading before trying again.";
                }
            });
            function setAction(label) {
                action.textContent = label;
                action.setAttribute("aria-label", `${label} ${video.title}`);
            }
            action.className = "movie-release-action";
            setAction("Download");
            if (!session.downloads_enabled) {
                action.setAttribute("aria-disabled", "true");
            }
            actions.append(link, action);
            content.append(title, badges, meta, actions, notice);
            row.append(art, content);

            let seconds;
            function updateMatch() {
                const ratio = seconds / (titleDetails.runtime_minutes * 60);
                const same = ratio >= .9 && ratio <= 1.1;
                const comparison = titleDetails.kind === "tv" ? (titleDetails.season == null ? "series" : "season") : "film";
                match.hidden = !(ratio > 0 && Number.isFinite(ratio)) || Boolean(titleDetails.runtime_estimated);
                match.dataset.level = same ? "same" : "different";
                match.textContent = same ? "Same length" : `${ratio < .9 ? "Shorter" : "Longer"} than the ${comparison}`;
            }
            function update(details) {
                const height = details.height ?? video.height;
                const tier = videoQualityTier(height || 0);
                quality.dataset.level = row.dataset.tier = tier;
                quality.textContent = height >= 2160 && height < 4320 ? "4K" : height ? `${height}p` : "Quality unknown";
                seconds = details.duration ?? video.duration ?? video.seconds;
                const duration = formatMinutes(seconds / 60);
                updateMatch();
                const count = details.view_count ?? video.view_count;
                const views = Number.isFinite(count) ? `${count.toLocaleString("en")} ${count === 1 ? "view" : "views"}` : "";
                meta.textContent = [details.uploader || video.uploader || video.channel, duration, views].filter(Boolean).join(", ");
                const thumbnail = details.thumbnail || video.thumbnail;
                if (typeof thumbnail === "string" && thumbnail.startsWith("https://") && image.src !== thumbnail) {
                    image.src = thumbnail;
                    image.hidden = false;
                }
            }
            update(video);
            return {row, update, updateMatch, id: video.url.slice(-11)};
        }
        async function findVideos(retrying = false) {
            if (retrying) {
                youtubeMetadata = null;
                youtubeSearch = call("MovieFind", term).catch(() => ({error: "YouTube did not respond."}));
            }
            const reply = await youtubeSearch;
            if (!alive()) return false;
            if (reply?.error || !Array.isArray(reply?.results)) {
                if (videoOutage.card.hidden && reply?.error === "Searching the web is not set up on this server.") {
                    videoOutage.card.querySelector(".service-status-announcement strong").textContent = "Web search unavailable";
                    videoOutage.card.querySelector(".service-status-announcement p").textContent = "Searching the web is not set up on this server.";
                }
                web.hidden = false;
                videoOutage.show();
                return true;
            }
            showDetails(reply.title_details);
            const videos = youtubeVideos(reply);
            videoCards = [];
            if (videos.length) {
                const list = el("ul"), heading = el("h2", "YouTube"), status = el("p");
                status.setAttribute("role", "status");
                status.className = "movie-source-note";
                list.className = "movie-source-list";
                list.setAttribute("aria-label", "YouTube videos");
                const cards = videos.map(videoCard);
                videoCards = cards;
                list.append(...cards.map(card => card.row));
                web.append(heading);
                if (!session.downloads_enabled) web.append(el("p", "Downloading is not switched on for your profile."));
                web.append(list);
                web.hidden = false;
                if (!release || retrying) announceResults(videos.length);
                enrichVideos(videos).then(details => {
                    if (!alive()) return;
                    for (const card of cards) {
                        const fresh = details?.results?.[card.id];
                        if (fresh) card.update(fresh);
                    }
                });
            }
            videoOutage.clear();
            web.hidden = !videos.length;
            return !web.hidden;
        }
        const requestStates = {
            pending: "Waiting for approval", approved: "Request approved", failed: "Request needs attention",
            available: "Available in the library", existing: "Already requested or available",
            no_seasons: "No seasons available to request", requested: "Request received"
        };
        function requestRow(item, season) {
            const row = el("li"), details = el("div"), note = el("p");
            const meta = [item.kind === "tv" ? season == null ? "Series" : "Season " + season : "Movie", item.year].filter(Boolean);
            row.className = "movie-source-row";
            note.setAttribute("role", "status");
            details.append(el("h3", item.title), el("p", meta.join(", ")), note);
            row.append(details);
            const unavailable = item.status === 6 || (season == null && (item.status === 5 || item.kind === "movie" && [2, 3].includes(item.status)));
            if (unavailable) {
                note.textContent = {2: requestStates.pending, 3: "Requested", 5: requestStates.available, 6: "Requests disabled for this title"}[item.status];
                return row;
            }
            const label = item.kind === "movie" ? "Request download" : season == null ? "Request all seasons" : "Request season " + season;
            const action = button(label, async () => {
                if (action.getAttribute("aria-disabled") === "true") return;
                if (document.activeElement === document.body) action.focus();
                action.setAttribute("aria-disabled", "true");
                note.textContent = "Sending request…";
                let reply;
                try { reply = await call("MovieRequest", item.kind, item.id, season ?? null); }
                catch { reply = {error: "Could not confirm the request. Try again."}; }
                if (!alive() || !row.isConnected) return;
                if (reply?.error || !requestStates[reply?.state]) {
                    action.removeAttribute("aria-disabled");
                    note.textContent = reply?.error || "Could not confirm the request. Try again.";
                    return;
                }
                note.textContent = requestStates[reply.state];
                if (document.activeElement === action) { note.tabIndex = -1; note.focus(); }
                action.remove();
            });
            action.className = "movie-source-action";
            action.setAttribute("aria-label", `${label}: ${item.title}${item.year ? ` (${item.year})` : ""}`);
            row.append(action);
            return row;
        }
        async function findDownloads() {
            let reply;
            try { reply = await call("MovieRequestSearch", term); }
            catch { reply = {error: "Download lookup did not respond."}; }
            if (!alive()) return false;
            if (reply?.error || !Array.isArray(reply?.results)) {
                downloads.hidden = false;
                downloadOutage.show();
                return true;
            }
            const found = reply.results.slice(0, 12);
            requestCount = found.length;
            if (release && !matchingTitles) showMatchingTitles(found.filter(item => item.status !== 5));
            showDetails(reply.title_details);
            if (found.length) {
                const heading = el("h2", "Download options"), rows = el("ul");
                rows.className = "movie-source-list";
                rows.append(...found.map(item => requestRow(item, reply.season)));
                downloads.append(heading, rows);
            }
            downloadOutage.clear();
            downloads.hidden = !found.length;
            return !!found.length;
        }

        const searches = [findVideos()];
        if (matchingTitles) searches.push(matchingTitles);
        if (session.requests_enabled) searches.push(findDownloads());
        if (release) {
            releaseLookup = release.load();
            searches.push(releaseLookup);
        }
        let shown = false, outstanding = searches.length;
        for (const search of searches) search.then(found => {
            if (!alive()) return;
            shown ||= found;
            outstanding--;
            if (!outstanding) {
                message.classList.remove("is-checking");
                message.textContent = shown ? "" : "No watch or download options found. Try another title.";
                if (!findRelease && !panel.hasAttribute("data-release-layout")) announceResults(externalCount || requestCount || videoCards.length);
            }
        });
    }

    const form = el("form"), query = el("input"), submit = el("button");
    form.className = "movie-search";
    form.setAttribute("role", "search");
    form.setAttribute("aria-label", "Movies and TV");
    query.type = "search";
    query.placeholder = "Movies, series, or episodes";
    query.setAttribute("aria-label", "Search movies and TV");
    query.maxLength = 120;
    query.enterKeyHint = "search";
    submit.setAttribute("aria-label", "Search");
    submit.type = "submit";
    submit.append(icon(searchPath));
    const browse = el("div"), results = el("div");
    browse.className = "movie-browse";
    results.className = "movie-search-results";
    const clear = button("", () => clearSearch());
    clear.setAttribute("aria-label", "Clear");
    clear.append(icon("M6 6l12 12M18 6 6 18"));
    clear.hidden = true;
    const scrollHost = host.closest(".workspace > main") ?? document.scrollingElement ?? document.documentElement;
    const searchAnnouncement = el("p"), searchProgress = el("p", "Searching…");
    searchAnnouncement.className = "movie-visually-hidden";
    searchAnnouncement.setAttribute("role", "status");
    searchAnnouncement.setAttribute("aria-atomic", "true");
    let searchRequest, searchTimer, submittedTerm, homeScroll, updateReleaseProgress, searchCount = 0;
    searchProgress.hidden = true;
    function announceResults(external = 0, showEmpty = false) {
        if (results.querySelector("[data-release-layout]")) return;
        if (searchAnnouncement.textContent) return;
        const count = searchCount + external;
        searchAnnouncement.classList.toggle("movie-visually-hidden", !showEmpty || count > 0);
        searchAnnouncement.textContent = count ? `${plural(count, "title")} found.` : "No titles found.";
    }
    function replaceSearchResults() {
        clearTimeout(searchTimer);
        searchRequest?.abort();
        updateReleaseProgress = undefined;
        submittedTerm = undefined;
        if (results.contains(document.activeElement)) submit.focus({preventScroll: true});
        results.replaceChildren();
        searchAnnouncement.textContent = "";
        searchProgress.hidden = true;
        searchCount = 0;
    }
    function resetSearch() {
        while (seriesView) closeSeries(query);
        replaceSearchResults();
        clear.hidden = true;
        browse.hidden = false;
        if (homeScroll) {
            scrollHost.scrollTop = homeScroll.top;
            for (const [row, left] of homeScroll.rows) row.scrollLeft = left;
            homeScroll = undefined;
        }
    }
    function showSearch() {
        homeScroll ??= {top: scrollHost.scrollTop, rows: [...browse.querySelectorAll(".movie-shelf-scroll")].map(row => [row, row.scrollLeft])};
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
        searchProgress.hidden = false;
        const season = preview ? null : /^(.+?)\s+(?:season\s+|s)(\d{1,3})$/i.exec(term);
        let searchedOtherSources = false;
        const noMatch = () => {
            if (preview || term.length < 2) return false;
            if (searchedOtherSources) return true;
            searchedOtherSources = true;
            externalResults(term, signal);
            return true;
        };
        shelf("In your library", "Movie,Series,Episode", false, results, term, signal, {
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
        searchProgress.hidden = false;
        searchTimer = setTimeout(() => startSearch(false, true), 350);
    };
    form.append(query, submit, clear);
    const toolbar = el("div");
    toolbar.className = "movie-toolbar";
    toolbar.append(form);
    const catalogue = el("div"), downloadsPanel = el("section");
    catalogue.className = "movie-catalogue";
    downloadsPanel.className = "movie-downloads";
    downloadsPanel.setAttribute("aria-label", "Downloading");
    const queue = el("ul");
    catalogue.append(browse, searchProgress, results, searchAnnouncement);
    if (session.downloads_enabled) {
        downloadsPanel.hidden = true;
        downloadsPanel.append(el("h2", "Downloading"), queue);
        catalogue.prepend(downloadsPanel);
    }
    const header = document.querySelector(".app-header .header-search");
    (header ?? library).append(toolbar);
    library.append(catalogue);
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
            const direct = item.item === Id;
            if (!direct && (!season || item.item !== season)) continue;
            const results = item.results.filter(result =>
                (direct || result.title === Name) && (result.can_delete || result.refresh_pending || result.error));
            const running = audioJobRunning(item);
            if (!direct && !item.results.some(result => result.title === Name)) continue;
            if (!running && !results.length && !(direct && item.error)) continue;
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
            } else {
                const results = audioJobResults(job, async (...args) => {
                    try {
                        const reply = await call(...args);
                        if (!reply?.error) scheduleDownloads(3100);
                        return reply;
                    } catch { return {error: "The server did not respond. Try again."}; }
                });
                if (Type === "Episode") {
                    const episode = IndexNumber == null ? Name : `episode ${IndexNumber}, ${Name}`;
                    for (const remove of results.querySelectorAll("[data-audio-remove]"))
                        remove.setAttribute("aria-label", "Delete source file for " + episode);
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
    async function updateDownloads(bounded = life.signal) {
        if (!queueVisible() || checkingQueue) return;
        checkingQueue = true;
        if (Date.now() >= refreshAfterGrabAt) refreshAfterGrabAt = 0;
        let reply;
        try { reply = await boundedCall(bounded, "MovieDownloads"); } catch {}
        checkingQueue = false;
        if (!queueVisible()) return;
        const itemsAvailable = reply?.available && Array.isArray(reply.items);
        downloadItems = itemsAvailable ? reply.items : [];
        updateReleaseProgress?.();
        if (itemsAvailable) {
            audioJobs = downloadItems.filter(item => Array.isArray(item.results));
            for (const job of audioJobs) {
                if (audioJobRunning(job)) pendingAudioJobs.add(job.id);
                else if (pendingAudioJobs.delete(job.id)) {
                    const title = job.results.length === 1 && job.results[0].title;
                    const message = job.state === "Added" ? (title ? `Audio added to ${title}.` : "Audio track added.") :
                        "The audio job finished with issues. Open the title for details.";
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
            for (const row of seriesView.section.querySelectorAll(".movie-season[data-season]")) updateSeasonState(row);
            for (const slot of seriesView.section.querySelectorAll(".movie-title-audio")) updateAudioJobSlot(slot);
        }
        const running = downloadItems.filter(item => !Array.isArray(item.results) && item.progress < 1 &&
            ["Waiting", "Downloading", "Almost done", "Stalled"].includes(item.state));
        downloadsPanel.hidden = !running.length;
        queue.replaceChildren(...running.map(item => {
            const tile = el("li"), bar = el("div"), fill = el("span");
            const progress = Math.max(0, Math.min(1, Number(item.progress) || 0));
            bar.className = "movie-download-progress";
            bar.setAttribute("role", "progressbar");
            bar.setAttribute("aria-label", item.name);
            bar.setAttribute("aria-valuenow", Math.round(progress * 100));
            fill.style.transform = `scaleX(${progress})`;
            bar.append(fill);
            const eta = item.eta != null && ["Downloading", "Almost done"].includes(item.state)
                ? `, about ${Math.max(1, Math.ceil(item.eta / 60))} min left` : "";
            tile.append(el("strong", item.name), bar, el("p", item.state + eta));
            return tile;
        }));
        if (refreshAfterGrabAt) scheduleDownloads(Math.max(0, refreshAfterGrabAt - Date.now()));
        else if (pendingAudioJobs.size || (!library.hidden && running.length))
            scheduleDownloads(5000);
    }
    const queueVisibility = () => scheduleDownloads(0);
    const queueObserver = new MutationObserver(queueVisibility);
    queueObserver.observe(library, {attributes: true, attributeFilter: ["hidden"]});
    document.addEventListener("visibilitychange", queueVisibility, {signal: life.signal});
    life.signal.addEventListener("abort", () => { clearTimeout(queueTimer); queueObserver.disconnect(); });
    const skeleton = movieLoading("home");
    const empty = el("section"), homeStatus = el("p"), entryFocus = document.activeElement;
    homeStatus.className = "movie-visually-hidden";
    homeStatus.setAttribute("role", "status");
    host.prepend(homeStatus);
    browse.setAttribute("role", "region");
    browse.setAttribute("aria-label", "Movie library");
    browse.tabIndex = -1;
    empty.className = "movie-library-empty";
    empty.append(el("h3", "Your library is empty"), button("Search for a title", () => query.focus()));
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
        const previewLabel = el("p", "Demo library");
        previewLabel.className = "movie-preview-label";
        browse.append(previewLabel);
    }
    browse.append(featured, favoriteStatus);
    const fields = "Overview,Genres,ProviderIds,DateCreated,MediaStreams";
    const titleTypes = "Movie,Series";
    const resumeShelf = shelf("Continue watching", "Movie,Episode", true, browse, "", life.signal,
        {singlePage: true, params: {fields}, accept: item =>
            !item.IsMissing && item.LocationType !== "Virtual" && !item.UserData?.Played &&
            (item.UserData?.PlaybackPositionTicks > 0 || item.UserData?.PlayedPercentage > 0)});
    const favoriteShelf = shelf("My list", titleTypes, false, browse, "", life.signal,
        {format: "favorites", params: {fields, isFavorite: true}, accept: item => item.UserData?.IsFavorite === true});
    const recentShelf = shelf("Recently added", titleTypes, false, browse, "", life.signal,
        {format: "recent", params: {fields, sortBy: "DateCreated", sortOrder: "Descending", limit: 12}, singlePage: true,
            accept: item => Number.isFinite(Date.parse(item.DateCreated))});
    const tvShelf = shelf("Series", "Series", false, browse, "", life.signal, {params: {fields}});
    const moviesShelf = shelf("Movies", "Movie", false, browse, "", life.signal, {params: {fields}});
    const collectionsShelf = shelf("Collections", "BoxSet", false, browse, "", life.signal,
        {format: "collections", params: {fields}});
    const genreOutage = createServiceStatus({
        detail: "Reconnect to load movie genres.", label: "Retry genres", retry: refreshGenres,
        focus: () => browse, automatic: true
    });
    const genreRetry = genreOutage.card;
    browse.append(genreRetry, empty);
    catalogue.prepend(skeleton);
    browse.hidden = true;
    query.disabled = submit.disabled = true;
    requestAnimationFrame(() => { if (!homeReady && active) homeStatus.textContent = "Loading movies and TV…"; });
    let genreShelves = [], genresLoaded = false, loadingHome = false, homeReady = false, savingFavorite = false;
    let heroItems = [], heroPick, heroSlide, heroRotation, heroPreload, heroChoice, heroFade, outgoingSlide;
    let heroHovered = false;
    const heroInterval = 9000;
    const heroName = item => item.SeriesName ? `${item.SeriesName}, ${item.Name}` : item.Name;
    const hasBackdrop = item => backdropSources(item).some(([, type]) => type === "Backdrop");
    const heroVisible = () => active && !library.hidden && !browse.hidden && !featured.hidden;

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
        const paused = !heroVisible() || document.hidden || heroChoice || heroHovered ||
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
        button.title = saved ? "Remove from My list" : "Add to My list";
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
                if (active) message.textContent = "Could not update My list. Try again.";
            } finally {
                savingFavorite = false;
                favorite.removeAttribute("aria-disabled");
            }
        });
        favorite.className = "movie-hero-favorite";
        favorite.dataset.favoriteId = id;
        favorite.setAttribute("aria-label", "My list: " + title.Name);
        markFavorite(favorite, isFavorite(title));
        favorite.append(icon(heartPath));
        return favorite;
    }

    function renderHome() {
        placeBrowseCards();
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
        heroItems = candidates.size ? [...candidates.values()] : first ? [first] : [];
        empty.hidden = !!pick || !!browseShelves.some(shelf => shelf.cards.size || shelf.failed) || !genreRetry.hidden;
        if (!pick) {
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
                dot.title = `Show ${heroName(item)}`;
                dot.setAttribute("aria-label", dot.title);
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
        const identity = JSON.stringify([pick, saved, background, readMoviePreferences(preferenceViewer).backgroundStyle, innerWidth > 1920]);
        heroPick = pick;
        if (featured.dataset.selection === identity && !featured.hidden) return;
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
        const facts = titleFacts(pick, ageRatingBadge(pick.OfficialRating || existingTitle?.OfficialRating));
        const genres = (pick.Genres ?? []).slice(0, 3);
        if (genres.length) facts.push(el("span", genres.join(", ")));
        body.append(heading);
        if (facts.length) {
            const meta = el("div");
            meta.className = "movie-hero-meta";
            meta.append(...facts);
            body.append(meta);
        }
        if (pick.Overview) {
            const overview = el("p", pick.Overview);
            overview.className = "movie-hero-overview";
            body.append(overview);
        }
        const details = button("", () => openSeries(title, details, pick.ParentIndexNumber));
        const detailsLabel = pick.Type === "Series" && !preview ? "Seasons" : "Details";
        details.className = "movie-hero-details";
        details.dataset.itemId = titleKey(pick);
        details.setAttribute("aria-label", detailsLabel);
        details.title = detailsLabel;
        details.append(icon("M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"));
        if (pick.Type !== "Series" && !preview) {
            const play = playAction(pick);
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
                const time = el("p", `${remaining} left`);
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
                    const plays = item.UserData?.PlayCount || Number(item.UserData?.Played || progressOf(item) > 0);
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
            }
        } finally { loadingHome = false; }
    }
    const refreshOnFocus = () => { if (!document.hidden && !library.hidden && homeReady) void refreshHome(true); };
    window.addEventListener("focus", () => {
        queueVisibility();
        refreshOnFocus();
    }, {signal: life.signal});
    document.addEventListener("visibilitychange", refreshOnFocus, {signal: life.signal});
    const homeLoad = refreshHome();
    const largeBackdrop = matchMedia("(min-width: 1921px)");
    largeBackdrop.addEventListener?.("change", renderHome, {signal: life.signal});
    // A page key moves to the same position on the next page. Side buttons keep their own focus.
    library.addEventListener("keydown", event => {
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        const page = {PageUp: -5, PageDown: 5}[event.key];
        const current = event.target;
        const navigate = ".movie-card, .movie-hero-actions button";
        if ((!arrows && !page) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !current.matches?.(navigate)) return;
        const catalogue = seriesView?.section ?? (browse.hidden ? results : browse);
        const groups = [...catalogue.querySelectorAll(".movie-hero:not([hidden]) .movie-hero-slide:not([inert]) .movie-hero-actions, .movie-shelf:not([hidden]) .movie-cards")]
            .map(group => [...group.querySelectorAll(navigate)]).filter(group => group.length);
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
        target.focus({ preventScroll: true });
        if (arrows?.[1]) (target.closest(".movie-shelf-lane") ?? featured).scrollIntoView({block: "nearest"});
    });
    return { connectionChanged, async restoreNavigation(value, keepFocus = false) {
        await homeLoad;
        if (!active || preview) return;
        const route = value ? JSON.parse(value) : {};
        if (playerItem && playerItem.Id !== route.player?.Id) await closePlayback(keepFocus, true);
        if (!active) return;
        const linked = seriesView?.section.querySelectorAll('.movie-shelf[data-format="related"] .movie-card');
        const relatedOpener = [...(linked ?? [])].find(node => node.dataset.itemId === route.detail?.Id);
        let ancestor = seriesView?.parent;
        while (ancestor && ancestor.item.Id !== route.detail?.Id) ancestor = ancestor.parent;
        if (relatedOpener && !ancestor && seriesView.item.Id !== route.detail?.Id)
            openSeries(route.detail, relatedOpener, route.season, true, keepFocus);
        else if (seriesView && seriesView.item.Id !== route.detail?.Id) {
            while (seriesView && seriesView !== ancestor) closeSeries(undefined, true, keepFocus);
        }
        if (route.detail && !seriesView) {
            const opener = [...library.querySelectorAll("[data-item-id]")].find(node =>
                node.dataset.itemId === route.detail.Id && !node.closest("[hidden]")) ?? browse;
            openSeries(route.detail, opener, route.season, true, keepFocus);
        }
        if (route.player && !playerItem) {
            const opener = seriesView?.section.querySelector(".movie-hero-play:not([hidden])") ??
                seriesView?.section.querySelector("h2") ?? browse;
            void play(route.player, opener, {fromHistory: true});
        }
    }, async close() {
        if (!active) return;
        active = false;
        const leaving = leavePlayer();
        life.abort();
        stop();
        await leaving;
        await reports;
        if (!preview) try { await app.invokeMethodAsync("MovieCloseMedia", session.media_ticket); } catch {}
    } };
}
