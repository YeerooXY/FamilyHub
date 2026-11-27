let lastFocusId = "";
document.addEventListener("focusin", event => { if (event.target !== document.body) lastFocusId = event.target.id; });
let healthFocus;
document.addEventListener("focusin", event => {
    healthFocus?.disconnect();
    const control = event.target.closest?.(".health-table-button");
    if (!control) return;
    const panel = control.closest(".health-panel");
    const observer = new MutationObserver(() => {
        if (control.isConnected) return;
        observer.disconnect();
        if (document.activeElement === document.body) panel.querySelector(".health-header button")?.focus();
    });
    healthFocus = observer;
    observer.observe(panel, { childList: true, subtree: true });
});
document.addEventListener("keydown", event => {
    const arrow = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
    const dashboard = event.target.closest?.(".health-dashboard");
    if (!arrow || !dashboard || !matchMedia("(min-width:1920px)").matches || event.defaultPrevented) return;
    const origin = event.target.closest("button,input");
    const [x, y] = arrow;
    if (!origin || (x && !origin.matches(".health-table-button"))) return;
    const controls = [...dashboard.querySelectorAll(x ? ".health-table-button" : "button, input:checked")];
    const bounds = origin.closest("label,button").getBoundingClientRect();
    const centered = rect => (rect.left + rect.right) / 2;
    const candidates = controls.map(control => {
        const rect = control.closest("label,button").getBoundingClientRect();
        const horizontal = centered(rect) - centered(bounds);
        const vertical = rect.top - bounds.top;
        return { control, distance: horizontal * x + vertical * y, sideways: Math.abs(horizontal * y + vertical * x) };
    }).filter(item => item.distance > 10 && (!x || item.sideways < 80))
      .sort((a, b) => a.distance - b.distance || a.sideways - b.sideways);
    if (candidates.length) {
        event.preventDefault();
        candidates[0].control.focus();
    }
});
window.familyhub = { press(id) { document.getElementById(id)?.click(); }, retainFocus(id) { if (document.activeElement === document.body) document.getElementById(id)?.focus(); }, restoreFocus(removedId, successorId) {
    if (document.activeElement?.id === removedId || (document.activeElement === document.body && lastFocusId === removedId)) document.getElementById(successorId)?.focus();
}, view(name) { document.body.dataset.view = name; familyhub.feedback?.screen(); const content = document.getElementById("content"); if (content) content.scrollTop = 0; if (document.activeElement === document.body) document.getElementById("content")?.focus(); }, focus(id) { const target = document.getElementById(id); if (target) target.focus(); else requestAnimationFrame(() => document.getElementById(id)?.focus()); } };

(() => {
    const panel = document.getElementById("blazor-error-ui");
    if (!panel) return;
    const button = panel.querySelector("button");
    const announcement = document.getElementById("blazor-error-announcement");
    const app = document.getElementById("app");
    const reloadKey = "familyhub:reload-requested";
    const visible = () => getComputedStyle(panel).display !== "none";
    const show = () => { panel.style.display = "block"; };

    const announce = () => {
        if (!visible()) {
            if (announcement.textContent) { announcement.textContent = ""; app.inert = false; }
            return;
        }
        if (announcement.textContent) return;
        for (const dialog of app.querySelectorAll("dialog[open]")) dialog.close();
        app.inert = true;
        announcement.textContent = panel.querySelector("h2").textContent + ". " + panel.querySelector("p").textContent;
        button.focus({ preventScroll: true });
    };
    new MutationObserver(announce).observe(panel, { attributes: true, attributeFilter: ["style", "class"] });
    announce();

    async function fallback() {
        try { sessionStorage.removeItem(reloadKey); } catch { }
        if (!visible() && !document.getElementById("blazor-startup")) return;
        show();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 3500);
        try {
            await fetch("/_familyhub/ReloadApp", {
                method: "POST", headers: { "X-FamilyHub-WebView": "reload" },
                mode: "same-origin", credentials: "omit", redirect: "error", signal: timeout.signal
            });
        } catch { }
        finally {
            clearTimeout(timer);
            button.removeAttribute("aria-disabled");
        }
    }

    try {
        const requested = Number(sessionStorage.getItem(reloadKey));
        const elapsed = Date.now() - requested;
        if (requested && elapsed >= 0 && elapsed < 15000) setTimeout(fallback, Math.max(0, 3000 - elapsed));
        else sessionStorage.removeItem(reloadKey);
    } catch { }
    button.addEventListener("click", () => {
        if (button.hasAttribute("aria-disabled")) return;
        button.setAttribute("aria-disabled", "true");
        try { sessionStorage.setItem(reloadKey, String(Date.now())); } catch { }
        setTimeout(fallback, 3000);
        location.reload();
    });

    let hiddenSince = document.hidden ? Date.now() : null;
    familyhub.checkReloadOnResume = async active => {
        if (!active) { hiddenSince ??= Date.now(); return; }
        const away = hiddenSince === null ? 0 : Date.now() - hiddenSince;
        hiddenSince = null;
        if (away < 60000 || visible()) return;
        const timer = setTimeout(() => { if (!document.hidden && familyhub.nativeActive !== false) show(); }, 3000);
        try {
            await window.DotNet.invokeMethodAsync("FamilyHub.App", "CheckAppResponse");
            clearTimeout(timer);
        } catch { /* The timeout also handles an interop call that never settles. */ }
    };
})();

familyhub.profileAvatarBounds = id => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.effects === 'off') return null;
    const bounds = document.getElementById(id)?.querySelector('.profile-avatar')?.getBoundingClientRect();
    return bounds?.width ? [bounds.x, bounds.y, bounds.width] : null;
};
familyhub.centerProfileAvatar = ([x, y, width]) => {
    const avatar = document.querySelector('.profile-sign-in-identity .profile-avatar');
    if (!avatar) return;
    const end = avatar.getBoundingClientRect();
    avatar.animate([
        {transform: `translate(${x - end.x}px, ${y - end.y}px) scale(${width / end.width})`, transformOrigin: 'top left'},
        {transform: 'none', transformOrigin: 'top left'}
    ], {duration: 280, easing: 'cubic-bezier(.2,.75,.25,1)'});
};

