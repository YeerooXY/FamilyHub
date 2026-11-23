import { buildPlayerUi } from "./movie-player-ui.js";

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

function normalizeMoviePreferences(prefs) {
    return {
        audio: ["hu", "en"].includes(prefs?.audio) ? prefs.audio : "default",
        subtitles: ["off", "hu", "en"].includes(prefs?.subtitles) ? prefs.subtitles : "default"
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
    const preferenceViewer = viewer ?? [base.origin, session.user];
    host.replaceChildren(status, player, library);
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
        reports = reports.then(() => request("Sessions/Playing" + action, {}, data, null))
            .catch(() => { if (active) { status.textContent = "Watch progress could not be saved."; note("progress-save-failed", playback.method); } });
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
        const { audioIndex, position, paused } = options;
        if (player.contains(document.activeElement)) {
            library.hidden = false;
            opener.focus();
        }
        stop();
        const rev = selection;
        const prefs = readMoviePreferences(preferenceViewer);
        status.textContent = "Opening " + item.Name + "…";
        const media = el("video");
        const nativeHls = !!media.canPlayType("application/vnd.apple.mpegurl");
        try {
            if (!nativeHls && !globalThis.Hls && (globalThis.MediaSource || globalThis.ManagedMediaSource))
                await import("./vendor/hls.light.min.js").catch(() => {});
            if (!active || rev !== selection) return;
            const Hls = nativeHls ? null : globalThis.Hls;
            const hls = nativeHls || Hls?.isSupported();
            const profile = { Name: "FamilyHub web video",
                DirectPlayProfiles: [{ Type: "Video", Container: "mp4,m4v", VideoCodec: "h264", AudioCodec: "aac,mp3" }],
                TranscodingProfiles: [{ Type: "Video", Context: "Streaming", Protocol: hls ? "hls" : "http",
                    Container: hls ? "ts" : "mp4", VideoCodec: "h264", AudioCodec: "aac" }],
                SubtitleProfiles: [{ Format: "vtt", Method: "External" }] };
            const playbackInfo = (sourceId, index) => request("Items/" + item.Id + "/PlaybackInfo", {userId: session.user}, {
                UserId: session.user, DeviceProfile: profile,
                ...(sourceId ? {MediaSourceId: sourceId, SubtitleStreamIndex: -1} : {}),
                ...(index != null ? {AudioStreamIndex: index} : {}),
                EnableDirectPlay: index == null, EnableDirectStream: true, EnableTranscoding: true });
            const [resultInfo, freshItem] = await Promise.all([
                playbackInfo(),
                position == null ? reports.then(() => request("Items/" + item.Id, {userId: session.user})) : null
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
            let direct = source.SupportsDirectPlay;
            // A static stream leaves audio selection to the browser. Ask Jellyfin to select the track on multi-audio files.
            const customAudio = audio.length > 1 ? requestedAudio : undefined;
            if (customAudio != null || (!direct && defaultSubtitle >= 0)) {
                const playback = await playbackInfo(source.Id, customAudio).catch(() => null);
                if (!active || rev !== selection) return;
                const configured = playback?.MediaSources?.[0];
                if (configured?.TranscodingUrl || (configured?.SupportsDirectPlay && customAudio == null)) {
                    selectedAudio = configured.DefaultAudioStreamIndex ?? requestedAudio ?? defaultAudio;
                    direct = configured.SupportsDirectPlay && customAudio == null;
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
                status.textContent = "This device cannot resume this video. Continue on another device.";
                note("cannot-resume");
                library.hidden = false;
                opener.focus();
                return;
            }
            const back = button("Back to movies", async () => {
                await leavePlayer(); stop(); library.hidden = false; opener.focus(); await reports;
                if (active && !library.hidden) await reloadResume();
            });
            const subtitles = (source.MediaStreams || []).filter(s => s.Type === "Subtitle" && s.IsTextSubtitleStream);
            const controls = el("div");
            controls.className = "movie-track-controls";
            const audioPick = audio.length > 1 ? select(controls, "Audio track",
                audio.map(track => [track.Index, track.DisplayTitle || track.Language || "Audio"])) : null;
            if (audioPick) {
                audioPick.value = String(selectedAudio);
                audioPick.onchange = () => play(item, opener, { sheet: true, audioIndex: Number(audioPick.value),
                    position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                    subtitleIndex: playback.subtitleOverride });
            }
            const subtitleOptions = subtitles.map(track => [track.Index, track.DisplayTitle || track.Language || "Subtitles"]);
            const subtitlePick = subtitles.length ? select(controls, "Subtitle track", [[-1, "Off"], ...subtitleOptions]) : null;
            const notice = el("p");
            notice.setAttribute("role", "status");
            media.controls = false; media.playsInline = true; media.preload = "metadata";
            media.className = "movie-video";
            media.crossOrigin = "anonymous";
            media.setAttribute("aria-label", item.Name);
            const textTracks = new Map();
            for (const s of subtitles) {
                const track = el("track"); track.kind = "subtitles"; track.label = s.DisplayTitle || s.Language || "Subtitles";
                track.srclang = s.Language || "und";
                track.src = url(`Videos/${item.Id}/${source.Id}/Subtitles/${s.Index}/Stream.vtt`, {api_key:session.token});
                media.append(track);
                textTracks.set(s.Index, track.track);
            }
            const playback = { item, source, id: result.PlaySessionId, method: direct ? "DirectPlay" : source.TranscodeReasons?.length ? "Transcode" : "DirectStream" };
            playback.setSubtitles = (index) => {
                playback.subtitleOverride = index;
                const language = prefs.subtitles;
                const preferred = preferredTrack(subtitles, language);
                const unavailable = index == null && languageCodes[language] && !preferred;
                const selected = index ?? (language === "default" ? defaultSubtitle : preferred?.Index);
                const activeSubtitle = textTracks.has(selected) ? selected : -1;
                for (const [trackIndex, track] of textTracks)
                    track.mode = trackIndex === activeSubtitle ? "hidden" : "disabled"; // hidden: the player draws the cues itself
                if (subtitlePick) subtitlePick.value = String(activeSubtitle);
                const audioFallback = audioIndex == null && audioLanguage !== "default" && (!preferredAudio || preferredAudio.Index !== selectedAudio);
                notice.textContent = [
                    audioFallback ? `${labels[audioLanguage]} audio unavailable. Using the default track.` : "",
                    audioIndex != null && audioIndex !== selectedAudio ? "Selected audio track unavailable. Using the default track." : "",
                    unavailable ? `${labels[language]} subtitles unavailable. Subtitles are off.` : ""
                ].filter(Boolean).join(" ");
            };
            if (subtitlePick) subtitlePick.onchange = () => playback.setSubtitles(Number(subtitlePick.value));
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
            ui = buildPlayerUi({ media, surface: player, back, signal: playerLife.signal,
                title: numbered ? `S${item.ParentIndexNumber}:E${item.IndexNumber} “${item.Name}”` : item.Name,
                kicker: item.SeriesName, trackControls: [controls], notice });
            player.append(media, ui.root);
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
            if (options.sheet && audioPick) ui.openTracksAt();
            else ui.playButton.focus();
            status.textContent = "";
            if (!paused) media.play().catch(() => {
                if (current === playback && !status.textContent) { status.textContent = "Press play to start."; ui?.say("Press play to start."); }
            });
        } catch {
            if (active && rev === selection) {
                leavePlayer();
                stop();
                status.textContent = "Could not open this video. Try again.";
                note("open-failed");
                library.hidden = false;
                opener.focus();
            }
        }
    }
    function progressOf(item) {
        const data = item.UserData;
        if (data?.PlayedPercentage > 0) return Math.round(data.PlayedPercentage);
        return item.RunTimeTicks > 0 && data?.PlaybackPositionTicks > 0
            ? Math.round(data.PlaybackPositionTicks / item.RunTimeTicks * 100) : 0;
    }
    function card(item, wide) {
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
        const fallback = item.Type === "Episode" || item.SeriesName ? "episode"
            : Math.floor(item.Name.length / 2) % 2 ? "movie" : "movie-alt";
        images.add(new URL(`./movie-art/${fallback}.jpg`, import.meta.url).href);
        chainImages(poster, [...images]);
        const artwork = el("span");
        artwork.className = "movie-art";
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
                const page = await request(resume ? "UserItems/Resume" : "Items", {userId: session.user,
                    recursive:true, includeItemTypes:type, startIndex:reset ? 0 : offset, limit:40, enableUserData:true, enableImages:true, enableImageTypes:"Primary,Thumb,Backdrop", imageTypeLimit:1,
                    ...(term ? {searchTerm:term} : {}),
                    ...(resume ? {mediaTypes:"Video"} : {sortBy:"SortName",sortOrder:"Ascending"}),
                    ...extra.params}, undefined, signal);
                if (!active || signal.aborted) return;
                const focusedCard = reset && rows.contains(document.activeElement) ? document.activeElement : null;
                let successor;
                if (reset) { offset = 0; rows.replaceChildren(); }
                const wasFocused = document.activeElement === more;
                let first;
                for (const item of page.Items) {
                    const b = card(item, wide);
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
                if (term && reset) {
                    const count = page.TotalRecordCount ?? offset;
                    status.textContent = count ? `${count} matching ${count === 1 ? "title" : "titles"}.` : "No matching titles.";
                }
                if (wasFocused || focusedCard) (successor || first || heading).focus();
            } catch {
                if (active && !signal.aborted) {
                    more.hidden = false;
                    more.textContent = "Retry " + title.toLowerCase();
                    status.textContent = "Could not load " + title.toLowerCase() + ".";
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
    const form = el("form"), query = el("input"), submit = el("button", "Search");
    form.className = "movie-search";
    form.setAttribute("role", "search");
    form.setAttribute("aria-label", "Movie library");
    query.type = "search";
    query.placeholder = "Search movies and episodes";
    query.setAttribute("aria-label", query.placeholder);
    const browse = el("div"), results = el("div");
    const clear = button("Clear", () => { query.value = ""; query.focus(); resetSearch(); });
    clear.hidden = true;
    let searchRequest;
    function resetSearch() {
        searchRequest?.abort();
        clear.hidden = true;
        results.replaceChildren();
        browse.hidden = false;
        status.textContent = "";
    }
    form.onsubmit = event => {
        event.preventDefault();
        resetSearch();
        const term = query.value.trim();
        if (!term) return;
        clear.hidden = false;
        browse.hidden = true;
        searchRequest = new AbortController();
        status.textContent = "Searching…";
        shelf("Search results", "Movie,Episode", false, results, term, searchRequest.signal);
    };
    query.oninput = () => { if (!query.value.trim()) resetSearch(); };
    life.signal.addEventListener("abort", () => searchRequest?.abort(), {once:true});
    form.append(query, submit, clear);
    library.append(form, browse, results);
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
            urls.push(new URL("./movie-art/" + (pick.Type === "Episode" ? "episode" : "movie") + ".jpg", import.meta.url).href);
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
        { params: { sortBy: "DateCreated", sortOrder: "Descending", limit: 20 }, hideEmpty: true });
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
        const groups = [...browse.querySelectorAll(".movie-hero:not([hidden]) .movie-hero-actions, .movie-shelf:not([hidden]) .movie-row, .movie-shelf:not([hidden]) .movie-cards")]
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
    return { async close() {
        if (!active) return;
        leavePlayer(); active = false; life.abort(); stop(); await reports;
        try { await request("Sessions/Logout", {}, {}, timeoutSignal(5000)); } catch {}
    } };
}
