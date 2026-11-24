// Full-window player controls for Movies & TV: title and close at the top, 10-second skips around a large
// play button, a seek bar with the remaining time, and Episodes / Audio / Subtitles / Next Episode below.
// The module owns only the controls. movies.js owns the video element, Jellyfin and progress reporting.

import { attachSound, soundPanelWanted, SOUND_MODES, MAX_VOLUME } from "./movie-sound.js";

const SVG = "http://www.w3.org/2000/svg";
const paths = {
    back: "M15 5l-7 7 7 7",
    close: "M6 6l12 12M18 6L6 18",
    play: "M7 4.5v15l12-7.5z",
    pause: "M7 4h4v16H7zM13 4h4v16h-4z",
    skip: ["M9 3L6 6l3 3", "M6 6a8 8 0 1 1-2 5"],
    next: ["M5 5v14l10-7z", "M19 5v14"],
    episodes: ["M8 4h12v12H8z", "M4 8v12h12"],
    audio: ["M4 9v6h4l5 4V5L8 9z", "M16.5 9a4.5 4.5 0 0 1 0 6"],
    subtitles: ["M4 5h16v11h-9l-4 4v-4H4z", "M7 9h10M7 12h6"],
    settings: ["M4 7h16M4 17h16", "M9 4v6M15 14v6"],
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
        text.setAttribute("x", "12.5");
        text.setAttribute("y", "15.2");
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
    const root = make("div", "movie-ui");
    let idleTimer, dragging = false, openSheet = null, nextEpisode = null;

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

    // Middle: skip back, play or pause, skip forward.
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
    spinner.hidden = true;
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", "Loading");
    const mid = make("div", "movie-ui-mid");
    mid.append(rewind, playPause, forward);

    // Bottom: seek bar and remaining time, then the three actions.
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
    seekRow.append(seekWrap, remaining);

    const fullscreen = button("movie-ui-action", "Full screen", paths.expand, {}, () => {
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        else surface.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
    });
    fullscreen.append(make("span", "", "Full screen"));
    fullscreen.hidden = !document.fullscreenEnabled;
    const episodesButton = button("movie-ui-action", "Episodes", paths.episodes, {}, () => toggleSheet("episodes"));
    episodesButton.append(make("span", "", "Episodes"));
    episodesButton.hidden = true;
    const audioButton = button("movie-ui-action", "Audio", paths.audio, {}, () => toggleSheet("audio"));
    audioButton.append(make("span", "", "Audio"));
    audioButton.hidden = !ctx.audioPick && !ctx.addAudio;
    const subtitlesButton = button("movie-ui-action", "Subtitles", paths.subtitles, {}, () => toggleSheet("subtitles"));
    subtitlesButton.append(make("span", "", "Subtitles"));
    const settingsButton = button("movie-ui-action", "Settings", paths.settings, {}, () => openSettingsAt());
    settingsButton.append(make("span", "", "Settings"));
    // Sound settings for a PC: phones and televisions have hardware volume, so nothing is offered there.
    const sound = soundPanelWanted() ? attachSound(media, { signal }) : null;
    const soundButton = button("movie-ui-action", "Sound", paths.sound, {}, () => toggleSheet("sound"));
    soundButton.append(make("span", "", "Sound"));
    soundButton.hidden = !sound;
    const nextButton = button("movie-ui-action", "Next episode", paths.next, {}, () => nextEpisode?.play());
    nextButton.append(make("span", "", "Next Episode"));
    nextButton.hidden = true;
    const actions = make("div", "movie-ui-actions");
    actions.append(fullscreen, episodesButton, audioButton, subtitlesButton, settingsButton, soundButton, nextButton);
    const bottom = make("div", "movie-ui-bottom");
    bottom.append(seekRow, actions);

    // Sheets: Audio & Subtitles and Episodes. One is open at a time; each has one named close control.
    const sheets = {};
    function makeSheet(name, heading, closeLabel, opener) {
        const sheet = make("div", "movie-sheet");
        sheet.hidden = true;
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-label", heading);
        const head = make("div", "movie-sheet-head");
        const close = button("movie-sheet-close", closeLabel, paths.close, {}, closeSheet);
        head.append(make("h3", "", heading), close);
        const body = make("div", "movie-sheet-body");
        sheet.append(head, body);
        sheets[name] = { node: sheet, body, close, opener };
        return sheet;
    }
    const audioSheet = makeSheet("audio", "Audio", "Close audio", audioButton);
    const subtitlesSheet = makeSheet("subtitles", "Subtitles", "Close subtitles", subtitlesButton);
    const settingsSheet = makeSheet("settings", "Settings", "Close settings", settingsButton);
    const settingsBody = sheets.settings.body;
    const qualityLabel = make("p", "movie-quality-label", ctx.dataSaver.quality);
    const qualityOptions = make("div", "movie-quality-options");
    qualityOptions.setAttribute("role", "radiogroup");
    qualityOptions.setAttribute("aria-label", "Data saver");
    for (const [id, label, estimate] of ctx.dataSaver.choices) {
        const row = button("movie-track-option", label + ", " + estimate, null, {}, () => ctx.dataSaver.change(id));
        row.setAttribute("role", "radio");
        row.setAttribute("aria-checked", String(ctx.dataSaver.selected === id));
        row.append(make("span", "", label), make("small", "", estimate));
        qualityOptions.append(row);
    }
    settingsBody.append(qualityLabel, make("h4", "movie-quality-label", "Data saver"), qualityOptions);
    function openSettingsAt() {
        toggleSheet("settings", qualityOptions.querySelector('[aria-checked="true"]'));
    }
    const episodesSheet = makeSheet("episodes", "Episodes", "Close episodes", episodesButton);
    const soundSheet = makeSheet("sound", "Sound", "Close sound", soundButton);
    let refreshOutputs = async () => {};
    if (sound) {
        soundSheet.classList.add("movie-sheet-sound");
        const volumeRow = make("div", "movie-sound-volume");
        const mute = make("button", "movie-sound-mute");
        mute.type = "button";
        const volume = make("input", "movie-sound-slider");
        Object.assign(volume, { type: "range", min: 0, max: MAX_VOLUME * 100, step: 5 });
        volume.setAttribute("aria-label", "Volume");
        const readout = make("output", "movie-sound-readout");
        const hint = make("p", "movie-sound-hint", "Above 100% is louder than the original and can distort.");
        volumeRow.append(mute, volume, readout);
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
        const paint = state => {
            volume.value = state.muted ? 0 : Math.round(state.volume * 100);
            readout.textContent = (state.muted ? 0 : Math.round(state.volume * 100)) + "%";
            volume.setAttribute("aria-valuetext", readout.textContent);
            mute.setAttribute("aria-label", state.muted ? "Unmute" : "Mute");
            mute.setAttribute("aria-pressed", String(state.muted));
            mute.replaceChildren(icon(state.muted || state.volume === 0 ? paths.soundOff : paths.sound));
            hint.hidden = state.muted || state.volume <= 1;
            for (const row of modeRows) row.setAttribute("aria-checked", String(row.dataset.value === state.mode));
            for (const row of outputs.list.children) row.setAttribute("aria-checked", String(row.dataset.value === state.device));
        };
        mute.addEventListener("click", () => sound.toggleMute(), { signal });
        volume.addEventListener("input", () => sound.set({ volume: Number(volume.value) / 100 }), { signal });
        sound.onChange(paint);
        refreshOutputs = async () => {
            const found = sound.canPickOutput ? await sound.outputs() : [];
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
        };
        const body = sheets.sound.body;
        body.classList.add("movie-sound-body");
        body.append(volumeRow, hint, modes.column, outputs.column);
        paint(sound.state);
    }
    // Audio & Subtitles is one popover with a list per kind, like Netflix. The labelled selects stay in the document,
    // hidden, as the single source of truth: choosing a row sets its select and fires the select's change event.
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
                options = next;
                list.replaceChildren(...options.map(option => {
                    const row = make("button", "movie-track-option", option.text);
                    row.type = "button";
                    row.setAttribute("role", "radio");
                    row.addEventListener("click", () => {
                        if (pick.value === option.value) return;
                        pick.value = option.value;
                        pick.dispatchEvent(new Event("change"));
                        sync();
                    }, { signal });
                    return row;
                }));
            }
            options.forEach((option, index) =>
                list.children[index].setAttribute("aria-checked", String(pick.value === option.value)));
        }
        sync();
        return sync;
    }
    const syncAudio = trackList(sheets.audio.body, ctx.audioPick, "Audio track");
    const syncSubtitles = trackList(sheets.subtitles.body, ctx.subtitlePick, "Subtitle track");
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
        sheets.audio.body.append(sync);
    }
    if (ctx.addAudio) {
        const add = button("movie-track-option", "Add audio track", null, {}, () => ctx.addAudio(add));
        add.textContent = "Add audio track";
        sheets.audio.body.append(add);
    }
    if (ctx.subtitleSearch) {
        const finder = make("div", "movie-subtitle-finder");
        const form = make("div", "movie-subtitle-form");
        const languageLabel = make("label", "", "Subtitle language");
        const language = make("select");
        language.add(new Option("English", "eng"));
        language.add(new Option("Hungarian", "hun"));
        language.value = ctx.subtitleSearch.language;
        languageLabel.append(language);
        const find = make("button", "movie-subtitle-action", "Find subtitles");
        find.type = "button";
        const feedback = make("p", "");
        feedback.setAttribute("role", "status");
        const results = make("ul", "movie-subtitle-results");
        results.setAttribute("aria-label", "Subtitle results");
        form.append(languageLabel, find);
        finder.append(form, feedback, results);
        sheets.subtitles.body.append(finder);
        let busy = false;
        function setBusy(value) {
            busy = value;
            find.setAttribute("aria-disabled", String(value));
            for (const row of results.querySelectorAll("button")) row.setAttribute("aria-disabled", String(value));
        }
        find.addEventListener("click", async () => {
            if (busy) return;
            find.focus();
            results.replaceChildren();
            setBusy(true);
            feedback.textContent = "Searching for subtitles…";
            const selectedLanguage = language.value;
            const languageName = language.selectedOptions[0].text;
            try {
                const matches = await ctx.subtitleSearch.find(selectedLanguage);
                if (signal.aborted) return;
                for (const result of matches.filter(result => typeof result.Id === "string" && result.Id)) {
                    const entry = make("li");
                    const add = make("button", "movie-subtitle-action");
                    add.type = "button";
                    const facts = [languageName];
                    if (Number.isFinite(result.CommunityRating) && result.CommunityRating > 0)
                        facts.push(`Rating ${result.CommunityRating.toLocaleString(undefined, {maximumFractionDigits: 1})}`);
                    if (Number.isFinite(result.DownloadCount))
                        facts.push(`${result.DownloadCount.toLocaleString()} ${result.DownloadCount === 1 ? "download" : "downloads"}`);
                    add.append(make("strong", "", result.Name || "Subtitle"), make("span", "", facts.join(" · ")));
                    add.addEventListener("click", async () => {
                        if (busy) return;
                        add.focus();
                        setBusy(true);
                        feedback.textContent = "Adding subtitles…";
                        try {
                            await ctx.subtitleSearch.add(result, selectedLanguage);
                            if (signal.aborted) return;
                            if (openSheet === "subtitles") closeSheet();
                            results.replaceChildren();
                            feedback.textContent = "";
                            failure.textContent = "Subtitles added.";
                            show();
                        } catch {
                            if (!signal.aborted) feedback.textContent = "Could not add the subtitles. Try again or check with the server owner.";
                        } finally {
                            if (!signal.aborted) setBusy(false);
                        }
                    }, { signal });
                    entry.append(add);
                    results.append(entry);
                }
                feedback.textContent = results.childElementCount ? "" : "No subtitles found.";
            } catch {
                if (!signal.aborted) feedback.textContent = "Could not search for subtitles. Check subtitle access with the server owner and try again.";
            } finally {
                if (!signal.aborted) setBusy(false);
            }
        }, { signal });
    }
    function toggleSheet(name, focusTarget) {
        if (openSheet === name) return closeSheet();
        const previous = openSheet && sheets[openSheet];
        openSheet = name;
        sheets[name].node.hidden = false;
        if (name === "audio") syncAudio();
        if (name === "subtitles") syncSubtitles();
        if (name === "sound") refreshOutputs();
        sheets[name].opener.setAttribute("aria-expanded", "true");
        show();
        // Focus starts on the close control (or the current episode), so Escape and Enter work the same everywhere.
        (focusTarget ?? sheets[name].body.querySelector("[aria-current='true']") ?? sheets[name].close).focus();
        if (previous) {
            previous.opener.setAttribute("aria-expanded", "false");
            previous.node.hidden = true;
        }
    }
    function closeSheet() {
        if (!openSheet) return;
        const sheet = sheets[openSheet];
        openSheet = null;
        sheet.opener.setAttribute("aria-expanded", "false");
        sheet.opener.focus();
        sheet.node.hidden = true;
        show();
    }
    for (const sheet of Object.values(sheets)) sheet.opener.setAttribute("aria-expanded", "false");

    // Surface: a tap or click on the picture. Touch toggles the controls, a mouse toggles play, double click goes fullscreen.
    const surfaceLayer = make("div", "movie-ui-surface");
    let tapTimer, hiddenAtTouch = false;
    // The touch itself wakes the controls (show runs on pointerdown), so remember what the tap found.
    root.addEventListener("pointerdown", () => { hiddenAtTouch = root.classList.contains("movie-idle"); }, { capture: true, signal });
    surfaceLayer.addEventListener("click", event => {
        if (openSheet) { closeSheet(); return; }
        const pointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
        if (!pointer) {
            // Like YouTube: a tap on the picture hides visible controls at once and brings hidden ones back.
            if (hiddenAtTouch) show();
            else { clearTimeout(idleTimer); root.classList.add("movie-idle"); }
            return;
        }
        if (event.detail > 1) { clearTimeout(tapTimer); fullscreen.click(); return; }
        clearTimeout(tapTimer);
        tapTimer = setTimeout(toggle, 220);
    }, { signal });

    // The caller's status line doubles as the on-picture message, so track fallbacks are visible without opening the sheet.
    const notice = ctx.notice;
    const failure = make("p", "movie-ui-line");
    failure.setAttribute("role", "status");
    const hint = make("p", "movie-ui-line");
    hint.setAttribute("role", "status");
    notice.classList.add("movie-ui-line");
    const message = make("div", "movie-ui-message");
    message.append(notice, failure, hint);
    const spinnerRoot = make("div", "movie-ui-center");
    spinnerRoot.append(spinner);
    const subs = make("div", "movie-ui-subs");
    subs.setAttribute("aria-hidden", "true");
    root.append(surfaceLayer, subs, spinnerRoot, message, top, mid, bottom, audioSheet, subtitlesSheet, episodesSheet, soundSheet, settingsSheet);

    // Controls hide a few seconds after the last touch, playing or paused. Reduced motion only removes the fade, not the hiding.
    // A keyboard or remote focus ring keeps them up so the focused control stays visible.
    let keyboardMode = false;
    document.addEventListener("keydown", () => { keyboardMode = true; }, { capture: true, signal });
    root.addEventListener("pointerdown", () => { keyboardMode = false; }, { signal });
    function show() {
        root.classList.remove("movie-idle");
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!dragging && !openSheet && !(keyboardMode && root.querySelector(":focus-visible"))) root.classList.add("movie-idle");
        }, 3500);
    }
    // Subtitles: draw the active cues just above the bottom of the picture, and above the seek row while the controls show.
    const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
    let watched = [];
    function placeSubs() {
        const area = root.getBoundingClientRect();
        const hidden = root.classList.contains("movie-idle");
        const barTop = hidden ? null : seekRow.getBoundingClientRect().top - area.top;
        subs.style.bottom = subtitleBottom({ width: area.width, height: area.height, videoWidth: media.videoWidth, videoHeight: media.videoHeight, barTop }) + "px";
    }
    function drawCues() {
        const text = watched.flatMap(track => [...(track.activeCues || [])].map(cue => cue.text)).join("\n");
        const lines = cleanCue(text).replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => entities[entity]).split("\n").filter(Boolean);
        subs.replaceChildren(...lines.map(line => make("span", "movie-ui-sub", line)));
        placeSubs();
    }
    function watchTracks() {
        for (const track of watched) track.removeEventListener("cuechange", drawCues);
        watched = [...media.textTracks].filter(track => track.mode === "hidden");
        for (const track of watched) track.addEventListener("cuechange", drawCues);
        drawCues();
    }
    media.textTracks.addEventListener("change", watchTracks, { signal });
    media.textTracks.addEventListener("addtrack", watchTracks, { signal });
    for (const type of ["loadedmetadata", "resize"]) media.addEventListener(type, placeSubs, { signal });
    window.addEventListener("resize", placeSubs, { signal });
    document.addEventListener("fullscreenchange", placeSubs, { signal });
    const classWatcher = new MutationObserver(placeSubs);
    classWatcher.observe(root, { attributes: true, attributeFilter: ["class"] });
    signal.addEventListener("abort", () => { classWatcher.disconnect(); for (const track of watched) track.removeEventListener("cuechange", drawCues); });

    for (const type of ["pointermove", "pointerdown", "touchstart", "focusin"])
        root.addEventListener(type, event => { if (!root.classList.contains("movie-idle") || type !== "pointermove" || event.pointerType === "mouse") show(); }, { passive: true, signal });
    signal.addEventListener("abort", () => { clearTimeout(idleTimer); clearTimeout(tapTimer); });

    // Seek bar.
    const duration = () => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    function paint() {
        const total = duration(), at = Number.isFinite(media.currentTime) ? media.currentTime : 0;
        if (!dragging) seek.value = String(total ? Math.min(at, total) : 0);
        seek.max = String(total || 1);
        const fraction = total ? Math.min(1, (dragging ? Number(seek.value) : at) / total) : 0;
        seek.style.setProperty("--pct", (fraction * 100).toFixed(2) + "%");
        const left = total ? Math.max(0, total - (dragging ? Number(seek.value) : at)) : 0;
        remaining.textContent = clock(left);
        seek.setAttribute("aria-valuetext", `${clock(dragging ? Number(seek.value) : at)} of ${clock(total)}`);
    }
    function showTip() {
        const total = duration();
        const fraction = total ? Number(seek.value) / total : 0;
        tip.textContent = clock(Number(seek.value));
        tip.hidden = false;
        // Anchor to the painted track and keep the whole tooltip inside it.
        const width = seek.getBoundingClientRect().width, half = tip.offsetWidth / 2;
        tip.style.left = Math.min(Math.max(fraction * width, half), Math.max(half, width - half)) + "px";
    }
    seek.addEventListener("input", () => { dragging = true; paint(); showTip(); show(); }, { signal });
    seek.addEventListener("change", () => {
        media.currentTime = Number(seek.value);
        dragging = false;
        tip.hidden = true;
        paint();
    }, { signal });
    seek.addEventListener("blur", () => { tip.hidden = true; }, { signal });

    // Media state.
    const sync = () => {
        const paused = media.paused;
        playPause.setAttribute("aria-label", paused ? "Play" : "Pause");
        playPause.replaceChildren(icon(paused ? paths.play : paths.pause));
        root.classList.toggle("movie-paused", paused);
        if (paused) show(); else show();
    };
    const busy = on => { spinner.hidden = !on; };
    for (const [type, run] of [["play", sync], ["pause", sync], ["playing", () => { busy(false); failure.textContent = ""; sync(); }],
        ["waiting", () => busy(true)], ["seeking", () => busy(true)], ["seeked", () => busy(false)],
        ["canplay", () => busy(false)], ["timeupdate", paint], ["durationchange", paint], ["loadedmetadata", paint]])
        media.addEventListener(type, run, { signal });
    document.addEventListener("fullscreenchange", () => {
        const on = document.fullscreenElement === surface;
        fullscreen.replaceChildren(icon(on ? paths.collapse : paths.expand), make("span", "", on ? "Exit full screen" : "Full screen"));
        fullscreen.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    }, { signal });

    // Keyboard and TV remote. With a control focused, the arrow keys move between controls (a TV remote has no pointer):
    // left and right inside a row, up and down between rows. The seek bar scrubs with left and right. With nothing
    // focused, left and right skip 10 seconds. Space, K or Enter toggles play, Escape closes a sheet, Back closes the player.
    const rows = () => [[back], [rewind, playPause, forward], [seek], [fullscreen, episodesButton, audioButton, subtitlesButton, settingsButton, soundButton, nextButton].filter(b => !b.hidden)];
    function moveFocus(target, key) {
        const sheetNode = openSheet && sheets[openSheet].node;
        if (sheetNode?.contains(target)) {
            const items = [...sheetNode.querySelectorAll("button, select, input")].filter(node => !node.closest("[hidden]"));
            const at = items.indexOf(target) + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0);
            if (at !== items.indexOf(target) && items[at]) items[at].focus();
            return true;
        }
        const all = rows(), row = all.findIndex(items => items.includes(target));
        if (row < 0) return false;
        if (key === "ArrowLeft" || key === "ArrowRight") {
            const step = key === "ArrowRight" ? 1 : -1;
            if (target === seek) skip(step * 10);
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
        else back.click();
    });
    document.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (target.closest?.("dialog")) return;
        if (event.key === "Escape" && openSheet) { event.preventDefault(); closeSheet(); return; }
        if (event.keyCode === 461 || event.key === "BrowserBack") { event.preventDefault(); back.click(); return; }
        const arrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
        if (target instanceof HTMLSelectElement) return;
        // A volume slider keeps its own Left and Right; only the seek bar scrubs.
        if (target instanceof HTMLInputElement && target !== seek && ["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        if (arrow && root.contains(target) && target !== document.body) {
            show();
            if (moveFocus(target, event.key)) event.preventDefault();
            return;
        }
        if (target instanceof HTMLButtonElement && [" ", "Enter"].includes(event.key)) return;
        if (event.key === "ArrowLeft") { event.preventDefault(); skip(-10); }
        else if (event.key === "ArrowRight") { event.preventDefault(); skip(10); }
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); show(); playPause.focus(); }
        else if (event.key === " " || event.key === "k" || event.key === "Enter") { event.preventDefault(); toggle(); }
        else if (event.key === "f" || event.key === "F") fullscreen.click();
        else if ((event.key === "m" || event.key === "M") && sound) { sound.toggleMute(); failure.textContent = sound.state.muted ? "Muted." : "Sound on."; show(); }
    }, { signal, capture: true });

    sync();
    paint();
    watchTracks();
    show();
    return {
        root,
        playButton: playPause,
        /** Episodes of the current season, or null when the title is not part of a series. */
        setEpisodes(list, currentId, play) {
            episodesButton.hidden = !list?.length;
            const body = sheets.episodes.body;
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
            nextButton.hidden = !episode;
            if (episode) nextButton.setAttribute("aria-label", "Next episode: " + episode.Name);
        },
        /** A short line over the picture, for example "This device could not play this version." */
        say(text) { failure.textContent = text; busy(false); show(); },
        hint(text) {
            hint.textContent = text;
            const timer = setTimeout(() => { hint.textContent = ""; }, 6000);
            signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        },
        setDataSaver(id) {
            ctx.dataSaver.choices.forEach(([choice], index) =>
                qualityOptions.children[index].setAttribute("aria-checked", String(choice === id)));
        },
        openSettingsAt,
        useAudioElement(element) {
            if (!sound) return false;
            sound.useAudioElement(element);
            return true;
        },
        openSheetName: () => openSheet,
        reopenSheet(name) {
            if (name && sheets[name]) toggleSheet(name, name === "audio"
                ? sheets.audio.body.querySelector("[aria-checked='true']") : null);
        },
        dispose() { root.remove(); }
    };
}