// Collect control actions only. Never read text, form values, paths, URLs, or key characters.
window.familyhub.feedback = (() => {
    const keys = new Set(['Enter', 'Escape', ' ', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
    const known = new Set(['open-hub', 'profile-toggle', 'open-settings', 'open-feedback', 'open-library', 'search-form',
        'q', 'play', 'previous', 'next', 'volume', 'show-queue', 'create-playlist', 'keep-playlist', 'report-song',
        'profile-display-name', 'profile-save-name', 'feedback-description', 'feedback-attach']);
    const controls = 'button,a,input,textarea,select,summary,[role=button],label,video,audio';
    const week = 7 * 86400;
    let storageKey, events = [], timer, pointer;
    const scrollTimes = new WeakMap();
    const now = () => Math.floor(Date.now() / 1000);
    const currentScreen = () => document.querySelector('.feedback-screen[open]') ? 'feedback' : document.body.dataset.view || 'app';
    function flush() {
        clearTimeout(timer);
        timer = undefined;
        if (storageKey) try { localStorage.setItem(storageKey, JSON.stringify(events)); } catch {}
    }
    function add(event, control, key) {
        if (!storageKey) return;
        const at = now();
        const screen = currentScreen();
        events.push({at, event, screen, control, key});
        while (events.length > 1600 || events[0].at < at - week) events.shift();
        timer ??= setTimeout(flush, 750);
    }
    function target(element) {
        const control = element?.closest?.(controls) || element?.closest?.('form,section,main,dialog,footer');
        if (!control) return 'area';
        if (known.has(control.id)) return control.id;
        if (control.matches('.seek-control input')) return 'seek-bar';
        if (control.matches('.dw-enter')) return 'wordle-submit';
        if (control.matches('.dw-key')) return 'wordle-key';
        if (control.matches('.song-primary')) return 'song-row';
        const level = Array.from(control.parentElement?.children || []).indexOf(control) + 1;
        return `${control.localName}-${level}`;
    }
    document.addEventListener('click', event => { if (event.isTrusted) add('click', target(event.target)); }, true);
    document.addEventListener('change', event => { if (event.isTrusted) add('change', target(event.target)); }, true);
    document.addEventListener('submit', event => { if (event.isTrusted) add('submit', target(event.submitter || event.target)); }, true);
    document.addEventListener('keydown', event => {
        if (!event.isTrusted || event.repeat || event.isComposing || !keys.has(event.key)) return;
        if (event.target?.closest?.('textarea,input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]),[contenteditable=true]') && !['Enter', 'Escape', 'Tab'].includes(event.key)) return;
        add('key', target(event.target), event.key === ' ' ? 'Space' : event.key);
    }, true);
    document.addEventListener('pointerdown', event => {
        if (event.isTrusted) pointer = {id: event.pointerId, x: event.clientX, y: event.clientY, control: target(event.target)};
    }, true);
    document.addEventListener('pointerup', event => {
        if (event.isTrusted && pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10)
            add('drag', pointer.control);
        pointer = undefined;
    }, true);
    document.addEventListener('pointercancel', () => { pointer = undefined; }, true);
    document.addEventListener('scrollend', event => {
        if (!event.isTrusted || Date.now() - (scrollTimes.get(event.target) || 0) < 1000) return;
        scrollTimes.set(event.target, Date.now());
        add('scroll', target(event.target));
    }, true);
    window.addEventListener('error', () => add('error', 'client'));
    window.addEventListener('unhandledrejection', () => add('error', 'request'));
    window.addEventListener('pagehide', flush);
    return {
        useProfile(identity) {
            const next = identity ? 'familyhub:feedback-events:' + identity : undefined;
            if (next === storageKey) return;
            flush();
            storageKey = next;
            events = [];
            pointer = undefined;
            if (next) try {
                const parsed = JSON.parse(localStorage.getItem(next) || '[]');
                if (Array.isArray(parsed)) events = parsed.filter(item => item?.at >= now() - week).slice(-1600);
            } catch {}
            add('screen');
        },
        screen() { add('screen'); },
        context(control) {
            if (['import-failed', 'playback-failed'].includes(control)) add('context', control);
        },
        recent() { return events.filter(item => item.at >= now() - 900).slice(-200); }
    };
})();
document.addEventListener('click', event => { if(event.target.closest('[aria-disabled="true"]')) { event.preventDefault(); event.stopImmediatePropagation(); } },true);

function applyWindowChrome(chrome) {
    document.body.classList.toggle('native-titlebar',chrome.supported);
    const style = document.documentElement.style;
    if (chrome.supported) {
        style.setProperty('--window-controls-width',`${chrome.rightInset}px`);
        style.setProperty('--window-controls-left',`${chrome.leftInset}px`);
        style.setProperty('--caption-height',`${chrome.height}px`);
    } else {
        style.removeProperty('--window-controls-width');
        style.removeProperty('--window-controls-left');
        style.removeProperty('--caption-height');
    }
}
window.familyhub.prepareChrome = async () => {
    if (!window.chrome?.webview) return;
    for (let attempt=0;attempt<12;attempt++) {
        try {
            const chrome=await DotNet.invokeMethodAsync('FamilyHub.App','UpdateWindowChrome',[],devicePixelRatio);
            if(chrome.supported) { applyWindowChrome(chrome); return; }
        } catch { }
        await new Promise(requestAnimationFrame);
    }
};
let chromeHeader, chromeObserver, chromeSignature, chromeScheduled = false, chromeRequest = 0;
window.familyhub.syncChrome = () => {
    if (document.activeElement !== document.body && !document.activeElement.getClientRects().length) document.getElementById('q')?.focus();
    const header = document.querySelector('.app-header');
    if (header !== chromeHeader) {
        chromeObserver?.disconnect(); chromeHeader = header;
        if (header) { chromeObserver = new ResizeObserver(() => window.familyhub.syncChrome()); chromeObserver.observe(header); }
    }
    if (chromeScheduled) return;
    chromeScheduled = true;
    requestAnimationFrame(async () => {
        chromeScheduled = false;
        positionAnchoredPopup(document.querySelector('[data-popup-anchor][open]'));
        if (!window.chrome?.webview) return;
        const rects = [...document.querySelectorAll('.app-header button,.app-header input,.app-header a,.app-header form,.skip:focus')]
            .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height)
            .map(({x,y,width,height}) => ({x:x-4,y:y-4,width:width+8,height:height+8}));
        const signature = JSON.stringify([rects,devicePixelRatio,innerWidth,innerHeight]);
        if (signature === chromeSignature) return;
        chromeSignature = signature;
        const request = ++chromeRequest;
        try {
            const chrome = await DotNet.invokeMethodAsync('FamilyHub.App','UpdateWindowChrome',rects,devicePixelRatio);
            if (request !== chromeRequest) return;
            applyWindowChrome(chrome);
            // The insets can move controls without changing the header's size.
            window.familyhub.syncChrome();
        } catch { if (request === chromeRequest) chromeSignature = null; }
    });
};
window.familyhub.refreshChrome = () => {
    chromeSignature = null;
    chromeRequest++;
    window.familyhub.syncChrome();
};
let chromeSettle;
function refreshAfterWindowChange() {
    window.familyhub.refreshChrome();
    // Caption metrics can settle after the presenter and WebView size change.
    clearTimeout(chromeSettle);
    chromeSettle = setTimeout(window.familyhub.refreshChrome, 300);
}
window.addEventListener('resize', refreshAfterWindowChange);
window.addEventListener('chrome-refresh', refreshAfterWindowChange);
window.familyhub.refreshAppFullscreen = fullscreen => window.dispatchEvent(new CustomEvent('chrome-refresh', {detail: fullscreen}));
window.familyhub.prepareAppFullscreenExit = async () => {
    const active = document.activeElement;
    if (!active?.closest('.app-header.app-fullscreen')) return;
    const successor = document.querySelector('.movie-expanded-page .movie-player.movie-expanded, #settings-exit');
    if (!successor) return;
    const dialog = active.closest('dialog[open]');
    if (dialog) await window.familyhub.closeDialog(dialog.id);
    successor.focus({preventScroll:true});
};
document.addEventListener('focusin', () => window.familyhub.syncChrome());

let appFullscreenReference;
window.familyhub.bindAppFullscreen = reference => { appFullscreenReference = reference; };
document.addEventListener('keydown', event => {
    if (event.key !== 'F11' || !appFullscreenReference || !window.chrome?.webview) return;
    event.preventDefault();
    if (!event.repeat) appFullscreenReference.invokeMethodAsync('ToggleAppFullscreen').catch(() => {});
}, true);

function normalizeTheme(theme) {
    const aliases = {stars:'classic',black:'normal',pink:'hot-pink',purple:'violet'};
    const id = aliases[theme] ?? theme;
    return PaddockEffects.themes.some(option => option.id === id) ? id : 'classic';
}
function applyAppearance(theme, collapsed, effects, width = 232) {
    PaddockEffects.apply(normalizeTheme(theme),effects);
    syncPanelSkies();
    document.body.dataset.navigation = collapsed ? 'compact' : 'expanded';
    document.body.style.setProperty('--sidebar-width', `${collapsed ? 72 : Math.max(180,Math.min(420,width))}px`);
    window.familyhub.syncChrome();
}
window.familyhub.themeOptions = () => PaddockEffects.themes;
window.familyhub.loadAppearance = key => {
    let appearance = {theme:'classic',collapsed:false,effects:true,width:232};
    try { appearance = {...appearance,...JSON.parse(localStorage.getItem('familyhub:appearance:'+key) || '{}')}; } catch {}
    appearance.theme = normalizeTheme(appearance.theme);
    applyAppearance(appearance.theme,appearance.collapsed,appearance.effects,appearance.width);
    return appearance;
};
window.familyhub.saveAppearance = (key,theme,collapsed,effects,width=232) => {
    applyAppearance(theme,collapsed,effects,width);
    try { localStorage.setItem('familyhub:appearance:'+key,JSON.stringify({theme,collapsed,effects,width})); } catch {}
};
window.familyhub.loadPlaylistCollection = key => {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('familyhub:playlist-collection:' + key)); } catch {}
    const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : [];
    return {pinned:ids(saved?.pinned), recent:ids(saved?.recent).slice(0, 12)};
};
window.familyhub.savePlaylistCollection = (key, collection) => {
    try { localStorage.setItem('familyhub:playlist-collection:' + key, JSON.stringify(collection)); } catch {}
};
let observedPanel;
function syncPanelSkies() {
    if (!window.PaddockEffects || !document.body.dataset.theme) return;
    let changed = false;
    document.querySelectorAll('.workspace,.sidebar').forEach((panel, index) => {
        const theme = document.body.dataset.theme;
        if (panel.dataset.frame !== theme || !panel.querySelector(':scope > .panel-sky')) {
            panel.dataset.frame = theme;
            PaddockEffects.mountSky(panel, index + 2);
            changed = true;
        }
    });
    if (changed) PaddockEffects.refreshSky();
}
function updatePanel() {
    if (!observedPanel) return;
    const pills = observedPanel.querySelector('.genre-pills');
    const stuck = !!pills && observedPanel.scrollTop > 0 && pills.getBoundingClientRect().top <= observedPanel.getBoundingClientRect().top + 1;
    pills?.classList.toggle('is-stuck',stuck);
}
window.familyhub.observePanel = () => {
    syncPanelSkies();
    const panel = document.querySelector('.workspace>main');
    if (panel !== observedPanel) {
        observedPanel?.removeEventListener('scroll',updatePanel);
        observedPanel = panel;
        observedPanel?.addEventListener('scroll',updatePanel,{passive:true});
    }
    updatePanel();
};

