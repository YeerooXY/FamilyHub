import { buildPlayerUi } from "./movie-player-ui.js";
import { buildReleaseSearch, cleanResultTitle, formatMinutes, videoQualityTier } from "./movie-releases.js";

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
const dataChoices = [
    ["auto", "Auto", "Full on Wi-Fi, Saver on mobile data"],
    ["full", "Full quality", "Varies by movie"],
    ["good", "Good", "720p · about 1.1 GB an hour"],
    ["saver", "Saver", "480p · about 0.45 GB an hour"],
    ["lowest", "Lowest", "360p · about 0.25 GB an hour"]
];
const dataLimits = {
    good: { bitrate: 2500000, height: 720 },
    saver: { bitrate: 1000000, height: 480, audioBitrate: 96000 },
    lowest: { bitrate: 500000, height: 360, audioBitrate: 96000 }
};

function normalizeMoviePreferences(prefs) {
    return {
        audio: ["hu", "en"].includes(prefs?.audio) ? prefs.audio : "default",
        subtitles: ["off", "hu", "en"].includes(prefs?.subtitles) ? prefs.subtitles : "default",
        dataSaver: dataChoices.some(([id]) => id === prefs?.dataSaver) ? prefs.dataSaver : "auto"
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

export function openMovies(host, session, app, viewer) {
    const base = new URL(session.url.replace(/\/?$/, "/"));
    const headers = { Authorization:
        `MediaBrowser Client="FamilyHub", Device="FamilyHub Movies", DeviceId="${session.device}", Version="1", Token="${session.token}"` };
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
        const res = await fetch(url(path, params), { method: body ? "POST" : "GET", signal: signal ?? timeoutSignal(8000),
            headers: { ...headers, "Content-Type": "application/json" }, referrerPolicy: "no-referrer",
            credentials: "omit", redirect: "error", body: body ? JSON.stringify(body) : undefined });
        if (!res.ok) throw Error("Jellyfin request failed");
        return res.status === 204 ? null : JSON.parse(await res.text() || "null");
    };
    async function searchLibrary(path, params, body, signal) {
        const bounded = new AbortController();
        const cancel = () => bounded.abort();
        const timer = setTimeout(cancel, 8000);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, {once: true});
        try { return await request(path, params, body, bounded.signal); }
        finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    }
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
    function select(container, name, options) {
        const label = el("label", name), pick = el("select");
        for (const [value, text] of options) pick.add(new Option(text, value));
        label.append(pick);
        container.append(label);
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
    const icon = (path, flip) => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("class", "movie-icon");
        const shape = document.createElementNS(svg.namespaceURI, "path");
        shape.setAttribute("d", path);
        svg.append(shape);
        if (flip) svg.style.transform = "scaleX(-1)";
        return svg;
    };
    const playPath = "M7 4.5v15l12-7.5z", chevronPath = "M9 5l7 7-7 7";
        const quietMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    const seriesCache = new Map();
    function seriesEpisodes(item) {
        if (!seriesCache.has(item.SeriesId))
            seriesCache.set(item.SeriesId, request(`Shows/${encodeURIComponent(item.SeriesId)}/Episodes`,
                { userId: session.user, fields: "RunTimeTicks", enableUserData: true }).then(page => page?.Items ?? null).catch(() => null));
        return seriesCache.get(item.SeriesId);
    }
    // The player always covers the whole window. The browser's own fullscreen is tried too, but the Android app's
    // WebView has none, so the page layout does the work. Entering is asynchronous: drop a late fullscreen if the
    // viewer already left.
    let fullscreenRequest = null;
    function enterPlayer() {
        player.classList.add("movie-expanded");
        document.documentElement.classList.add("movie-expanded-page");
        if (document.fullscreenElement !== player && !fullscreenRequest)
            fullscreenRequest = Promise.resolve(player.requestFullscreen?.({ navigationUI: "hide" })).catch(() => {});
        screen.orientation?.lock?.("landscape").catch(() => {});
        // The Android app turns the screen to landscape and hides the system bars; a browser ignores the call.
        Promise.resolve(app.invokeMethodAsync("MovieScreen", true)).catch(() => {});
    }
    // Resolves once the browser has left fullscreen: elements outside the fullscreen player cannot take focus before.
    async function leavePlayer() {
        player.classList.remove("movie-expanded");
        document.documentElement.classList.remove("movie-expanded-page");
        screen.orientation?.unlock?.();
        Promise.resolve(app.invokeMethodAsync("MovieScreen", false)).catch(() => {});
        await fullscreenRequest;
        fullscreenRequest = null;
        if (document.fullscreenElement === player) await document.exitFullscreen?.().catch(() => {});
    }
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
        const { audioIndex, position, paused } = options;
        if (player.contains(document.activeElement)) player.focus({ preventScroll: true });
        stop();
        const rev = selection;
        const prefs = readMoviePreferences(preferenceViewer);
        prefs.dataSaver = options.dataSaver ?? prefs.dataSaver;
        status.textContent = "Opening " + item.Name + "…";
        if (player.classList.contains("movie-expanded")) {
            const loading = el("p", status.textContent);
            loading.className = "movie-ui-message movie-ui-line";
            loading.setAttribute("role", "status");
            player.append(loading);
        }
        const media = el("video");
        const nativeHls = !!media.canPlayType("application/vnd.apple.mpegurl");
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
            const playbackInfo = (sourceId, index) => request("Items/" + item.Id + "/PlaybackInfo", {userId: session.user}, {
                UserId: session.user, DeviceProfile: profile,
                ...(sourceId ? {MediaSourceId: sourceId, SubtitleStreamIndex: -1} : {}),
                ...(index != null ? {AudioStreamIndex: index} : {}),
                ...(limit ? { MaxStreamingBitrate: limit.bitrate, AllowVideoStreamCopy: false, AllowAudioStreamCopy: false } : {}),
                ...(limit?.audioBitrate ? { MaxAudioChannels: 2 } : {}),
                EnableDirectPlay: !limit && index == null, EnableDirectStream: !limit, EnableTranscoding: true });
            const readResume = async () => {
                await pendingReportsByItem.get(item.Id);
                if (active && rev === selection) return request("Items/" + item.Id, {userId: session.user});
            };
            const [resultInfo, freshItem] = await Promise.all([
                playbackInfo(),
                position == null ? readResume() : null
            ]);
            if (!active || rev !== selection) return;
            let result = resultInfo;
            const resume = position ?? (freshItem?.UserData?.PlaybackPositionTicks || 0) / 1e7;
            let source = result.MediaSources?.[0];
            if (!source) throw Error();
            const audioLanguage = prefs.audio;
            const audio = (source.MediaStreams || []).filter(s => s.Type === "Audio");
            const preferredAudio = preferredTrack(audio, audioLanguage);
            const defaultAudio = source.DefaultAudioStreamIndex ?? audio.find(s => s.IsDefault)?.Index ?? audio[0]?.Index;
            const defaultSubtitle = source.DefaultSubtitleStreamIndex;
            const requestedAudio = audioIndex ?? preferredAudio?.Index;
            let selectedAudio = defaultAudio;
            let direct = !limit && source.SupportsDirectPlay;
            // A static stream leaves audio selection to the browser. Ask Jellyfin to select the track on multi-audio files.
            const customAudio = audio.length > 1 ? requestedAudio : undefined;
            if (customAudio != null || (!direct && defaultSubtitle >= 0)) {
                const playback = await playbackInfo(source.Id, customAudio).catch(() => null);
                if (!active || rev !== selection) return;
                const configured = playback?.MediaSources?.[0];
                if (configured?.TranscodingUrl || (!limit && configured?.SupportsDirectPlay && customAudio == null)) {
                    selectedAudio = configured.DefaultAudioStreamIndex ?? requestedAudio ?? defaultAudio;
                    direct = !limit && configured.SupportsDirectPlay && customAudio == null;
                    result = playback;
                    source = configured;
                } else if (!direct && defaultSubtitle >= 0) {
                    throw Error();
                }
            }
            const path = direct ? "Videos/" + item.Id + "/stream" : source.TranscodingUrl;
            if (!path) throw Error();
            const stream = url(path.startsWith(base.pathname) ? path.slice(base.pathname.length) : path, {api_key: session.token, mediaSourceId: source.Id, playSessionId: result.PlaySessionId});
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
            const controls = el("div");
            controls.className = "movie-track-controls";
            const audioPick = audio.length > 1 ? select(controls, "Audio track",
                audio.map(track => [track.Index, track.DisplayTitle || track.Language || "Audio"])) : null;
            if (audioPick) {
                audioPick.value = String(selectedAudio);
                audioPick.onchange = () => play(item, opener, { sheet: "tracks", audioIndex: Number(audioPick.value),
                    position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                    subtitleIndex: playback.subtitleOverride, dataSaver: playback.dataSaver });
            }
            const subtitleOptions = subtitles.map(track => [track.Index, track.DisplayTitle || track.Language || "Subtitles"]);
            const subtitlePick = select(controls, "Subtitle track", [[-1, "Off"], ...subtitleOptions]);
            const notice = el("p");
            notice.setAttribute("role", "status");
            media.controls = false; media.playsInline = true; media.preload = "metadata";
            media.className = "movie-video";
            media.crossOrigin = "anonymous";
            media.setAttribute("aria-label", item.Name);
            const textTracks = new Map();
            function addSubtitleTrack(s) {
                const track = el("track"); track.kind = "subtitles"; track.label = s.DisplayTitle || s.Language || "Subtitles";
                track.srclang = s.Language || "und";
                track.src = url(`Videos/${item.Id}/${source.Id}/Subtitles/${s.Index}/Stream.vtt`, {api_key:session.token});
                media.append(track);
                textTracks.set(s.Index, track.track);
            }
            for (const subtitle of subtitles) addSubtitleTrack(subtitle);
            const playback = { item, source, id: result.PlaySessionId, dataSaver: prefs.dataSaver,
                method: direct ? "DirectPlay" : limit || source.TranscodeReasons?.length ? "Transcode" : "DirectStream" };
            playback.setSubtitles = (index) => {
                playback.subtitleOverride = index;
                const language = prefs.subtitles;
                const preferred = preferredTrack(subtitles, language);
                const unavailable = index == null && languageCodes[language] && !preferred;
                const selected = index ?? (language === "default" ? defaultSubtitle : preferred?.Index);
                const activeSubtitle = textTracks.has(selected) ? selected : -1;
                for (const [trackIndex, track] of textTracks)
                    track.mode = trackIndex === activeSubtitle ? "hidden" : "disabled"; // hidden: the player draws the cues itself
                subtitlePick.value = String(activeSubtitle);
                const audioFallback = audioIndex == null && audioLanguage !== "default" && (!preferredAudio || preferredAudio.Index !== selectedAudio);
                notice.textContent = [
                    audioFallback ? `${labels[audioLanguage]} audio unavailable. Using the default track.` : "",
                    audioIndex != null && audioIndex !== selectedAudio ? "Selected audio track unavailable. Using the default track." : "",
                    unavailable ? `${labels[language]} subtitles unavailable. Subtitles are off.` : ""
                ].filter(Boolean).join(" ");
            };
            subtitlePick.onchange = () => playback.setSubtitles(Number(subtitlePick.value));
            current = playback; video = media; library.hidden = true;
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
            media.onerror = () => { if (current === playback) { status.textContent = "This device could not play this version."; ui?.say("This device could not play this version."); note("playback-error", playback.method); } };
            if (!direct && !nativeHls && hls) {
                playback.hls = new Hls({ startPosition: resume, enableWorker: false });
                playback.hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (data.fatal && current === playback) media.onerror();
                });
                playback.hls.loadSource(stream.href);
                playback.hls.attachMedia(media);
            } else {
                media.src = stream;
            }
            let ui;
            const numbered = item.ParentIndexNumber != null && item.IndexNumber != null;
            playerLife = new AbortController();
            const playerSignal = playerLife.signal;
            const subtitleItem = /^[a-f\d]{32}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(source.Id) ? source.Id : item.Id;
            const subtitlePath = `Items/${encodeURIComponent(subtitleItem)}`;
            const remote = subtitlePath + "/RemoteSearch/Subtitles/";
            const subtitleSearch = {
                language: prefs.subtitles === "hu" ? "hun" : "eng",
                find: language => searchLibrary(remote + language, {}, undefined, playerSignal),
                async add(result, language) {
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
                        for (const node of media.querySelectorAll("track")) node.remove();
                        subtitles.splice(0, subtitles.length, ...refreshed);
                        textTracks.clear();
                        subtitlePick.replaceChildren(new Option("Off", -1));
                        for (const stream of subtitles) {
                            addSubtitleTrack(stream);
                            subtitlePick.add(new Option(stream.DisplayTitle || stream.Language || "Subtitles", stream.Index));
                        }
                        playback.setSubtitles(track.Index);
                        return;
                    }
                    throw Error("Subtitle track unavailable");
                }
            };
            const restartQuality = (dataSaver, sheet) => play(item, opener, {
                dataSaver, sheet, audioIndex, subtitleIndex: playback.subtitleOverride,
                position: metadataLoaded ? media.currentTime : resume, paused: media.paused
            });
            let qualityChange = 0;
            playback.refreshQuality = async () => {
                if (playback.dataSaver !== "auto") return;
                const change = ++qualityChange;
                const nextQuality = await qualityFor("auto");
                if (current === playback && change === qualityChange && playback.dataSaver === "auto" && nextQuality !== quality)
                    return restartQuality("auto", ui.openSheetName());
            };
            const originalGb = (resultInfo.MediaSources[0].Bitrate ?? 0) * 3600 / 8e9;
            const dataSaver = {
                choices: dataChoices.map(([id, label, estimate]) =>
                    [id, label, id === "full" && originalGb >= 0.05 ? `about ${originalGb.toFixed(1)} GB an hour` : estimate]),
                selected: prefs.dataSaver,
                quality: limit ? limit.height + "p, saving data" : "Full quality",
                async change(choice) {
                    if (!saveMoviePreferences(preferenceViewer, { ...readMoviePreferences(preferenceViewer), dataSaver: choice })) {
                        ui.say("This device could not save your movie preferences.");
                        return;
                    }
                    playback.dataSaver = choice;
                    ui.setDataSaver(choice);
                    const change = ++qualityChange;
                    const nextQuality = await qualityFor(choice);
                    if (current === playback && change === qualityChange && nextQuality !== quality)
                        return restartQuality(choice, "settings");
                }
            };
            ui = buildPlayerUi({ media, surface: player, back, signal: playerSignal, subtitleSearch, dataSaver,
                title: numbered ? `S${item.ParentIndexNumber}:E${item.IndexNumber} “${item.Name}”` : item.Name,
                kicker: item.SeriesName, trackControls: [controls], notice });
            player.replaceChildren(media, ui.root);
            enterPlayer();
            playback.setSubtitles(options.subtitleIndex);
            if (item.Type === "Episode" && item.SeriesId) {
                seriesEpisodes(item).then(list => {
                    if (current !== playback || !list) return;
                    const season = list.filter(episode => episode.ParentIndexNumber === item.ParentIndexNumber);
                    ui.setEpisodes(season.length > 1 ? season : list, item.Id, next => play(next, opener));
                    const after = list[list.findIndex(episode => episode.Id === item.Id) + 1];
                    playback.next = after;
                    ui.setNext(after, next => play(next, opener));
                });
            }
            if (options.sheet === "settings") ui.openSettingsAt();
            else if (options.sheet === "tracks") ui.openTracksAt();
            else ui.playButton.focus();
            if (quality === "saver" && prefs.dataSaver === "auto" && !autoHintShown) {
                autoHintShown = true;
                const key = preferencesKey(preferenceViewer) + ":data-saver-hint";
                let seen = false;
                try { seen = !!localStorage.getItem(key); localStorage.setItem(key, "1"); } catch {}
                if (!seen) ui.hint("Switched to Saver on mobile data.");
            }
            status.textContent = "";
            if (!paused) media.play().catch(() => {
                if (current === playback && !status.textContent) { status.textContent = "Press play to start."; ui?.say("Press play to start."); }
            });
            if (network !== connectionRevision) void playback.refreshQuality();
        } catch {
            if (active && rev === selection) {
                await leavePlayer();
                if (!active || rev !== selection) return;
                status.textContent = "Could not open this video. Try again.";
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
    function card(item, wide, searchResult = false) {
        const seriesPrefix = item.SeriesName?.trim().toLowerCase();
        const needsSeries = seriesPrefix && !item.Name.trim().toLowerCase().startsWith(seriesPrefix);
        const name = needsSeries ? `${item.SeriesName} · ${item.Name}` : item.Name;
        const b = button("", () => play(item, b));
        b.className = "movie-card";
        b.dataset.itemId = item.Id;
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
        const candidates = wide ? [...landscape, primary, ...series] : [primary, ...landscape, ...series];
        const images = new Set(candidates.filter(([id, , tag]) => id && tag).map(([id, type, tag]) =>
            url(`Items/${encodeURIComponent(id)}/Images/${type}`, { tag, maxWidth: wide ? 720 : 480 }).href));
        chainImages(poster, [...images]);
        const artwork = el("span");
        artwork.className = "movie-art";
        artwork.style.setProperty("--art-hue", titleHue(item.SeriesName || item.Name));
        artwork.dataset.initial = [...(item.SeriesName || item.Name).trim()][0]?.toUpperCase() ?? "";
        artwork.append(poster);
        const watched = progressOf(item);
        if (watched > 0 && watched < 100) {
            const track = el("span"), fill = el("span");
            track.className = "movie-progress";
            track.setAttribute("aria-hidden", "true");
            fill.style.width = watched + "%";
            track.append(fill);
            artwork.append(track);
        }
        const caption = el("span", name);
        caption.className = "movie-caption";
        if (searchResult) {
            const action = el("span", progressOf(item) > 0 && progressOf(item) < 100 ? "Resume" : "Play");
            action.className = "movie-search-play";
            action.setAttribute("aria-hidden", "true");
            caption.append(action);
        }
        b.append(artwork, caption);
        return b;
    }
    // A shelf is a horizontal row (Netflix style); `grid` lays search results out as a wrapping grid instead.
    // `extra` may set `params` (more query values), `lazy` (load when scrolled into view) and `hideEmpty`.
    function shelf(title, type, resume = false, parent = browse, term = "", signal = life.signal, extra = {}) {
        const grid = !!term, section = el("section"), heading = el("h2", title), rows = el("div");
        const wide = type !== "Movie";
        section.className = "movie-shelf";
        rows.className = grid ? (wide ? "movie-cards movie-cards-wide" : "movie-cards")
            : wide ? "movie-row movie-row-wide" : "movie-row";
        const more = button("Show more", () => load(offset === 0));
        more.className = "movie-more";
        heading.tabIndex = -1;
        let wrap = rows;
        if (!grid) {
            wrap = el("div");
            wrap.className = wide ? "movie-row-wrap movie-row-wrap-wide" : "movie-row-wrap";
            const side = (direction) => {
                const chev = button("", () => rows.scrollBy({ left: direction * rows.clientWidth * .85,
                    behavior: quietMotion() ? "auto" : "smooth" }));
                chev.className = "movie-chev movie-chev-" + (direction < 0 ? "left" : "right");
                chev.tabIndex = -1;
                chev.setAttribute("aria-hidden", "true");
                chev.append(icon(chevronPath, direction < 0));
                return chev;
            };
            const left = side(-1), right = side(1);
            const edges = () => {
                left.hidden = rows.scrollLeft < 4;
                right.hidden = rows.scrollLeft + rows.clientWidth >= rows.scrollWidth - 4;
                if (!more.hidden || busy || !hasMore) return;
                if (rows.scrollLeft + rows.clientWidth > rows.scrollWidth - rows.clientWidth * .6) load(false);
            };
            let queued = false;
            rows.addEventListener("scroll", () => {
                if (queued) return;
                queued = true;
                requestAnimationFrame(() => { queued = false; edges(); });
            }, { passive: true });
            new ResizeObserver(edges).observe(rows);
            life.signal.addEventListener("abort", () => rows.replaceChildren(), { once: true });
            wrap.append(rows, left, right);
            extra.afterPage = edges;
        }
        section.append(heading, wrap, more); parent.append(section);
        let offset = 0, busy = false, hasMore = false;
        async function load(reset) {
            if (busy || !active) return;
            busy = true; more.setAttribute("aria-disabled", "true");
            try {
                const fetchPage = term ? searchLibrary : request;
                const page = await (extra.page?.() ?? fetchPage(resume ? "UserItems/Resume" : "Items", {userId: session.user,
                    recursive:true, includeItemTypes:type, startIndex:reset ? 0 : offset, limit:40, enableUserData:true, enableImages:true, enableImageTypes:"Primary,Thumb,Backdrop", imageTypeLimit:1,
                    ...(term ? {searchTerm:term} : {}),
                    ...(resume ? {mediaTypes:"Video"} : {sortBy:"SortName",sortOrder:"Ascending"}),
                    ...extra.params}, undefined, signal));
                if (!active || signal.aborted) return;
                const focusedCard = reset && rows.contains(document.activeElement) ? document.activeElement : null;
                let successor;
                if (reset) { offset = 0; rows.replaceChildren(); }
                const wasFocused = document.activeElement === more;
                let first;
                for (const item of page.Items) {
                    const b = card(item, wide, grid);
                    rows.append(b); first ??= b;
                    if (item.Id === focusedCard?.dataset.itemId) successor ??= b;
                }
                offset += page.Items.length;
                hasMore = !(offset >= page.TotalRecordCount || page.Items.length < 40);
                more.hidden = !grid || !hasMore;
                more.textContent = "Show more";
                if (status.textContent === "Could not load " + title.toLowerCase() + ".") status.textContent = "";
                if (!offset && !term) {
                    if (extra.hideEmpty) section.hidden = true;
                    else rows.textContent = resume ? "No videos in progress." : "No titles yet.";
                }
                extra.afterPage?.();
                if (extra.hideWhenAtMost && !term && page.TotalRecordCount <= extra.hideWhenAtMost) section.hidden = true;
                if (term && reset) {
                    const count = page.TotalRecordCount ?? offset;
                    status.textContent = count ? `${count} in your library` : "";
                    if (!count && extra.noMatch) {
                        extra.noMatch();
                        if (wasFocused || focusedCard) submit.focus();
                        section.hidden = true;
                        return;
                    }
                    if (count && extra.match && !page.Items.some(extra.match)) extra.noMatch?.();
                }
                if (wasFocused || focusedCard) (successor || first || heading).focus();
            } catch {
                if (active && !signal.aborted) {
                    more.hidden = false;
                    more.textContent = term ? "Retry library search" : "Retry " + title.toLowerCase();
                    status.textContent = term ? "Could not search your library." : "Could not load " + title.toLowerCase() + ".";
                    extra.noMatch?.();
                }
            } finally { busy = false; more.removeAttribute("aria-disabled"); }
        }
        more.hidden = true;
        if (extra.lazy && "IntersectionObserver" in globalThis) {
            const watcher = new IntersectionObserver(entries => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                watcher.disconnect();
                load(true);
            }, { rootMargin: "300px 0px" });
            watcher.observe(section);
            life.signal.addEventListener("abort", () => watcher.disconnect(), { once: true });
        } else load(true);
        return () => load(true);
    }
    function externalResults(term, signal) {
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
        const release = session.release_search_enabled
            ? buildReleaseSearch(() => call("MovieReleaseSearch", term), signal,
                session.downloads_enabled ? async row => {
                    const reply = await call("MovieDownload", row.guid, row.indexerId, row.title);
                    if (reply?.state === "sent") refreshDownloadsAfterGrab();
                    return reply;
                } : null, showDetails) : null;
        if (release) panel.append(release.element);
        panel.append(web);

        const alive = () => active && !signal.aborted && panel.isConnected;
        const message = el("p", "Checking other sources…");
        message.className = "movie-source-note";
        message.setAttribute("role", "status");
        alternate.after(message);

        function retry(section, reason, label, run) {
            const line = el("p", reason), action = button(label, run);
            line.setAttribute("role", "status");
            section.replaceChildren(line, action);
            section.hidden = false;
        }
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
            link.href = video.url;
            link.rel = "noopener noreferrer";
            link.target = "_blank";
            link.onclick = event => {
                event.preventDefault();
                link.focus();
                Promise.resolve(app.invokeMethodAsync("MovieOpenLink", video.url))
                    .catch(() => window.open(video.url, "_blank", "noopener,noreferrer"));
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
                    notice.textContent = reply?.error || "Could not confirm the download. Check On the server before trying again.";
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
                meta.textContent = [details.uploader || video.uploader || video.channel, duration, views].filter(Boolean).join(" · ");
                const thumbnail = details.thumbnail || video.thumbnail;
                if (typeof thumbnail === "string" && thumbnail.startsWith("https://") && image.src !== thumbnail) {
                    image.src = thumbnail;
                    image.hidden = false;
                }
            }
            update(video);
            return {row, update, updateMatch, id: video.url.slice(-11)};
        }
        async function findVideos(event) {
            const trigger = event?.currentTarget;
            if (trigger?.getAttribute("aria-disabled") === "true") return true;
            if (trigger) {
                trigger.focus();
                trigger.setAttribute("aria-disabled", "true");
                trigger.textContent = "Checking YouTube…";
            }
            let reply;
            try { reply = await call("MovieFind", term); }
            catch { reply = {error: "YouTube did not respond."}; }
            if (!alive()) return false;
            if (reply?.error || !Array.isArray(reply?.results)) {
                const focused = trigger === document.activeElement;
                retry(web, reply?.error || "YouTube did not respond.", "Retry YouTube", findVideos);
                if (focused) web.querySelector("button").focus();
                return true;
            }
            showDetails(reply.title_details);
            const videos = reply.results.filter(item => typeof item.title === "string"
                && /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(item.url))
                .map(item => ({...item, title: cleanResultTitle(item.title)})).filter(item => item.title);
            const focused = trigger === document.activeElement;
            web.replaceChildren();
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
                const ids = cards.filter((_, index) => {
                    const video = videos[index];
                    return !video.height || !(video.duration ?? video.seconds);
                }).map(card => card.id);
                if (ids.length) {
                    call("MovieYouTubeMetadata", ids).then(details => {
                        if (!alive()) return;
                        for (const card of cards) {
                            const fresh = details?.results?.[card.id];
                            if (fresh) card.update(fresh);
                        }
                    }).catch(() => {});
                }
            }
            web.hidden = !web.children.length;
            if (focused) (web.querySelector("a") || submit).focus();
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
            details.append(el("h3", item.title), el("p", meta.join(" · ")), note);
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
        async function findDownloads(event) {
            const trigger = event?.currentTarget;
            if (trigger?.getAttribute("aria-disabled") === "true") return true;
            if (trigger) { trigger.setAttribute("aria-disabled", "true"); trigger.textContent = "Checking downloads…"; }
            let reply;
            try { reply = await call("MovieRequestSearch", term); }
            catch { reply = {error: "Download lookup did not respond."}; }
            if (!alive()) return false;
            if (reply?.error || !Array.isArray(reply?.results)) {
                const focused = trigger === document.activeElement;
                retry(downloads, reply?.error || "Download lookup did not respond.", "Retry download lookup", findDownloads);
                if (focused) downloads.querySelector("button").focus();
                return true;
            }
            const found = reply.results.slice(0, 12);
            showDetails(reply.title_details);
            const focused = trigger === document.activeElement;
            downloads.replaceChildren();
            downloads.hidden = !found.length;
            if (found.length) {
                const heading = el("h2", "Download options"), rows = el("ul");
                rows.className = "movie-source-list";
                rows.append(...found.map(item => requestRow(item, reply.season)));
                downloads.append(heading, rows);
            }
            if (focused) (downloads.querySelector("button") || submit).focus();
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
            if (shown) message.textContent = "";
            else if (!outstanding) message.textContent = "No watch or download options found. Try another title.";
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
        searchRequest?.abort();
        clear.hidden = true;
        results.replaceChildren();
        browse.hidden = false;
        status.textContent = "";
    }
    async function findSeason(title, season, signal) {
        const shows = await searchLibrary("Items", {userId: session.user, recursive: true, includeItemTypes: "Series",
            searchTerm: title, limit: 12}, undefined, signal);
        const matches = shows.Items.filter(item => item.Name.localeCompare(title, undefined, {sensitivity: "base"}) === 0);
        const pages = await Promise.all(matches.slice(0, 3).map(item =>
            searchLibrary(`Shows/${encodeURIComponent(item.Id)}/Episodes`, {userId: session.user, season, isMissing: false}, undefined, signal)));
        const items = pages.flatMap(page => page.Items).filter(item => item.ParentIndexNumber === season);
        return {Items: items, TotalRecordCount: items.length};
    }
    form.onsubmit = event => {
        event.preventDefault();
        resetSearch();
        const term = query.value.trim();
        if (!term) return;
        if (document.activeElement === query || document.activeElement === document.body) submit.focus();
        clear.hidden = false;
        browse.hidden = true;
        searchRequest = new AbortController();
        status.textContent = "Searching…";
        const signal = searchRequest.signal;
        const season = /^(.+?)\s+(?:season\s+|s)(\d{1,2})$/i.exec(term);
        let searchedOtherSources = false;
        const noMatch = () => {
            if (searchedOtherSources || term.length < 2) return;
            searchedOtherSources = true;
            externalResults(term, signal);
        };
        shelf("In your library", "Movie,Episode", false, results, term, signal, {
            noMatch,
            match: season ? undefined : item => [item.Name, item.SeriesName].some(name => name && searchTitle(name) === searchTitle(term)),
            page: season ? () => findSeason(season[1], Number(season[2]), signal) : undefined
        });
    };
    query.oninput = () => { if (!query.value.trim()) resetSearch(); else clear.hidden = false; };
    life.signal.addEventListener("abort", () => searchRequest?.abort(), {once:true});
    form.append(query, clear, submit);
    const toolbar = el("div");
    toolbar.className = "movie-toolbar";
    toolbar.append(form);
    const columns = el("div"), catalogue = el("div"), downloadsPanel = el("section");
    columns.className = "movie-library-columns";
    catalogue.className = "movie-catalogue";
    downloadsPanel.className = "movie-downloads";
    downloadsPanel.setAttribute("aria-label", "On the server");
    const queue = el("div");
    queue.append(el("p", "Checking server downloads…"));
    downloadsPanel.append(el("h2", "On the server"), queue);
    catalogue.append(browse, results);
    columns.append(downloadsPanel, catalogue);
    library.append(toolbar, columns);

    let queueTimer, checkingQueue = false, refreshAfterGrabAt = 0;
    const queueVisible = () => active && !document.hidden && !library.hidden && host.isConnected;
    function scheduleDownloads(delay) {
        clearTimeout(queueTimer);
        if (queueVisible()) queueTimer = setTimeout(updateDownloads, delay);
    }
    function refreshDownloadsAfterGrab() {
        // Let the server's three-second queue cache expire before checking for the new item.
        refreshAfterGrabAt = Date.now() + 3100;
        scheduleDownloads(3100);
    }
    async function updateDownloads() {
        if (!queueVisible() || checkingQueue) return;
        checkingQueue = true;
        if (Date.now() >= refreshAfterGrabAt) refreshAfterGrabAt = 0;
        let reply;
        try { reply = await call("MovieDownloads"); } catch {}
        checkingQueue = false;
        if (!queueVisible()) return;
        const itemsAvailable = reply?.available && Array.isArray(reply.items);
        if (!itemsAvailable) {
            queue.replaceChildren(el("p", reply?.reason || "The download server is unavailable."));
        } else if (!reply.items.length) {
            queue.replaceChildren(el("p", "No downloads on the server."));
        } else {
            const items = el("ul");
            for (const item of reply.items) {
                const tile = el("li"), bar = el("div"), fill = el("span");
                const progress = Math.max(0, Math.min(1, Number(item.progress) || 0));
                bar.className = "movie-download-progress";
                bar.setAttribute("role", "progressbar");
                bar.setAttribute("aria-label", item.name);
                bar.setAttribute("aria-valuenow", Math.round(progress * 100));
                fill.style.transform = `scaleX(${progress})`;
                bar.append(fill);
                const eta = item.eta != null && ["Downloading", "Almost done"].includes(item.state)
                    ? ` · about ${Math.max(1, Math.ceil(item.eta / 60))} min left` : "";
                tile.append(el("strong", item.name), bar, el("p", item.state + eta));
                items.append(tile);
            }
            queue.replaceChildren(items);
        }
        if (refreshAfterGrabAt) scheduleDownloads(Math.max(0, refreshAfterGrabAt - Date.now()));
        else if (itemsAvailable && reply.items.some(item =>
            ["Waiting", "Downloading", "Almost done", "Stalled"].includes(item.state))) scheduleDownloads(5000);
    }
    const queueVisibility = () => scheduleDownloads(0);
    const queueObserver = new MutationObserver(queueVisibility);
    queueObserver.observe(library, {attributes: true, attributeFilter: ["hidden"]});
    document.addEventListener("visibilitychange", queueVisibility, {signal: life.signal});
    life.signal.addEventListener("abort", () => { clearTimeout(queueTimer); queueObserver.disconnect(); });
    queueVisibility();
    // Featured billboard: the title in progress, otherwise the newest movie that has a backdrop.
    async function billboard() {
        const section = el("section"), art = el("img"), body = el("div");
        section.className = "movie-hero";
        section.hidden = true;
        art.alt = ""; art.decoding = "async"; art.referrerPolicy = "no-referrer";
        art.className = "movie-hero-art";
        body.className = "movie-hero-body";
        section.append(art, body);
        browse.prepend(section);
        const fields = "Overview,Genres,OfficialRating,ProductionYear,RunTimeTicks";
        const common = { userId: session.user, limit: 12, fields, enableUserData: true, enableImages: true,
            enableImageTypes: "Primary,Thumb,Backdrop", imageTypeLimit: 1 };
        const backdrops = item => [[item.Id, "Backdrop", item.BackdropImageTags?.[0]],
            [item.ParentBackdropItemId, "Backdrop", item.ParentBackdropImageTags?.[0]],
            [item.SeriesId, "Backdrop", item.ParentBackdropImageTags?.[0]],
            [item.Id, "Thumb", item.ImageTags?.Thumb]].filter(([id, , tag]) => id && tag);
        try {
            let pick;
            const resumed = await request("UserItems/Resume", { ...common, mediaTypes: "Video" });
            pick = resumed.Items.find(item => backdrops(item).length) ?? resumed.Items.find(item => progressOf(item) > 0);
            if (!pick) {
                const recent = await request("Items", { ...common, recursive: true, includeItemTypes: "Movie",
                    sortBy: "DateCreated", sortOrder: "Descending" });
                pick = recent.Items.find(item => backdrops(item).length) ?? recent.Items[0];
            }
            if (!pick || !active) return;
            const width = innerWidth > 1700 ? 2560 : 1600;
            const urls = backdrops(pick).map(([id, type, tag]) =>
                url(`Items/${encodeURIComponent(id)}/Images/${type}`, { tag, maxWidth: width }).href);
            section.style.setProperty("--art-hue", titleHue(pick.SeriesName || pick.Name));
            chainImages(art, urls);
            const seriesPrefix = pick.SeriesName?.trim().toLowerCase();
            const name = seriesPrefix && !pick.Name.trim().toLowerCase().startsWith(seriesPrefix)
                ? `${pick.SeriesName} · ${pick.Name}` : pick.Name;
            const heading = el("h2", name);
            heading.id = "movie-hero-title-" + session.device.slice(0, 8);
            heading.tabIndex = -1;
            heading.className = "movie-hero-title";
            section.setAttribute("aria-labelledby", heading.id);
            const minutes = pick.RunTimeTicks ? Math.round(pick.RunTimeTicks / 6e8) : 0;
            const facts = [pick.ProductionYear, pick.OfficialRating,
                minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : minutes ? `${minutes} min` : "",
                ...(pick.Genres ?? []).slice(0, 3)].filter(Boolean);
            const meta = el("p", facts.join(" · "));
            meta.className = "movie-hero-meta";
            body.append(heading);
            if (facts.length) body.append(meta);
            if (pick.Overview) {
                const overview = el("p", pick.Overview);
                overview.className = "movie-hero-overview";
                body.append(overview);
            }
            const resuming = progressOf(pick) > 0 && progressOf(pick) < 100;
            const play$ = button("", () => play(pick, play$));
            play$.className = "movie-hero-play";
            play$.setAttribute("aria-describedby", heading.id);
            play$.append(icon(playPath), el("span", resuming ? "Resume" : "Play"));
            const actions = el("div");
            actions.className = "movie-hero-actions";
            actions.append(play$);
            body.append(actions);
            if (resuming) {
                const track = el("span"), fill = el("span");
                track.className = "movie-progress movie-hero-progress";
                track.setAttribute("aria-hidden", "true");
                fill.style.width = progressOf(pick) + "%";
                track.append(fill);
                body.append(track);
            }
            section.hidden = false;
        } catch {
            section.remove();
        }
    }
    billboard();
    const reloadResume = shelf("Continue watching", "Movie,Episode", true);
    shelf("Recently added", "Movie", false, browse, "", life.signal,
        { params: { sortBy: "DateCreated", sortOrder: "Descending", limit: 20 }, hideEmpty: true, hideWhenAtMost: 8 });
    request("Genres", { userId: session.user, includeItemTypes: "Movie", sortBy: "SortName" }).then(genres => {
        if (!active) return;
        for (const genre of (genres.Items ?? []).slice(0, 6))
            shelf(genre.Name, "Movie", false, browse, "", life.signal,
                { params: { genres: genre.Name }, lazy: true, hideEmpty: true });
    }).catch(() => {});
    shelf("Movies", "Movie"); shelf("TV episodes", "Episode");
    // Arrow keys (and a TV remote's directional pad) move between cards, rows and the billboard.
    library.addEventListener("keydown", event => {
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        const current = event.target;
        if (!arrows || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
            || !current.matches?.(".movie-card, .movie-hero-play")) return;
        const catalogue = browse.hidden ? results : browse;
        const groups = [...catalogue.querySelectorAll(".movie-hero:not([hidden]) .movie-hero-actions, .movie-shelf:not([hidden]) .movie-row, .movie-shelf:not([hidden]) .movie-cards")]
            .map(group => [...group.querySelectorAll("button:not([hidden])")].filter(node => node.matches(".movie-card, .movie-hero-play")))
            .filter(group => group.length);
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
        leavePlayer(); active = false; life.abort(); stop(); await reports;
        try { await request("Sessions/Logout", {}, {}, timeoutSignal(5000)); } catch {}
    } };
}
