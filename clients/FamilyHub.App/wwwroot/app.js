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
    const fallback = () => document.getElementById('profile-toggle') || document.getElementById('server') || document.getElementById('content');
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : fallback();
    if (document.activeElement === document.body) previous?.focus({preventScroll:true});
    dialog._returnFocus = previous;
    if (!dialog._focusBound) {
        dialog._focusBound = true;
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
    if (dialog.matches(':popover-open')) dialog.hidePopover();
    else if (dialog instanceof HTMLDialogElement) dialog.close();
    const target = dialog._returnFocus;
    if (target?.isConnected) target.focus({preventScroll:true});
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
            reference.invokeMethodAsync('LoadMoreSearch', version).catch(() => {});
        }
    }, { root, rootMargin: '160px' });
    searchPageObserver.observe(sentinel);
};

// A virtual row can leave the DOM while scrolled; keep keyboard focus in its list.
let focusedSongControl;
document.addEventListener('focusin',event=>{focusedSongControl=event.target.closest?.('.song-row')?event.target:null;});
new MutationObserver(()=>{
    if(document.activeElement===document.body && focusedSongControl && !focusedSongControl.isConnected) {
        focusedSongControl=null;
        (document.body.dataset.view==='search'?document.getElementById('results'):document.getElementById('content'))?.focus({preventScroll:true});
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
        if (elapsed.textContent !== time(value)) elapsed.textContent = time(value);
        const badge = control.querySelector('.seek-tooltip'); if (badge.textContent !== time(value)) badge.textContent = time(value);
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
        tip.textContent = text;
        const r = active.getBoundingClientRect(), t = tip.getBoundingClientRect();
        tip.style.left = Math.max(6, Math.min(innerWidth - t.width - 6, r.left + (r.width - t.width) / 2)) + 'px';
        tip.style.top = (r.top > t.height + 12 ? r.top - t.height - 9 : r.bottom + 9) + 'px';
        tip.classList.add('is-visible');
    };
    const show = target => {
        const button = target.closest?.('button[title],button[data-tooltip],button[aria-label],.storage-state[title],.storage-state[data-tooltip]');
        if (!button || (!button.hasAttribute('title') && !button.dataset.tooltip && button.textContent.trim())) return;
        if (active === button) return;
        hide(); active = button;
        if (!tip) { tip = document.createElement('div'); tip.id = 'app-control-tooltip'; tip.className = 'app-tooltip'; tip.setAttribute('role','tooltip'); document.body.append(tip); }
        if (!button.hasAttribute('aria-describedby')) button.setAttribute('aria-describedby', tip.id);
        paint();
        observer = new MutationObserver(paint); observer.observe(button, {attributes:true,attributeFilter:['title','aria-label']});
    };
    document.addEventListener('pointerover', event => { if (event.pointerType !== 'touch') show(event.target); });
    document.addEventListener('pointerout', event => { if (active?.contains(event.target) && !active.contains(event.relatedTarget)) hide(); });
    document.addEventListener('focusin', event => { if (event.target.matches?.(':focus-visible')) show(event.target); });
    document.addEventListener('focusout', event => { if (active?.contains(event.target)) hide(); });
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
})();

window.familyhub.focusIfWithin = (selector, successor) => { if (document.activeElement?.closest(selector)) document.getElementById(successor)?.focus({preventScroll:true}); };
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
   for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]<128)continue;r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];n++;}
   if(n){panel.style.setProperty('--playlist-tint',`${Math.round(r/n)} ${Math.round(g/n)} ${Math.round(b/n)}`);panel.dataset.tintSource=img.currentSrc;}
  }catch{panel.style.removeProperty('--playlist-tint');}
 };
 if(!panel._tintObserver){panel._tintObserver=new MutationObserver(sample);panel._tintObserver.observe(panel,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});panel.addEventListener('load',sample,true);}
 sample();
};
window.familyhub.captureLeaderboard = () => {
 const table=document.querySelector('.stats-leaderboard');if(!table)return;
 table._rowPositions=new Map([...table.querySelectorAll('tbody tr')].map(row=>[row,row.getBoundingClientRect().top]));
 table._rowFocus=table.contains(document.activeElement)?document.activeElement:null;
};
window.familyhub.animateLeaderboard = () => {
 const table=document.querySelector('.stats-leaderboard');if(!table?._rowPositions)return;
 const positions=table._rowPositions;
 if(document.activeElement===document.body&&table._rowFocus){const target=table._rowFocus; (target.isConnected?target:document.getElementById('server-stats-refresh'))?.focus({preventScroll:true});}
 table._rowFocus=null;
 const rows=[...table.querySelectorAll('tbody tr')],oldRows=[...positions.keys()];
 if(rows.length===oldRows.length&&rows.every((row,i)=>row===oldRows[i]))return;
 table._rowPositions=null;
 if(matchMedia('(prefers-reduced-motion: reduce)').matches||document.body.dataset.effects==='off')return;
 for(const row of table.querySelectorAll('tbody tr')){
  const before=positions.get(row);row.getAnimations().forEach(a=>a.cancel());
  const delta=before-row.getBoundingClientRect().top;
  if(Number.isFinite(delta)&&Math.abs(delta)>1)row.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:340,easing:'cubic-bezier(.2,.8,.2,1)'});
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
// Android Back: close the topmost popup or dialog the same way Escape does.
window.familyhub.closeTopLayer = () => {
 const popup=[...document.querySelectorAll(':popover-open')].pop();
 if(popup){ popup.hidePopover(); return true; }
 const dialog=[...document.querySelectorAll('dialog[open]')].pop();
 if(dialog){ if(dialog.requestClose)dialog.requestClose(); else dialog.close(); return true; }
 return false;
};