let openDialogs = [];
function positionAnchoredPopup(dialog) {
    if (!dialog?.dataset.popupAnchor) return;
    const anchor = document.getElementById(dialog.dataset.popupAnchor);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    dialog.style.setProperty('--popup-anchor-top', `${rect.bottom + 8}px`);
    dialog.style.setProperty('--popup-anchor-left', `${Math.max(8, rect.left)}px`);
    dialog.style.setProperty('--popup-anchor-right', `${Math.max(8, innerWidth - rect.right)}px`);
}
window.familyhub.showDialog = (id, focusId, openerId) => {
    const dialog = document.getElementById(id);
    if (!dialog || dialog.open) return;
    const fallback = () => document.getElementById(dialog.dataset.returnFocus) || document.getElementById('profile-toggle') || document.getElementById('server') || document.getElementById('content');
    const previous = document.getElementById(openerId)
        || (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : fallback());
    if (document.activeElement === document.body) previous?.focus({preventScroll:true});
    dialog._returnFocus = previous;
    openDialogs = openDialogs.filter(node => node.isConnected && node.open);
    openDialogs.push(dialog);
    if (dialog.classList.contains('popup-panel')) familyhub.bindPopupSheet(id);
    if (!dialog._focusBound) {
        dialog._focusBound = true;
        // Route Escape through the same close path to restore explicit openers on touch browsers.
        dialog.addEventListener('cancel', event => {
            if (!dialog.matches('.popup-panel,.animated-dialog')) return;
            event.preventDefault();
            if (!dialog.matches('.update-dialog.is-updating')) window.familyhub.closeDialog(dialog.id);
        });
        dialog.addEventListener('close', () => {
            // A menu action can close one dialog and open another before this event.
            if (dialog.open) return;
            openDialogs = openDialogs.filter(node => node !== dialog);
            if (document.activeElement !== document.body && !dialog.contains(document.activeElement)) return;
            const target = dialog._returnFocus;
            (target?.isConnected && target.getClientRects().length ? target : fallback())?.focus({preventScroll:true});
        });
    }
    positionAnchoredPopup(dialog);
    dialog.showModal();
    (document.getElementById(focusId) || dialog.querySelector('button,input'))?.focus({preventScroll:true});
};
window.familyhub.closeDialog = (id, successorId) => {
    const dialog = document.getElementById(id);
    if (!dialog) return;
    const successor = document.getElementById(successorId);
    if (successor) dialog._returnFocus = successor;
    if (dialog._closing) return dialog._closing;
    // Dialogs marked animated-dialog play their closing animation first, unless motion is reduced.
    if (dialog.classList.contains('animated-dialog') && dialog.open
        && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        dialog.classList.add('is-closing');
        dialog._closing = new Promise(resolve => {
            const ended = event => { if (event.target === dialog) finish(); };
            const finish = () => {
                clearTimeout(timeout);
                dialog._closing = null;
                dialog.removeEventListener('animationend', ended);
                dialog.classList.remove('is-closing');
                if (dialog.open) dialog.close();
                const target = dialog._returnFocus;
                if (target?.isConnected && target.getClientRects().length) target.focus({preventScroll:true});
                resolve();
            };
            const timeout = setTimeout(finish, 260);
            dialog.addEventListener('animationend', ended);
        });
        return dialog._closing;
    }
    dialog.close();
    const target = dialog._returnFocus;
    if (target?.isConnected && target.getClientRects().length) target.focus({preventScroll:true});
};

