// Sound settings for the movie player on a PC: volume with an extra-loud range, mute, a sound mode and the output device.
// Settings belong to the device (one speaker setup), not to a profile, so they live under one storage key.
// Phones and televisions have hardware volume, so the panel is only offered where a mouse and keyboard are.

export const SOUND_MODES = [
    ["original", "Original"],
    ["night", "Night mode"],
    ["dialogue", "Dialogue"],
    ["bass", "Bass boost"]
];
const KEY = "familyhub.movie.sound.v1";
export const MAX_VOLUME = 2;

export function normalizeSound(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const volume = Number.isFinite(value.volume) ? Math.min(MAX_VOLUME, Math.max(0, value.volume)) : 1;
    return {
        volume: Math.round(volume * 100) / 100,
        muted: value.muted === true,
        mode: SOUND_MODES.some(([id]) => id === value.mode) ? value.mode : "original",
        device: typeof value.device === "string" && value.device.length <= 512 ? value.device : ""
    };
}

export function readSound(storage = globalThis.localStorage) {
    try { return normalizeSound(JSON.parse(storage.getItem(KEY))); } catch { return normalizeSound(); }
}

export function saveSound(sound, storage = globalThis.localStorage) {
    try { storage.setItem(KEY, JSON.stringify(normalizeSound(sound))); return true; } catch { return false; }
}

/** Whether to offer the panel: a fine pointer with hover, and a window narrower than a television. */
export function soundPanelWanted(win = globalThis) {
    try {
        return win.matchMedia("(hover: hover) and (pointer: fine)").matches && win.innerWidth < 1600;
    } catch { return false; }
}

/**
 * Applies the saved sound to a video element and returns the controller.
 * Volume up to 100% and mute use the element. Anything louder, and every mode, goes through Web Audio; that graph
 * is built only when first needed, because a media element can be connected to one only once.
 */
export function attachSound(media, { signal, storage, AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext } = {}) {
    let state = readSound(storage);
    let context = null, source = null, master = null, nodes = null;
    const listeners = new Set();
    const canRoute = typeof AudioContextClass === "function";
    const canPickOutput = () => typeof (context?.setSinkId ?? media.setSinkId) === "function";

    function ensureGraph() {
        if (context || !canRoute) return !!context;
        try {
            context = new AudioContextClass({ latencyHint: "playback" });
            source = context.createMediaElementSource(media);
            master = context.createGain();
            master.connect(context.destination);
            nodes = {
                compressor: Object.assign(context.createDynamicsCompressor(), {}),
                makeup: context.createGain(),
                highpass: context.createBiquadFilter(),
                presence: context.createBiquadFilter(),
                bass: context.createBiquadFilter()
            };
            nodes.compressor.threshold.value = -42; nodes.compressor.knee.value = 28; nodes.compressor.ratio.value = 10;
            nodes.compressor.attack.value = .004; nodes.compressor.release.value = .25;
            nodes.makeup.gain.value = 2.2;
            nodes.highpass.type = "highpass"; nodes.highpass.frequency.value = 140;
            nodes.presence.type = "peaking"; nodes.presence.frequency.value = 2600; nodes.presence.Q.value = 1; nodes.presence.gain.value = 6;
            nodes.bass.type = "lowshelf"; nodes.bass.frequency.value = 140; nodes.bass.gain.value = 8;
            return true;
        } catch {
            context = null;
            return false;
        }
    }

    function route() {
        if (!context) return;
        source.disconnect();
        for (const node of Object.values(nodes)) node.disconnect();
        const chain = {
            night: [nodes.compressor, nodes.makeup],
            dialogue: [nodes.highpass, nodes.presence],
            bass: [nodes.bass],
            original: []
        }[state.mode];
        let last = source;
        for (const node of chain) { last.connect(node); last = node; }
        last.connect(master);
    }

    function apply() {
        const needsGraph = state.mode !== "original" || state.volume > 1;
        if (needsGraph && !context) ensureGraph();
        if (context) {
            // Once the element is in the graph its own volume stays at full and the gain node does the work.
            media.volume = 1; media.muted = false;
            master.gain.value = state.muted ? 0 : state.volume;
            route();
            if (context.state === "suspended") context.resume().catch(() => {});
        } else {
            media.volume = Math.min(1, state.volume);
            media.muted = state.muted;
        }
    }

    async function applyDevice() {
        const target = context?.setSinkId ? context : media.setSinkId ? media : null;
        if (!target) return true;
        try { await target.setSinkId(state.device || ""); return true; } catch { return false; }
    }

    // A fresh element starts at the saved settings; the user's choice outlives each movie.
    apply();
    if (state.device) applyDevice();
    signal?.addEventListener("abort", () => { context?.close().catch(() => {}); context = null; }, { once: true });

    const controller = {
        get state() { return { ...state }; },
        get canRoute() { return canRoute; },
        get canPickOutput() { return canPickOutput(); },
        onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        set(patch) {
            const before = state;
            state = normalizeSound({ ...state, ...patch });
            // Raising the volume above zero ends a mute, as every player does.
            if (patch.volume !== undefined && patch.muted === undefined && state.volume > 0) state.muted = false;
            if (patch.mode !== undefined && !canRoute && state.mode !== "original") state.mode = "original";
            apply();
            if (state.device !== before.device) applyDevice();
            saveSound(state, storage);
            for (const listener of listeners) listener(controller.state);
            return controller.state;
        },
        toggleMute() { return controller.set({ muted: !state.muted }); },
        async outputs() {
            try {
                const all = await navigator.mediaDevices.enumerateDevices();
                let count = 0;
                return all.filter(device => device.kind === "audiooutput").map(device => ({
                    id: device.deviceId, label: device.label || (device.deviceId === "default" ? "System default" : `Output ${++count}`)
                }));
            } catch { return []; }
        }
    };
    return controller;
}
