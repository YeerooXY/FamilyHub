// Player controls. movies.js owns the video, Jellyfin and progress reporting.

import { attachSound, soundPanelWanted, SOUND_MODES, MAX_VOLUME } from "./movie-sound.js";

const SVG = "http://www.w3.org/2000/svg";
const subtitleSizeKey = "familyhub.movie.subtitle-size";
const subtitleSizes = ["Small", "Medium", "Large"];
const paths = {
    back: "M15 5l-7 7 7 7",
    close: "M6 6l12 12M18 6L6 18",
    check: "M5 12l4 4 10-10",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4",
    minus: "M5 12h14",
    plus: "M5 12h14m-7-7v14",
    reset: "M4 11a8 8 0 1 1 2 7M4 5v6h6",
    play: "M8 4.5v15l12-7.5z",
    pause: "M7 4h4v16H7zM13 4h4v16h-4z",
    skip: ["M12 5a8 8 0 1 1-7.4 5", "M14.5 2.5L12 5l2.5 2.5"],
    next: ["M5 5v14l10-7z", "M19 5v14"],
    episodes: ["M8 4h12v12H8z", "M4 8v12h12"],
    subtitles: ["M4 5h16v11h-9l-4 4v-4H4z", "M7 9h10M7 12h6"],
    sound: ["M4 9v6h4l5 4V5L8 9z", "M16.5 9a4.5 4.5 0 0 1 0 6"],
    soundOff: ["M4 9v6h4l5 4V5L8 9z", "M17 9.5l4 5M21 9.5l-4 5"],
    expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    collapse: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
};

function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function icon(shape, { flip = false, label = "" } = {}) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "movie-icon");
    // Only the arrow mirrors; the number stays readable.
    const group = document.createElementNS(SVG, "g");
    if (flip) group.setAttribute("transform", "translate(24 0) scale(-1 1)");
    for (const d of [shape].flat()) {
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", d);
        group.append(path);
    }
    svg.append(group);
    if (label) {
        const text = document.createElementNS(SVG, "text");
        text.setAttribute("x", "12");
        text.setAttribute("y", "16");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("class", "movie-icon-number");
        text.textContent = label;
        svg.append(text);
    }
    return svg;
}

function clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function placeRangeTip(range, tip, fraction, thumbWidth) {
    const width = range.getBoundingClientRect().width;
    const half = tip.offsetWidth / 2;
    const center = thumbWidth / 2 + fraction * (width - thumbWidth);
    tip.style.left = Math.min(Math.max(center, half), Math.max(half, width - half)) + "px";
}

// Subtitles are drawn here, not by the browser: the browser puts them at the bottom of the whole video box, which is far
// below the picture on a phone held upright and under the seek bar while the controls show. YouTube's ">>" speaker marks go.
export function cleanCue(text) {
    return String(text ?? "").replace(/<[^>]+>/g, "").split("\n").map(line => line.replace(/^\s*(?:&gt;|>){2,}\s*/, "").trim()).filter(Boolean).join("\n");
}
// Distance from the bottom of the window to the bottom edge of the subtitle block, in pixels.
export function subtitleBottom({ width, height, videoWidth, videoHeight, barTop = null }) {
    const scale = videoWidth && videoHeight ? Math.min(width / videoWidth, height / videoHeight) : 1;
    const picture = videoWidth && videoHeight ? videoHeight * scale : height;
    const pictureBottom = (height + picture) / 2;
    let edge = pictureBottom - Math.max(12, picture * 0.05);
    if (barTop !== null) edge = Math.min(edge, barTop - 8);
    return Math.max(8, Math.round(height - edge));
}

export function watchPlayerIdle(surface, signal, onIdle, onWake) {
    let timer;
    function hide() {
        clearTimeout(timer);
        surface.classList.add("movie-cursor-idle");
        onIdle?.();
    }
    function show() {
        surface.classList.remove("movie-cursor-idle");
        onWake?.();
        clearTimeout(timer);
        timer = setTimeout(hide, 3000);
    }
    for (const type of ["pointermove", "pointerdown", "touchstart", "focusin", "focusout"])
        surface.addEventListener(type, show, {passive: true, signal});
    document.addEventListener("keydown", event => {
        if (surface.contains(event.target) || event.target === document.body) show();
    }, {capture: true, signal});
    signal.addEventListener("abort", () => {
        clearTimeout(timer);
        surface.classList.remove("movie-cursor-idle");
    }, {once: true});
    show();
    return {hide, show};
}

/**
 * @param {object} ctx
 * @param {HTMLVideoElement} ctx.media
 * @param {HTMLElement} ctx.surface  element that goes fullscreen (the player section)
 * @param {HTMLButtonElement} ctx.back  the close control, named "Back to movies"
 * @param {string} ctx.title @param {string} [ctx.kicker]
 * @param {HTMLSelectElement} ctx.subtitlePick  labelled subtitle select
 * @param {HTMLElement} ctx.notice  status line for track fallbacks
 * @param {AbortSignal} ctx.signal  aborts every listener
 */
