import { buildPlayerUi } from "./movie-player-ui.js";
import { addAudioDialog, audioJobResults, audioJobRunning, audioLanguage as audioLanguageName } from "./movie-audio-ui.js";
import { movieAudioSync } from "./movie-audio-sync.js";
import { buildReleaseSearch, cleanResultTitle, formatMinutes, videoQualityTier } from "./movie-releases.js";
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

function searchTitle(text) {
    return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const languageCodes = {
    hu: ["hu", "hun", "hungarian", "magyar"],
    en: ["en", "eng", "english"]
};

function preferredTrack(tracks, language) {
    const matches = tracks.filter(track => languageCodes[language]?.includes(track.Language?.toLowerCase().split(/[-_]/)[0]));
    return matches.find(track => track.IsDefault) ?? matches[0];
}

const labels = { default: "Default", hu: "Hungarian", en: "English", off: "Off" };
const preferencesKey = viewer => "familyhub:movie-tracks:" + JSON.stringify(viewer);
const dataChoices = ["auto", "full", "good", "saver", "lowest"];
const dataLimits = {
    good: { bitrate: 2500000, height: 720 },
    saver: { bitrate: 1000000, height: 480, audioBitrate: 96000 },
    lowest: { bitrate: 500000, height: 360, audioBitrate: 96000 }
};

function normalizeMoviePreferences(prefs) {
    return {
        audio: ["hu", "en"].includes(prefs?.audio) ? prefs.audio : "default",
        subtitles: ["off", "hu", "en"].includes(prefs?.subtitles) ? prefs.subtitles : "default",
        dataSaver: dataChoices.includes(prefs?.dataSaver) ? prefs.dataSaver : "auto"
    };
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

export function openMovies(host, session, app, viewer, homeBudget = 9500) {
    const base = new URL(session.url.replace(/\/?$/, "/"));
    const mediaBase = new URL(session.media_url);
    if (mediaBase.protocol !== "https:" || mediaBase.origin !== new URL(viewer.server).origin) throw Error("Invalid movie media origin");
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
    // Report a playback problem once a minute per kind; the server keeps the cause in its log.
    const lastNote = new Map();
    const send = (kind, method, title, minutes) =>
        Promise.resolve(app.invokeMethodAsync("MovieEvent", kind, method ?? "", title ?? "", minutes ?? null)).catch(() => {});
    const note = (kind, method = "") => {
        if (!active || performance.now() - (lastNote.get(kind) ?? -6e4) < 6e4) return;
        lastNote.set(kind, performance.now());
        send(kind, method);
    };
    const status = el("p");
    status.setAttribute("role", "status");
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
    const call = async (method, ...args) => JSON.parse(await app.invokeMethodAsync(method, ...args));
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
    function addAudio(item, opener, parent, signal) {
        addAudioDialog({parent, opener, item, signal, onJob: () => scheduleDownloads(0),
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
    function chainImages(img, urls) {
        const next = urls[Symbol.iterator]();
        const advance = () => {
            const image = next.next();
            if (image.done) { img.removeAttribute("src"); img.onerror = null; } else img.src = image.value;
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
    const quietMotion = () => document.body.dataset.effects === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches;
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
        if (!active) return;
        const { audioIndex, position, paused, forceTranscode, sourceId } = options;
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
        } else status.textContent = opening;
        const media = el("video");
        const nativeHls = !!media.canPlayType("application/vnd.apple.mpegurl");
        let failure = "The server did not return playback information.";
        try {
            if (!nativeHls && !globalThis.Hls && (globalThis.MediaSource || globalThis.ManagedMediaSource))
                await import("./vendor/hls.light.min.js").catch(() => {});
            const network = connectionRevision;
            const quality = await qualityFor(prefs.dataSaver);
            if (!active || rev !== selection) return;
            const limit = dataLimits[quality];
            const Hls = nativeHls ? null : globalThis.Hls;
            const hls = nativeHls || Hls?.isSupported();
            const profile = { Name: "FamilyHub web video",
                DirectPlayProfiles: [{ Type: "Video", Container: "mp4,m4v", VideoCodec: "h264", AudioCodec: "aac,mp3" }],
                TranscodingProfiles: [{ Type: "Video", Context: "Streaming", Protocol: hls ? "hls" : "http",
                    Container: hls ? "ts" : "mp4", VideoCodec: "h264", AudioCodec: "aac" }],
                SubtitleProfiles: [{ Format: "vtt", Method: "External" }] };
            const condition = (Property, Value) => ({ Condition: "LessThanEqual", Property, Value: String(Value), IsRequired: true });
            if (limit) {
                profile.MaxStreamingBitrate = limit.bitrate;
                profile.CodecProfiles = [{ Type: "Video", Codec: "h264", Conditions: [condition("Height", limit.height)] }];
                if (limit.audioBitrate) {
                    profile.TranscodingProfiles[0].MaxAudioChannels = "2";
                    profile.TranscodingProfiles[0].EnableAudioVbrEncoding = false;
                    profile.CodecProfiles.push({ Type: "VideoAudio", Codec: "aac",
                        Conditions: [condition("AudioBitrate", limit.audioBitrate), condition("AudioChannels", 2)] });
                }
            }
            const playbackInfo = (sourceId, index, signal) => request("Items/" + item.Id + "/PlaybackInfo", {userId: session.user}, {
                UserId: session.user, DeviceProfile: profile,
                ...(sourceId ? {MediaSourceId: sourceId, SubtitleStreamIndex: -1} : {}),
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
            const resume = position ?? (freshItem?.UserData?.PlaybackPositionTicks || 0) / 1e7;
            failure = result?.ErrorCode === "NoCompatibleStream" ? "The server found no compatible stream." :
                "The server did not provide a playable version.";
            let source = result?.MediaSources?.[0];
            if (!source) throw Error();
            const audioLanguage = prefs.audio;
            const audio = (source.MediaStreams || []).filter(s => s.Type === "Audio");
            const preferredAudio = preferredTrack(audio, audioLanguage);
            const defaultAudio = source.DefaultAudioStreamIndex ?? audio.find(s => s.IsDefault)?.Index ?? audio[0]?.Index;
            const defaultSubtitle = source.DefaultSubtitleStreamIndex;
            const requestedAudio = audioIndex ?? preferredAudio?.Index;
            let selectedAudio = defaultAudio;
            let direct = !forceTranscode && !limit && source.SupportsDirectPlay;
            // A static stream leaves audio selection to the browser. Ask Jellyfin to select the track on multi-audio files.
            const customAudio = audio.length > 1 || audio[0]?.IsExternal ? requestedAudio : undefined;
            if ((!forceTranscode && customAudio != null) || (!sourceId && !direct && defaultSubtitle >= 0)) {
                const playback = await withinMovieLoad(signal => playbackInfo(source.Id, customAudio, signal), life.signal).catch(() => null);
                if (!active || rev !== selection) return;
                const configured = playback?.MediaSources?.[0];
                if (configured?.TranscodingUrl || (!forceTranscode && !limit && configured?.SupportsDirectPlay && customAudio == null)) {
                    selectedAudio = configured.DefaultAudioStreamIndex ?? requestedAudio ?? defaultAudio;
                    direct = !forceTranscode && !limit && configured.SupportsDirectPlay && customAudio == null;
                    result = playback;
                    source = configured;
                } else if (!direct && defaultSubtitle >= 0) {
                    if (forceTranscode) throw Error();
                    return play(item, opener, {...options, sourceId: source.Id, forceTranscode: true, position: resume});
                }
            }
            const path = direct ? "Videos/" + item.Id + "/stream" : source.TranscodingUrl;
            if (!path && !forceTranscode)
                return play(item, opener, {...options, sourceId: source.Id, forceTranscode: true, position: resume});
            if (!path) throw Error();
            const stream = mediaUrl(path, {mediaSourceId: source.Id, playSessionId: result.PlaySessionId});
            if (direct) stream.searchParams.set("static", "true");
            if (!direct && !hls && resume > 0) {
                await leavePlayer();
                if (!active || rev !== selection) return;
                status.textContent = "This device cannot resume this video. Continue on another device.";
                note("cannot-resume");
                library.hidden = false;
                opener.focus();
                stop();
                return;
            }
            const back = button("Back to movies", async () => {
                if (!active || rev !== selection) return;
                await leavePlayer();
                if (!active || rev !== selection) return;
                library.hidden = false;
                opener.focus();
                stop();
                const closedSelection = selection;
                await reports;
                if (active && closedSelection === selection) await reloadResume();
            });
            const subtitles = (source.MediaStreams || []).filter(s => s.Type === "Subtitle" && s.IsTextSubtitleStream);
            const deviceLanguage = navigator.language?.split("-")[0].toLowerCase();
            const subtitleLanguage = languageCodes[prefs.subtitles] ? prefs.subtitles : deviceLanguage === "hu" ? "hu" : "en";
            const audioPick = audio.length ? select("Audio track",
                audio.map(track => [track.Index, track.IsExternal ? audioLanguageName(track.Language) + ", added"
                    : track.DisplayTitle || audioLanguageName(track.Language)])) : null;
            if (audioPick) {
                audioPick.value = String(selectedAudio);
                audioPick.onchange = () => play(item, opener, { sheet: "audio", audioIndex: Number(audioPick.value),
                    position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                    subtitleIndex: playback.subtitleOverride, dataSaver: playback.dataSaver, forceTranscode, sourceId: forceTranscode ? source.Id : undefined });
            }
            const subtitleOptions = subtitles.map(track => [track.Index, track.DisplayTitle || track.Language || "Subtitles"]);
            const subtitlePick = select("Subtitle track", [[-1, "Off"], ...subtitleOptions]);
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
                track.src = mediaUrl(`Videos/${item.Id}/${source.Id}/Subtitles/${s.Index}/Stream.vtt`);
                media.append(track);
                textTracks.set(s.Index, track.track);
            }
            for (const subtitle of subtitles) addSubtitleTrack(subtitle);
            const playback = { item, source, id: result.PlaySessionId, dataSaver: prefs.dataSaver,
                method: direct ? "DirectPlay" : forceTranscode || limit || source.TranscodeReasons?.length ? "Transcode" : "DirectStream" };
            playback.setSubtitles = (index) => {
                playback.subtitleOverride = index;
                const language = prefs.subtitles;
                const preferred = language === "off" ? null : preferredTrack(subtitles, subtitleLanguage);
                const selected = index ?? (language === "default" && textTracks.has(defaultSubtitle)
                    ? defaultSubtitle : preferred?.Index);
                const activeSubtitle = textTracks.has(selected) ? selected : -1;
                for (const [trackIndex, track] of textTracks)
                    track.mode = trackIndex === activeSubtitle ? "hidden" : "disabled"; // hidden: the player draws the cues itself
                subtitlePick.value = String(activeSubtitle);
                const audioFallback = audioIndex == null && audioLanguage !== "default" && (!preferredAudio || preferredAudio.Index !== selectedAudio);
                notice.textContent = [
                    audioFallback ? `${labels[audioLanguage]} audio unavailable. Using the default track.` : "",
                    audioIndex != null && audioIndex !== selectedAudio ? "Selected audio track unavailable. Using the default track." : ""
                ].filter(Boolean).join(" ");
            };
            subtitlePick.onchange = () => playback.setSubtitles(Number(subtitlePick.value));
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
            const failed = (hlsError = null) => {
                if (current !== playback || recovering) return;
                note("playback-error", playback.method);
                const retry = {audioIndex: selectedAudio, subtitleIndex: playback.subtitleOverride, dataSaver: playback.dataSaver,
                    position: metadataLoaded ? media.currentTime : resume, paused: playback.started && media.paused,
                    sourceId: source.Id, forceTranscode: true};
                const code = media.error?.code;
                if (!forceTranscode && (direct || playback.method === "DirectStream" || code === 3 || code === 4 || hlsError === "mediaError")) {
                    recovering = true;
                    void play(item, opener, retry);
                    return;
                }
                const reason = code === 2 || hlsError === "networkError" ? "The video stream stopped responding." :
                    code === 3 || code === 4 || hlsError === "mediaError" ? "The video stream could not be decoded." :
                    "The server stream could not start.";
                ui?.showFailure(reason, () => play(item, opener, retry));
            };
            media.onerror = () => failed();
            if (!direct && !nativeHls && hls) {
                playback.hls = new Hls({ startPosition: resume, enableWorker: false });
                playback.hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (data.fatal) failed(data.type);
                });
            }
            const numbered = item.ParentIndexNumber != null && item.IndexNumber != null;
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
            const subtitleCode = subtitleLanguage === "hu" ? "hun" : "eng";
            const subtitleSearch = {
                itemId: item.Id,
                language: subtitleCode,
                async find(language) {
                    const results = await searchLibrary(remote + language, {}, undefined, playerSignal);
                    if (!Array.isArray(results)) throw Error("Invalid subtitle results");
                    return results.filter(result => typeof result?.Id === "string" && result.Id);
                },
                async add(result, language, automatic = false) {
                    const readTracks = async () => {
                        const fresh = await searchLibrary(subtitlePath, {userId: session.user}, undefined, playerSignal);
                        return (fresh.MediaSources?.find(candidate => candidate.Id === source.Id)?.MediaStreams
                            ?? fresh.MediaStreams ?? []).filter(stream => stream.Type === "Subtitle" && stream.IsTextSubtitleStream);
                    };
                    const existing = await readTracks();
                    await searchLibrary(remote + encodeURIComponent(result.Id), {}, {}, playerSignal);
                    for (let attempt = 0; attempt < 12 && !playerSignal.aborted; attempt++) {
                        if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
                        if (playerSignal.aborted) return;
                        const refreshed = await readTracks();
                        const added = refreshed.filter(track => track.IsExternal && !existing.some(old =>
                            old.Path && track.Path ? old.Path === track.Path : old.Index === track.Index));
                        const matching = added.filter(track => languageCodes[language === "hun" ? "hu" : "en"]
                            .includes(track.Language?.toLowerCase().split(/[-_]/)[0]));
                        const track = matching.length === 1 ? matching[0] : null;
                        if (!track || playerSignal.aborted) continue;
                        const prior = subtitles.find(stream => stream.Index === playback.subtitleOverride);
                        for (const node of media.querySelectorAll("track")) node.remove();
                        subtitles.splice(0, subtitles.length, ...refreshed);
                        textTracks.clear();
                        subtitlePick.replaceChildren(new Option("Off", -1));
                        for (const stream of subtitles) {
                            addSubtitleTrack(stream);
                            subtitlePick.add(new Option(stream.DisplayTitle || stream.Language || "Subtitles", stream.Index));
                        }
                        if (automatic && playback.subtitleOverride != null) {
                            playback.setSubtitles(prior
                                ? refreshed.find(stream => prior.Path ? stream.Path === prior.Path : stream.Index === prior.Index)?.Index ?? -1
                                : -1);
                        } else playback.setSubtitles(track.Index);
                        ui.syncSubtitles();
                        return;
                    }
                    throw Error("Subtitle track unavailable");
                }
            };
            async function autoSubtitles() {
                if (prefs.subtitles === "off") {
                    ui.subtitleStatus("Automatic search is off in Movies settings. Find subtitles searches manually.");
                    return;
                }
                if (options.subtitleIndex != null || preferredTrack(subtitles, subtitleLanguage)) return;
                const key = preferencesKey(preferenceViewer) + ":autosub:" + item.Id;
                let tried = subtitleAttempts.has(key);
                try {
                    tried ||= sessionStorage.getItem(key) === "1";
                    if (!tried) sessionStorage.setItem(key, "1");
                } catch { /* The in-memory attempt still covers this Movies view. */ }
                if (tried) {
                    ui.subtitleStatus("Automatic search already ran for this title. Use Find subtitles to search again.");
                    return;
                }
                subtitleAttempts.add(key);
                const name = labels[subtitleLanguage];
                ui.subtitleStatus(`Searching for ${name} subtitles…`, true);
                let best;
                try {
                    const found = await subtitleSearch.find(subtitleCode);
                    if (playerSignal.aborted) return;
                    best = found.sort((a, b) => (b.DownloadCount ?? 0) - (a.DownloadCount ?? 0) ||
                        (b.CommunityRating ?? 0) - (a.CommunityRating ?? 0))[0];
                    if (!best) {
                        ui.subtitleStatus(`No ${name} subtitles found. Use Find subtitles to retry. If searches stay empty, ask the server owner to check the Open Subtitles plugin and account in Jellyfin.`);
                        return;
                    }
                    ui.subtitleStatus(`Adding ${name} subtitles…`, true);
                    await subtitleSearch.add(best, subtitleCode, true);
                    if (!playerSignal.aborted) ui.subtitleStatus(`${name} subtitles added.`);
                } catch {
                    if (!playerSignal.aborted) ui.subtitleStatus(best
                        ? "Could not add subtitles. Use Find subtitles to retry or ask the server owner to check subtitle permissions and storage."
                        : "Could not search for subtitles. Use Find subtitles to retry or ask the server owner to check the Jellyfin subtitle provider and your subtitle management permission.");
                }
            }
            let qualityChange = 0;
            playback.refreshQuality = async () => {
                if (playback.dataSaver !== "auto") return;
                const change = ++qualityChange;
                const nextQuality = await qualityFor("auto");
                if (current === playback && change === qualityChange && playback.dataSaver === "auto" && nextQuality !== quality)
                    return play(item, opener, {
                        dataSaver: "auto", sheet: ui.openSheetName(), audioIndex, subtitleIndex: playback.subtitleOverride,
                        position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                        forceTranscode, sourceId: forceTranscode ? source.Id : undefined
                    });
            };
            ui = buildPlayerUi({ media, surface: player, back, signal: playerSignal, subtitleSearch,
                fullscreenEnabled: nativeFullscreen || document.fullscreenEnabled || document.webkitFullscreenEnabled, isFullscreen, setFullscreen,
                title: numbered ? `S${item.ParentIndexNumber}:E${item.IndexNumber} “${item.Name}”` : item.Name,
                kicker: item.SeriesName, audioPick, subtitlePick, audioSync, notice,
                addAudio: session.downloads_enabled ? trigger => addAudio(item, trigger, player, playerSignal) : null });
            playback.showJobToast = ui.hint;
            player.replaceChildren(media, ui.root);
            enterPlayer();
            playback.setSubtitles(options.subtitleIndex);
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
            ui.reopenSheet(options.sheet);
            library.hidden = true;
            if (quality === "saver" && prefs.dataSaver === "auto" && !autoHintShown) {
                autoHintShown = true;
                const key = preferencesKey(preferenceViewer) + ":data-saver-hint";
                let seen = false;
                try { seen = !!localStorage.getItem(key); localStorage.setItem(key, "1"); } catch {}
                if (!seen) ui.hint("Switched to Saver on mobile data.");
            }
            status.textContent = "";
            if (playback.hls) {
                playback.hls.loadSource(stream.href);
                playback.hls.attachMedia(media);
            } else media.src = stream;
            if (!paused) media.play().catch(error => {
                if (current !== playback || recovering) return;
                if (error?.name === "NotSupportedError") failed("mediaError");
                else if (!media.error) ui.say("Press play to start.");
            });
            if (network !== connectionRevision) void playback.refreshQuality();
        } catch {
            if (active && rev === selection) {
                await leavePlayer();
                if (!active || rev !== selection) return;
                status.textContent = failure + " Try again using the play button.";
                note("open-failed");
                library.hidden = false;
                opener.focus();
                stop();
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
    function seriesCardItem(item) {
        if (!item.SeriesId || !item.SeriesName) return item;
        return { ...item, Id: item.SeriesId, Name: item.SeriesName, Type: "Series", SeriesName: undefined,
            ProviderIds: undefined, ImageTags: { Primary: item.SeriesPrimaryImageTag, Thumb: item.SeriesThumbImageTag },
            BackdropImageTags: undefined, ParentThumbItemId: undefined, ParentPrimaryImageItemId: undefined };
    }

    let seriesView;
    function closeSeries(focus) {
        if (!seriesView) return;
        const { section, opener, controller, fromResults, searchStatus } = seriesView;
        seriesView = undefined;
        controller.abort();
        browse.hidden = fromResults;
        results.hidden = false;
        toolbar.hidden = false;
        status.textContent = searchStatus;
        (fromResults ? results : browse).classList.add("movie-screen-entry");
        const replacement = opener.isConnected && !opener.closest("[hidden]") ? opener :
            [...(fromResults ? results : browse).querySelectorAll(".movie-card, .movie-hero-details")]
                .find(card => card.dataset.itemId === opener.dataset.itemId && !card.closest("[hidden]"));
        (focus || replacement || submit).focus({preventScroll: !!focus});
        section.remove();
    }
    function openSeries(item, opener, preferredSeason) {
        const section = el("section"), heading = el("h2", item.Name), summary = el("p"), list = el("div");
        const credit = el("p", "Season data from TMDB. " + tmdbAttribution);
        const back = button("", () => closeSeries());
        back.className = "movie-title-back";
        back.setAttribute("aria-label", "Back to titles");
        back.title = "Back to titles";
        back.append(icon("M19 12H5m7-7-7 7 7 7"));
        const controller = new AbortController(), signal = controller.signal;
        const fromResults = browse.hidden, isSeries = item.Type === "Series";
        section.className = "movie-series movie-screen-entry" + (isSeries ? "" : " movie-film-detail");
        section.setAttribute("aria-labelledby", "movie-series-title");
        heading.id = "movie-series-title";
        heading.tabIndex = -1;
        summary.setAttribute("role", "status");
        list.className = "movie-season-list";
        credit.className = "movie-matches-credit";
        credit.hidden = true;
        const header = el("header"), intro = el("div");
        header.className = "movie-series-header";
        intro.className = "movie-title-intro";
        intro.append(cardArtwork(item), heading);
        if (item.Overview) intro.append(el("p", item.Overview));
        header.append(back, intro);
        if (isSeries) header.append(summary);
        section.append(header, list, credit);
        section.addEventListener("keydown", event => {
            if (event.key === "Escape" && !event.target.closest("dialog, select")) { event.stopPropagation(); closeSeries(); }
        });
        seriesView = { section, opener, controller, fromResults, searchStatus: fromResults ? status.textContent : "" };
        status.textContent = "";
        catalogue.append(section);
        heading.focus({preventScroll: true});
        browse.classList.remove("movie-screen-entry");
        results.classList.remove("movie-screen-entry");
        toolbar.hidden = true;
        browse.hidden = results.hidden = true;
        section.scrollIntoView({block: "start"});

        if (!isSeries) {
            const actions = el("div"), runtime = formatMinutes(item.RunTimeTicks / 6e8);
            actions.className = "movie-title-actions";
            const art = movieBackdrop(item);
            const facts = [item.ProductionYear, item.OfficialRating, runtime, ...(item.Genres ?? []).slice(0, 3)].filter(Boolean);
            if (facts.length) {
                const meta = el("p", facts.join(", "));
                meta.className = "movie-film-meta";
                heading.after(meta);
            }
            header.prepend(art);
            header.style.setProperty("--art-hue", titleHue(item.Name));
            actions.append(playAction(item));
            if (session.downloads_enabled) {
                actions.append(audioAction(item, signal));
                list.append(audioJobSlot(item));
            }
            intro.append(actions);
            return;
        }

        const seasons = el("div"), lane = el("div"), pills = new Map();
        seasons.className = "movie-season-picker";
        seasons.hidden = true;
        lane.className = "movie-season-pills";
        lane.setAttribute("role", "group");
        lane.setAttribute("aria-label", "Seasons");
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
        const local = bounded => localEpisodes(item.Id, bounded);
        const tmdb = async bounded => {
            const show = item.ProviderIds?.Tmdb ? item : await request(`Items/${encodeURIComponent(item.Id)}`,
                {userId: session.user, fields: "ProviderIds"}, undefined, bounded).catch(() => null);
            const id = show?.ProviderIds?.Tmdb;
            const year = String(show?.ProductionYear ?? item.ProductionYear ?? "");
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
            list.replaceChildren(...nodes);
            if (focused) {
                const same = key ? [...list.querySelectorAll("[data-episode-id]")].find(node =>
                    node.dataset.episodeId === key && node.hasAttribute("data-episode-audio") === focus.hasAttribute("data-episode-audio")) :
                    focus.matches(".movie-hero-play") ? list.querySelector(".movie-hero-play") : null;
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
                list.hidden = true;
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
            if (!quiet) {
                summary.textContent = "Loading seasons…";
                list.setAttribute("aria-busy", "true");
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
                    for (const [n, pill] of pills) {
                        if (available.has(n)) continue;
                        pill.remove();
                        pills.delete(n);
                    }
                    let next = lane.firstElementChild;
                    for (const n of numbers) {
                        if (!pills.has(n)) pills.set(n, button(n ? `Season ${n}` : "Specials", () => {
                            pills.get(n).focus({preventScroll: true});
                            if (selectedSeason !== n) void choose(n);
                        }));
                        const pill = pills.get(n);
                        if (pill !== next) lane.insertBefore(pill, next);
                        next = pill.nextElementSibling;
                    }
                    seasons.hidden = !numbers.length;
                    selectSeason(first);
                    if (removedFocus) seasonFocus().focus({preventScroll: true});
                    if (firstMount && first != null && first !== numbers[0])
                        lane.scrollLeft = pills.get(first).offsetLeft - lane.offsetLeft;
                    updateSeasonArrows();
                    credit.hidden = !metadata;
                    renderSeason(first);
                    summarize();
                }, signal);
            } finally {
                busy = false;
                list.removeAttribute("aria-busy");
            }
        }
        seriesView.refreshProgress = () => load(true);
        void load(false);
    }
    function playAction(item) {
        const resume = progressOf(item) > 0 && !item.UserData?.Played;
        const action = button(resume ? "Resume" : "Play", () => play(item, action));
        action.className = "movie-hero-play";
        return action;
    }
    function audioAction(item, signal) {
        const action = button("Add audio track", event => addAudio(item, event.currentTarget, library, signal));
        action.setAttribute("aria-label", "Add audio track for " + item.Name);
        action.setAttribute("aria-haspopup", "dialog");
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
            const resume = episodes.find(episode => progressOf(episode) > 0 && !episode.UserData?.Played);
            header.append(playAction(resume ?? episodes.find(episode => !episode.UserData?.Played) ?? episodes[0]));
            const watched = episodes.filter(episode => episode.UserData?.Played).length;
            counts.append(chip(`${watched} of ${episodes.length} watched`));
        } else if (libraryKnown) {
            header.append(button("Find season " + number, () => {
                const suffix = " S" + String(number).padStart(2, "0");
                query.value = item.Name.slice(0, query.maxLength - suffix.length).trimEnd() + suffix;
                closeSeries(submit);
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
            if (runtime) content.append(el("span", runtime));
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
    function cardArtwork(item) {
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
        const candidates = [primary, ...landscape, ...series];
        const images = new Set(candidates.filter(([id, , tag]) => id && tag).map(([id, type, tag]) =>
            url(`Items/${encodeURIComponent(id)}/Images/${type}`, { tag, maxWidth: 480 }).href));
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
    function movieBackdrop(item) {
        const art = el("img");
        art.alt = "";
        art.decoding = "async";
        art.referrerPolicy = "no-referrer";
        art.className = "movie-hero-art";
        const width = innerWidth > 1700 ? 2560 : 1600;
        chainImages(art, backdropSources(item).map(([id, type, tag]) =>
            url(`Items/${encodeURIComponent(id)}/Images/${type}`, {tag, maxWidth: width}).href));
        return art;
    }
    function card(item, searchResult, resume) {
        const title = seriesCardItem(item);
        const continuingEpisode = resume && item.Type === "Episode";
        const display = continuingEpisode ? item : title;
        const name = continuingEpisode && item.SeriesName ? `${item.SeriesName}, ${item.Name}` : display.Name;
        const b = button("", () => openSeries(title, b, item.ParentIndexNumber));
        b.className = "movie-card";
        b.dataset.itemId = display.Id;
        const artwork = cardArtwork(display);
        const watched = progressOf(item);
        if (watched > 0 && watched < 100) {
            const track = el("span"), fill = el("span");
            track.className = "movie-progress";
            track.setAttribute("aria-hidden", "true");
            fill.style.width = watched + "%";
            track.append(fill);
            artwork.append(track);
        }
        const caption = el("span"), titleText = el("span", name);
        caption.className = "movie-caption";
        titleText.className = "movie-card-name";
        caption.append(titleText);
        if (searchResult) {
            const action = el("span", title.Type === "Series" ? "Seasons" : "Details");
            action.className = "movie-search-play";
            action.setAttribute("aria-hidden", "true");
            caption.append(action);
        }
        b.append(artwork, caption);
        attachCardDownload(b, title.Name);
        return b;
    }
    const browseShelves = [];
    function placeBrowseCards() {
        const visible = new Map(), placed = new Set();
        const focused = document.activeElement;
        let focusKey, fallback, originalShelf;
        for (const shelf of browseShelves) {
            const {section, heading, rows, cards, more, resume} = shelf;
            if (rows.contains(focused)) {
                focusKey = focused.dataset.titleKey;
                fallback = heading;
                originalShelf = shelf;
            } else if (section.contains(focused)) fallback = heading;
            const keep = new Set();
            for (const [key, node] of cards) {
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
            section.hidden = !keep.size && more.hidden && !shelf.failed;
            shelf.updateArrows();
        }
        if (fallback && (!focused.isConnected || focused.closest("[hidden]"))) {
            const original = originalShelf?.cards.get(focusKey);
            const replacement = original?.isConnected ? original : visible.get(focusKey);
            (replacement || (!fallback.closest("[hidden]") ? fallback : submit)).focus({preventScroll: true});
        }
    }
    function shelf(title, type, resume = false, parent = browse, term = "", signal = life.signal, extra = {}) {
        const grid = !!term, section = el("section"), heading = el("h2", title), rows = el("div");
        section.className = "movie-shelf";
        rows.className = "movie-cards";
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
        const state = { section, heading, rows, more, cards, resume, updateArrows: () => {}, load, items: [] };
        if (!grid) browseShelves.push(state);
        section.append(heading, rows, outage.card, more); parent.append(section);
        if (!grid) {
            const lane = el("div"), viewport = el("div");
            lane.className = "movie-shelf-lane";
            viewport.className = "movie-shelf-scroll";
            rows.before(lane);
            lane.append(viewport);
            viewport.append(rows);
            const arrows = [-1, 1].map(direction => {
                const arrow = button("", event => {
                    if (event.currentTarget.getAttribute("aria-disabled") === "true") return;
                    viewport.scrollBy({left: direction * viewport.clientWidth * .85, behavior: quietMotion() ? "auto" : "smooth"});
                });
                arrow.className = "movie-shelf-arrow";
                arrow.setAttribute("aria-label", (direction < 0 ? "Previous " : "Next ") + title.toLowerCase());
                arrow.append(icon(direction < 0 ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"));
                return arrow;
            });
            lane.append(...arrows);
            state.updateArrows = () => {
                const room = viewport.scrollWidth - viewport.clientWidth;
                if (room <= 1 && arrows.includes(document.activeElement))
                    (rows.firstElementChild ?? heading).focus({preventScroll: true});
                arrows[0].setAttribute("aria-disabled", String(viewport.scrollLeft < 1));
                arrows[1].setAttribute("aria-disabled", String(viewport.scrollLeft >= room - 1));
                for (const arrow of arrows) arrow.tabIndex = arrow.getAttribute("aria-disabled") === "true" ? -1 : 0;
                lane.dataset.overflow = String(room > 1);
            };
            if (globalThis.ResizeObserver) {
                const resize = new ResizeObserver(state.updateArrows);
                resize.observe(viewport);
                signal.addEventListener("abort", () => resize.disconnect(), {once: true});
            } else window.addEventListener("resize", state.updateArrows, {signal});
            viewport.addEventListener("scroll", state.updateArrows, {passive: true});
        }
        let offset = 0, busy = false;
        async function load(reset, quiet = false, bounded = signal, batch = false) {
            if (busy || !active) return;
            busy = true; more.setAttribute("aria-disabled", "true");
            try {
                const fetchPage = batch ? request : searchLibrary;
                const page = await (extra.page?.() ?? fetchPage(resume ? "UserItems/Resume" : "Items", {userId: session.user,
                    recursive:true, includeItemTypes:type, startIndex:reset ? 0 : offset, limit:20, enableUserData:true, enableImages:true, enableImageTypes:"Primary,Thumb,Backdrop", imageTypeLimit:1,
                    ...(term ? {searchTerm:term} : {}),
                    ...(resume ? {mediaTypes:"Video"} : {sortBy:"SortName",sortOrder:"Ascending"}),
                    ...extra.params}, undefined, bounded));
                if (!active || signal.aborted) return;
                if (!Array.isArray(page?.Items)) throw Error("Invalid library page");
                if (reset && !grid && JSON.stringify(state.items) === JSON.stringify(page.Items) && state.loaded && !state.failed) return;
                if (reset) { offset = 0; cards.clear(); }
                state.items = reset ? page.Items : [...state.items, ...page.Items];
                const wasFocused = document.activeElement === more;
                let first;
                for (const item of page.Items) {
                    const key = titleKey(item);
                    if (cards.has(key) || extra.accept && !extra.accept(item, page)) continue;
                    const node = card(item, grid, resume);
                    node.dataset.titleKey = key;
                    cards.set(key, node);
                    if (grid) rows.append(node);
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
                if (term && reset) {
                    const count = page.TotalRecordCount ?? offset;
                    status.textContent = count ? `${cards.size} in your library` : "";
                    if (!count && extra.noMatch) {
                        extra.noMatch();
                        if (wasFocused) submit.focus();
                        section.hidden = true;
                        return;
                    }
                    if (count && extra.match && !page.Items.some(extra.match)) extra.noMatch?.();
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
                    extra.noMatch?.();
                }
            } finally { busy = false; more.removeAttribute("aria-disabled"); }
        }
        more.hidden = true;
        if (grid) void load(true);
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
        let titleDetails = {}, videoCards = [];
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
        const web = el("section"), downloads = el("section");
        web.className = "movie-source movie-youtube";
        downloads.className = "movie-source";
        web.hidden = downloads.hidden = true;
        panel.append(downloads);
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
        if (session.release_search_enabled) {
            call("MovieMatches", term).then(reply => {
                const list = Array.isArray(reply?.matches) ? reply.matches : [];
                if (!list.length || !alive()) return;
                const matchShelf = el("section"), grid = el("div"), credit = el("p", "Posters and details from TMDB. " + tmdbAttribution);
                matchShelf.className = "movie-matches";
                matchShelf.setAttribute("aria-label", "Matching titles");
                grid.className = "movie-matches-grid";
                credit.className = "movie-source-note movie-matches-credit";
                for (const item of list) {
                    const pick = button("", () => {
                        const season = /\s+(?:season\s+|s)(\d{1,3})$/i.exec(term);
                        query.value = item.kind === "tv" && season ? `${item.title} S${season[1].padStart(2, "0")}`
                            : item.kind === "tv" || !item.year ? item.title : `${item.title} ${item.year}`;
                        startSearch(findRelease);
                    });
                    pick.className = "movie-match";
                    const art = el("span");
                    art.className = "movie-art";
                    art.style.setProperty("--art-hue", titleHue(item.title));
                    art.dataset.initial = [...item.title.trim()][0]?.toUpperCase() ?? "";
                    if (item.poster) {
                        const image = el("img");
                        image.alt = "";
                        image.loading = "lazy";
                        image.decoding = "async";
                        image.referrerPolicy = "no-referrer";
                        image.onerror = () => image.remove();
                        image.src = item.poster;
                        art.append(image);
                    }
                    const caption = el("span", item.title), meta = el("span", [item.year, item.kind === "tv" ? "Series" : "Film"].filter(Boolean).join(", "));
                    caption.className = "movie-caption";
                    meta.className = "movie-match-meta";
                    pick.append(art, caption, meta);
                    pick.setAttribute("aria-label", `Search for ${item.title}${item.year ? ` (${item.year})` : ""}`);
                    attachCardDownload(pick, item.title);
                    grid.append(pick);
                }
                matchShelf.append(el("h2", "Matching titles"), grid, credit);
                // The release cards carry the posters, so the matches only feed them.
                release?.setMatches(list);
            }).catch(() => {});
        }
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
                const videos = candidates.filter(fullMatch);
                const details = videos.some(item => !item.height) && alive() ? await enrichVideos(candidates) : null;
                const videaMatches = videaFailed ? [] : videa?.season ? [videa.season] : videa?.results || [];
                const ranked = [
                    ...(torrentFailed ? [] : torrents?.results || []),
                    ...videaMatches.map(item => ({...item, site: "Videa"})),
                    ...videos.map(item => ({...item, site: "YouTube", height: item.height || details?.results?.[item.url.slice(-11)]?.height}))
                ];
                if (!ranked.length && (torrentFailed || videaFailed)) {
                    return {error: [torrentFailed && (torrents?.error || "Release lookup did not respond."),
                        videaFailed && (videa?.error || "Videa did not respond.")].filter(Boolean).join(" ")};
                }
                return {results: ranked, title_details: torrents?.title_details || youtube?.title_details, unavailable: (torrents?.unavailable || 0) + Number(torrentFailed) + Number(videaFailed)};
            }, signal, session.downloads_enabled ? async row => {
                const reply = row.episodes
                    ? await call("MovieVideaSeasonDownload", row.name, row.episodes)
                    : row.site
                    ? await call(row.site === "Videa" ? "MovieVideaDownload" : "MovieYouTubeDownload", row.url, row.title)
                    : await call("MovieDownload", row.guid, row.indexerId, row.title);
                if (reply?.state === "sent") refreshDownloadsAfterGrab();
                return reply;
            } : null, showDetails, readMoviePreferences(preferenceViewer).audio) : null;
        if (release) panel.append(release.element);
        panel.append(web);
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
        function videoCard(video) {
            const row = el("li"), art = el("div"), image = el("img"), content = el("div");
            row.className = "movie-release movie-youtube-card";
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
            badges.append(quality, match);
            const actions = el("div"), link = el("a", "Watch on YouTube");
            actions.className = "movie-youtube-actions";
            link.className = "movie-source-action";
            link.append(icon("M13 5h6v6m0-6-9 9m6-1v5H6V8h5"));
            const watchUrl = typeof video.url === "string" && /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(video.url) ? video.url : null;
            if (watchUrl) link.href = watchUrl;
            link.rel = "noopener noreferrer";
            link.target = "_blank";
            link.onclick = event => {
                event.preventDefault();
                link.focus();
                if (watchUrl) Promise.resolve(app.invokeMethodAsync("MovieOpenLink", watchUrl))
                    .catch(() => window.open(watchUrl, "_blank", "noopener,noreferrer"));
            };
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
                web.append(heading, status);
                if (!session.downloads_enabled) web.append(el("p", "Downloading is not switched on for your profile."));
                web.append(list);
                web.hidden = false;
                status.textContent = videos.length === 1 ? "1 video found." : `${videos.length} videos found.`;
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
        if (session.requests_enabled) searches.push(findDownloads());
        if (release) searches.push(release.load());
        let shown = false, outstanding = searches.length;
        for (const search of searches) search.then(found => {
            if (!alive()) return;
            shown ||= found;
            outstanding--;
            if (!outstanding) {
                message.classList.remove("is-checking");
                message.textContent = shown ? "" : "No watch or download options found. Try another title.";
                if (findRelease) status.textContent = "";
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
    submit.append(icon("M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"));
    const browse = el("div"), results = el("div");
    results.className = "movie-search-results";
    const clear = button("", () => { query.value = ""; query.focus(); resetSearch(); });
    clear.setAttribute("aria-label", "Clear");
    clear.append(icon("M6 6l12 12M18 6 6 18"));
    clear.hidden = true;
    let searchRequest;
    function resetSearch() {
        closeSeries(query);
        searchRequest?.abort();
        if (results.contains(document.activeElement)) submit.focus();
        clear.hidden = true;
        results.replaceChildren();
        browse.hidden = false;
        status.textContent = "";
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
    function startSearch(findRelease = false) {
        closeSeries(submit);
        resetSearch();
        const term = query.value.trim();
        if (!term) return;
        submit.focus();
        clear.hidden = false;
        browse.hidden = true;
        searchRequest = new AbortController();
        status.textContent = findRelease ? `Searching for ${term}…` : "Searching…";
        const signal = searchRequest.signal;
        if (findRelease) {
            form.scrollIntoView({block: "nearest"});
            externalResults(term, signal, true);
            return;
        }
        const season = /^(.+?)\s+(?:season\s+|s)(\d{1,3})$/i.exec(term);
        let searchedOtherSources = false;
        const noMatch = () => {
            if (searchedOtherSources || term.length < 2) return;
            searchedOtherSources = true;
            externalResults(term, signal);
        };
        shelf("In your library", "Movie,Series,Episode", false, results, term, signal, {
            noMatch,
            match: season ? undefined : item => [item.Name, item.SeriesName].some(name => name && searchTitle(name) === searchTitle(term)),
            page: season ? () => findSeason(season[1], Number(season[2]), signal) : undefined
        });
    }
    form.onsubmit = event => { event.preventDefault(); startSearch(); };
    query.oninput = () => { if (!query.value.trim()) resetSearch(); else clear.hidden = false; };
    life.signal.addEventListener("abort", () => { searchRequest?.abort(); seriesView?.controller.abort(); }, {once:true});
    form.append(query, clear, submit);
    const toolbar = el("div");
    toolbar.className = "movie-toolbar";
    toolbar.append(form);
    const catalogue = el("div"), downloadsPanel = el("section");
    catalogue.className = "movie-catalogue";
    downloadsPanel.className = "movie-downloads";
    downloadsPanel.setAttribute("aria-label", "Downloading");
    const queue = el("ul");
    catalogue.append(browse, results);
    if (session.downloads_enabled) {
        downloadsPanel.hidden = true;
        downloadsPanel.append(el("h2", "Downloading"), queue);
        catalogue.prepend(downloadsPanel);
    }
    library.append(toolbar, catalogue);

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
    const skeleton = movieSkeleton();
    function movieSkeleton() {
        const node = el("div");
        node.className = "movie-home-skeleton";
        node.setAttribute("aria-hidden", "true");
        node.append(el("span"), el("span"));
        return node;
    }
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
    browse.append(featured);
    const fields = "Overview,Genres,ProviderIds";
    const resumeShelf = shelf("Continue watching", "Movie,Episode", true, browse, "", life.signal,
        {singlePage: true, params: {fields}});
    const tvShelf = shelf("TV series", "Series", false, browse, "", life.signal, {params: {fields}});
    const moviesShelf = shelf("Movies", "Movie", false, browse, "", life.signal, {params: {fields}});
    const recentShelf = shelf("Recently added", "Movie,Series", false, browse, "", life.signal,
        {params: {fields, sortBy: "DateCreated", sortOrder: "Descending"}, singlePage: true});
    const genreOutage = createServiceStatus({
        detail: "Reconnect to load movie genres.", label: "Retry genres", retry: refreshGenres,
        focus: () => browse, automatic: true
    });
    const genreRetry = genreOutage.card;
    browse.append(genreRetry, empty);
    catalogue.prepend(skeleton);
    browse.hidden = true;
    toolbar.hidden = true;
    requestAnimationFrame(() => { if (!homeReady && active) homeStatus.textContent = "Loading movies and TV…"; });
    let genreShelves = [], genresLoaded = false, loadingHome = false, homeReady = false;

    function renderHome() {
        placeBrowseCards();
        const pick = resumeShelf.items.find(item => progressOf(item) > 0) ??
            recentShelf.items.find(item => item.Type === "Movie" && backdropSources(item).length) ??
            recentShelf.items[0] ?? moviesShelf.items[0] ?? tvShelf.items[0];
        empty.hidden = !!pick || !!browseShelves.some(shelf => shelf.cards.size || shelf.failed) || !genreRetry.hidden;
        if (!pick) {
            if (featured.contains(document.activeElement)) browse.focus({preventScroll: true});
            featured.hidden = true;
            featured.replaceChildren();
            return;
        }
        const identity = JSON.stringify(pick);
        if (featured.dataset.selection === identity && !featured.hidden) return;
        const focusClass = featured.contains(document.activeElement) ? document.activeElement.className : "";
        featured.dataset.selection = identity;
        const art = movieBackdrop(pick), body = el("div"), actions = el("div");
        body.className = "movie-hero-body";
        actions.className = "movie-hero-actions";
        featured.style.setProperty("--art-hue", titleHue(pick.SeriesName || pick.Name));
        const heading = el("h2", pick.SeriesName ? `${pick.SeriesName}, ${pick.Name}` : pick.Name);
        heading.id = "movie-featured-title";
        heading.className = "movie-hero-title";
        featured.setAttribute("aria-labelledby", heading.id);
        const facts = [pick.ProductionYear, pick.OfficialRating, formatMinutes(pick.RunTimeTicks / 6e8),
            ...(pick.Genres ?? []).slice(0, 3)].filter(Boolean);
        body.append(heading);
        if (facts.length) {
            const meta = el("p", facts.join(", "));
            meta.className = "movie-hero-meta";
            body.append(meta);
        }
        if (pick.Overview) {
            const overview = el("p", pick.Overview);
            overview.className = "movie-hero-overview";
            body.append(overview);
        }
        const details = button(pick.Type === "Series" ? "Seasons" : "Details",
            () => openSeries(seriesCardItem(pick), details, pick.ParentIndexNumber));
        details.className = "movie-hero-details";
        details.dataset.itemId = titleKey(pick);
        if (pick.Type !== "Series") {
            const play = playAction(pick);
            play.setAttribute("aria-describedby", heading.id);
            play.prepend(icon(playPath));
            actions.append(play);
        }
        actions.append(details);
        body.append(actions);
        const watched = progressOf(pick);
        if (watched > 0 && watched < 100) {
            const track = el("span"), fill = el("span");
            track.className = "movie-progress movie-hero-progress";
            track.setAttribute("aria-hidden", "true");
            fill.style.width = watched + "%";
            track.append(fill);
            body.append(track);
        }
        featured.replaceChildren(art, body);
        featured.hidden = false;
        if (focusClass) (Array.from(actions.children).find(node => node.className === focusClass) ?? details).focus({preventScroll: true});
    }
    async function loadGenres(bounded, quiet) {
        try {
            if (!genresLoaded) {
                const page = await request("Genres", {userId: session.user, includeItemTypes: "Movie", sortBy: "SortName"}, undefined, bounded);
                if (!Array.isArray(page?.Items)) throw Error("Invalid genres");
                const names = page.Items.slice(0, 6).map(genre => genre.Name);
                genreShelves = names.map(name => shelf(name, "Movie", false, browse, "", life.signal, {
                    params: {genres: name, fields},
                    accept: item => (names.find(genre => item.Genres?.some(value => searchTitle(value) === searchTitle(genre))) ?? name) === name
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
                ...[resumeShelf, tvShelf, moviesShelf, recentShelf].map(shelf => shelf.load(true, quiet, bounded, true)),
                loadGenres(bounded, quiet),
                quiet ? undefined : updateDownloads(bounded),
                quiet ? seriesView?.refreshProgress?.() : undefined
            ]), life.signal, homeReady ? 9500 : homeBudget);
            if (!active) return;
            renderHome();
            if (!homeReady) {
                homeReady = true;
                skeleton.remove();
                browse.hidden = toolbar.hidden = false;
                homeStatus.textContent = browseShelves.some(shelf => shelf.failed) || !genreRetry.hidden ? "" : "Movies and TV loaded.";
                if (document.activeElement === entryFocus || document.activeElement === document.body || host.contains(document.activeElement))
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
    void refreshHome();
    // Arrow keys (and a TV remote's directional pad) move between cards, rows and the billboard.
    library.addEventListener("keydown", event => {
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        const current = event.target;
        if (!arrows || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
            || !current.matches?.(".movie-card, .movie-hero-play, .movie-hero-details")) return;
        const catalogue = browse.hidden ? results : browse;
        const groups = [];
        for (const group of catalogue.querySelectorAll(".movie-hero:not([hidden]) .movie-hero-actions, .movie-shelf:not([hidden]) .movie-cards")) {
            let row, top;
            for (const card of group.querySelectorAll(".movie-card, .movie-hero-play, .movie-hero-details")) {
                const y = card.getBoundingClientRect().top;
                if (!row || Math.abs(y - top) > 8) { row = []; groups.push(row); top = y; }
                row.push(card);
            }
        }
        const index = groups.findIndex(group => group.includes(current));
        if (index < 0) return;
        let target;
        if (arrows[0]) target = groups[index][groups[index].indexOf(current) + arrows[0]];
        else {
            const x = current.getBoundingClientRect().left;
            const next = groups[index + arrows[1]];
            target = next?.reduce((best, node) =>
                Math.abs(node.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? node : best);
        }
        if (!target) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: arrows[1] ? "center" : "nearest", inline: "nearest", behavior: quietMotion() ? "auto" : "smooth" });
    });
    return { connectionChanged, async close() {
        if (!active) return;
        active = false;
        const leaving = leavePlayer();
        life.abort();
        stop();
        await leaving;
        await reports;
        try { await app.invokeMethodAsync("MovieCloseMedia", session.media_ticket); } catch {}
    } };
}
