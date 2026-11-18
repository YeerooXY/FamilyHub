let lastFocusId = "";
document.addEventListener("focusin", event => { if (event.target !== document.body) lastFocusId = event.target.id; });
window.familyhub = { retainFocus(id) { if (document.activeElement === document.body) document.getElementById(id)?.focus(); }, restoreFocus(removedId, successorId) {
    if (document.activeElement?.id === removedId || (document.activeElement === document.body && lastFocusId === removedId)) document.getElementById(successorId)?.focus();
}, view(name) { document.body.dataset.view = name; const content = document.getElementById("content"); if (content) content.scrollTop = 0; if (document.activeElement === document.body) document.getElementById("content")?.focus(); }, focus(id) { const target = document.getElementById(id); if (target) target.focus(); else requestAnimationFrame(() => document.getElementById(id)?.focus()); } };
document.addEventListener('click', event => { if(event.target.closest('[aria-disabled="true"]')) { event.preventDefault(); event.stopImmediatePropagation(); } },true);

function dismissProfileMenu() {
    const menu = document.getElementById('profile-menu');
    const toggle = document.getElementById('profile-toggle');
    if (!menu || !toggle) return;
    if (menu.contains(document.activeElement)) toggle.focus();
    toggle.click();
}
document.addEventListener('click', event => {
    if (!event.target.closest('.sidebar-account')) dismissProfileMenu();
});
window.addEventListener('blur', dismissProfileMenu);


function applyWindowChrome(chrome) {
    document.body.classList.toggle('native-titlebar',chrome.supported);
    document.documentElement.style.setProperty('--window-controls-width',`${chrome.rightInset ?? 0}px`);
    document.documentElement.style.setProperty('--window-controls-left',`${chrome.leftInset ?? 0}px`);
    document.documentElement.style.setProperty('--caption-height',`${chrome.minHeight || 48}px`);
}
window.familyhub.prepareChrome = async () => {
    for (let attempt=0;attempt<12;attempt++) {
        try {
            const chrome=await DotNet.invokeMethodAsync('FamilyHub.App','UpdateWindowChrome',48,[],devicePixelRatio);
            if(chrome.supported) { applyWindowChrome(chrome); return; }
        } catch { }
        await new Promise(requestAnimationFrame);
    }
    document.body.classList.add('native-titlebar');
    document.documentElement.style.setProperty('--window-controls-width','144px');
};
let chromeHeader, chromeObserver, chromeSignature, chromeScheduled = false;
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
        const header = document.querySelector('.app-header');
        const height = header?.getBoundingClientRect().bottom ?? 48;
        const rects = [...document.querySelectorAll('.app-header button,.app-header input,.app-header a,.app-header form,.skip:focus')]
            .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height)
            .map(({x,y,width,height}) => ({x:x-4,y:y-4,width:width+8,height:height+8}));
        const signature = JSON.stringify([height,rects,devicePixelRatio,innerWidth]);
        if (signature === chromeSignature) return;
        chromeSignature = signature;
        try {
            const chrome = await DotNet.invokeMethodAsync('FamilyHub.App','UpdateWindowChrome',height,rects,devicePixelRatio);
            applyWindowChrome(chrome);
        } catch { chromeSignature = null; }
    });
};
window.addEventListener('resize', () => window.familyhub.syncChrome());
document.addEventListener('focusin', () => window.familyhub.syncChrome());

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