export function buildPlayerUi(ctx) {
    const { media, surface, back, signal } = ctx;
    const stylesheet = new URL("./movie-player.css", import.meta.url).href;
    if (![...document.styleSheets].some(sheet => sheet.href === stylesheet) &&
        !document.head.querySelector("link[data-movie-player]")) {
        const link = make("link");
        Object.assign(link, { rel: "stylesheet", href: stylesheet });
        link.dataset.moviePlayer = "";
        document.head.append(link);
    }
    const root = make("div", "movie-ui");
    let dragging = false, openSheet = null, nextEpisode = null;

    const button = (className, label, shape, options, run) => {
        const b = make("button", className);
        b.type = "button";
        b.setAttribute("aria-label", label);
        if (shape) b.append(icon(shape, options));
        b.addEventListener("click", run, { signal });
        return b;
    };

    // Top: one Back control at the left, centred title.
    const top = make("div", "movie-ui-top");
    const heading = make("div", "movie-ui-heading");
    if (ctx.kicker) heading.append(make("p", "movie-ui-kicker", ctx.kicker));
    heading.append(make("h2", "movie-ui-title", ctx.title));
    back.classList.add("movie-ui-back");
    back.setAttribute("aria-label", "Back to movies");
    back.replaceChildren(icon(paths.back));
    top.append(back, heading);

    const skip = (seconds) => {
        const end = Number.isFinite(media.duration) ? media.duration : Infinity;
        media.currentTime = Math.min(Math.max(0, media.currentTime + seconds), end);
        show();
    };
    const toggle = () => { if (media.paused) media.play().catch(() => {}); else media.pause(); show(); };
    const rewind = button("movie-ui-skip", "Back 10 seconds", paths.skip, { label: "10" }, () => skip(-10));
    const forward = button("movie-ui-skip", "Forward 10 seconds", paths.skip, { flip: true, label: "10" }, () => skip(10));
    const playPause = button("movie-ui-play", "Play", paths.play, {}, toggle);
    const spinner = make("div", "movie-ui-spinner");
    spinner.hidden = media.readyState >= 3;
    spinner.setAttribute("role", "status");
    const spinnerLabel = make("span", "movie-player-sr", "Loading");
    spinner.append(spinnerLabel);
    const mid = make("div", "movie-ui-mid");
    mid.append(playPause, rewind, forward);

    const elapsed = make("span", "movie-ui-elapsed", "0:00");
    const seek = make("input", "movie-seek");
    seek.type = "range";
    seek.min = "0";
    seek.max = "1";
    seek.step = "any";
    seek.value = "0";
    seek.setAttribute("aria-label", "Seek");
    const remaining = make("span", "movie-ui-remaining", "0:00");
    remaining.title = "Time remaining";
    const tip = make("span", "movie-seek-tip");
    tip.hidden = true;
    tip.setAttribute("aria-hidden", "true");
    const seekWrap = make("div", "movie-seek-wrap");
    seekWrap.append(seek, tip);
    const seekRow = make("div", "movie-ui-seekrow");
    seekRow.append(elapsed, seekWrap, remaining);

    const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement;
    const isFullscreen = () => ctx.isFullscreen?.() ?? fullscreenElement() === surface;
    let fullscreenPending = false;
    async function toggleFullscreen() {
        if (fullscreen.hidden || fullscreenPending) return;
        const focused = document.activeElement;
        const on = !isFullscreen();
        fullscreenPending = true;
        try {
            if (ctx.setFullscreen) {
                if (!await ctx.setFullscreen(on)) throw Error();
            } else if (on) {
                await (surface.requestFullscreen ?? surface.webkitRequestFullscreen).call(surface, { navigationUI: "hide" });
            } else {
                await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
            }
        } catch {
            if (!signal.aborted) failure.textContent = on ? "Could not enter full screen. Try again." : "Could not exit full screen. Try again.";
        } finally {
            fullscreenPending = false;
        }
        if (signal.aborted) return;
        syncFullscreen();
        if (document.activeElement === document.body)
            (root.contains(focused) ? focused : playPause).focus({ preventScroll: true });
        show();
    }
    const fullscreen = button("movie-ui-action", "Full screen", paths.expand, {}, toggleFullscreen);
    fullscreen.hidden = /iPhone|iPod/.test(navigator.userAgent) ||
        !(ctx.fullscreenEnabled || document.fullscreenEnabled || document.webkitFullscreenEnabled);
    const episodesButton = button("movie-ui-action", "Episodes", paths.episodes, {}, () => toggleSheet("episodes"));
    episodesButton.append(make("span", "", "Episodes"));
    episodesButton.hidden = true;
    const tracksButton = button("movie-ui-action", "Audio & Subtitles", paths.subtitles, {}, () => toggleSheet("audio"));
    const sound = soundPanelWanted() ? attachSound(media, { signal }) : null;
    root.classList.toggle("movie-hardware-volume", !sound);
    const nextButton = button("movie-ui-action", "Next episode", paths.next, {}, () => nextEpisode?.play());
    nextButton.append(make("span", "", "Next episode"));
    nextButton.hidden = true;
    const actions = make("div", "movie-ui-actions");
    actions.append(episodesButton, nextButton, tracksButton, fullscreen);
    const transport = make("div", "movie-ui-transport");
    transport.append(mid, actions);
    const bottom = make("div", "movie-ui-bottom");
    bottom.append(seekRow, transport);

    // Sheets: Audio & Subtitles and Episodes. One is open at a time; each has one named close control.
    const sheets = {};
    function makeSheet(name, heading, closeLabel, opener) {
        const sheet = make("div", "movie-sheet");
        sheet.hidden = true;
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-label", heading);
        sheet.setAttribute("aria-modal", "true");
        const head = make("div", "movie-sheet-head");
        const close = button("movie-sheet-close", closeLabel, paths.close, {}, closeSheet);
        head.append(make("h3", "", heading), close);
        const body = make("div", "movie-sheet-body");
        sheet.append(head, body);
        sheets[name] = { node: sheet, body, close, opener };
        return sheet;
    }
    const audioSheet = makeSheet("audio", "Audio & Subtitles", "Close audio and subtitles", tracksButton);
    audioSheet.classList.add("movie-sheet-tracks");
    const audio = make("section", "movie-track-col");
    const subtitles = make("section", "movie-track-col");
    const subtitleHead = make("div", "movie-track-heading");
    const downloadLabel = "Find a subtitle for this film";
    let lastDownloadLanguage;
    const download = button("movie-track-icon", downloadLabel, paths.download, {}, () => {
        download.focus({ preventScroll: true });
        if (download.getAttribute("aria-disabled") === "true" || !ctx.subtitleSearch) return;
        const missing = ctx.subtitleSearch.missing();
        lastDownloadLanguage = missing.find(language => language !== lastDownloadLanguage) ?? missing[0];
        void ctx.subtitleSearch.run(lastDownloadLanguage);
    });
    download.title = downloadLabel;
    const searchStatus = make("p", "movie-subtitle-status");
    searchStatus.setAttribute("role", "status");
    subtitleHead.append(make("h4", "", "Subtitles"), download);
    audio.append(make("h4", "", "Audio"));
    subtitles.append(subtitleHead, searchStatus);
    sheets.audio.body.append(audio, subtitles);
    const episodesSheet = makeSheet("episodes", "Episodes", "Close episodes", episodesButton);
    bottom.append(episodesSheet);
    if (sound) {
        const volumeRow = make("div", "movie-volume");
        const mute = button("movie-ui-action", "Mute", paths.sound, {}, () => sound.toggleMute());
        const volumeWrap = make("div", "movie-volume-track");
        const volume = make("input", "movie-sound-slider");
        Object.assign(volume, { type: "range", min: 0, max: MAX_VOLUME * 100, step: 1 });
        volume.setAttribute("aria-label", "Volume");
        const readout = make("span", "movie-volume-tip");
        readout.setAttribute("aria-hidden", "true");
        const hint = make("p", "movie-sound-hint", "Volume above 100% can distort.");
        hint.id = "movie-volume-boost-hint";
        volumeWrap.append(volume, readout, hint);
        volumeRow.append(mute, volumeWrap);
        mid.append(volumeRow);
        const options = (heading, label) => {
            const column = make("div", "movie-track-col");
            const list = make("div", "movie-track-list");
            list.setAttribute("role", "radiogroup");
            list.setAttribute("aria-label", label);
            column.append(make("h4", "", heading), list);
            return { column, list };
        };
        const modes = options("Sound mode", "Sound mode"), outputs = options("Output", "Sound output");
        const modeRows = SOUND_MODES.map(([id, name]) => {
            const row = make("button", "movie-track-option", name);
            row.type = "button";
            row.setAttribute("role", "radio");
            row.dataset.value = id;
            row.addEventListener("click", () => { sound.set({ mode: id }); modes.list.querySelector("[aria-checked='true']")?.focus(); }, { signal });
            modes.list.append(row);
            return row;
        });
        function placeVolumeTip() {
            placeRangeTip(volume, readout, Number(volume.value) / Number(volume.max), 12);
        }
        const paint = state => {
            volume.value = state.muted ? 0 : Math.round(state.volume * 100);
            readout.textContent = (state.muted ? 0 : Math.round(state.volume * 100)) + "%";
            volume.setAttribute("aria-valuetext", readout.textContent);
            volume.style.setProperty("--pct", Number(volume.value) / Number(volume.max) * 100 + "%");
            placeVolumeTip();
            mute.setAttribute("aria-label", state.muted ? "Unmute" : "Mute");
            mute.setAttribute("aria-pressed", String(state.muted));
            mute.replaceChildren(icon(state.muted || state.volume === 0 ? paths.soundOff : paths.sound));
            hint.hidden = state.muted || state.volume <= 1;
            if (hint.hidden) volume.removeAttribute("aria-describedby");
            else volume.setAttribute("aria-describedby", hint.id);
            for (const row of modeRows) row.setAttribute("aria-checked", String(row.dataset.value === state.mode));
            for (const row of outputs.list.children) row.setAttribute("aria-checked", String(row.dataset.value === state.device));
        };
        volume.addEventListener("input", () => sound.set({ volume: Number(volume.value) / 100 }), { signal });
        for (const type of ["pointerenter", "focusin"])
            volumeRow.addEventListener(type, () => requestAnimationFrame(placeVolumeTip), { signal });
        window.addEventListener("resize", placeVolumeTip, { signal });
        sound.onChange(paint);
        const details = make("details", "movie-sound-options");
        details.append(make("summary", "", "Sound options"), modes.column, outputs.column);
        outputs.column.hidden = true;
        details.addEventListener("toggle", async () => {
            if (!details.open || outputs.list.childElementCount) return;
            const found = sound.canPickOutput ? await sound.outputs() : [];
            if (signal.aborted) return;
            outputs.column.hidden = found.length < 2;
            outputs.list.replaceChildren(...found.map(({ id, label }) => {
                const row = make("button", "movie-track-option", label);
                row.type = "button";
                row.setAttribute("role", "radio");
                row.dataset.value = id === "default" ? "" : id;
                row.addEventListener("click", () => sound.set({ device: row.dataset.value }), { signal });
                return row;
            }));
            paint(sound.state);
        }, { signal });
        audio.append(details);
        paint(sound.state);
    }
    // The hidden selects keep playback and the track rows in sync.
    function trackList(sheet, pick, name) {
        if (!pick) return () => {};
        pick.closest("label").hidden = true;
        const list = make("div", "movie-track-list");
        list.setAttribute("role", "radiogroup");
        list.setAttribute("aria-label", name);
        sheet.append(pick.closest("label"), list);
        let options = [];
        function sync() {
            const next = [...pick.options];
            if (next.length !== options.length || next.some((option, index) => option !== options[index])) {
                const previousRows = [...list.children];
                const focusedIndex = previousRows.indexOf(document.activeElement);
                const focusedValue = options[focusedIndex]?.dataset.language ?? options[focusedIndex]?.value;
                options = next;
                const nextRows = options.map(option => {
                    const row = make("button", "movie-track-option movie-track-choice", option.text);
                    row.type = "button";
                    row.setAttribute("role", "radio");
                    const dot = make("span", "movie-track-dot");
                    dot.append(icon(paths.check));
                    row.prepend(dot);
                    row.addEventListener("click", () => {
                        if (pick.value === option.value) return;
                        pick.value = option.value;
                        pick.dispatchEvent(new Event("change"));
                        if (pick === ctx.subtitlePick) syncSubtitles();
                        else sync();
                    }, { signal });
                    row.addEventListener("focus", () => {
                        for (const other of list.children) other.tabIndex = other === row ? 0 : -1;
                    }, { signal });
                    return row;
                });
                if (focusedIndex < 0) list.replaceChildren(...nextRows);
                else {
                    list.append(...nextRows);
                    (nextRows[next.findIndex(option => (option.dataset.language ?? option.value) === focusedValue)]
                        ?? nextRows[0] ?? sheets.audio.close)
                        .focus({ preventScroll: true });
                    previousRows.forEach(row => row.remove());
                }
            }
            const activeRow = list.contains(document.activeElement) ? document.activeElement
                : list.children[options.findIndex(option => option.value === pick.value)] ?? list.firstElementChild;
            options.forEach((option, index) => {
                const row = list.children[index];
                row.setAttribute("aria-checked", String(pick.value === option.value));
                row.tabIndex = row === activeRow ? 0 : -1;
            });
        }
        sync();
        return sync;
    }
    const syncAudio = trackList(audio, ctx.audioPick, "Audio track");
    if (!ctx.audioPick) audio.append(make("p", "", "Default audio"));
    const soundOptions = audio.querySelector(".movie-sound-options");
    if (soundOptions) audio.append(soundOptions);
    const syncSubtitleRows = trackList(subtitles, ctx.subtitlePick, "Subtitle track");
    const sizeLabel = make("label", "movie-subtitle-size", "Subtitle size");
    const size = make("select");
    for (const label of subtitleSizes) size.add(new Option(label, label.toLowerCase()));
    let savedSize;
    try { savedSize = localStorage.getItem(subtitleSizeKey); } catch {}
    size.value = [...size.options].some(option => option.value === savedSize) ? savedSize : "medium";
    root.dataset.subtitleSize = size.value;
    size.addEventListener("change", () => {
        root.dataset.subtitleSize = size.value;
        try { localStorage.setItem(subtitleSizeKey, size.value); } catch {}
    }, { signal });
    sizeLabel.append(size);
    if (ctx.audioSync) {
        const sync = make("div", "movie-audio-sync");
        sync.setAttribute("role", "group");
        sync.setAttribute("aria-label", "Sync");
        const output = make("output");
        function update() {
            const ms = ctx.audioSync.value;
            output.textContent = ms === 0 ? "0 ms" : `${Math.abs(ms)} ms ${ms < 0 ? "earlier" : "later"}`;
        }
        const adjust = (step, label, text) => {
            const action = button("movie-track-option", label, null, {}, () => {
                action.focus({preventScroll: true});
                ctx.audioSync.step(step);
                update();
            });
            action.textContent = text;
            return action;
        };
        update();
        sync.append(make("span", "", "Sync"), adjust(-100, "Play audio 100 ms earlier", "\u2212"), output,
            adjust(100, "Play audio 100 ms later", "+"));
        audio.append(sync);
    }
    const subtitleAnnouncement = make("span", "movie-player-sr");
    subtitleAnnouncement.setAttribute("role", "status");
    subtitles.append(subtitleAnnouncement);

    const timing = make("section", "movie-track-col movie-subtitle-timing");
    const timingFields = make("div", "movie-timing-fields");
    const bitmapNote = make("p", "", "Timing is unavailable for image subtitles.");
    timing.append(make("h4", "", "Timing"), bitmapNote, timingFields, sizeLabel);
    sheets.audio.body.append(timing);
    let timingKey, shift = 0, speed = 0;
    let stopHold = () => {};
    const shiftControl = stepper("Shift", 600, 1, "s", () => shift, value => { shift = value; });
    const speedControl = stepper("Speed", 500, 2, "%", () => speed, value => { speed = value; });
    function stepper(label, limit, places, unit, read, write) {
        const group = make("div", "movie-timing-stepper");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", label);
        const heading = make("div", "movie-timing-label");
        const controls = make("div", "movie-timing-controls");
        const output = make("output");
        output.setAttribute("aria-label", label + " value");
        const reset = button("movie-track-icon", "Reset subtitle " + label.toLowerCase(), paths.reset, {}, () => set(0));
        reset.title = reset.getAttribute("aria-label");
        function set(value) {
            write(Math.min(limit, Math.max(-limit, value)));
            if (timingKey) {
                try {
                    if (shift || speed) localStorage.setItem(timingKey, JSON.stringify({ shift, speed }));
                    else localStorage.removeItem(timingKey);
                } catch {}
            }
            paint();
            refreshCueTiming();
        }
        function paint() {
            const value = read();
            output.textContent = (value > 0 ? "+" : "") + (value / 10 ** places).toFixed(places) + " " + unit;
            if (value === 0 && reset === document.activeElement) increase.focus({ preventScroll: true });
            reset.hidden = value === 0;
        }
        function adjust(direction, shape, verb) {
            let repeated = false;
            const control = button("movie-track-icon", verb + " subtitle " + label.toLowerCase(), shape, {}, event => {
                if (!repeated || event.detail === 0) set(read() + direction * (event.shiftKey ? 10 : 1));
                repeated = false;
            });
            control.title = control.getAttribute("aria-label");
            control.addEventListener("pointerdown", event => {
                if (event.button !== 0 || !event.isPrimary) return;
                control.focus({ preventScroll: true });
                stopHold();
                repeated = false;
                control.setPointerCapture(event.pointerId);
                const step = event.shiftKey ? 10 : 1;
                let delay = 260;
                function repeat() {
                    repeated = true;
                    set(read() + direction * step);
                    delay = Math.max(45, delay * .78);
                    timer = setTimeout(repeat, delay);
                }
                let timer = setTimeout(repeat, 350);
                stopHold = () => clearTimeout(timer);
            }, { signal });
            for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"])
                control.addEventListener(type, () => stopHold(), { signal });
            return control;
        }
        const decrease = adjust(-1, paths.minus, "Decrease"), increase = adjust(1, paths.plus, "Increase");
        heading.append(make("span", "", label), reset);
        controls.append(decrease, output, increase);
        group.append(heading, controls);
        group.addEventListener("keydown", event => {
            if (event.key !== "PageUp" && event.key !== "PageDown") return;
            event.preventDefault();
            set(read() + (event.key === "PageUp" ? 10 : -10));
        }, { signal });
        timingFields.append(group);
        return paint;
    }
    function syncTiming() {
        const selected = ctx.subtitlePick?.selectedOptions[0];
        const language = selected?.dataset.language;
        const bitmap = !!language && ctx.burnedSubtitle === Number(selected.value);
        if (!language && timing.contains(document.activeElement))
            subtitles.querySelector("[aria-checked='true']")?.focus({ preventScroll: true });
        timing.hidden = !language;
        timingFields.hidden = sizeLabel.hidden = bitmap;
        bitmapNote.hidden = !bitmap;
        const key = language && !bitmap && ctx.itemId != null
            ? "familyhub.movie.subtitle-timing.v1:" + JSON.stringify([ctx.itemId, language]) : undefined;
        if (key !== timingKey) {
            timingKey = key;
            let saved;
            try { if (key) saved = JSON.parse(localStorage.getItem(key)); } catch {}
            shift = Number.isInteger(saved?.shift) && Math.abs(saved.shift) <= 600 ? saved.shift : 0;
            speed = Number.isInteger(saved?.speed) && Math.abs(saved.speed) <= 500 ? saved.speed : 0;
        }
        shiftControl();
        speedControl();
        refreshCueTiming();
    }
    function syncDownload() {
        const missing = ctx.subtitleSearch?.missing().length > 0;
        // Keep the focused action until the user moves on after the last download.
        download.hidden = !missing && document.activeElement !== download;
        download.setAttribute("aria-disabled", String(searching || !missing));
    }
    let searching = false, announcedTrack;
    function subtitleStatus(text, working = false) {
        searching = working;
        searchStatus.textContent = text;
        syncDownload();
    }
    function syncSubtitles() {
        syncSubtitleRows();
        syncTiming();
        syncDownload();
        const label = ctx.subtitlePick?.selectedOptions[0]?.text;
        if (openSheet === "audio" && label && label !== announcedTrack)
            subtitleAnnouncement.textContent = `Subtitles: ${label}`;
        announcedTrack = label;
    }
    download.addEventListener("blur", () => queueMicrotask(syncDownload), { signal });
    signal.addEventListener("abort", () => stopHold(), { once: true });
    function toggleSheet(name, focusTarget) {
        if (openSheet === name) return closeSheet();
        const previous = openSheet && sheets[openSheet];
        openSheet = name;
        sheets[name].node.hidden = false;
        if (name === "audio") { syncAudio(); syncSubtitles(); }
        sheets[name].opener.setAttribute("aria-expanded", "true");
        show();
        // Focus starts on the close control (or the current episode), so Escape and Enter work the same everywhere.
        (focusTarget ?? sheets[name].body.querySelector("[aria-current='true']") ?? sheets[name].close).focus();
        if (previous) {
            previous.opener.setAttribute("aria-expanded", "false");
            previous.node.hidden = true;
            stopHold();
        }
    }
    function closeSheet() {
        if (!openSheet) return;
        const sheet = sheets[openSheet];
        openSheet = null;
        sheet.opener.setAttribute("aria-expanded", "false");
        (sheet.opener.hidden ? tracksButton : sheet.opener).focus({ preventScroll: true });
        sheet.node.hidden = true;
        stopHold();
        show();
    }
    for (const sheet of Object.values(sheets)) {
        sheet.opener.setAttribute("aria-expanded", "false");
        sheet.opener.setAttribute("aria-haspopup", "dialog");
    }

    // Surface: a tap or click on the picture. Touch toggles the controls, a mouse toggles play, double click goes fullscreen.
    const surfaceLayer = make("div", "movie-ui-surface");
    let tapTimer, hiddenAtTouch = false;
    // The touch itself wakes the controls (show runs on pointerdown), so remember what the tap found.
    root.addEventListener("pointerdown", () => { hiddenAtTouch = root.classList.contains("movie-idle"); }, { capture: true, signal });
    surfaceLayer.addEventListener("mousedown", event => event.preventDefault(), { signal });
    surfaceLayer.addEventListener("click", event => {
        if (document.activeElement === document.body) playPause.focus({ preventScroll: true });
        if (event.pointerType === "touch" || !matchMedia("(hover: hover) and (pointer: fine)").matches) {
            // Like YouTube: a tap on the picture hides visible controls at once and brings hidden ones back.
            if (hiddenAtTouch) show();
            else hide();
            return;
        }
        if (event.detail > 1) { clearTimeout(tapTimer); void toggleFullscreen(); return; }
        clearTimeout(tapTimer);
        tapTimer = setTimeout(toggle, 220);
    }, { signal });

    // The caller's status line doubles as the on-picture message, so track fallbacks are visible without opening the sheet.
    const notice = ctx.notice;
    const failure = make("p", "movie-ui-line");
    failure.id = "movie-playback-error";
    failure.setAttribute("role", "status");
    const retry = make("button", "movie-ui-retry", "Try again");
    retry.type = "button";
    retry.setAttribute("aria-describedby", failure.id);
    retry.hidden = true;
    const hint = make("p", "movie-ui-line");
    hint.setAttribute("role", "status");
    notice.classList.add("movie-ui-line");
    const message = make("div", "movie-ui-message");
    message.append(notice, failure, retry, hint);
    const spinnerRoot = make("div", "movie-ui-center");
    spinnerRoot.append(spinner);
    const subs = make("div", "movie-ui-subs");
    subs.setAttribute("aria-hidden", "true");
    const shortcutStatus = make("div", "movie-ui-shortcut");
    shortcutStatus.setAttribute("role", "status");
    let shortcutTimer;
    function showShortcut(text) {
        shortcutStatus.textContent = text;
        clearTimeout(shortcutTimer);
        shortcutTimer = setTimeout(() => { shortcutStatus.textContent = ""; }, 1200);
    }
    root.append(surfaceLayer, subs, spinnerRoot, message, top, bottom, shortcutStatus, audioSheet);

    // Controls hide a few seconds after the last touch, playing or paused. Reduced motion only removes the fade, not the hiding.
    // A keyboard or remote focus ring keeps them up so the focused control stays visible.
    root.addEventListener("pointerdown", event => {
        root.classList.add("movie-pointer");
        const sheet = openSheet && sheets[openSheet];
        if (sheet && !sheet.node.contains(event.target) && !sheet.opener.contains(event.target))
            event.preventDefault();
    }, { capture: true, signal });
    root.addEventListener("click", event => {
        const sheet = openSheet && sheets[openSheet];
        if (sheet && !sheet.node.contains(event.target) && !sheet.opener.contains(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            closeSheet();
            return;
        }
        const button = event.target.closest("button");
        if (button && event.detail > 0) button.focus({ preventScroll: true });
    }, { capture: true, signal });
    const {hide, show} = watchPlayerIdle(surface, signal, () => {
        if (dragging || openSheet || retry.hidden && !root.classList.contains("movie-pointer") &&
            root.querySelector(".movie-ui-top :focus-visible, .movie-ui-mid :focus-visible, .movie-ui-bottom :focus-visible")) return;
        root.classList.add("movie-idle");
    }, () => {
        root.classList.remove("movie-idle");
    });
    // Subtitles: draw the active cues just above the bottom of the picture, and above the seek row while the controls show.
    const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
    let watched = [], frame, drawnText;
    function placeSubs() {
        const area = root.getBoundingClientRect();
        const hidden = root.classList.contains("movie-idle");
        const barTop = hidden ? null : seekRow.getBoundingClientRect().top - area.top;
        subs.style.bottom = subtitleBottom({ width: area.width, height: area.height, videoWidth: media.videoWidth, videoHeight: media.videoHeight, barTop }) + "px";
    }
    function drawCues() {
        const text = watched.flatMap(track => {
            if (!shift && !speed) return [...(track.activeCues ?? [])].map(cue => cue.text);
            const cues = track.cues;
            if (!cues?.length) return [];
            const anchor = cues[0].startTime;
            // Compare in the original cue timeline to apply the same transform to both edges.
            const time = anchor + (media.currentTime - shift / 10 - anchor) / (1 + speed / 10000);
            const active = [];
            for (const cue of cues) {
                if (cue.startTime > time) break;
                if (time < cue.endTime) active.push(cue.text);
            }
            return active;
        }).join("\n");
        if (text === drawnText) return;
        drawnText = text;
        const lines = cleanCue(text).replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => entities[entity]).split("\n").filter(Boolean);
        subs.replaceChildren(...lines.map(line => make("span", "movie-ui-sub", line)));
        placeSubs();
    }
    function paintTimedFrame() {
        drawCues();
        if ((shift || speed) && watched.length && !media.paused && !media.ended)
            frame = requestAnimationFrame(paintTimedFrame);
    }
    function refreshCueTiming() {
        cancelAnimationFrame(frame);
        watchTracks();
        paintTimedFrame();
    }
    function watchTracks() {
        for (const track of watched) track.removeEventListener("cuechange", drawCues);
        watched = [...media.textTracks].filter(track => track.mode === "hidden");
        for (const track of watched) track.addEventListener("cuechange", drawCues);
        drawCues();
    }
    media.textTracks.addEventListener("change", watchTracks, { signal });
    media.textTracks.addEventListener("addtrack", watchTracks, { signal });
    media.textTracks.addEventListener("removetrack", watchTracks, { signal });
    for (const type of ["play", "pause", "ended"]) media.addEventListener(type, refreshCueTiming, { signal });
    for (const type of ["seeking", "seeked", "timeupdate"]) media.addEventListener(type, drawCues, { signal });
    for (const type of ["loadedmetadata", "resize"]) media.addEventListener(type, placeSubs, { signal });
    window.addEventListener("resize", placeSubs, { signal });
    for (const type of ["fullscreenchange", "webkitfullscreenchange"])
        document.addEventListener(type, placeSubs, { signal });
    const classWatcher = new MutationObserver(placeSubs);
    classWatcher.observe(root, { attributes: true, attributeFilter: ["class"] });
    signal.addEventListener("abort", () => {
        cancelAnimationFrame(frame);
        classWatcher.disconnect();
        for (const track of watched) track.removeEventListener("cuechange", drawCues);
    });

    signal.addEventListener("abort", () => { clearTimeout(tapTimer); clearTimeout(shortcutTimer); });

    // Seek bar.
    const duration = () => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    function paint() {
        const total = duration(), at = Number.isFinite(media.currentTime) ? media.currentTime : 0;
        seek.max = String(total || 1);
        if (!dragging) seek.value = String(total ? Math.min(at, total) : 0);
        const fraction = total ? Math.min(1, (dragging ? Number(seek.value) : at) / total) : 0;
        seek.style.setProperty("--pct", (fraction * 100).toFixed(2) + "%");
        const left = total ? Math.max(0, total - (dragging ? Number(seek.value) : at)) : 0;
        remaining.textContent = clock(left);
        elapsed.textContent = clock(dragging ? Number(seek.value) : at);
        seek.setAttribute("aria-valuetext", `${clock(dragging ? Number(seek.value) : at)} of ${clock(total)}`);
    }
    function showTip() {
        const total = duration();
        const fraction = total ? Number(seek.value) / total : 0;
        tip.textContent = clock(Number(seek.value));
        tip.hidden = false;
        placeRangeTip(seek, tip, fraction, 14);
    }
    seek.addEventListener("input", () => { dragging = true; paint(); showTip(); show(); }, { signal });
    seek.addEventListener("change", () => {
        media.currentTime = Number(seek.value);
        dragging = false;
        tip.hidden = true;
        paint();
        show();
    }, { signal });
    for (const type of ["blur", "pointercancel"])
        seek.addEventListener(type, () => {
            dragging = false;
            tip.hidden = true;
            paint();
        }, { signal });

    // Media state.
    const sync = () => {
        const paused = media.paused || media.ended;
        playPause.setAttribute("aria-label", paused ? "Play" : "Pause");
        playPause.replaceChildren(icon(paused ? paths.play : paths.pause));
        root.classList.toggle("movie-paused", paused);
        show();
    };
    const busy = (on, label = "Buffering") => {
        spinner.hidden = !on;
        if (on && spinnerLabel.textContent !== label) spinnerLabel.textContent = label;
    };
    for (const [type, run] of [["play", sync], ["pause", sync], ["playing", () => {
        busy(false);
        failure.textContent = "";
        if (document.activeElement === retry) playPause.focus({preventScroll: true});
        retry.hidden = true;
        sync();
    }],
        ["waiting", () => busy(true, media.readyState < 1 ? "Loading" : "Buffering")],
        ["seeking", () => busy(true)], ["seeked", () => busy(false)], ["ended", () => { busy(false); sync(); }],
        ["canplay", () => busy(false)], ["timeupdate", paint], ["durationchange", paint], ["loadedmetadata", paint]])
        media.addEventListener(type, run, { signal });
    function syncFullscreen() {
        const label = isFullscreen() ? "Exit full screen" : "Full screen";
        fullscreen.replaceChildren(icon(isFullscreen() ? paths.collapse : paths.expand));
        fullscreen.setAttribute("aria-label", label);
    }
    for (const type of ["fullscreenchange", "webkitfullscreenchange"])
        document.addEventListener(type, syncFullscreen, { signal });
    syncFullscreen();

    // TV remotes use the arrows to move between controls and scrub on the seek bar.
    const rows = () => [[back], [seek], [playPause, rewind, forward, episodesButton, nextButton, tracksButton, fullscreen].filter(b => !b.hidden)];
    function moveFocus(target, key) {
        const sheetNode = openSheet && sheets[openSheet].node;
        if (sheetNode?.contains(target)) {
            const items = focusable(sheetNode);
            const at = items.indexOf(target) + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0);
            if (at !== items.indexOf(target) && items[at]) items[at].focus();
            return true;
        }
        const all = rows(), row = all.findIndex(items => items.includes(target));
        if (row < 0) return false;
        if (key === "ArrowLeft" || key === "ArrowRight") {
            const step = key === "ArrowRight" ? 1 : -1;
            if (target === seek) seekBy(step * 10);
            else all[row][Math.min(all[row].length - 1, Math.max(0, all[row].indexOf(target) + step))].focus();
            return true;
        }
        const next = all[Math.min(all.length - 1, Math.max(0, row + (key === "ArrowDown" ? 1 : -1)))];
        const middle = node => { const box = node.getBoundingClientRect(); return box.left + box.width / 2; };
        const x = middle(target);
        next.reduce((best, node) => Math.abs(middle(node) - x) < Math.abs(middle(best) - x) ? node : best).focus();
        return true;
    }
    // The Android Back button arrives here (familyhub.closeTopLayer): close a sheet first, then the player.
    root.addEventListener("movie-back", () => {
        const dialog = [...ctx.surface.querySelectorAll("dialog[open]")].at(-1);
        if (dialog) dialog.close();
        else if (openSheet) closeSheet();
        else if (isFullscreen()) void toggleFullscreen();
        else back.click();
    }, { signal });
    function seekBy(seconds) {
        const before = media.currentTime;
        skip(seconds);
        const moved = Math.round(media.currentTime - before);
        showShortcut(moved ? `${moved > 0 ? "+" : "−"}${Math.abs(moved)} s` : clock(media.currentTime));
    }
    function focusable(container) {
        return [...container.querySelectorAll("button, input, select, summary")].filter(control =>
            !control.disabled && control.tabIndex >= 0 && control.getClientRects().length &&
            getComputedStyle(control).visibility === "visible" &&
            (!control.closest("details:not([open])") || control.matches("summary")));
    }
    document.addEventListener("keydown", event => {
        const target = event.target, key = event.key.toLowerCase();
        if (!(target instanceof HTMLElement) || (!surface.contains(target) && target !== document.body) || target.closest("dialog") ||
            event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey) return;
        const arrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
        const sheet = openSheet && sheets[openSheet].node;
        const inSheet = sheet && sheet.contains(target);
        const tv = innerWidth >= 1600 && !sound;
        if (key === "tab" || key === "enter" && !event.altKey || arrow && (tv || inSheet))
            root.classList.remove("movie-pointer");
        if (key === "tab" && !event.altKey) {
            const controls = focusable(sheet || root);
            const edge = event.shiftKey ? controls[0] : controls.at(-1);
            if (target === edge || !controls.includes(target)) {
                event.preventDefault();
                (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
            }
            return;
        }
        if (target.isContentEditable || target.matches("textarea, input:not([type=range])")) return;
        if (key === "escape" && !event.altKey) {
            event.preventDefault();
            if (event.repeat || fullscreenPending) return;
            if (openSheet) closeSheet();
            else if (isFullscreen()) void toggleFullscreen();
            else back.click();
            return;
        }
        if (target.matches("select")) return;
        if ((!event.altKey && (key === "f11" || key === "f")) || event.altKey && key === "enter") {
            if (fullscreen.hidden) return;
            event.preventDefault();
            if (!event.repeat) void toggleFullscreen();
            return;
        }
        if (event.altKey) return;
        if (event.keyCode === 461 || key === "browserback") {
            event.preventDefault();
            root.dispatchEvent(new Event("movie-back"));
            return;
        }
        if (inSheet) {
            const group = target.closest("[role='radiogroup']");
            if (arrow && openSheet === "audio" && group) {
                const radios = [...group.querySelectorAll("[role='radio']")];
                const step = key === "arrowdown" || key === "arrowright" ? 1 : -1;
                const index = radios.indexOf(target) + step;
                if (radios[index] || !tv || key === "arrowleft" || key === "arrowright") {
                    event.preventDefault();
                    (radios[index] ?? radios.at(step > 0 ? 0 : -1))?.focus();
                    return;
                }
            }
            const stepper = target.closest(".movie-timing-stepper");
            if (stepper && (key === "arrowleft" || key === "arrowright")) {
                const controls = [...stepper.querySelectorAll(".movie-timing-controls button")];
                event.preventDefault();
                controls.at(key === "arrowleft" ? 0 : -1).focus();
                return;
            }
            if (tv && arrow && moveFocus(target, event.key)) event.preventDefault();
            return;
        }
        if (key === " " || key === "spacebar" || key === "k" || key === "enter" && !target.closest("button")) {
            event.preventDefault();
            if (!event.repeat) toggle();
        } else if (arrow) {
            if (target.matches(".movie-sound-slider") && (key === "arrowleft" || key === "arrowright")) return;
            event.preventDefault();
            if (tv && !(event.shiftKey && target === seek) && moveFocus(target, event.key)) return;
            if (key === "arrowleft" || key === "arrowright") {
                seekBy((key === "arrowright" ? 1 : -1) * (event.shiftKey ? 30 : 10));
            } else if (sound) {
                const step = key === "arrowup" ? .05 : -.05;
                const { muted, volume } = sound.state;
                const next = Math.round(Math.min(MAX_VOLUME, Math.max(0, (muted ? 0 : volume) + step)) * 100) / 100;
                sound.set({ volume: next });
                showShortcut(volumeLabel());
            }
        } else if (key === "m" && sound) {
            event.preventDefault();
            if (event.repeat) return;
            sound.toggleMute();
            showShortcut(volumeLabel());
        }
    }, { signal, capture: true });
    function volumeLabel() {
        const { muted, volume } = sound.state;
        return muted ? "Muted" : `Volume ${Math.round(volume * 100)}%`;
    }

    sync();
    paint();
    syncSubtitles();
    show();
    return {
        root,
        playButton: playPause,
        /** Episodes of the current season, or null when the title is not part of a series. */
        setEpisodes(list, currentId, play) {
            const body = sheets.episodes.body;
            if (!list?.length) {
                if (openSheet === "episodes") closeSheet();
                if (episodesButton === document.activeElement) tracksButton.focus({ preventScroll: true });
            } else if (body.contains(document.activeElement)) {
                sheets.episodes.close.focus({ preventScroll: true });
            }
            episodesButton.hidden = !list?.length;
            body.replaceChildren();
            for (const episode of list ?? []) {
                const row = make("button", "movie-episode");
                row.type = "button";
                const number = episode.IndexNumber != null ? `${episode.IndexNumber}. ` : "";
                row.append(make("span", "movie-episode-name", number + episode.Name));
                const watched = episode.UserData?.PlayedPercentage;
                if (watched > 0 && watched < 100) {
                    const bar = make("span", "movie-progress"), fill = make("span");
                    bar.setAttribute("aria-hidden", "true");
                    fill.style.width = Math.round(watched) + "%";
                    bar.append(fill);
                    row.append(bar);
                }
                if (episode.Id === currentId) row.setAttribute("aria-current", "true");
                row.addEventListener("click", () => play(episode), { signal });
                body.append(row);
            }
        },
        setNext(episode, play) {
            nextEpisode = episode ? { play: () => play(episode), name: episode.Name } : null;
            if (!episode && nextButton === document.activeElement) tracksButton.focus({ preventScroll: true });
            nextButton.hidden = !episode;
            if (episode) nextButton.setAttribute("aria-label", "Next episode: " + episode.Name);
        },
        say(text) { if (retry.hidden) failure.textContent = text; busy(false); show(); },
        showFailure(reason, run) {
            failure.textContent = reason;
            retry.onclick = run;
            const reveal = retry.hidden;
            retry.hidden = false;
            if (reveal && !openSheet && root.contains(document.activeElement)) retry.focus({preventScroll: true});
            busy(false);
            show();
        },
        subtitleStatus,
        syncSubtitles,
        hint(text) {
            hint.textContent = text;
            const timer = setTimeout(() => { hint.textContent = ""; }, 6000);
            signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        },
        openSettingsAt() { tracksButton.focus({ preventScroll: true }); },
        useAudioElement(element) {
            if (!sound) return false;
            sound.useAudioElement(element);
            return true;
        },
        openSheetName: () => openSheet,
        reopenSheet(name, focusSubtitle = false) {
            if (name === "subtitles") name = "audio";
            if (name && sheets[name]) toggleSheet(name, name === "audio"
                ? (focusSubtitle ? subtitles : audio).querySelector("[aria-checked='true']") : null);
            if (name === "audio" && focusSubtitle && announcedTrack)
                subtitleAnnouncement.textContent = `Subtitles: ${announcedTrack}`;
        },
        dispose() { root.remove(); }
    };
}