// Playlist covers from the clipboard: shrunk to fit 512 px and sent to .NET as a JPEG data URL.
window.familyhub.imageToJpeg = async blob => {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', .88);
};
window.familyhub.clipboardImage = async () => {
    try {
        for (const item of await navigator.clipboard.read()) {
            const type = item.types.find(t => t.startsWith('image/'));
            if (type) return await window.familyhub.imageToJpeg(await item.getType(type));
        }
    } catch { }
    return null;
};
window.familyhub.clipboardText = async () => {
    try { return await navigator.clipboard.readText(); }
    catch { return null; }
};
window.familyhub.bindImagePaste = (id, reference) => {
    const dialog = document.getElementById(id);
    if (!dialog) return;
    dialog._pasteReference = reference;
    if (dialog._pasteBound) return;
    dialog._pasteBound = true;
    dialog.addEventListener('paste', async event => {
        const file = [...(event.clipboardData?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
        if (!file) return;
        event.preventDefault();
        try { await dialog._pasteReference?.invokeMethodAsync('PasteImage', await window.familyhub.imageToJpeg(file)); } catch { }
    });
};

window.familyhub.bindSidebarResize = reference => {
    const handle = document.getElementById('sidebar-resize');
    if (!handle || handle._bound) return;
    handle._bound = true;
    let expanded = 232, dragging = false;
    const resize = raw => {
        const collapsed = raw < 150;
        if (!collapsed) expanded = Math.max(180, Math.min(420, innerWidth * .45, raw));
        document.body.dataset.navigation = collapsed ? 'compact' : 'expanded';
        document.body.style.setProperty('--sidebar-width', `${collapsed ? 72 : expanded}px`);
        handle.setAttribute('aria-valuenow', collapsed ? 72 : Math.round(expanded));
    };
    const save = () => reference.invokeMethodAsync('ResizeSidebar', Math.round(expanded), document.body.dataset.navigation === 'compact');
    handle.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); handle.focus(); dragging = true; document.body.classList.add('sidebar-resizing'); expanded = Math.max(180,parseInt(getComputedStyle(document.body).getPropertyValue('--sidebar-width')) || 232); handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', e => { if (dragging) resize(e.clientX - document.querySelector('.sidebar').getBoundingClientRect().left); });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) handle.addEventListener(event, () => { if (dragging) { dragging = false; document.body.classList.remove('sidebar-resizing'); save(); } });
    handle.addEventListener('keydown', e => {
        const current = Number(handle.getAttribute('aria-valuenow'));
        const values = {ArrowLeft:current - 36,ArrowRight:current === 72 ? 180 : current + 24,Home:72,End:420};
        if (!(e.key in values)) return;
        e.preventDefault(); resize(values[e.key]); save();
    });
};


// Keep navigation tied to the selected artwork, with a quiet fade for surrounding content.
let playlistTransition = null, playlistNavigationAnimation;
const playlistCard = key => [...document.querySelectorAll('[data-playlist-key]')].find(card => card.dataset.playlistKey === key);
const reducePlaylistMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
window.familyhub.beginPlaylistTransition = (key, opening) => {
    playlistNavigationAnimation?.cancel();
    playlistTransition = null;
    if (reducePlaylistMotion()) return;
    const source = opening ? playlistCard(key)?.querySelector('.cover') : document.querySelector('.playlist-image-picker,.playlist-hero>.cover');
    const rect = source?.getBoundingClientRect();
    if (rect?.width && rect.height) playlistTransition = {key, opening, left:rect.left, top:rect.top, width:rect.width, height:rect.height, time:performance.now()};
};
window.familyhub.finishPlaylistTransition = () => {
    const transition = playlistTransition; playlistTransition = null;
    if (!transition || reducePlaylistMotion() || performance.now() - transition.time > 2000) return;
    const content = document.querySelector(transition.opening ? '.playlist-hero' : '.playlist-grid');
    playlistNavigationAnimation?.cancel();
    playlistNavigationAnimation = content?.animate([{opacity:.65},{opacity:1}], {duration:180,easing:'ease-out'});
};
window.familyhub.finishPlaylistNameEdit = async () => {
    const input = document.getElementById('playlist-name-inline');
    if (!input || reducePlaylistMotion()) return;
    input.classList.add('is-finishing');
    await Promise.race([Promise.all(input.getAnimations().map(animation => animation.finished.catch(() => {}))),new Promise(resolve => setTimeout(resolve,240))]);
};

let searchPageObserver;
customElements.define('playlist-page-end', class extends HTMLElement {
    watch(reference) {
        this.observer = new IntersectionObserver(entries => {
            if (this.isConnected && entries.some(entry => entry.isIntersecting)) {
                this.observer.disconnect();
                reference.invokeMethodAsync('LoadNextPage').catch(() => {});
            }
        }, {root: this.closest('main'), rootMargin: '0px 0px 240px 0px'});
        this.observer.observe(this);
    }
    disconnectedCallback() { this.observer?.disconnect(); }
});
window.familyhub.observePlaylistEnd = (element, reference) => element?.watch(reference);
window.familyhub.observeSearch = (reference, version) => {
    searchPageObserver?.disconnect();
    const root = document.getElementById('results'), sentinel = document.getElementById('search-more-sentinel');
    if (!reference || !root || !sentinel) return;
    searchPageObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
            searchPageObserver.disconnect();
            reference.invokeMethodAsync('LoadMoreSearchInBackground', version).catch(() => {});
        }
    }, { root, rootMargin: '160px' });
    searchPageObserver.observe(sentinel);
};

// Rows can move or leave the DOM during filtering, sorting and paging.
let focusedSongControl;
// Catalogue review restores removed controls to the next action after its render.
document.addEventListener('focusin',event=>{focusedSongControl=event.target.closest?.('.song-row:not(.catalogue-row)')?event.target:null;});
new MutationObserver(()=>{
    if(document.activeElement===document.body && focusedSongControl) {
        const target=focusedSongControl.isConnected && focusedSongControl.getClientRects().length ? focusedSongControl
            : document.getElementById('playlist-song-search-toggle') || (document.body.dataset.view==='search'?document.getElementById('results'):document.getElementById('content'));
        focusedSongControl=null;
        target?.focus({preventScroll:true});
    }
}).observe(document.getElementById('app'),{childList:true,subtree:true});

