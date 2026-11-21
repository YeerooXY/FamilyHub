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
        const res = await fetch(url(path, params), { method: body ? "POST" : "GET", signal: signal ?? AbortSignal.timeout(8000),
            headers: { ...headers, "Content-Type": "application/json" }, referrerPolicy: "no-referrer",
            credentials: "omit", redirect: "error", body: body ? JSON.stringify(body) : undefined });
        if (!res.ok) throw Error("Jellyfin request failed");
        return res.status === 204 ? null : JSON.parse(await res.text() || "null");
    };
    const status = el("p");
    status.setAttribute("role", "status");
    const player = el("section"), library = el("div");
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
    function report(action, playback, media) {
        const data = { ItemId: playback.item.Id, MediaSourceId: playback.source.Id,
            PlaySessionId: playback.id, PositionTicks: Math.round(media.currentTime * 1e7),
            IsPaused: media.paused, CanSeek: media.seekable.length > 0, PlayMethod: playback.method };
        reports = reports.then(() => request("Sessions/Playing" + action, {}, data, null))
            .catch(() => { if (active) status.textContent = "Watch progress could not be saved."; });
    }
    function stop() {
        selection++;
        if (current?.started) report("/Stopped", current, video);
        const hls = current?.hls;
        current = null;
        hls?.destroy();
        if (video) { video.pause(); video.removeAttribute("src"); video.load(); video = null; }
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
                library.hidden = false;
                opener.focus();
                return;
            }
            const back = button("Back to movies", async () => {
                stop(); library.hidden = false; opener.focus(); await reports;
                if (active && !library.hidden) await reloadResume();
            });
            player.append(back, el("h2", item.Name));
            const subtitles = (source.MediaStreams || []).filter(s => s.Type === "Subtitle" && s.IsTextSubtitleStream);
            const controls = el("div");
            controls.className = "movie-track-controls";
            player.append(controls);
            const audioPick = audio.length > 1 ? select(controls, "Audio track",
                audio.map(track => [track.Index, track.DisplayTitle || track.Language || "Audio"])) : null;
            if (audioPick) {
                audioPick.value = String(selectedAudio);
                audioPick.onchange = () => play(item, opener, { audioIndex: Number(audioPick.value),
                    position: metadataLoaded ? media.currentTime : resume, paused: media.paused,
                    subtitleIndex: playback.subtitleOverride });
            }
            const subtitleOptions = subtitles.map(track => [track.Index, track.DisplayTitle || track.Language || "Subtitles"]);
            const subtitlePick = subtitles.length ? select(controls, "Subtitle track", [[-1, "Off"], ...subtitleOptions]) : null;
            const notice = el("p");
            notice.setAttribute("role", "status");
            player.append(notice);
            media.controls = true; media.playsInline = true; media.preload = "metadata";
            media.style.cssText = "display:block;width:100%;max-height:65vh;background:#000";
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
                    track.mode = trackIndex === activeSubtitle ? "showing" : "disabled";
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
            };
            media.onerror = () => { if (current === playback) status.textContent = "This device could not play this version."; };
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
            player.append(media);
            playback.setSubtitles(options.subtitleIndex);
            (audioIndex != null && audioPick ? audioPick : back).focus();
            status.textContent = "";
            if (!paused) media.play().catch(() => {
                if (current === playback && !status.textContent) status.textContent = "Press play to start.";
            });
        } catch {
            if (active && rev === selection) {
                stop();
                status.textContent = "Could not open this video. Try again.";
                library.hidden = false;
                opener.focus();
            }
        }
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
        const next = images.values();
        const loadImage = () => {
            const image = next.next();
            if (image.done) {
                poster.removeAttribute("src");
                poster.onerror = null;
            } else poster.src = image.value;
        };
        poster.onerror = loadImage;
        loadImage();
        const artwork = el("span");
        artwork.className = "movie-art";
        artwork.append(poster);
        const caption = el("span", name);
        caption.className = "movie-caption";
        b.append(artwork, caption);
        return b;
    }
    function shelf(title, type, resume = false, parent = browse, term = "", signal = life.signal) {
        const section = el("section"), heading = el("h2", title), rows = el("div");
        const wide = type !== "Movie";
        rows.className = wide ? "movie-cards movie-cards-wide" : "movie-cards";
        const more = button("Show more", () => load(offset === 0));
        more.className = "movie-more";
        heading.tabIndex = -1; section.append(heading, rows, more); parent.append(section);
        let offset = 0, busy = false;
        async function load(reset) {
            if (busy || !active) return;
            busy = true; more.setAttribute("aria-disabled", "true");
            try {
                const page = await request(resume ? "UserItems/Resume" : "Items", {userId: session.user,
                    recursive:true, includeItemTypes:type, startIndex:reset ? 0 : offset, limit:40, enableUserData:true, enableImages:true, enableImageTypes:"Primary,Thumb,Backdrop", imageTypeLimit:1,
                    ...(term ? {searchTerm:term} : {}),
                    ...(resume ? {mediaTypes:"Video"} : {sortBy:"SortName",sortOrder:"Ascending"})}, undefined, signal);
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
                more.hidden = offset >= page.TotalRecordCount || page.Items.length < 40;
                more.textContent = "Show more";
                if (status.textContent === "Could not load " + title.toLowerCase() + ".") status.textContent = "";
                if (!offset && !term) rows.textContent = resume ? "No videos in progress." : "No titles yet.";
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
        more.hidden = true; load(true);
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
    const reloadResume = shelf("Continue watching", "Movie,Episode", true);
    shelf("Movies", "Movie"); shelf("TV episodes", "Episode");
    return { async close() {
        if (!active) return;
        active = false; life.abort(); stop(); await reports;
        try { await request("Sessions/Logout", {}, {}, AbortSignal.timeout(5000)); } catch {}
    } };
}
