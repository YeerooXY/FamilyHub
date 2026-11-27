export const AUDIO_DELAY_LIMIT = 500, AUDIO_DELAY_STEP = 25;
export const clampAudioDelay = ms => Math.max(-AUDIO_DELAY_LIMIT, Math.min(AUDIO_DELAY_LIMIT, Math.round(ms / AUDIO_DELAY_STEP) * AUDIO_DELAY_STEP));

/** Keep the selected audio on a second media clock while the main element supplies the picture. */
export function movieAudioSync(media, { key, signal, stream, Hls, report, useAudioElement }) {
    let value = 0, companion, hls, playing = false, muted = false, correcting = false, starting = false;
    try {
        const saved = Number(localStorage.getItem(key));
        if (localStorage.getItem(key) != null && Number.isFinite(saved)) value = clampAudioDelay(saved);
    } catch {}

    function stop() {
        if (!companion) return;
        hls?.destroy();
        companion.oncanplay = companion.onerror = null;
        companion.pause();
        companion.removeAttribute("src");
        companion.load();
        companion = hls = null;
        if (correcting && !useAudioElement(null)) media.muted = muted;
        correcting = starting = false;
    }

    function fail() {
        value = 0;
        stop();
        try { localStorage.removeItem(key); } catch {}
        report("Audio sync is unavailable for this stream.");
    }

    function follow() {
        if (!companion || !companion.readyState) return;
        const time = media.currentTime - value / 1000;
        if (!playing || time < 0 || time >= companion.duration) { companion.pause(); return; }
        const drift = time - companion.currentTime;
        if (companion.paused || Math.abs(drift) > .25) companion.currentTime = time;
        companion.playbackRate = media.playbackRate * Math.max(.94, Math.min(1.06, 1 + 0.5 * drift));
        if (companion.paused && !starting) {
            const audio = companion;
            starting = true;
            audio.play().then(() => {
                if (companion !== audio) return;
                starting = false;
                if (!correcting) {
                    muted = media.muted;
                    if (!useAudioElement(audio)) {
                        media.muted = true;
                        audio.muted = muted;
                    }
                    correcting = true;
                }
                follow();
            }).catch(error => { if (companion === audio) {
                starting = false;
                if (error.name !== "AbortError") fail();
            } });
        }
    }

    function apply() {
        if (!value) { stop(); return; }
        if (!companion) {
            companion = document.createElement("audio");
            companion.crossOrigin = media.crossOrigin;
            companion.preload = "auto";
            companion.volume = media.volume;
            companion.muted = true;
            const audio = companion;
            companion.oncanplay = follow;
            companion.onerror = () => { if (companion === audio) fail(); };
            if (Hls) {
                hls = new Hls({startPosition: Math.max(0, media.currentTime - value / 1000), enableWorker: false});
                hls.on(Hls.Events.ERROR, (_event, data) => { if (companion === audio && data.fatal) fail(); });
                hls.loadSource(stream);
                hls.attachMedia(companion);
            } else companion.src = stream;
        }
        follow();
    }

    media.addEventListener("playing", () => { playing = true; apply(); }, {signal});
    for (const event of ["pause", "waiting", "seeking", "ended"])
        media.addEventListener(event, () => { playing = false; companion?.pause(); }, {signal});
    media.addEventListener("seeked", () => { playing = !media.paused; follow(); }, {signal});
    const timer = setInterval(follow, 120);
    signal.addEventListener("abort", () => { clearInterval(timer); stop(); }, {once: true});

    return {
        get value() { return value; },
        step(ms) {
            value = clampAudioDelay(value + ms);
            try { localStorage.setItem(key, String(value)); } catch {}
            apply();
        }
    };
}
