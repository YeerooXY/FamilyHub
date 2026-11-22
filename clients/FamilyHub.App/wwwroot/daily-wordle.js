const handles = new WeakMap();
const themeKey = 'familyhub:wordle-theme';

export function bind(surface, receiver) {
    unbind(surface);
    const abort = new AbortController();
    const handle = {abort, timer: null, lastRefresh: 0, refreshing: false};
    handles.set(surface, handle);
    handle.refresh = () => {
        if (document.hidden || handle.refreshing || Date.now() - handle.lastRefresh < 750) return;
        handle.lastRefresh = Date.now();
        handle.refreshing = true;
        receiver.invokeMethodAsync('RefreshToday').catch(() => {}).finally(() => { handle.refreshing = false; });
    };
    window.addEventListener('focus', handle.refresh, {signal: abort.signal});
    window.addEventListener('online', handle.refresh, {signal: abort.signal});
    document.addEventListener('visibilitychange', handle.refresh, {signal: abort.signal});
    const updateLiveFamily = () => receiver.invokeMethodAsync('UpdateLiveFamily', !document.hidden).catch(() => {});
    const familyTimer = setInterval(() => {
        if (!document.hidden) updateLiveFamily();
    }, 350);
    document.addEventListener('visibilitychange', updateLiveFamily, {signal: abort.signal});
    updateLiveFamily();
    abort.signal.addEventListener('abort', () => clearInterval(familyTimer), {once: true});
    const themeButton = surface.querySelector('.dw-theme');
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    let preference;
    try { preference = localStorage.getItem(themeKey); } catch {}
    const updateTheme = () => {
        const dark = preference === 'dark' || (preference !== 'light' && systemTheme.matches);
        surface.dataset.theme = dark ? 'dark' : 'light';
        themeButton.setAttribute('aria-pressed', String(dark));
    };
    updateTheme();
    themeButton.addEventListener('click', event => {
        preference = surface.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(themeKey, preference); } catch {}
        updateTheme();
        if (event.detail > 0 && surface.dataset.playing === 'true') surface.focus({preventScroll: true});
    }, {signal: abort.signal});
    systemTheme.addEventListener('change', updateTheme, {signal: abort.signal});
    if (!surface.contains(document.activeElement)) surface.focus({preventScroll: true});

    surface.addEventListener('keydown', event => {
        if (surface.dataset.playing !== 'true' || event.defaultPrevented || event.isComposing ||
            event.altKey || event.ctrlKey || event.metaKey || event.target.closest('dialog,input,textarea,select,[contenteditable=true]')) return;
        const key = event.key;
        if (key === 'Enter' && event.target.closest('button,a')) return;
        if (!(key === 'Enter' || key === 'Backspace' || /^[a-z]$/i.test(key))) return;
        event.preventDefault();
        if (key !== 'Enter' && event.target.closest('button,a')) surface.focus({preventScroll: true});
        receiver.invokeMethodAsync('TypeKey', key.length === 1 ? key.toUpperCase() : key).catch(() => {});
    }, {signal: abort.signal});
}

export function unbind(surface) {
    const handle = handles.get(surface);
    if (handle) {
        clearTimeout(handle.timer);
        handle.abort.abort();
    }
    handles.delete(surface);
}

export function updateReset(surface, nextReset) {
    const handle = handles.get(surface);
    if (!handle) return;
    clearTimeout(handle.timer);
    const reset = Date.parse(nextReset);
    if (Number.isFinite(reset) && reset > Date.now())
        handle.timer = setTimeout(handle.refresh, reset - Date.now() + 250);
}

export function open(dialog, openerId) {
    if (!dialog || dialog.open) return;
    const opener = document.getElementById(openerId) ?? document.activeElement;
    dialog.addEventListener('close', () => {
        if (document.activeElement === document.body || dialog.contains(document.activeElement)) {
            const destination = opener?.isConnected && opener !== document.body ? opener : dialog.closest('.daily-wordle');
            destination?.focus({preventScroll: true});
        }
    }, {once: true});
    dialog.showModal();
    dialog.querySelector('button')?.focus({preventScroll: true});
}

export function restoreInside(dialog, successor) {
    if (dialog?.open && !dialog.contains(document.activeElement)) successor.focus({preventScroll: true});
}

export function restoreBoard(surface) {
    if (document.activeElement === document.body)
        surface?.focus({preventScroll: true});
}

export function familyFocus(surface) {
    const active = document.activeElement;
    return surface.contains(active) && active?.matches('.dw-family-card') ? active.id : null;
}

export function restoreFamilyFocus(surface, id) {
    if (document.activeElement === document.body)
        (document.getElementById(id) ?? surface).focus({preventScroll: true});
}

export function isOpen(dialog) {
    return Boolean(dialog?.open);
}