window.familyhub.showDialog = (id, focusId) => {
    const dialog = document.getElementById(id);
    if (!dialog || dialog.open) return;
    const fallback = () => document.getElementById(dialog.dataset.returnFocus) || document.getElementById('profile-toggle') || document.getElementById('server') || document.getElementById('content');
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : fallback();
    if (document.activeElement === document.body) previous?.focus({preventScroll:true});
    dialog._returnFocus = previous;
    if (!dialog._focusBound) {
        dialog._focusBound = true;
        // Escape on an animated dialog closes it through closeDialog so it animates too.
        dialog.addEventListener('cancel', event => {
            if (!dialog.classList.contains('animated-dialog')) return;
            event.preventDefault();
            window.familyhub.closeDialog(dialog.id);
        });
        dialog.addEventListener('close', () => {
            const target = dialog._returnFocus;
            if (target?.isConnected && target.getClientRects().length) target.focus({preventScroll:true});
            else fallback()?.focus({preventScroll:true});
        });
    }
    dialog.showModal();
    (document.getElementById(focusId) || dialog.querySelector('button,input'))?.focus({preventScroll:true});
};
window.familyhub.closeDialog = (id, successorId) => {
    const dialog = document.getElementById(id);
    if (!dialog) return;
    const successor = document.getElementById(successorId);
    if (successor) dialog._returnFocus = successor;
    // Dialogs marked animated-dialog play their closing animation first, unless motion is reduced.
    if (dialog.classList.contains('animated-dialog') && dialog.open && !dialog._closing
        && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        dialog._closing = true;
        dialog.classList.add('is-closing');
        let done = false;
        const ended = event => { if (event.target === dialog) finish(); };
        const finish = () => {
            if (done) return;
            done = true; dialog._closing = false;
            dialog.removeEventListener('animationend', ended);
            dialog.classList.remove('is-closing');
            if (dialog.open) dialog.close();
            const target = dialog._returnFocus;
            if (target?.isConnected) target.focus({preventScroll:true});
        };
        dialog.addEventListener('animationend', ended);
        setTimeout(finish, 260);
        return;
    }
    if (dialog._closing) return;
    if (dialog.matches(':popover-open')) dialog.hidePopover();
    else if (dialog instanceof HTMLDialogElement) dialog.close();
    const target = dialog._returnFocus;
    if (target?.isConnected) target.focus({preventScroll:true});
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

window.familyhub.showPanel = (id, opener, focusId) => {
    const panel = document.getElementById(id), source = document.getElementById(opener);
    if (!panel) return;
    const anchor = source?.getBoundingClientRect();
    panel._returnFocus = source;
    if (!panel._focusBound) {
        panel._focusBound = true;
        panel.addEventListener('toggle', event => {
            if (event.newState === 'closed' && (panel.contains(document.activeElement) || document.activeElement === document.body)) {
                const target = panel._returnFocus;
                (target?.isConnected && target.getClientRects().length ? target : document.getElementById('content'))?.focus({preventScroll:true});
            }
        });
    }
    if (!panel.matches(':popover-open')) panel.showPopover({source});
    const box = {width: panel.offsetWidth, height: panel.offsetHeight};
    const parent = source?.closest('[popover]');
    const left = parent ? anchor.left - box.width - 8 : (anchor?.right ?? innerWidth / 2) - box.width;
    panel.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, left < 8 && parent ? anchor.right + 8 : left)) + 'px';
    panel.style.top = Math.max(8, Math.min(innerHeight - box.height - 8, parent ? anchor.top : (anchor?.bottom ?? 80) + 8)) + 'px';
    (document.getElementById(focusId) || panel.querySelector('button,input'))?.focus({preventScroll:true});
};
window.familyhub.showPlaylistPicker = opener => familyhub.showPanel('song-playlist-dialog', opener, 'playlist-picker-filter');

