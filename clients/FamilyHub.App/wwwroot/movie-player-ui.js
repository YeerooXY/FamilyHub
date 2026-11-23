// Full-window player controls for Movies & TV: title and close at the top, 10-second skips around a large
// play button, a seek bar with the remaining time, and Episodes / Audio & Subtitles / Next Episode below.
// The module owns only the controls. movies.js owns the video element, Jellyfin and progress reporting.

const SVG = "http://www.w3.org/2000/svg";
const paths = {
    close: "M6 6l12 12M18 6L6 18",
    play: "M7 4.5v15l12-7.5z",
    pause: "M7 4h4v16H7zM13 4h4v16h-4z",
    skip: ["M9 3L6 6l3 3", "M6 6a8 8 0 1 1-2 5"],
    next: ["M5 5v14l10-7z", "M19 5v14"],
    episodes: ["M8 4h12v12H8z", "M4 8v12h12"],
    tracks: ["M4 5h16v11h-9l-4 4v-4H4z", "M7 9h10M7 12h6"],
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

/**
 * @param {object} ctx
 * @param {HTMLVideoElement} ctx.media
 * @param {HTMLElement} ctx.surface  element that goes fullscreen (the player section)
 * @param {HTMLButtonElement} ctx.back  the close control, named "Back to movies"
 * @param {string} ctx.title @param {string} [ctx.kicker]
 * @param {HTMLElement[]} ctx.trackControls  labelled selects for audio and subtitles
 * @param {HTMLElement} ctx.notice  status line for track fallbacks
 * @param {AbortSignal} ctx.signal  aborts every listener
 */
export function buildPlayerUi(ctx) {
    const { media, surface, back, signal } = ctx;
    const quiet = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
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

    // Top: centred title, close at the right.
    const top = make("div", "movie-ui-top");
    const heading = make("div", "movie-ui-heading");
    if (ctx.kicker) heading.append(make("p", "movie-ui-kicker", ctx.kicker));
    heading.append(make("h2", "movie-ui-title", ctx.title));
    back.classList.add("movie-ui-close");
    back.setAttribute("aria-label", "Back to movies");
    back.replaceChildren(icon(paths.close));
    top.append(heading, back);

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
    const tracksButton = button("movie-ui-action", "Audio and subtitles", paths.tracks, {}, () => toggleSheet("tracks"));
    tracksButton.append(make("span", "", "Audio & Subtitles"));
    const nextButton = button("movie-ui-action", "Next episode", paths.next, {}, () => nextEpisode?.play());
    nextButton.append(make("span", "", "Next Episode"));
    nextButton.hidden = true;
    const actions = make("div", "movie-ui-actions");
    actions.append(fullscreen, episodesButton, tracksButton, nextButton);
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
        const close = button("movie-sheet-close", closeLabel, paths.close, {}, () => closeSheet(true));
        head.append(make("h3", "", heading), close);
        const body = make("div", "movie-sheet-body");
        sheet.append(head, body);
        sheets[name] = { node: sheet, body, close, opener };
        return sheet;
    }
    const tracksSheet = makeSheet("tracks", "Audio & Subtitles", "Close audio and subtitles", tracksButton);
    const episodesSheet = makeSheet("episodes", "Episodes", "Close episodes", episodesButton);
    sheets.tracks.body.append(...ctx.trackControls);
    function toggleSheet(name, focusTarget) {
        if (openSheet === name) return closeSheet(true);
        closeSheet(false);
        openSheet = name;
        sheets[name].node.hidden = false;
        sheets[name].opener.setAttribute("aria-expanded", "true");
        show();
        // Focus starts on the close control (or the current episode), so Escape and Enter work the same everywhere.
        (focusTarget ?? sheets[name].body.querySelector("[aria-current='true']") ?? sheets[name].close).focus();
    }
    function closeSheet(restoreFocus) {
        if (!openSheet) return;
        const sheet = sheets[openSheet];
        openSheet = null;
        sheet.node.hidden = true;
        sheet.opener.setAttribute("aria-expanded", "false");
        if (restoreFocus) sheet.opener.focus();
        show();
    }
    for (const name of ["tracks", "episodes"]) sheets[name].opener.setAttribute("aria-expanded", "false");

    // Surface: a tap or click on the picture. Touch toggles the controls, a mouse toggles play, double click goes fullscreen.
    const surfaceLayer = make("div", "movie-ui-surface");
    let tapTimer;
    surfaceLayer.addEventListener("click", event => {
        if (openSheet) { closeSheet(false); return; }
        const pointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
        if (!pointer) {
            if (root.classList.contains("movie-idle") || !media.paused) root.classList.toggle("movie-idle");
            else show();
            if (!root.classList.contains("movie-idle")) show();
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
    notice.classList.add("movie-ui-line");
    const message = make("div", "movie-ui-message");
    message.append(notice, failure);
    const spinnerRoot = make("div", "movie-ui-center");
    spinnerRoot.append(spinner);
    root.append(surfaceLayer, spinnerRoot, message, top, mid, bottom, tracksSheet, episodesSheet);

    // Controls hide while the film plays and nobody touches anything.
    function show() {
        root.classList.remove("movie-idle");
        clearTimeout(idleTimer);
        if (quiet()) return;
        idleTimer = setTimeout(() => {
            if (!media.paused && !dragging && !openSheet && !root.querySelector(":focus-visible")) root.classList.add("movie-idle");
        }, 3500);
    }
    for (const type of ["pointermove", "pointerdown", "touchstart", "focusin"])
        root.addEventListener(type, () => { if (!root.classList.contains("movie-idle") || type !== "pointermove") show(); }, { passive: true, signal });
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
    const rows = () => [[back], [rewind, playPause, forward], [seek], [fullscreen, episodesButton, tracksButton, nextButton].filter(b => !b.hidden)];
    function moveFocus(target, key) {
        const sheetNode = openSheet && sheets[openSheet].node;
        if (sheetNode?.contains(target)) {
            const items = [...sheetNode.querySelectorAll("button, select")];
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
    root.addEventListener("movie-back", () => { if (openSheet) closeSheet(true); else back.click(); });
    document.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (event.key === "Escape" && openSheet) { event.preventDefault(); closeSheet(true); return; }
        if (event.keyCode === 461 || event.key === "BrowserBack") { event.preventDefault(); back.click(); return; }
        const arrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
        if (target instanceof HTMLSelectElement) return;
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
    }, { signal, capture: true });

    sync();
    paint();
    return {
        root,
        playButton: playPause,
        openTracks: () => toggleSheet("tracks"),
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
                row.addEventListener("click", () => { closeSheet(false); play(episode); }, { signal });
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
        /** Reopens Audio & Subtitles with the audio list focused, after an audio change rebuilt the player. */
        openTracksAt: () => toggleSheet("tracks", sheets.tracks.body.querySelector("select")),
        dispose() { root.remove(); }
    };
}