window.familyhub.bindSeekHover = input => {
    const control = input.closest('.seek-control'), row = control.closest('.seek-row');
    const output = control.querySelector('.seek-tooltip'), elapsed = row.querySelector('.seek-elapsed');
    let hoverX, dragPointer, lastValue = input.valueAsNumber, initialValue = lastValue;
    const time = seconds => { seconds = Math.floor(Math.max(0, seconds)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    const preview = () => {
        const max = Number(input.max);
        if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(lastValue)) return;
        const value = Math.max(0, Math.min(max, lastValue));
        const percent = (100 * (value / max)) + '%';
        if (control.style.getPropertyValue('--seek-position') !== percent) control.style.setProperty('--seek-position', percent);
        // Change the text node Blazor rendered; replacing it (textContent) detaches Blazor's node
        // and the time then stops following playback.
        const write = (element, text) => { const node = element.firstChild; if (node && node.nodeType === 3 && !node.nextSibling) { if (node.nodeValue !== text) node.nodeValue = text; } else if (element.textContent !== text) element.textContent = text; };
        write(elapsed, time(value));
        if (dragPointer !== undefined && input.valueAsNumber !== value) input.value = String(value);
    };
    const paint = () => {
        if (input.disabled || (dragPointer === undefined && hoverX === undefined && document.activeElement !== input)) return;
        const rect = input.getBoundingClientRect();
        const max = Number(input.max), value = input.valueAsNumber;
        output.hidden = !Number.isFinite(max) || max <= 0 || !Number.isFinite(value) || rect.width <= 12;
        if (output.hidden) return;
        // Native range values are mapped between the centres of the 12 px thumb at either end.
        const thumbTravel = rect.width - 12;
        const hovering = dragPointer === undefined && hoverX !== undefined;
        const pointer = hovering ? hoverX - rect.left : 6 + thumbTravel * (value / max);
        const fraction = Math.max(0, Math.min(1, (pointer - 6) / thumbTravel));
        const label = time(hovering ? fraction * max : value);
        if (output.textContent !== label) output.textContent = label;
        const half = output.getBoundingClientRect().width / 2;
        output.style.left = Math.max(half, Math.min(rect.width - half, pointer)) + 'px';
    };
    const setHover = event => {
        hoverX = event?.pointerType !== 'touch' && Number.isFinite(event?.clientX) ? event.clientX : undefined;
        control.classList.toggle('is-hovering', hoverX !== undefined);
        paint();
    };
    const endDrag = () => {
        dragPointer = undefined;
        control.classList.remove('is-dragging');
        document.removeEventListener('pointerup', finish, true);
        document.removeEventListener('pointercancel', finish, true);
        paint();
    };
    const cancel = () => {
        if (dragPointer === undefined) return;
        lastValue = initialValue;
        input.value = String(initialValue);
        preview();
        endDrag();
    };
    const finish = event => {
        if (event.pointerId !== dragPointer) return;
        if (event.type === 'pointercancel') cancel();
        else endDrag();
    };
    input.addEventListener('pointerdown', event => {
        if (input.disabled || event.button !== 0 || dragPointer !== undefined) return;
        dragPointer = event.pointerId;
        initialValue = lastValue = input.valueAsNumber;
        control.classList.toggle('is-touch-interaction', event.pointerType === 'touch');
        control.classList.add('is-dragging');
        setHover(event);
        document.addEventListener('pointerup', finish, true);
        document.addEventListener('pointercancel', finish, true);
    });
    input.addEventListener('input', () => {
        if (input.disabled) return;
        lastValue = input.valueAsNumber;
        preview();
        paint();
    });
    input.addEventListener('lostpointercapture', finish);
    input.addEventListener('focus', paint);
    input.addEventListener('blur', () => {
        control.classList.remove('is-touch-interaction');
        endDrag();
    });
    input.addEventListener('keydown', event => {
        control.classList.remove('is-touch-interaction');
        if (event.key === 'Escape') cancel();
    });
    const sync = new MutationObserver(() => {
        if (dragPointer !== undefined) {
            if (input.disabled) endDrag();
            else preview();
        }
        paint();
    });
    sync.observe(control, {attributes:true,attributeFilter:['style']});
    sync.observe(input, {attributes:true,attributeFilter:['max','value','disabled']});
    sync.observe(elapsed, {childList:true,characterData:true,subtree:true});
    const resize = new ResizeObserver(paint);
    resize.observe(control);
    input.addEventListener('pointerenter', setHover);
    input.addEventListener('pointermove', setHover);
    input.addEventListener('pointerleave', () => setHover());
    return () => {
        sync.disconnect();
        resize.disconnect();
        endDrag();
    };
};

window.familyhub.observeSeekBar = (slider, reference) => {
    const unbind = window.familyhub.bindSeekHover(slider);
    const observer = new IntersectionObserver(([entry]) => reference.invokeMethodAsync('SeekVisibility', entry.isIntersecting));
    observer.observe(slider);
    return {disconnect: () => { observer.disconnect(); unbind(); }};
};

(() => {
    let active, tip, observer;
    const hide = () => {
        tip?.classList.remove('is-visible');
        if (active?.getAttribute('aria-describedby') === 'app-control-tooltip') active.removeAttribute('aria-describedby');
        observer?.disconnect(); active = null;
    };
    const paint = () => {
        if (!active?.isConnected) return hide();
        const title = active.getAttribute('title');
        if (title) { active.dataset.tooltip = title; active.removeAttribute('title'); }
        const text = title || active.dataset.tooltip || active.getAttribute('aria-label');
        if (!text) return hide();
        tip.classList.toggle('is-stats-point', active.classList.contains('stats-chart-point-button'));
        tip.textContent = text;
        const r = active.getBoundingClientRect(), t = tip.getBoundingClientRect();
        tip.style.left = Math.max(6, Math.min(innerWidth - t.width - 6, r.left + (r.width - t.width) / 2)) + 'px';
        tip.style.top = (r.top > t.height + 12 ? r.top - t.height - 9 : r.bottom + 9) + 'px';
        tip.classList.add('is-visible');
    };
    const show = target => {
        const button = target.closest?.('button[title],button[data-tooltip],button[aria-label],.storage-state[title],.storage-state[data-tooltip],.playlist-column-label,.playlist-track-album,.playlist-track-date');
        if (!button || (!button.hasAttribute('title') && !button.dataset.tooltip && button.textContent.trim())) return;
        if (active === button) return;
        hide(); active = button;
        if (!tip) { tip = document.createElement('div'); tip.id = 'app-control-tooltip'; tip.className = 'app-tooltip'; tip.setAttribute('role','tooltip'); document.body.append(tip); }
        if (!button.hasAttribute('aria-describedby')) button.setAttribute('aria-describedby', tip.id);
        paint();
        observer = new MutationObserver(paint); observer.observe(button, {attributes:true,attributeFilter:['title','aria-label','data-tooltip']});
    };
    document.addEventListener('pointerover', event => { if (event.pointerType !== 'touch') show(event.target); });
    document.addEventListener('pointerout', event => {
        if (active?.contains(event.target) && !active.contains(event.relatedTarget)
            && !(active.classList.contains('stats-chart-point-button') && active === document.activeElement)) hide();
    });
    document.addEventListener('focusin', event => { if (event.target.matches?.(':focus-visible')) show(event.target); });
    document.addEventListener('focusout', event => { if (active?.contains(event.target)) hide(); });
    document.addEventListener('pointerdown', hide);
    document.addEventListener('click', event => { if (event.target.closest?.('.stats-chart-point-button')) show(event.target); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
})();

// Focus inside an element that is about to go moves to a successor that may still be hidden: the
// main area holds it until the successor shows, so focus never falls to the page body.
window.familyhub.handFocusTo = (selector, successor) => {
 if (!document.activeElement?.closest(selector)) return;
 (document.getElementById('content') || document.querySelector('main'))?.focus({preventScroll:true});
 let tries = 0;
 const step = () => { const target = document.getElementById(successor); if (target?.getClientRects().length) target.focus({preventScroll:true}); else if (++tries < 30) requestAnimationFrame(step); };
 requestAnimationFrame(step);
};
window.familyhub.focusIfWithin = (selector, successor) => { if (document.activeElement?.closest(selector)) document.getElementById(successor)?.focus({preventScroll:true}); };
window.familyhub.captureStatsFocus = () => {
 const root=document.querySelector('.server-stats');
 if(root)root._statsFocus=root.contains(document.activeElement)?document.activeElement:null;
};
window.familyhub.restoreStatsFocus = () => {
 const root=document.querySelector('.server-stats'), previous=root?._statsFocus;
 if(previous&&document.activeElement===document.body){
  const successor=previous.isConnected?previous:document.getElementById(previous.id)||root.querySelector('.stats-chart-point-button')||document.getElementById('server-stats-refresh');
  successor?.focus({preventScroll:true});
 }
 if(root)root._statsFocus=null;
};
window.familyhub.bindUpdatePolling = reference => {
    familyhub.stopUpdatePolling?.();
    const check = event => { if (!document.hidden) reference.invokeMethodAsync('CheckForBackgroundUpdate', event?.type === 'online').catch(() => {}); };
    const timer = setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    familyhub.stopUpdatePolling = () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); window.removeEventListener('online', check); };
};
window.familyhub.tintPlaylistHeader = () => {
 const panel=document.querySelector('.playlist-hero');
 if(!panel)return;
 const sample=()=>{
  const img=panel.querySelector('.playlist-identity img');
  if(!img||!img.complete||!img.naturalWidth||panel.dataset.tintSource===img.currentSrc)return;
  try{
   const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
   const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,16,16);
   const pixels=ctx.getImageData(0,0,16,16).data;let r=0,g=0,b=0,n=0;
   for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]<128)continue;const w=.04+(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2]))/255;r+=pixels[i]*w;g+=pixels[i+1]*w;b+=pixels[i+2]*w;n+=w;}
   if(n){
    // Like Spotify: the cover's average hue, kept saturated and mid-dark so white text stays readable.
    r/=n*255;g/=n*255;b/=n*255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2,d=max-min;
    let h=0,s=d===0?0:d/(1-Math.abs(2*l-1));
    if(d){h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;h*=60;if(h<0)h+=360;}
    s=s<.02?s:Math.min(.62,Math.max(.34,s));const L=Math.min(.42,Math.max(.3,l)),c=(1-Math.abs(2*L-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=L-c/2;
    const [R,G,B]=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
    const tint=[R,G,B].map(v=>Math.round((v+m)*255)).join(' ');panel.style.setProperty('--playlist-tint',tint);panel.parentElement?.style.setProperty('--playlist-tint',tint);panel.dataset.tintSource=img.currentSrc;}
  }catch{panel.style.removeProperty('--playlist-tint');}
 };
 if(!panel._tintObserver){panel._tintObserver=new MutationObserver(sample);panel._tintObserver.observe(panel,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});panel.addEventListener('load',sample,true);}
 sample();
};
window.familyhub.captureLeaderboard = () => {
 const table=document.querySelector('.stats-leaderboard');if(!table)return;
 table._rowPositions=new Map([...table.querySelectorAll('[data-profile-key]')].map(row=>[row,row.getBoundingClientRect().top]));
 table._rowFocus=table.contains(document.activeElement)?document.activeElement:null;
};
window.familyhub.animateLeaderboard = () => {
 const table=document.querySelector('.stats-leaderboard');if(!table?._rowPositions)return;
 const positions=table._rowPositions;
 if(document.activeElement===document.body&&table._rowFocus){const target=table._rowFocus; (target.isConnected?target:document.getElementById('server-stats-refresh'))?.focus({preventScroll:true});}
 table._rowFocus=null;
 const rows=[...table.querySelectorAll('[data-profile-key]')],oldRows=[...positions.keys()];
 if(rows.length===oldRows.length&&rows.every((row,i)=>row===oldRows[i]))return;
 table._rowPositions=null;
 if(matchMedia('(prefers-reduced-motion: reduce)').matches||document.body.dataset.effects==='off')return;
 for(const row of table.querySelectorAll('[data-profile-key]')){
  const before=positions.get(row);row.getAnimations().forEach(a=>a.cancel());
  const delta=before-row.getBoundingClientRect().top;
  if(Number.isFinite(delta)&&Math.abs(delta)>1)row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
 }
};
// The collapsed playlist bar shows once the playlist header scrolls out of view.
window.familyhub.observePlaylistHero = () => {
 const hero=document.querySelector('.playlist-hero'), bar=document.querySelector('.playlist-sticky');
 if(familyhub.heroObserver?.target===hero)return;
 familyhub.heroObserver?.disconnect(); familyhub.heroObserver=null;
 if(!hero||!bar)return;
 const set=visible=>{ bar.classList.toggle('is-visible',visible); bar.inert=!visible; const play=bar.querySelector('button'); if(play)play.tabIndex=visible?0:-1; if(!visible&&bar.contains(document.activeElement))document.getElementById('play-playlist')?.focus({preventScroll:true}); };
 const observer=new IntersectionObserver(([entry])=>set(!entry.isIntersecting&&entry.boundingClientRect.top<0),{root:document.getElementById('content'),rootMargin:'-56px 0px 0px 0px'});
 observer.observe(hero); observer.target=hero; familyhub.heroObserver=observer;
};
// Scrolls to a section that renders after its data loads, such as the leaderboard.
window.familyhub.revealWhenReady = id => {
 const reveal=()=>{ const target=document.getElementById(id); if(!target)return false; target.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); return true; };
 if(reveal())return;
 const observer=new MutationObserver(()=>{ if(reveal())observer.disconnect(); });
 observer.observe(document.getElementById('content')||document.body,{childList:true,subtree:true});
 setTimeout(()=>observer.disconnect(),8000);
};
const phoneLayout = matchMedia('(max-width:720px)');
window.familyhub.isPhone = () => phoneLayout.matches;
document.addEventListener('keydown', event => {
    if (event.target.closest?.('.switcher-grid') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
    }
    if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
        const exit = document.getElementById('settings-exit');
        if (exit) {
            event.preventDefault();
            if (!event.repeat) exit.click();
        }
    }
});
phoneLayout.addEventListener('change', event => {
    if (!event.matches) document.getElementById('player-options-close')?.click();
    const exit = document.getElementById('settings-exit');
    if (exit && !document.querySelector('dialog[open]') &&
        (document.activeElement === document.body || !document.activeElement.getClientRects().length)) exit.focus();
});
window.familyhub.dismissKeyboard = (input, successor) => {
    if (!familyhub.isPhone()) return;
    document.getElementById(input)?.blur();
    familyhub.focus(successor);
};
window.familyhub.searchSubmitted = () => familyhub.dismissKeyboard('q', 'view-title');
window.familyhub.bindGenreSearch = () => {
    const input = document.getElementById('genre-search');
    input?.addEventListener('keydown', event => {
        const expanded = input.getAttribute('aria-expanded') === 'true';
        if (expanded && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) event.preventDefault();
    });
};
window.familyhub.revealGenreOption = id => {
    const option = document.getElementById(id);
    if (!option) return;
    const list = option.parentElement;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    const bottom = option.offsetTop + option.offsetHeight;
    if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
};
window.familyhub.focusInOpenDialog = (id, onlyIfOutside = false) => {
    const target = document.getElementById(id);
    const dialog = target?.closest('dialog[open]');
    if (!dialog) return false;
    if (onlyIfOutside && dialog.contains(document.activeElement)) return false;
    target.focus();
    return true;
};
window.familyhub.restoreUploadFocus = (removed, successor) => requestAnimationFrame(() => {
    const target = document.getElementById(successor);
    if (target?.closest('dialog[open]')) familyhub.restoreFocus(removed, successor);
});
// Focuses the first of these controls that is on screen, after the next render.
window.familyhub.focusVisible = (...ids) => requestAnimationFrame(() => { for(const id of ids){ const target=document.getElementById(id); if(target&&target.getClientRects().length){ target.focus(); return; } } });
// Lyrics follow the song; scrolling by hand pauses following for a few seconds.
window.familyhub.revealLyric = id => {
 const line=document.getElementById(id), list=line?.closest('.lyrics-view'); if(!line||!list)return;
 if(!list.dataset.bound){ list.dataset.bound='1'; const hold=()=>{ list.dataset.heldUntil=Date.now()+4000; }; list.addEventListener('wheel',hold,{passive:true}); list.addEventListener('touchmove',hold,{passive:true}); }
 if(Date.now()<Number(list.dataset.heldUntil||0))return;
 const top = list.scrollTop + line.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight * .38;
 list.scrollTo({top,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
};
// Long titles in Now Playing scroll sideways, pause, then come round again.
// Measured once per song; the animation runs on the GPU with fixed pixel values.
window.familyhub.fitTitle = () => {
 // Full-screen Now Playing and lyrics cover the star background; stop drawing it meanwhile.
 const covered=document.hidden||document.body.classList.contains('native-hidden')||!!document.querySelector('.player-bar.is-expanded,.lyrics-view');
 if((document.body.dataset.visualPaused==='true')!==covered){ if(covered)document.body.dataset.visualPaused='true'; else delete document.body.dataset.visualPaused; }
 const remote=document.getElementById('remote-song-title');
 const title=remote?.clientWidth ? remote : document.getElementById('now-title');
 if(title!==familyhub.fittedTitle){
  familyhub.titleResize?.disconnect();
  familyhub.titleAnimations?.forEach(a=>a.cancel());
  if(familyhub.fittedTitle){
   familyhub.fittedTitle.querySelector('.marquee-copy')?.remove();
   familyhub.fittedTitle.classList.remove('is-marquee');
   delete familyhub.fittedTitle.dataset.fitted;
  }
  familyhub.fittedTitle=title;
  if(title){
   familyhub.titleResize??=new ResizeObserver(()=>familyhub.fitTitle());
   familyhub.titleResize.observe(title);
  }
 }
 const text=title?.querySelector('.marquee-text'); if(!text)return;
 const key=[text.textContent,title.clientWidth,document.hidden,document.body.classList.contains('native-hidden'),matchMedia('(prefers-reduced-motion: reduce)').matches].join('|');
 if(title.dataset.fitted===key)return;
 title.dataset.fitted=key;
 familyhub.titleAnimations?.forEach(a=>a.cancel()); familyhub.titleAnimations=[];
 title.querySelector('.marquee-copy')?.remove();
 title.classList.remove('is-marquee');
 title.title=text.textContent;
 if(!title.clientWidth||document.hidden||document.body.classList.contains('native-hidden'))return;
 const overflow=text.scrollWidth>title.clientWidth+2 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(!overflow)return;
 title.classList.add('is-marquee');
 const copy=text.cloneNode(true); copy.classList.add('marquee-copy'); copy.setAttribute('aria-hidden','true'); title.appendChild(copy);
 const distance=text.getBoundingClientRect().width;
 // 2.5 s still, then about 40 px a second until the copy takes the original's place.
 const duration=Math.round(2500+distance/40*1000), hold=2500/duration;
 const frames=[{transform:'translate3d(0,0,0)',offset:0},{transform:'translate3d(0,0,0)',offset:hold},{transform:`translate3d(${-distance}px,0,0)`,offset:1}];
 const timing={duration,iterations:Infinity,easing:'linear'};
 familyhub.titleAnimations=[text.animate(frames,timing),copy.animate(frames,timing)];
};
// Mini player: swipe left for the next song, right for the previous one.
window.familyhub.bindMiniSwipe = () => {
 const area=document.querySelector('.player-bar #show-queue'); if(!area||area.dataset.swipeBound)return; area.dataset.swipeBound='1';
 const bar=area.closest('.player-bar'); let start=null, dx=0, swipedAt=0;
 const reset=()=>{ area.style.transition='transform .2s ease,opacity .2s ease'; area.style.transform=''; area.style.opacity=''; };
 area.addEventListener('click',e=>{ if(Date.now()-swipedAt<350){ e.stopImmediatePropagation(); e.preventDefault(); } },true);
 area.addEventListener('pointerdown',e=>{ if(bar.classList.contains('is-expanded')||!familyhub.isPhone())return; start={x:e.clientX,y:e.clientY}; dx=0; },{passive:true});
 area.addEventListener('pointermove',e=>{ if(!start)return; const x=e.clientX-start.x, y=e.clientY-start.y; if(Math.abs(x)<10||Math.abs(x)<Math.abs(y))return; dx=x; area.style.transition='none'; area.style.transform=`translateX(${dx}px)`; area.style.opacity=String(Math.max(.35,1-Math.abs(dx)/220)); },{passive:true});
 const end=()=>{ if(!start)return; start=null; if(Math.abs(dx)>10)swipedAt=Date.now();
  const buttons=bar.querySelectorAll('.transport-buttons>button'); const target=dx<-64?buttons[3]:dx>64?buttons[1]:null;
  reset(); if(target&&target.getAttribute('aria-disabled')!=='true')target.click(); dx=0; };
 area.addEventListener('pointerup',end); area.addEventListener('pointercancel',end);
};
// Modal dialogs and inline player sheets use the same keyboard and drag handling.
window.familyhub.bindPopupSheet = (id, closeId) => {
    const panel = document.getElementById(id);
    if (!panel || panel.dataset.sheetBound) return;
    panel.dataset.sheetBound = '1';
    const native = panel instanceof HTMLDialogElement;
    const isOpen = () => native ? panel.open : panel.classList.contains('is-open');
    const close = () => native ? familyhub.closeDialog(id) : document.getElementById(closeId)?.click();
    const inPanel = target => target.closest('.popup-panel') === panel;
    let start = null, moved = 0, draggedAt = 0, onBackdrop = false;
    const outside = event => {
        const box = panel.getBoundingClientRect();
        return event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom;
    };
    panel.addEventListener('click', event => {
        if (!inPanel(event.target)) return;
        if (event.detail > 0 && Date.now() - draggedAt < 350) {
            event.stopImmediatePropagation();
            event.preventDefault();
        } else if (event.target.closest('[data-popup-close]') || (onBackdrop && event.target === panel && outside(event))) {
            close();
        }
    }, true);
    panel.addEventListener('keydown', event => {
        if (!inPanel(event.target)) return;
        if (event.key === 'Escape') {
            event.stopPropagation();
            if (!native) {
                event.preventDefault();
                close();
            }
            return;
        }
        if (event.key !== 'Tab') return;
        const controls = [...panel.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')]
            .filter(node => inPanel(node) && node.tabIndex >= 0 && !node.matches(':disabled') &&
                !node.closest('[inert]') && node.getClientRects().length && getComputedStyle(node).visibility === 'visible');
        const index = controls.indexOf(document.activeElement);
        if (event.shiftKey ? index <= 0 : index === controls.length - 1) {
            event.preventDefault();
            (event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus();
        }
    });
    const begin = (y, target) => {
        start = null;
        if (!familyhub.isPhone() || !isOpen() || panel.matches('.popup-centered,[data-popup-anchor],.update-dialog.is-updating') ||
            !inPanel(target) || panel.scrollTop > 0 && !target.closest('.dialog-heading') ||
            target.closest('input,select,textarea,[contenteditable=true],.whats-new ul')) return;
        start = y;
        moved = 0;
    };
    const move = y => {
        moved = Math.max(0, y - start);
        if (moved > 6) panel.style.transform = `translateY(${moved}px)`;
    };
    const end = cancelled => {
        if (start === null) return;
        start = null;
        panel.style.transform = '';
        if (moved > 6) draggedAt = Date.now();
        if (!cancelled && moved > 90) close();
    };
    panel.addEventListener('touchstart', event => {
        if (event.touches.length === 1) begin(event.touches[0].clientY, event.target);
        else end(true);
    }, {passive:true});
    panel.addEventListener('touchmove', event => {
        if (start === null) return;
        const y = event.touches[0].clientY;
        if (y < start && moved <= 6) { end(true); return; }
        if (event.cancelable) event.preventDefault();
        move(y);
    }, {passive:false});
    panel.addEventListener('touchend', () => end(false));
    panel.addEventListener('touchcancel', () => end(true));
    panel.addEventListener('pointerdown', event => {
        onBackdrop = native && event.target === panel && outside(event);
        if (event.pointerType !== 'touch' && event.button === 0 && !onBackdrop) begin(event.clientY, event.target);
    });
    panel.addEventListener('pointermove', event => {
        if (event.pointerType !== 'touch' && start !== null) move(event.clientY);
    });
    panel.addEventListener('pointerup', event => { if (event.pointerType !== 'touch') end(false); });
    panel.addEventListener('pointercancel', event => { if (event.pointerType !== 'touch') end(true); });
};

document.addEventListener('click', event => {
    if (!event.target.closest('.player-bar') && document.getElementById('lyrics-view') &&
        !openDialogs.some(dialog => dialog.open && dialog.contains(event.target))) {
        document.getElementById('lyrics-close')?.click();
    }
});

window.familyhub.closeTopLayer = () => {
    const movie = document.querySelector(".movie-player.movie-expanded .movie-ui");
    if (movie) { movie.dispatchEvent(new CustomEvent("movie-back")); return true; }
    const dialog = openDialogs.filter(node => node.isConnected && node.open).pop();
    if (!dialog) return false;
    if (dialog.requestClose) dialog.requestClose();
    else familyhub.closeDialog(dialog.id);
    return true;
};

// Trim paired dark letterbox bands for display; the cached original stays unchanged.
const coverCropCache = new Map();
window.familyhub.cropCover = image => {
 if (!image.naturalWidth || !image.parentElement) return;
 const key = image.currentSrc || image.src;
 let crop = coverCropCache.get(key);
 if (crop === undefined) {
  crop = null;
  try {
   const canvas = document.createElement('canvas'), ratio = Math.min(1,160 / Math.max(image.naturalWidth,image.naturalHeight));
   const w = canvas.width = Math.max(1,Math.round(image.naturalWidth*ratio)), h = canvas.height = Math.max(1,Math.round(image.naturalHeight*ratio));
   const context = canvas.getContext('2d',{willReadFrequently:true});
   context.drawImage(image,0,0,w,h);
   const pixels = context.getImageData(0,0,w,h).data;
   const dark = (x,y) => { const i=(y*w+x)*4; return pixels[i+3]>250 && Math.max(pixels[i],pixels[i+1],pixels[i+2])<=28; };
   const darkRow = y => { let count=0; for(let x=0;x<w;x++) if(dark(x,y))count++; return count>=w*.98; };
   let top=0,bottom=h,left=0,right=w;
   while(top<h && darkRow(top))top++;
   while(bottom>top && darkRow(bottom-1))bottom--;
   if(top<2 || h-bottom<2 || Math.abs(top-(h-bottom))>Math.max(3,h*.08) || bottom-top<h*.35) { top=0;bottom=h; }
   const darkColumn = x => { let count=0; for(let y=top;y<bottom;y++) if(dark(x,y))count++; return count>=(bottom-top)*.98; };
   while(left<w && darkColumn(left))left++;
   while(right>left && darkColumn(right-1))right--;
   if(left<2 || w-right<2 || Math.abs(left-(w-right))>Math.max(3,w*.08) || right-left<w*.35) { left=0;right=w; }
   if(top || left || bottom<h || right<w) crop={x:left/w,y:top/h,width:(right-left)/w,height:(bottom-top)/h};
  } catch { /* Cross-origin or undecodable pictures keep their normal cover fit. */ }
  coverCropCache.set(key,crop);
  if(coverCropCache.size>256)coverCropCache.delete(coverCropCache.keys().next().value);
 }
 for(const property of ['width','height','left','top','right','bottom','object-fit'])image.style.removeProperty(property);
 if(!crop)return;
 const frame=image.parentElement, width=frame.clientWidth, height=frame.clientHeight;
 if(!width || !height)return;
 const croppedWidth=image.naturalWidth*crop.width, croppedHeight=image.naturalHeight*crop.height;
 const scale=Math.max(width/croppedWidth,height/croppedHeight);
 Object.assign(image.style,{
  width:`${image.naturalWidth*scale/width*100}%`,height:`${image.naturalHeight*scale/height*100}%`,
  left:`${((width-croppedWidth*scale)/2-image.naturalWidth*crop.x*scale)/width*100}%`,
  top:`${((height-croppedHeight*scale)/2-image.naturalHeight*crop.y*scale)/height*100}%`,
  right:'auto',bottom:'auto',objectFit:'fill'
 });
};
document.addEventListener('load',event=>{ if(event.target instanceof HTMLImageElement && event.target.matches('.cover img'))familyhub.cropCover(event.target); },true);
// Home shelves: round arrow buttons step one view sideways and hide at either end. A focused
// button that hides hands focus to its counterpart, or to the shelf itself.
familyhub.updateShelf=id=>{
 const shelf=document.getElementById(id); if(!shelf)return;
 if(!shelf.hasAttribute('tabindex'))shelf.tabIndex=-1;
 const max=shelf.scrollWidth-shelf.clientWidth-1;
 const states=[...document.querySelectorAll(`[data-shelf="${id}"]`)].map(button=>({button,hide:max<=0||(Number(button.dataset.dir)<0?shelf.scrollLeft<=1:shelf.scrollLeft>=max)}));
 const focused=states.find(s=>s.hide&&s.button===document.activeElement);
 if(focused)(states.find(s=>!s.hide)?.button||shelf).focus({preventScroll:true});
 states.forEach(({button,hide})=>button.classList.toggle('is-end',hide));
 shelf.closest('.home-section')?.classList.toggle('has-overflow',max>0);
};
familyhub.scrollShelf=(id,dir)=>{
 const shelf=document.getElementById(id); if(!shelf)return;
 const smooth=!matchMedia('(prefers-reduced-motion: reduce)').matches;
 shelf.scrollBy({left:dir*Math.max(200,shelf.clientWidth*.8),behavior:smooth?'smooth':'auto'});
};
familyhub.watchShelf=id=>{
 const shelf=document.getElementById(id); if(!shelf)return;
 familyhub.updateShelf(id); if(shelf.dataset.watched)return;
 shelf.dataset.watched='1';
 shelf.addEventListener('scroll',()=>familyhub.updateShelf(id),{passive:true});
 new ResizeObserver(()=>familyhub.updateShelf(id)).observe(shelf);
};

matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>familyhub.fitTitle());
document.addEventListener('visibilitychange',()=>familyhub.setNativeActive(familyhub.nativeActive??true));
window.familyhub.setNativeActive = active => {
 familyhub.nativeActive=active;
 document.body.classList.toggle('native-hidden',!active||document.hidden);
 familyhub.checkReloadOnResume?.(active && !document.hidden);
 familyhub.fitTitle();
};

// Time labels on the "Playing on another device" bar: counted here once a second while that device plays, with no
// component re-render. A fresh position from the server changes data-clock-from and restarts the count.
(() => {
    const started = new WeakMap();
    const text = seconds => { const t = Math.max(0, Math.floor(seconds)); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    setInterval(() => {
        if (document.hidden) return;
        for (const node of document.querySelectorAll('[data-clock="at"]')) {
            const key = node.dataset.clockFrom + '|' + node.dataset.clockRunning;
            let mark = started.get(node);
            if (!mark || mark.key !== key) { mark = { key, at: performance.now() }; started.set(node, mark); }
            const base = Number(node.dataset.clockFrom), duration = Number(node.dataset.clockDuration);
            const now = Math.min(duration, base + (node.dataset.clockRunning === 'true' ? (performance.now() - mark.at) / 1000 : 0));
            const label = text(now);
            if (node.textContent !== label) node.textContent = label;
        }
    }, 1000);
})();