let searchPageObserver;
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
    if (!input || input._hoverBound) return;
    input._hoverBound = true;
    const control = input.closest('.seek-control'), row = control.closest('.seek-row');
    const output = control.querySelector('.seek-hover-tooltip'), elapsed = row.querySelector('.seek-elapsed');
    let lastPointer, dragging = false, lastValue = Number(input.value), initialValue = lastValue;
    const time = seconds => { seconds = Math.floor(Math.max(0, seconds)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    const preview = () => {
        const value = Math.max(0, Math.min(Number(input.max), lastValue));
        const percent = (100 * value / Math.max(1, Number(input.max))) + '%';
        if (control.style.getPropertyValue('--seek-position') !== percent) control.style.setProperty('--seek-position', percent);
        // Change the text node Blazor rendered; replacing it (textContent) detaches Blazor's node
        // and the time then stops following playback.
        const write = (element, text) => { const node = element.firstChild; if (node && node.nodeType === 3 && !node.nextSibling) { if (node.nodeValue !== text) node.nodeValue = text; } else if (element.textContent !== text) element.textContent = text; };
        write(elapsed, time(value));
        write(control.querySelector('.seek-tooltip'), time(value));
        if (dragging && Number(input.value) !== value) input.value = String(value);
    };
    const paint = event => {
        lastPointer = event;
        if (event.pointerType === 'touch') return;
        const rect = input.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (event.clientX - rect.left - 6) / Math.max(1, rect.width - 12)));
        output.textContent = time(percent * Number(input.max));
        const hover = (percent * 100) + '%';
        if (control.style.getPropertyValue('--seek-hover') !== hover) control.style.setProperty('--seek-hover', hover);
    };
    input.addEventListener('pointerdown', () => { if (input.getAttribute('aria-disabled') === 'true') return; dragging = true; initialValue = lastValue = Number(input.value); document.addEventListener('pointerup', () => { dragging = false; }, {once:true,capture:true}); });
    input.addEventListener('input', () => { if (input.getAttribute('aria-disabled') === 'true') return; lastValue = Number(input.value); preview(); });
    input.addEventListener('pointerup', () => { dragging = false; });
    input.addEventListener('lostpointercapture', () => { dragging = false; });
    input.addEventListener('blur', () => { dragging = false; });
    const cancel = () => { if (!dragging) return; dragging = false; lastValue = initialValue; input.value = String(initialValue); preview(); };
    input.addEventListener('pointercancel', cancel);
    input.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
    new MutationObserver(() => { if (dragging) preview(); if (lastPointer) paint(lastPointer); }).observe(control, {attributes:true,attributeFilter:['max','value','style'],subtree:true});
    new MutationObserver(() => { if (dragging) preview(); }).observe(elapsed, {childList:true,characterData:true,subtree:true});
    input.addEventListener('pointerenter', paint);
    input.addEventListener('pointermove', paint);
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

