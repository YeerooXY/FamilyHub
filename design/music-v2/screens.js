"use strict";
const query = new URLSearchParams(location.search);
const tracks = window.MUSIC_DESIGN_TRACKS;
const byId = new Map(tracks.map(t => [t.key, t]));
const state = { view: query.get("view") || "player", layout: query.get("layout") || "focus", phase: query.get("state") || "ready", current: "bad-romance", next: "dont-start-now", autoplay: query.get("state") !== "off", playing: true, genre: "All", search: "Lady Gaga", fading: true, fadeSeconds: 5, silence: true, beat: false, downloads: true, motion: true };
if(query.get('track')&&byId.has(query.get('track'))){state.current=query.get('track');state.next=byId.get(state.current).genre?tracks.find(t=>t.key!==state.current&&t.genre===byId.get(state.current).genre)?.key:null;}
const shapes = {
 play:'<path d="M6 3v18l15-9z"/>',
 pause:'<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>',
 next:'<path d="M4 3v18l13-9z"/><rect x="18" y="3" width="3" height="18" rx="1"/>',
 previous:'<path d="M20 3v18L7 12z"/><rect x="3" y="3" width="3" height="18" rx="1"/>',
 player:'<circle cx="12" cy="12" r="10"/><path fill="var(--icon-detail)" d="M9 6v12l9-6z"/>',
 library:'<rect x="2" y="3" width="5" height="18" rx="1"/><rect x="9" y="3" width="5" height="18" rx="1"/><path d="m16 4 4-1 4 17-4 1z"/>',
 search:'<circle cx="10" cy="10" r="8"/><path d="m14 17 3-3 7 7-3 3z"/>',
 settings:'<path d="m9 1 6 0 1 4 3-2 4 4-2 3 3 1v4l-4 1 2 3-4 4-3-2-1 3h-4l-1-4-3 2-4-4 2-3-3-1v-4l4-1-2-3 4-4 3 2z"/><circle fill="var(--icon-detail)" cx="12" cy="12" r="4"/>',
 check:'<path d="m2 12 3-3 5 5L20 3l3 3-13 14z"/>',
 down:'<path d="M9 2h6v10h6l-9 9-9-9h6z"/>',
 more:'<circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="12" r="2"/>',
 volume:'<path d="M2 8h5l7-6v20l-7-6H2zM17 6v12c7-3 7-9 0-12"/>',
 shuffle:'<path d="M2 5h4l12 12v-4l6 6-6 5v-4h-2L4 8H2zm0 14h4l5-5-2-2-5 4H2zM13 9l4-4h1V1l6 5-6 6V8h-1l-2 3z"/>',
 close:'<path d="m3 6 3-3 6 6 6-6 3 3-6 6 6 6-3 3-6-6-6 6-3-3 6-6z"/>',
 arrow:'<path d="M2 10h13l-5-5 3-3 11 10-11 10-3-3 5-5H2z"/>',
 music:'<path d="M8 3 22 1v16c0 5-8 6-8 2 0-3 4-4 5-3V7l-8 2v11c0 5-9 5-9 1 0-3 4-4 6-3z"/>'
};
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const icon = name => `<svg class="solid-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${shapes[name] || shapes.music}</svg>`;
const image = (track, cls="") => `<img class="cover ${cls}" src="${escape(track.file)}" alt="${escape(track.album||"Album cover unavailable")} album cover" width="600" height="600">`;
const time = seconds => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,"0")}`;
const button = (action, name, cls="", label=name) => `<button type="button" class="${cls}" data-action="${action}" aria-label="${escape(label)}" ${action==='next'&&(!state.autoplay||!state.next)?'disabled':''}>${icon(name)}</button>`;
const readiness = phase => phase === "preparing" ? `<span class="readiness pending"><span class="ring"></span>Preparing audio</span>` : phase === "error" ? `<span class="readiness problem">Preparation failed</span>` : phase === "mixing" ? `<span class="readiness">Both songs playing</span>` : `<span class="readiness">${icon("check")}Ready to play</span>`;

function transport(compact=false) {
  const current=byId.get(state.current);
  return `<div class="transport ${compact?'compact':''}"><div class="transport-controls"><span class="transport-spacer"></span>${button("previous","previous","icon-button","Previous song")}${button("play",state.playing?"pause":"play","main-play",state.playing?"Pause":"Play")}${button("next","next","icon-button","Next song")}<span class="transport-spacer"></span></div><div class="timeline"><span>${state.phase==='mixing'?time(current.duration-5):'2:16'}</span><input id="seek" type="range" min="0" max="${Math.floor(current.duration)}" value="${state.phase==='mixing'?Math.floor(current.duration-5):136}" aria-label="Playback position"><span>${time(current.duration)}</span></div></div>`;
}
function nextPane(large=false) {
 const next=byId.get(state.next);
 if (!state.autoplay) return `<aside class="next-pane off"><div class="next-heading"><h2>Up next</h2></div><div class="autoplay-off">${icon("player")}<h3>Stop after this song</h3><p>Turn on Autoplay to continue with related music.</p><button type="button" class="text-button" data-action="autoplay">Turn on Autoplay</button></div></aside>`;
 if (!next) return `<aside class="next-pane"><div class="next-heading"><h2>Up next</h2></div><div class="autoplay-off"><h3>${byId.get(state.current).genre?'No more '+escape(byId.get(state.current).genre)+' songs saved':'Genre not identified'}</h3><p>${byId.get(state.current).genre?'Choose another song in Search to continue.':'Choose a song with known genre metadata to continue a matching mix.'}</p><button type="button" class="text-button" data-action="search-focus">Search music</button></div></aside>`;
 return `<aside class="next-pane ${large?'large-next':''}"><div class="next-heading"><h2>${state.phase==='mixing'?'Fading in':'Next song'}</h2></div><button type="button" class="next-track" data-track="${next.key}" aria-label="Play ${escape(next.title)} next">${image(next)}<span><strong>${escape(next.title)}</strong><small>${escape(next.artist)}</small></span></button>${readiness(state.phase)}${state.phase==='preparing'?'<p class="state-detail">Playing continues while the next song prepares.</p>':''}${state.phase==='error'?'<p class="state-detail">Choose this song to retry, or select another song.</p>':''}${state.phase==='mixing'?'<div class="mix-progress"><span></span></div><p class="state-detail">Crossfading for 5 seconds</p>':''}</aside>`;
}
function player() {
 const t=byId.get(state.current);
 const genres=['Pop','Dance'].includes(t.genre)?['Pop','Dance']:[t.genre];
 const upcoming=state.autoplay?[byId.get(state.next),...tracks.filter(r=>r.key!==t.key&&r.key!==state.next&&r.genre&&genres.includes(r.genre)&&(state.downloads||r.saved))].filter(Boolean).slice(0,10):[];
 return `<section class="workspace-content player-workspace"><div class="playlist"><div class="section-heading"><h1>Player</h1></div><h2>Up next</h2>${upcoming.length?upcoming.map((r,i)=>`<button class="playlist-row" type="button" data-track="${r.key}"><span class="track-number">${i+1}</span>${image(r)}<span><strong>${escape(r.title)}</strong><small>${escape(r.artist)}</small></span>${storage(r)}<span class="playlist-duration">${time(r.duration)}</span></button>`).join(''):`<p class="empty-queue">${state.autoplay?'No more recommendations available.':'Playback stops after this song.'}</p>`}</div><aside class="workspace-rail"><h2>${state.phase==='mixing'?'Fading out':'Now playing'}</h2><div class="rail-current">${image(t)}<div><h3>${escape(t.title)}</h3><p>${escape(t.artist)}</p></div></div>${nextPane()}</aside></section>`;
}
function storage(t) {
 const name=t.saved?'Saved on server':'Available to download';
 return `<span class="storage-state" role="img" aria-label="${name}" title="${name}">${t.saved?'&#128190;':'&#9729;&#65039;'}</span>`;
}
function settings() {
 const check=(id,title,checked,detail='')=>`<label class="setting-row"><span><strong>${title}</strong>${detail?`<small>${detail}</small>`:''}</span><input id="${id}" type="checkbox" ${checked?'checked':''}></label>`;
 return `<section class="settings-view"><h1>Settings</h1><h2>Playback</h2>${check('autoplay','Autoplay',state.autoplay,'Continue with recommended songs.')}${check('fade-enabled','Crossfade',state.fading,'Applies to the next transition, including after seeking.')}<label class="setting-row fade-length"><span>Overlap <output id="fade-value">${state.fadeSeconds} s</output></span><input id="fade-setting" type="range" min="1" max="12" value="${state.fadeSeconds}" ${state.fading?'':'disabled'}></label><div class="fade-preview ${state.fading?'':'disabled'}" aria-label="Crossfade preview"><span>Current song</span><div class="fade-waves"><i></i><i></i></div><span>Next song</span></div>${check('beat-setting','Match beats',state.beat,'Use compatible tempos when analysis is available; otherwise crossfade normally.')}${check('silence-setting','Skip empty edges',state.silence,'Skip detected silence at the start and end. Keep original files unchanged.')}<h2>Downloads</h2>${check('download-setting','Download recommendations',state.downloads,'Prepare upcoming songs on the server.')}<p class="storage-legend"><span>&#128190; Saved on server</span><span>&#9729;&#65039; Available to download</span></p><h2>Appearance</h2>${check('motion-setting','Animations',state.motion,'Device reduced-motion preferences take priority.')}</section>`;
}
function library() {
 let visible=tracks.filter(t=>t.saved&&(state.genre==='All'||t.genre===state.genre));
 return `<section class="library-view"><div class="section-heading"><div><h1>Library</h1><p>${tracks.filter(t=>t.saved).length} songs saved on your server</p></div><button type="button" class="quiet-button" data-action="shuffle-library">${icon('shuffle')}Shuffle play</button></div><div class="filters" aria-label="Filter by genre">${['All','Pop','Dance','House'].map(g=>`<button type="button" data-filter="${g}" aria-pressed="${state.genre===g}" class="filter ${state.genre===g?'active':''}">${g}</button>`).join('')}</div><div class="table-heading"><span>Title</span><span>Album</span><span>Length</span></div><div class="track-table">${visible.map(t=>`<div class="song-row ${t.key===state.current?'is-current':''}"><button type="button" class="song-primary" data-track="${t.key}">${image(t)}<span><strong>${escape(t.title)}</strong><small>${escape(t.artist)}</small></span>${t.key===state.current?'<span class="equalizer" aria-label="Playing"><i></i><i></i><i></i></span>':''}</button><span class="album-cell">${escape(t.album)}</span><span class="duration-cell">${storage(t)}${time(t.duration)}</span></div>`).join('')}</div></section>`;
}
function search() {
 const results=tracks.filter(t=>(t.title+' '+t.artist).toLowerCase().includes(state.search.toLowerCase()));
 const list=results.length?results:tracks.slice(0,4);
 return `<section class="search-view"><div class="section-heading"><div><h1>Search</h1><p>Results for “${escape(state.search)}”</p></div></div><h2>Songs</h2><div class="search-results">${list.map(t=>`<button type="button" class="search-result" data-track="${t.key}">${image(t)}<span><strong>${escape(t.title)}</strong><small>${escape(t.artist)}</small><span class="search-meta">${escape(t.genre)} <span>${time(t.duration)}</span></span></span><span class="result-state ${t.saved?'':'available'}">${storage(t)}</span>${icon('play')}</button>`).join('')}</div><p class="search-permission">New music plays as it downloads and is saved to your server.</p></section>`;
}
function footer() {
 const t=byId.get(state.current);
 return `<footer class="mini-player"><button type="button" class="mini-track" data-action="view:player">${image(t)}<span><strong>${escape(t.title)}</strong><small>${escape(t.artist)}</small></span></button>${transport(true)}<div class="volume">${icon('volume')}<input type="range" min="0" max="1" step=".01" value=".7" aria-label="Volume"></div><div class="compact-actions"><button class="mobile-play" type="button" data-action="play" aria-label="${state.playing?'Pause':'Play'}">${icon(state.playing?'pause':'play')}</button>${button("next","next","mobile-next","Next song")}</div></footer>`;
}
function render() {
 const focused = document.activeElement?.getAttribute('data-action');
 const selected = document.activeElement?.getAttribute('data-filter');
 const focusId=document.activeElement?.id;
 document.body.dataset.view=state.view;document.body.dataset.layout=state.layout;document.body.dataset.motion=state.motion;
 document.getElementById('app').innerHTML=`<aside class="navigation"><a class="brand" href="screens.html"><img class="brand-mark" src="assets/familyhub-mark.png" alt=""><span>FamilyHub<small>Music</small></span></a><nav aria-label="Music"><button type="button" data-action="view:player" ${state.view==='player'?'aria-current="page"':''}>${icon('player')}<span>Player</span></button><button type="button" data-action="view:library" ${state.view==='library'?'aria-current="page"':''}>${icon('library')}<span>Library</span></button><button type="button" data-action="view:search" ${state.view==='search'?'aria-current="page"':''}>${icon('search')}<span>Search</span></button></nav><div class="nav-bottom"><button type="button" class="settings-button" data-action="settings">${icon('settings')}<span>Settings</span></button></div></aside><header class="topbar"><form id="search-form"><label class="search-field">${icon('search')}<input id="search" type="search" aria-label="Search songs or artists" placeholder="Search songs or artists" value="${state.view==='search'?escape(state.search):''}"><kbd>Ctrl K</kbd></label></form><button class="top-avatar" type="button" data-action="settings" aria-label="Settings for yeeroo">Y</button></header><main id="main" tabindex="-1">${state.view==='player'?player():state.view==='library'?library():state.view==='settings'?settings():search()}</main>${footer()}<div class="mobile-nav"><button data-action="view:player" ${state.view==='player'?'aria-current="page"':''}>${icon('player')}Player</button><button data-action="view:library" ${state.view==='library'?'aria-current="page"':''}>${icon('library')}Library</button><button data-action="search-focus" ${state.view==='search'?'aria-current="page"':''}>${icon('search')}Search</button><button data-action="settings" ${state.view==='settings'?'aria-current="page"':''}>${icon('settings')}Settings</button></div><p id="notice" role="status" class="toast" hidden></p>`;
 document.querySelectorAll('[data-action]').forEach(node=>node.addEventListener('click',()=>act(node.dataset.action)));
 document.querySelectorAll('[data-track]').forEach(node=>node.addEventListener('click',()=>playTrack(node.dataset.track)));
 document.querySelectorAll('[data-filter]').forEach(node=>node.addEventListener('click',()=>{state.genre=node.dataset.filter;render();}));
 document.getElementById('autoplay')?.addEventListener('change',e=>{state.autoplay=e.target.checked;render();document.getElementById('autoplay')?.focus();});
 document.getElementById('seek')?.addEventListener('input',e=>{e.target.previousElementSibling.textContent=time(Number(e.target.value));});
 document.getElementById('search-form').addEventListener('submit',e=>{e.preventDefault();state.search=document.getElementById('search').value.trim()||'Lady Gaga';state.view='search';render();document.querySelector('h1')?.setAttribute('tabindex','-1');document.querySelector('h1')?.focus();});
 for(const [id,key] of [['fade-enabled','fading'],['beat-setting','beat'],['silence-setting','silence'],['download-setting','downloads'],['motion-setting','motion']]) document.getElementById(id)?.addEventListener('change',e=>{state[key]=e.target.checked;render();document.getElementById(id)?.focus();});
 document.getElementById('fade-setting')?.addEventListener('input',e=>{state.fadeSeconds=Number(e.target.value);document.getElementById('fade-value').textContent=state.fadeSeconds+' s';});
 if(focusId&&document.getElementById(focusId))document.getElementById(focusId).focus();
 if(focused) [...document.querySelectorAll('[data-action]')].find(n=>n.dataset.action===focused&&n.offsetParent!==null)?.focus();
 else if(selected) [...document.querySelectorAll('[data-filter]')].find(n=>n.dataset.filter===selected&&n.offsetParent!==null)?.focus();
}
function playTrack(key) { if(!byId.has(key))return;state.current=key;state.next=tracks.find(t=>byId.get(key).genre&&t.genre===byId.get(key).genre&&t.key!==key)?.key||null;state.view='player';state.playing=true;state.phase='ready';render();[...document.querySelectorAll('[data-action="play"]')].find(n=>n.offsetParent!==null)?.focus(); }
function act(action) {
 if(action.startsWith('view:')){state.view=action.split(':')[1];render();if(document.activeElement===document.body){document.querySelector('h1').tabIndex=-1;document.querySelector('h1').focus();}return;}
 if(action.startsWith('menu:')){const notice=document.getElementById('notice');notice.textContent='Saved on your server';notice.hidden=false;setTimeout(()=>notice.hidden=true,2000);return;}
 if(action==='settings'){state.view='settings';render();document.querySelector('h1').tabIndex=-1;document.querySelector('h1').focus();return;}
 if(action==='search-focus'){state.view='search';render();document.getElementById('search').focus();return;}
 if(action==='next'){playTrack(state.next);return;}
 if(action==='previous'){playTrack('bad-romance');return;}
 if(action==='shuffle-library'||action==='shuffle'){const choices=tracks.filter(t=>t.key!==state.current);playTrack(choices[Math.floor(Math.random()*choices.length)].key);return;}
 if(action==='play')state.playing=!state.playing;
 if(action==='autoplay')state.autoplay=true;
 if(action==='retry')state.phase='preparing';
 render();
}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.getElementById('search').focus();}});
render();