window.familyhub.focusIfWithin = (selector, successor) => { if (document.activeElement?.closest(selector)) document.getElementById(successor)?.focus({preventScroll:true}); };
window.familyhub.statsVisible = () => !document.hidden && !!document.querySelector('.server-stats')?.getClientRects().length;
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
    const check = () => { if (!document.hidden) reference.invokeMethodAsync('CheckForBackgroundUpdate').catch(() => {}); };
    const timer = setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    familyhub.stopUpdatePolling = () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
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
window.familyhub.isPhone = () => matchMedia('(max-width:720px)').matches;
window.familyhub.searchSubmitted = () => {
    if (!familyhub.isPhone()) return;
    document.getElementById('q')?.blur();
    familyhub.focus('view-title');
};
// Focuses the first of these controls that is on screen, after the next render.
window.familyhub.focusVisible = (...ids) => requestAnimationFrame(() => { for(const id of ids){ const target=document.getElementById(id); if(target&&target.getClientRects().length){ target.focus(); return; } } });
// Opens a file input from another control (the Create playlist screen's big buttons).
window.familyhub.clickElement = id => document.getElementById(id)?.click();
// Lyrics follow the song; scrolling by hand pauses following for a few seconds.
window.familyhub.revealLyric = id => {
 const line=document.getElementById(id), list=line?.closest('.lyrics-view'); if(!line||!list)return;
 if(!list.dataset.bound){ list.dataset.bound='1'; const hold=()=>{ list.dataset.heldUntil=Date.now()+4000; }; list.addEventListener('wheel',hold,{passive:true}); list.addEventListener('touchmove',hold,{passive:true}); }
 if(Date.now()<Number(list.dataset.heldUntil||0))return;
 const top=line.offsetTop-list.clientHeight*.38;
 list.scrollTo({top,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
};
// Long titles in Now Playing scroll sideways, pause, then come round again.
// Measured once per song; the animation runs on the GPU with fixed pixel values.
window.familyhub.fitTitle = () => {
 // Full-screen Now Playing and lyrics cover the star background; stop drawing it meanwhile.
 const covered=document.hidden||document.body.classList.contains('native-hidden')||!!document.querySelector('.player-bar.is-expanded,.lyrics-view');
 if((document.body.dataset.visualPaused==='true')!==covered){ if(covered)document.body.dataset.visualPaused='true'; else delete document.body.dataset.visualPaused; }
 const title=document.getElementById('now-title'), text=title?.querySelector('.marquee-text'); if(!text)return;
 const expanded=!!title.closest('.player-bar.is-expanded');
 const enabled=expanded||familyhub.isPhone();
 const key=[text.textContent,enabled,title.clientWidth,document.hidden,document.body.classList.contains('native-hidden'),matchMedia('(prefers-reduced-motion: reduce)').matches].join('|');
 if(title.dataset.fitted===key)return;
 title.dataset.fitted=key;
 familyhub.titleAnimations?.forEach(a=>a.cancel()); familyhub.titleAnimations=[];
 title.querySelector('.marquee-copy')?.remove();
 title.classList.remove('is-marquee');
 if(!enabled||document.hidden||document.body.classList.contains('native-hidden'))return;
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
// The song options sheet closes when dragged down far enough.
window.familyhub.bindSheet = (id, closeId) => {
 const sheet=document.getElementById(id); if(!sheet||sheet.dataset.dragBound)return; sheet.dataset.dragBound='1';
 let start=null, moved=0, draggedAt=0;
 // A drag that springs back is not a tap on the row under the finger.
 sheet.addEventListener('click',e=>{ if(Date.now()-draggedAt<350){ e.stopPropagation(); e.preventDefault(); } },true);
 const begin=(y,target)=>{ if(!familyhub.isPhone()||!sheet.classList.contains('is-open')||sheet.scrollTop>0||target.closest('input,select,dialog'))return; start=y; moved=0; };
 const move=y=>{ moved=Math.max(0,y-start); if(moved>6){ sheet.style.transition='none'; sheet.style.transform=`translateY(${moved}px)`; } };
 const end=()=>{ if(start===null)return; start=null; sheet.style.transition=''; sheet.style.transform=''; if(moved>90){ document.getElementById(closeId)?.click(); } if(moved>6)draggedAt=Date.now(); };
 // Touch: the sheet scrolls vertically, so the browser would claim a downward swipe and cancel the drag.
 // At the top of the sheet a downward swipe moves the sheet instead; an upward one still scrolls it.
 sheet.addEventListener('touchstart',e=>{ if(e.touches.length===1)begin(e.touches[0].clientY,e.target); else start=null; },{passive:true});
 sheet.addEventListener('touchmove',e=>{ if(start===null)return; const y=e.touches[0].clientY; if(y<start&&moved<=6){ start=null; return; } e.preventDefault(); move(y); },{passive:false});
 sheet.addEventListener('touchend',end); sheet.addEventListener('touchcancel',end);
 // Mouse and pen keep the pointer drag.
 sheet.addEventListener('pointerdown',e=>{ if(e.pointerType!=='touch')begin(e.clientY,e.target); },{passive:true});
 sheet.addEventListener('pointermove',e=>{ if(e.pointerType!=='touch'&&start!==null)move(e.clientY); },{passive:true});
 sheet.addEventListener('pointerup',e=>{ if(e.pointerType!=='touch')end(); }); sheet.addEventListener('pointercancel',e=>{ if(e.pointerType!=='touch')end(); });
};
// Android Back: close the topmost popup or dialog the same way Escape does.
window.familyhub.closeTopLayer = () => {
 const popup=[...document.querySelectorAll(':popover-open')].pop();
 if(popup){ popup.hidePopover(); return true; }
 const dialog=[...document.querySelectorAll('dialog[open]')].pop();
 if(dialog){ if(dialog.requestClose)dialog.requestClose(); else dialog.close(); return true; }
 return false;
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
// Home shelves: arrow buttons step one view sideways and dim at either end.
familyhub.updateShelf=id=>{
 const shelf=document.getElementById(id); if(!shelf)return;
 const max=shelf.scrollWidth-shelf.clientWidth-1;
 document.querySelectorAll(`[data-shelf="${id}"]`).forEach(button=>{
  const end=Number(button.dataset.dir)<0?shelf.scrollLeft<=1:shelf.scrollLeft>=max;
  button.setAttribute('aria-disabled',String(end||max<=0));
 });
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
 familyhub.fitTitle();
};
