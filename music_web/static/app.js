"use strict";
// Untrusted metadata is only ever written with textContent (via el()), never as HTML.
const $ = (id) => document.getElementById(id);
const csrf = document.querySelector('meta[name="csrf-token"]').content;


let timer = null;
let selectedSource = null;
let seekingPointer = false;
const songRecommendations = window.MusicRecommendations;
let historyStorage; try { historyStorage=localStorage; } catch { historyStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}}; }
const listeningHistory = songRecommendations.createHistory(historyStorage, document.body.dataset.user || "anonymous");
let listeningSample = {source:null, time:0, seconds:0, saved:false};
function recordSkip() {
  if (currentTrack && listeningSample.source === sourceKey(currentTrack) && listeningSample.seconds >= 2 && listeningSample.seconds < 30) listeningHistory.record(currentTrack,"skipped");
}

let visibleResults = [], searchPreviewTracks = [];
let searchVersion = 0, searchController = null;
let searchQuery = "", searchOffset = null, searchLoading = false;
let typingTimer = null, viewportTimer = null, playbackSearchQuery = null;

function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

async function api(path, { method = "GET", json, form, signal } = {}) {
  const init = { method, credentials: "same-origin", headers: { "X-CSRFToken": csrf }, signal };
  if (json) { init.body = JSON.stringify(json); init.headers["Content-Type"] = "application/json"; }
  if (form) init.body = form;
  let res;
  try { res = await fetch(path, init); } catch { throw new Error("Cannot reach the server."); }
  if (res.status === 401) { location.href = "/login"; throw new Error("Sign in required."); }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) { const e = new Error(data.error || "Request failed."); e.status = res.status; throw e; }
  return data;
}

const duration = (s) => (typeof s === "number" && s > 0 ? Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") : "");
function musicIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ class: "icon", viewBox: "0 0 24 24", fill: "currentColor", stroke: "none", "stroke-width": "0", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path); svg.append(shape); return svg;
}

function cover(track) {
  const node = el("span", {class:"cover", "aria-hidden":"true"});
  node.textContent = (track?.title || "♫").slice(0, 1).toUpperCase();
  const id = sourceKey(track);
  if (/^[A-Za-z0-9_-]{11}$/.test(id || "")) {
    const img = el("img", {src:"/api/artwork/" + encodeURIComponent(id), alt:"", loading:"lazy"});
    img.addEventListener("error", () => img.remove(), {once:true});
    node.append(img);
  }
  return node;
}
function songButton(track, context = "queue") {
  const button = el("button", {type:"button", class:"song-primary", "data-source":sourceKey(track), "aria-label":"Play " + track.title},
    cover(track), el("span", {class:"song-text"}, el("strong", {}, track.title || "Untitled"),
    el("small", {}, track.channel || track.artist || ""), el("span", {class:"song-next"}, "Up next")),
    el("span", {class:"storage-state", role:"img"}),
    el("span", {class:"time"}, duration(track.duration)), el("span", {class:"song-playing", "aria-hidden":"true"}, el("i"), el("i"), el("i")));
  button.addEventListener("click", () => listen(track, context === "queue", context));
  return button;
}
function searchRow(track, context = "search") {
  const add = el("button", {type:"button", class:"queue-add", "data-source":sourceKey(track), "aria-label":"Add " + track.title + " to queue", title:"Add to queue"}, musicIcon("M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"));
  add.addEventListener("click", () => {
    const key = sourceKey(track);
    if (key === sourceKey(currentTrack) || manualQueue.has(key)) return;
    queue = queue.filter(t => sourceKey(t) !== key);
    const position = queue.filter(t => manualQueue.has(sourceKey(t))).length;
    manualQueue.add(key); queue.splice(position, 0, track);
    listeningHistory.record(track,"queued");
    renderQueue(); prepare();
    $("status-text").textContent = track.title + " added to queue.";
  });
  return el("li", {}, songButton(track, context), add);
}
function refreshVisiblePreviews() {
  if (document.body.dataset.view !== "search" || !$("search-previews").checked) return;
  const bounds = $("content").getBoundingClientRect();
  const rows = [...$("results").children];
  const candidates = rows.flatMap((row, index) => {
    const box = row.getBoundingClientRect(), track = visibleResults[index];
    return box.bottom > bounds.top && box.top < bounds.bottom && track?.duration > 0 && track.duration <= 600 ? [track] : [];
  }).slice(0, 16);
  if (candidates.map(sourceKey).join() === searchPreviewTracks.map(sourceKey).join()) return;
  searchPreviewTracks = candidates; prepare();
}
function scheduleVisiblePreviews() { clearTimeout(viewportTimer); viewportTimer = setTimeout(refreshVisiblePreviews, 150); }
function renderResults(list) {
  visibleResults = list; searchPreviewTracks = [];
  const ul = $("results"), hadFocus = ul.contains(document.activeElement);
  ul.replaceChildren(...list.map(searchRow));
  $("results-set").hidden = !list.length;
  updateSongStates();
  if(hadFocus) (ul.querySelector("button") || $("q")).focus();
  requestAnimationFrame(refreshVisiblePreviews);
}
$("search-form").addEventListener("submit", async e => {
  clearTimeout(typingTimer);
  searchDirty = false;
  e.preventDefault(); setView("search");
  const q = $("q").value.trim(), out = $("search-status");
  if(!q) { out.textContent = "Enter a song or artist."; $("q").focus(); return; }
  const version = ++searchVersion;
  searchQuery = q; searchOffset = null; searchPreviewTracks = []; $("load-more-search").hidden = true;
  searchController?.abort(); searchController = new AbortController();
  out.textContent = "Searching…";
  out.classList.remove("is-error", "is-feedback");
  $("pick").setAttribute("aria-busy", "true");
  $("search-form").classList.add("is-searching");
  try {
    const {results, next_offset} = await api("/api/search", {method:"POST", json:{query:q, include_long:$("include-long-mixes").checked}, signal:searchController.signal});
    if(version !== searchVersion) return;
    searchOffset = next_offset ?? null; $("load-more-search").hidden = searchOffset === null;
    renderResults(results); out.textContent = results.length ? `${results.length} songs` : "No results. Try different words.";
    out.classList.toggle("is-feedback", !results.length);
  } catch(err) { if(version === searchVersion) { out.textContent = err.message; out.classList.add("is-error"); } }
  finally { if(version === searchVersion) { $("pick").setAttribute("aria-busy", "false"); $("search-form").classList.remove("is-searching"); } }
});
$("q").addEventListener("input", () => {
  clearTimeout(typingTimer); searchController?.abort(); ++searchVersion;
  $("clear-search").hidden = !$("q").value;
  $("pick").setAttribute("aria-busy", "false"); $("search-form").classList.remove("is-searching");
  if ($("q").value.trim().length >= 2) typingTimer = setTimeout(() => $("search-form").requestSubmit(), 450);
  else { searchQuery = ""; searchOffset = null; renderResults([]); $("search-status").textContent = ""; $("load-more-search").hidden = true; }
});
$("clear-search").addEventListener("click", () => { $("q").value = ""; $("q").dispatchEvent(new Event("input")); $("q").focus(); });
$("content").addEventListener("scroll", scheduleVisiblePreviews, {passive:true});
window.addEventListener("resize", scheduleVisiblePreviews);

// ---- status ----
function showJob(job) {
  statusJob = job;
  rememberSaved(job); updateSongStates();
  const active = job.state === "running" || job.state === "queued";
  $("cancel").disabled = !active;
  $("retry").disabled = !(job.media_url || job.source_id);
  $("status").hidden = false;
  $("status-text").textContent = job.message;
  $("busy").hidden = !active;
  $("recovery").hidden = !["error", "cancelled"].includes(job.state);
  if (job.state === "done") loadLibrary();
  const player = decks[deckIndex];
  configureAudio(player, job);
  if (job.media_url && player.dataset.mediaUrl !== job.media_url) {
    loadPlayback(player, job.media_url);
    player.hidden = false;
  } else if (job.source_id && !job.media_url && ["unavailable", "expired"].includes(job.preview_state) && !active) {
    $("playback-state").textContent = "Playback could not be prepared. Use Retry playback or Open player.";
  }
}

function poll(id, fails, version = requestVersion) {
  timer = setTimeout(async () => {
    try {
      const { job } = await api("/api/jobs/" + encodeURIComponent(id));
      if (version !== requestVersion) return;
      if (job.source_id) {
        if (currentJob && currentJob.id !== id) return;
        currentJob = job;
      }
      showJob(job);
      if (job.state === "running" || job.state === "queued") poll(id, 0, version);
    } catch (ex) {
      if (version !== requestVersion) return;
      if (ex.status === 404) showJob({ state: "error", message: "This import is no longer listed." });
      else if (fails < 4 && version === requestVersion) poll(id, fails + 1, version);
      else showJob({ state: "error", message: "Lost contact with the server. The import may still be running." });
    }
  }, currentJob?.media_url ? 2000 : 300);
}

// Stable decks: search, queue edits and status updates never replace an audio element.
const decks = [$("preview-player"), $("next-player")];
let deckIndex = 0, currentJob = null, statusJob = null, currentTrack = null, requestVersion = 0;
let queue = [], pool = [], history = [], skipped = [], heard = new Set(), prepared = new Map();
let wantPlayback = false, startPosition = null;
const savedSources = new Set();
const manualQueue = new Set();
let recentSeed = null;
try {
  const stored = JSON.parse(localStorage.getItem("music:last-track"));
  if (stored && typeof stored.title === "string" && typeof stored.channel === "string") recentSeed = stored;
} catch { /* First visit or unavailable browser storage. */ }
let masterGain = null, pauseVersion = 0;
let audioContext = null, gains = [], levels = [], nodes = [], blending = false, plan = null, planKey = "", planPending = false;
let prepareVersion = 0;
let blendVersion = 0;
function sourceKey(track) {
  if (track?.id) return track.id;
  try { return new URL(track.url).searchParams.get("v") || track.url; }
  catch { return track?.url; } // The API validates pasted links; queue rendering must remain usable.
}
const preparedJob = (track) => prepared.get(sourceKey(track));
const failedPreparation = (job) => job && (["error", "cancelled"].includes(job.state) || (job.state === "done" && !job.media_url));
function unlock() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!audioContext && AudioContext) {
    try {
      audioContext = new AudioContext();
      masterGain = audioContext.createGain(); masterGain.connect(audioContext.destination);
      decks.forEach((deck, i) => {
        const node = audioContext.createMediaElementSource(deck); nodes.push(node);
        const gain = audioContext.createGain(); gain.gain.value = i === deckIndex ? 1 : 0;
        const level = audioContext.createGain(); levels.push(level);
        node.connect(level).connect(gain).connect(masterGain); gains.push(gain);
      });
    } catch { $("mix-state").textContent = "Audio mixing is unavailable. Tracks play separately."; }
  }
  if (audioContext?.state === "suspended") audioContext.resume().catch(() => {});
}
function attach(player, url) {
  if (player.dataset.mediaUrl === url) return;
  player.pause();
  player.hls?.destroy(); player.hls = null;
  player.dataset.mediaUrl = url;
  player.dataset.cued = "false"; delete player.dataset.failed;
  // Prefer MSE for growing EVENT playlists; Chromium's native path can stall at the first segment.
  if (window.Hls?.isSupported()) {
    const hls = new Hls({ enableWorker: false, startPosition: 0, maxBufferLength: 12, maxMaxBufferLength: 12, backBufferLength: 12,
      loader: window.MusicPrefixCache ? MusicPrefixCache.loader(Hls.DefaultConfig.loader) : Hls.DefaultConfig.loader });
    player.hls = hls; hls.loadSource(url); hls.attachMedia(player);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        player.dataset.failed = "true";
        if (player === decks[deckIndex]) {
          $("playback-state").textContent = "Playback failed. Use Retry playback.";
          $("recovery").hidden = false;
        }
      }
    });
  } else if (player.canPlayType("application/vnd.apple.mpegurl")) player.src = url;
  else {
    delete player.dataset.mediaUrl;
    $("playback-state").textContent = "HLS playback is unavailable in this browser. Use Open player after saving.";
  }
}
function configureAudio(player, job) {
  player.playbackProfile = job?.playback || {};
  const level = levels[decks.indexOf(player)];
  if (level) level.gain.setTargetAtTime(10 ** ((player.playbackProfile.gain_db ?? -6) / 20), audioContext.currentTime, .2);
}
function cueAudio(player) {
  if (player.dataset.cued === "true" || player.readyState < 1) return;
  const start = player.playbackProfile?.start || 0;
  if (player.currentTime < start) player.currentTime = start;
  player.dataset.cued = "true";
}
function startPlayback(player) {
  const resuming = startPosition !== null;
  if (startPosition !== null) {
    if (player.readyState < 1) return;
    player.dataset.cued = "true";
    player.currentTime = Math.min(startPosition, Number.isFinite(player.duration) ? player.duration : startPosition);
    startPosition = null;
  }
  if (wantPlayback) {
    const version = requestVersion;
    safePlay(player).then(played => {
      if (!played && resuming && version === requestVersion && wantPlayback && player.paused) {
        showHandoffMessage("Press Play to continue on this device.");
      }
    });
  }
}
function loadPlayback(player, url, direct = false) {
  if (direct) {
    player.hls?.destroy(); player.hls = null;
    player.dataset.mediaUrl = url;
    player.dataset.cued = "false";
    player.src = url;
  } else {
    attach(player, url);
  }
  startPlayback(player);
}
function rememberSaved(job) {
  if (!job?.saved || !job.source_id || savedSources.has(job.source_id)) return false;
  savedSources.add(job.source_id);
  return true;
}
function updateSongStates() {
  const active = sourceKey(currentTrack), next = sourceKey(queue[0]);
  if (selectedSource === active) selectedSource = null;
  document.querySelectorAll(".song-primary").forEach(button => {
    const source = button.dataset.source;
    const saved = savedSources.has(source) || pool.some(t => t.saved && sourceKey(t) === source);
    const job = currentJob?.source_id === source ? currentJob : prepared.get(source);
    const state = saved ? "Saved on server" : job?.priority === 0 && ["running", "queued"].includes(job.state) ? "Saving to server" : job?.media_url ? "Temporary preview" : "Available to download";
    const badge = button.querySelector(".storage-state");
    if (badge && badge.getAttribute("aria-label") !== state) {
      const path = saved ? "M1 12l4 4L16 5l1.4 1.4L5 18.8l-5.4-5.4z M10 16l2 2L24 6l-1.4-1.4L12 15.2l-.6-.6z" : job?.media_url ? "M3 12l5 5L21 4l1.4 1.4L8 19.8l-6.4-6.4z" : "M11 3h2v11l4-4 1.4 1.4L12 17.8l-6.4-6.4L7 10l4 4z M4 19h16v2H4z";
      const changed = badge.hasAttribute("aria-label");
      badge.replaceChildren(musicIcon(path));
      if (changed && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        badge.getAnimations().forEach(animation => animation.cancel());
        badge.animate([{opacity:.25, transform:"scale(.65)"}, {opacity:1, transform:"scale(1.12)", offset:.7}, {opacity:1, transform:"scale(1)"}], {duration:320, easing:"cubic-bezier(.2,.8,.2,1)"});
      }
      badge.setAttribute("aria-label", state); badge.title = state;
    }
    button.classList.toggle("is-selected", source === (selectedSource || active));
    const current = source === active;
    button.classList.toggle("is-current", current);
    button.classList.toggle("is-playing", current && !decks[deckIndex].paused);
    button.classList.toggle("is-next", !current && button.dataset.source === next);
    if (current) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".queue-add").forEach(button => {
    const added = manualQueue.has(button.dataset.source), current = button.dataset.source === active;
    button.setAttribute("aria-disabled", String(added || current));
    button.title = current ? "Now playing" : added ? "Added to queue" : "Add to queue";
    button.classList.toggle("is-added", added);
  });
}
async function smoothPause() {
  wantPlayback = false;
  localPlayPending = localPlay = null;
  const version = ++pauseVersion;
  if (masterGain && audioContext?.state === "running") {
    const now = audioContext.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(0, now + .18);
    await new Promise(resolve => setTimeout(resolve, 190));
  }
  if (version === pauseVersion) decks.forEach(deck => deck.pause());
}
async function safePlay(player) {
  ++pauseVersion;
  if (masterGain) {
    const now = audioContext.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(1, now + .18);
  }
  cueAudio(player);
  try {
    await player.play();
    $("playback-state").textContent = "Playing";
    return true;
  } catch {
    $("playback-state").textContent = "Playback needs a tap. Use Play.";
    return false;
  }
}
decks.forEach((player) => {
  player.addEventListener("loadedmetadata", () => {
    if (player === decks[deckIndex] && startPosition !== null) startPlayback(player);
    else cueAudio(player);
  });
  player.addEventListener("waiting", () => { if (player === decks[deckIndex]) $("playback-state").textContent = "Buffering"; });
  player.addEventListener("playing", () => { if (player === decks[deckIndex]) $("playback-state").textContent = "Playing"; });
  player.addEventListener("pause", () => {
    if (player !== decks[deckIndex]) return;
    // Natural completion can dispatch pause just before the fade timer commits the handoff.
    if (blending && player.ended) return;
    $("playback-state").textContent = "Paused";
    if (blending) {
      ++blendVersion; blending = false; decks[1 - deckIndex].pause();
      gains.forEach((gain, i) => { gain.gain.cancelScheduledValues(audioContext.currentTime); gain.gain.value = i === deckIndex ? 1 : 0; });
    }
  });
  player.addEventListener("error", () => {
    if (player !== decks[deckIndex] || !player.dataset.mediaUrl) return;
    $("playback-state").textContent = "Playback failed. Use Retry playback.";
    $("recovery").hidden = false;
    $("retry").disabled = false;
  });
  player.addEventListener("ended", () => { if (player === decks[deckIndex] && wantPlayback && $("autoplay").checked && !blending) advance(false); });
  player.addEventListener("timeupdate", () => {
    checkBlend();
    if (player === decks[deckIndex] && !blending && !player.paused && currentJob?.playback?.end && player.currentTime >= currentJob.playback.end) {
      if ($("autoplay").checked) advance(false); else player.pause();
    }
  });
});
$("play").addEventListener("click", () => {
  const player = decks[deckIndex];
  if (!player.paused) smoothPause();
  else if (currentTrack) playHere();
  else if (queue[0] || pool[0]) listen(queue[0] || pool[0]);
  else { setView("search"); $("q").focus(); }
});
$("retry").addEventListener("click", () => {
  unlock(); const player = decks[deckIndex], url = player.dataset.mediaUrl;
  if (url) {
    localPlayPending = playbackEpoch;
    wantPlayback = true;
    startPosition ??= player.currentTime;
    delete player.dataset.mediaUrl;
    loadPlayback(player, url, Boolean(currentTrack?.download_url && url === currentTrack.download_url));
  }
  else if (currentTrack) listen(currentTrack);
});
$("cancel").addEventListener("click", async () => {
  if (!statusJob) return;
  try { const data = await api(`/api/jobs/${statusJob.id}/cancel`, { method: "POST", json: {} }); showJob(data.job); }
  catch (err) { $("playback-state").textContent = err.message; }
});

function playHere(local = true) {
  unlock();
  const player = decks[deckIndex];
  if (player.dataset.mediaUrl) {
    if (local && player.paused) localPlayPending = playbackEpoch;
    wantPlayback = true;
    startPlayback(player);
  } else if (currentTrack) listen(currentTrack, true, "queue", local);
}

async function listen(track, keepQueue = false, context = "search", local = true, resume = null) {
  const localEpoch = local ? playbackEpoch : null;
  selectedSource = sourceKey(track);
  updateSongStates();
  unlock();
  if (!resume && queueIdentity(currentTrack) === queueIdentity(track) && currentJob?.media_url) { playHere(local); return; }
  if (!keepQueue) recordSkip();
  const version = ++requestVersion;
  const directUrl = (resume || !track.url) && track.download_url;
  const cached = directUrl ? null : preparedJob(track);
  const loadedIndex = decks.findIndex(deck => cached?.media_url && deck.dataset.mediaUrl === cached.media_url && deck.readyState >= 2);
  if (!keepQueue) {
    if (context !== "recommendations") {
      similarSeed = {...track}; recommendationSeed = ""; ++similarVersion;
      $("similar-panel").hidden = true;
    }
    const list = context === "library" ? [...$("library-list").children].filter(row => !row.hidden).map(row => pool.find(t => sourceKey(t) === row.querySelector(".song-primary").dataset.source)).filter(Boolean) : visibleResults;
    const index = list.findIndex(t => sourceKey(t) === sourceKey(track));
    playbackSearchQuery = context === "search" && $("queue-mode").value === "order" ? searchQuery : null;
    const tail = index >= 0 && (context === "library" || $("queue-mode").value === "order") ? list.slice(index + 1).filter(t => $("queue-mode").value !== "mix" || songRecommendations.similar(similarSeed,t)) : [];
    queue = [...new Map([...queue.filter(t => manualQueue.has(sourceKey(t))), ...tail].filter(t => sourceKey(t) !== sourceKey(track)).map(t => [sourceKey(t), t])).values()];
    for (const previous of list.slice(0, index)) heard.add(previous.url);
  }
  if (!resume && currentTrack && loadedIndex >= 0 && loadedIndex !== deckIndex && !decks[deckIndex].paused && Number($("fade").value) > 0) {
    // A direct selection authorizes this incoming song even with discovery disabled.
    if (!keepQueue) manualQueue.add(sourceKey(track));
    ++blendVersion; blending = false;
    queue = [track, ...queue.filter(t => queueIdentity(t) !== queueIdentity(track))];
    plan = { out:decks[deckIndex].currentTime, in:jobCue(cached), fade:Number($("fade").value), rate:1, mode:"Crossfade" };
    if (local) localPlayPending = localEpoch;
    renderQueue(); checkBlend(true); return;
  }
  if (!decks[deckIndex].paused) {
    if (resume) decks.forEach(deck => deck.pause());
    else await smoothPause();
  }
  if (version !== requestVersion) return;
  localPlayPending = localEpoch;
  wantPlayback = resume?.playing ?? true;
  startPosition = resume?.position ?? null;
  ++blendVersion;
  clearTimeout(timer); plan = null; planKey = ""; blending = false;
  if (loadedIndex >= 0) deckIndex = loadedIndex;
  decks.forEach((deck, i) => {
    deck.pause(); deck.playbackRate = 1;
    if (gains[i]) { gains[i].gain.cancelScheduledValues(audioContext.currentTime); gains[i].gain.value = i === deckIndex ? 1 : 0; }
  });
  const player = decks[deckIndex];
  if (loadedIndex < 0) {
    player.hls?.destroy(); player.hls = null;
    player.removeAttribute("src"); delete player.dataset.mediaUrl; player.load();
  }
  currentJob = cached?.media_url ? cached : null;
  if (!resume && context !== "previous" && currentTrack && queueIdentity(currentTrack) !== queueIdentity(track)) history.push(currentTrack);
  currentTrack = track;
  stalled = false;
  updateNowPlaying();
  if (directUrl) {
    statusJob = null;
    currentJob = {source_id:sourceKey(track), media_url:directUrl, playback:{duration:track.duration}};
    configureAudio(player, currentJob);
    loadPlayback(player, directUrl, true);
    $("recovery").hidden = true;
    $("busy").hidden = true;
    renderQueue(); prepare();
    return true;
  }
  if (cached?.media_url) {
    configureAudio(player, cached);
    if (loadedIndex < 0) loadPlayback(player, cached.media_url);
    else {
      if (!resume) player.currentTime = cached.playback?.start || 0;
      startPlayback(player);
    }
  }
  $("status").hidden = false; $("status-text").textContent = "Preparing playback";
  try {
    const { job } = await api("/api/jobs", { method: "POST", json: { ...track, allow_new: Boolean(resume) || !keepQueue || manualQueue.has(sourceKey(track)) || $("allow-new").checked, generation: Date.now() * 1000 + version } });
    if (version !== requestVersion) return;
    currentJob = job; heard.add(track.url);
    showJob(job); poll(job.id, 0);
    if (!resume) await fillQueue();
    if (version !== requestVersion) return;
    renderQueue(); prepare();
    return true;
  } catch (err) {
    if (version === requestVersion) {
      $("status-text").textContent = resume ? "Could not load this recording. Use Retry playback." : err.message;
      $("recovery").hidden = false;
      $("retry").disabled = false;
      return Boolean(cached?.media_url);
    }
  }
}
function queueIdentity(track) { return track?.playlistEntry || sourceKey(track); }
function pruneQueue() {
  manualQueue.delete(sourceKey(currentTrack));
  const explicit = queue.filter(t => t.playlistEntry || manualQueue.has(sourceKey(t)));
  const automatic = songRecommendations.unique(queue.filter(t => !t.playlistEntry && !manualQueue.has(sourceKey(t)) && !listeningHistory.recent(t) && ($("queue-mode").value !== "mix" || songRecommendations.similar(similarSeed || currentTrack,t))), [currentTrack,...explicit].filter(Boolean));
  queue = [...explicit,...automatic];
  queue = [...new Map(queue.filter((r) => queueIdentity(r) !== queueIdentity(currentTrack)).map((r) => [queueIdentity(r), r])).values()];
}
function renderQueueTimeline() {
  const current = $("queue-current"), previous = $("queue-history-list");
  const tracks = [...history].reverse().concat(listeningHistory.entries().filter(e => e.kind === "played").reverse().map(e => e.track));
  const earlier = [...new Map(tracks.filter(t => t?.url && sourceKey(t)!==sourceKey(currentTrack)).map(t => [sourceKey(t),t])).values()].slice(0,100);
  const key = sourceKey(currentTrack) || "";
  if (current.dataset.source !== key) {
    const focused=current.contains(document.activeElement);
    current.replaceChildren(...(currentTrack ? [songButton(currentTrack)] : [el("p",{class:"note"},"Choose a song to start.")]));
    current.dataset.source=key;
    if(focused) (current.querySelector("button") || $("queue-h")).focus();
  }
  const signature = JSON.stringify(earlier.map(t=>[sourceKey(t),t.title]));
  if (previous.dataset.signature !== signature) {
    const focused=previous.contains(document.activeElement), source=document.activeElement?.dataset.source;
    previous.replaceChildren(...earlier.map(track=>songButton(track)));
    previous.dataset.signature=signature;
    if(focused) ([...previous.children].find(b=>b.dataset.source===source) || $("queue-history").querySelector("summary")).focus();
  }
  $("queue-history-empty").hidden=Boolean(earlier.length);
}
function renderQueue() {
  pruneQueue();
  capturePlaybackQueue();
  queuePlaybackCheckIn();
  renderQueueTimeline();
  updateNext();
  const list = $("queue"), active = document.activeElement;
  const focusedIndex = [...list.children].findIndex((li) => li.contains(active));
  list.replaceChildren(...queue.map((track, i) => {
    const remove = el("button", { type: "button", "aria-label": `Remove ${track.title}` }, "Remove");
    remove.addEventListener("click", () => { manualQueue.delete(sourceKey(track)); queue.splice(i, 1); renderQueue(); prepare(); });
    const play = songButton(track);
    return el("li", {}, play, remove);
  }));
  updateSongStates();
  if (focusedIndex >= 0) (list.children[Math.min(focusedIndex, list.children.length - 1)]?.querySelector("button") || $("next")).focus();
}
async function prepare() {
  const version = ++prepareVersion;
  const wanted = queue.slice(0, 6).map(t => ({...t, requested:manualQueue.has(sourceKey(t))}));
  try {
    const { jobs } = await api("/api/queue", { method: "POST", json: {
      tracks: wanted, previews: $("search-previews").checked ? searchPreviewTracks : [],
      allow_new: $("allow-new").checked, preload_search:$("search-previews").checked, generation: Date.now() * 1000 + version } });
    if (version !== prepareVersion) return;
    prepared = new Map(jobs.map((j) => [j.source_id, j]));
    jobs.forEach(rememberSaved); updateSongStates();
    $("queue-state").textContent = jobs.length ? "Preparing next recording and up to five following recordings." : "Local mode prepares saved recordings only.";
    preload();
  } catch (err) { if (version === prepareVersion) $("queue-state").textContent = err.message; }
}
function upcoming() { return queue[0] && preparedJob(queue[0]); }
const jobCue = (job) => job?.playback?.start || 0;
function transitionKey() {
  return `${currentJob?.id}/${upcoming()?.id}/${$("fade").value}/${$("dj").checked}/${Boolean(upcoming()?.analysis)}/${Boolean(currentJob?.analysis)}/${currentJob?.playback?.end}/${jobCue(upcoming())}`;
}
function preload() {
  window.MusicPrefixCache?.warm([
    preparedJob(queue[0]),
    ...($("search-previews").checked ? searchPreviewTracks.map(preparedJob) : []),
    ...queue.slice(1, 6).map(preparedJob)
  ]);
  const job = upcoming();
  if (failedPreparation(job)) {
    plan = null; planKey = "";
    $("queue-state").textContent = "Next song could not prepare. Choose a song or retry it.";
    return;
  }
  if (job?.media_url && !blending) { configureAudio(decks[1 - deckIndex], job); attach(decks[1 - deckIndex], job.media_url); }
  const key = transitionKey();
  if (currentJob && job?.media_url && key !== planKey && !planPending) {
    planPending = true;
    const currentId = currentJob.id, nextId = job.id, version = requestVersion;
    api("/api/transition", { method: "POST", json: { current: currentJob.id, next: job.id,
      fade: Number($("fade").value), dj: $("dj").checked, current_rate: decks[deckIndex].playbackRate } }).then((data) => {
      if (version !== requestVersion || currentId !== currentJob?.id || nextId !== upcoming()?.id || key !== transitionKey() || failedPreparation(upcoming())) return;
      plan = data.plan; planKey = key;
      $("mix-state").textContent = plan.mode === "Beat blend" ? "Beat blend. Phrase and downbeat alignment are unknown." : "Crossfade";
      checkBlend();
    }).catch(() => { plan = null; }).finally(() => {
      planPending = false;
      if (key !== transitionKey()) preload();
    });
  }
}
setInterval(async () => {
  if (!queue.length && !searchPreviewTracks.length) return;
  try {
    const { jobs } = await api("/api/jobs");
    if (jobs.map(rememberSaved).some(Boolean)) loadLibrary();
    jobs.forEach((j) => { if (j.priority > 0) prepared.set(j.source_id, j); if (j.id === currentJob?.id) { currentJob = j; configureAudio(decks[deckIndex], j); } });
    updateSongStates();
    preload();
  } catch { /* current playback retains its source during a status outage */ }
}, 2000);

function related(seed, candidates) {
  const artist = artistName(seed);
  const remaining = candidates.map((r) => {
    let score = (artist && artistName(r) === artist ? 8 : 0) + listeningHistory.affinity(r);
    if (seed?.genre && r.genre && seed.genre.toLocaleLowerCase() === r.genre.toLocaleLowerCase()) score += 4;
    if (seed?.key && r.key && seed.key === r.key) score += 1;
    if (history.slice(-5).some((h) => h.channel === r.channel)) score -= 2;
    if (history.slice(-10).some((h) => h.url === r.url)) score -= 6;
    if (skipped.includes(r.url)) score -= 12;
    const a = currentJob?.analysis, b = prepared.get(r.id)?.analysis;
    if (a?.reliable && b?.reliable && Math.abs(a.bpm / b.bpm - 1) <= .06) score += 3;
    return { r, score };
  });
  const ordered = [], counts = new Map();
  while (remaining.length) {
    const adjusted = ({ r, score }) => score - (counts.get(r.channel) || 0) * 3;
    remaining.sort((a, b) => adjusted(b) - adjusted(a) || a.r.url.localeCompare(b.r.url));
    const { r } = remaining.shift(); ordered.push(r); counts.set(r.channel, (counts.get(r.channel) || 0) + 1);
  }
  return ordered;
}
function shuffled(candidates, random = Math.random) {
  const list = [...candidates];
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}
let advancing = false;
async function advance(manual = false, local = manual) {
  if (advancing) return;
  advancing = true;
  try {
    unlock();
    if (!manual && failedPreparation(upcoming())) { preload(); return; }
    if (manual) recordSkip();
    if (manual && currentTrack) skipped = [...skipped.slice(-19), currentTrack.url];
    const version = requestVersion;
    await fillQueue();
    if (version !== requestVersion) return;
    const next = queue.shift();
    if (next) await listen(next, true, "queue", local);
    else {
      renderQueue();
      $("queue-state").textContent = "Queue is empty.";
    }
  } finally { advancing = false; }
}
function artistName(track) { return songRecommendations.identity(track).artist; }
function eligibleAutoplay(candidates) {
  return songRecommendations.unique(candidates.filter(t => !listeningHistory.recent(t)), [currentTrack,...queue].filter(Boolean));
}
let recommendationSeed = "";
let similarSeed = null, similarVersion = 0;
async function discoverSimilar(seed) {
  const artist=artistName(seed).slice(0,120);
  if (!artist) return [];
  const data=await api("/api/recommendations", {method:"POST", json:{query:artist + " official audio", seed_artist:artist}});
  if ((!seed.genre || seed.genre === "Unsorted") && data.seed_genre && data.seed_genre !== "Unsorted") seed.genre=data.seed_genre;
  return songRecommendations.unique(data.results.filter(t=>songRecommendations.similar(seed,t)),[seed]);
}
$("recommend-similar").addEventListener("click", async () => {
  setView("queue");
  const panel=$("similar-panel"), status=$("similar-status"), list=$("similar-results");
  panel.hidden=false;
  if (!currentTrack) { status.textContent="Play a song to find similar recordings."; return; }
  const version=++similarVersion;
  const seed=similarSeed={...currentTrack}; recommendationSeed="";
  panel.setAttribute("aria-busy","true");
  list.replaceChildren(); status.textContent="Finding songs similar to " + seed.title + "…";
  try {
    const found=await discoverSimilar(seed);
    if(version!==similarVersion)return;
    const candidates=songRecommendations.unique([...found,...pool].filter(t=>songRecommendations.similar(seed,t)),[seed]);
    list.replaceChildren(...related(seed,candidates).map(t=>searchRow(t,"recommendations")));
    updateSongStates();
    status.textContent=candidates.length ? "Based on " + seed.title + ". Playing or queueing a new recording downloads it to the server." : "No similar recordings found. Try again after genre labels have loaded.";
  } catch(error) { if(version===similarVersion)status.textContent=error.message; }
  finally { if(version===similarVersion)panel.setAttribute("aria-busy","false"); }
});
async function fillQueue() {
  const version = requestVersion;
  pruneQueue();
  const anchor = similarSeed || currentTrack || recentSeed;
  const seed = artistName(anchor);
  if (seed && recommendationSeed !== seed && $("autoplay").checked && $("allow-new").checked && $("queue-mode").value === "mix") {
    recommendationSeed = seed;
    try {
      const results = await discoverSimilar(anchor);
      if (version !== requestVersion || anchor !== (similarSeed || currentTrack || recentSeed)) return;
      const discovered = eligibleAutoplay(results).filter(t => !heard.has(t.url));
      pool = [...new Map([...pool, ...discovered].map(t => [sourceKey(t), t])).values()];
      queue = [...new Map([...queue, ...related(anchor, discovered)].map(t => [sourceKey(t), t])).values()].slice(0,Math.max(10, queue.length));
    } catch { if(version===requestVersion)recommendationSeed=""; }
  }
  if (queue.length < 10 && $("autoplay").checked) {
    const eligible = [...new Map([...pool, ...visibleResults].map((r) => [r.url, r])).values()]
      .filter((r) => (!r.duration || r.duration < 1800) && ($("allow-new").checked || r.saved) && !queue.some((q) => sourceKey(q) === sourceKey(r)));
    let candidates = eligibleAutoplay(eligible).filter((r) => !heard.has(r.url));
    if ($("queue-mode").value !== "mix" && !queue.length && !candidates.length && $("allow-new").checked && currentTrack?.channel) {
      try { candidates = (await api("/api/search", { method: "POST", json: { query: currentTrack.channel + " audio" } })).results.filter((r) => r.url !== currentTrack.url); pool.push(...candidates); }
      catch (err) { $("queue-state").textContent = err.message; }
    }
    if ($("queue-mode").value === "shuffle") {
      candidates = shuffled(candidates);
    } else if ($("queue-mode").value === "mix") candidates = related(anchor, candidates.filter(t=>songRecommendations.similar(anchor,t)));
    if (version !== requestVersion || anchor !== (similarSeed || currentTrack || recentSeed)) return;
    candidates = eligibleAutoplay(candidates);
    queue.push(...candidates.slice(0, Math.max(0, 10 - queue.length)));
  }
}
$("next").addEventListener("click", () => advance(true));
function previousTrack(local = true) {
  const previous = history.pop(); if (!previous) return;
  if (currentTrack) queue.unshift(currentTrack);
  listen(previous, true, "previous", local);
}
$("previous").addEventListener("click", () => previousTrack());
$("library").addEventListener("click", async () => {
  try {
    const { results, genres = [], genre_keys = {} } = await api("/api/library?genre_filters=1"); pool = results;
    const additions = results.filter((r) => r.url !== currentTrack?.url).slice(0, Math.max(0, 30 - queue.length));
    additions.forEach(track=>manualQueue.add(sourceKey(track)));
    queue.push(...additions);
    renderQueue(); await prepare();
  } catch (err) { $("queue-state").textContent = err.message; }
});
for (const id of ["allow-new", "search-previews", "autoplay", "queue-mode", "fade", "dj"]) $(id).addEventListener("change", async () => {
  unlock(); planKey = ""; plan = null; await fillQueue(); renderQueue(); prepare();
});
$("fade").addEventListener("input", () => { plan = null; planKey = ""; preload(); });

async function checkBlend(manual = false) {
  const outgoing = decks[deckIndex], next = upcoming();
  if (blending || (!manual && !$("autoplay").checked) || outgoing.paused || !plan?.fade || !next?.media_url || outgoing.currentTime < plan.out) return;
  if (gains.length !== 2 || audioContext?.state !== "running") {
    $("mix-state").textContent = "Mixing needs an active audio session. Use Play; tracks otherwise play separately.";
    return;
  }
  const oldIndex = deckIndex, nextIndex = 1 - oldIndex, incoming = decks[nextIndex];
  if (incoming.readyState < 2) return;
  const version = requestVersion, blendId = ++blendVersion, activePlan = { ...plan }, nextTrack = queue[0];
  // Seeking into the overlap starts the next song at its cue, with only the remaining time available.
  const end = currentJob?.playback?.end || currentTrack?.duration || outgoing.duration;
  const remaining = (end - outgoing.currentTime) / outgoing.playbackRate;
  if (!Number.isFinite(remaining) || remaining <= .15) return;
  activePlan.fade = Math.min(activePlan.fade, remaining);
  blending = true;
  if (!("preservesPitch" in incoming) && activePlan.rate !== 1) {
    activePlan.rate = 1; activePlan.in = jobCue(next); activePlan.mode = "Crossfade";
  }
  incoming.preservesPitch = true; incoming.playbackRate = activePlan.rate;
  configureAudio(incoming, next);
  incoming.currentTime = activePlan.in; incoming.dataset.cued = "true";
  if (!(await safePlay(incoming))) { blending = false; return; }
  if (version !== requestVersion || blendId !== blendVersion) return;
  // A fulfilled play() is not evidence that decoded audio is progressing after a seek.
  const cue = incoming.currentTime, deadline = performance.now() + 4000;
  while (incoming.currentTime < cue + .04 || incoming.readyState < 3 || incoming.seeking) {
    if (version !== requestVersion || blendId !== blendVersion) return;
    if (performance.now() > deadline || incoming.dataset.failed) {
      incoming.pause(); blending = false;
      if (outgoing.ended) advance();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  // Keep the ramp within the outgoing audio remaining after media-element startup.
  activePlan.fade = Math.min(activePlan.fade, Math.max(.05, (end - outgoing.currentTime) / outgoing.playbackRate));
  const now = audioContext.currentTime;
  gains[oldIndex].gain.cancelScheduledValues(now); gains[nextIndex].gain.cancelScheduledValues(now);
  const fadeStart = incoming.currentTime;
  function finishFade() {
    if (version !== requestVersion || blendId !== blendVersion) return;
    gains[oldIndex].gain.cancelScheduledValues(audioContext.currentTime); gains[oldIndex].gain.value = 0;
    gains[nextIndex].gain.cancelScheduledValues(audioContext.currentTime); gains[nextIndex].gain.value = 1;
    deckIndex = nextIndex;
    outgoing.pause();
    if (outgoing === document.activeElement) $("play").focus();
    outgoing.hidden = true; incoming.hidden = false;
    history.push(currentTrack);
    const queuedIndex = queue.indexOf(nextTrack); if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    currentTrack = nextTrack; heard.add(currentTrack.url);
    stalled = incoming.readyState < 3;
    markPlaybackStarted();
    updateNowPlaying();
    currentJob = next; plan = null; planKey = ""; blending = false;
    showJob(next);
    // Promote before queue reconciliation: otherwise removal from the queue can cancel the audible job.
    api("/api/jobs", { method: "POST", json: { ...currentTrack, allow_new: manualQueue.has(sourceKey(currentTrack)) || $("allow-new").checked } }).then(async ({job}) => {
      if (version !== requestVersion || currentJob?.id !== next.id) return;
      currentJob = job; poll(job.id, 0, version);
      await fillQueue(); renderQueue(); prepare();
    }).catch((err) => { $("status-text").textContent = err.message; });
  }
  function ramp() {
    if (version !== requestVersion || blendId !== blendVersion) return;
    if (incoming.dataset.failed) {
      blending = false; incoming.pause();
      gains[oldIndex].gain.value = 1; gains[nextIndex].gain.value = 0;
      $("playback-state").textContent = "Next song stopped buffering. Use Next to retry it.";
      return;
    }
    const progressing = incoming.readyState >= 3 && !incoming.seeking && !incoming.paused;
    const fraction = progressing ? Math.min(1, (incoming.currentTime - fadeStart) / incoming.playbackRate / activePlan.fade) : 0;
    gains[oldIndex].gain.setTargetAtTime(1 - fraction, audioContext.currentTime, .015);
    gains[nextIndex].gain.setTargetAtTime(fraction, audioContext.currentTime, .015);
    if (fraction >= 1) { finishFade(); return; }
    setTimeout(ramp, 40);
  }
  ramp();
}

// Navigation never replaces either audio deck.
const viewSections = {library:"library-view", search:"pick", queue:"queue-view", settings:"settings-view"};
function setView(view) {
  const active = document.activeElement;
  const changed = document.body.dataset.view !== view;
  let moved = false;
  for(const [key,id] of Object.entries(viewSections)) {
    const shown = key === view;
    if(!shown && $(id).contains(active)) moved = true;
    $(id).hidden = !shown;
    const nav = $("nav-"+key);
    if (nav) { nav.toggleAttribute("data-active", key === view);
      if(key === view) nav.setAttribute("aria-current","page"); else nav.removeAttribute("aria-current"); }
  }
  document.body.dataset.view = view;
  $("view-title").textContent = {library:"Library",search:"Search",queue:"Queue",settings:"Settings"}[view];
  if(moved) $(view === "queue" ? "queue-h" : "view-title").focus();
  if(changed) {
    $("content").scrollTop = 0;
    document.querySelector(".workspace").scrollTop = 0;
  }
  if (view === "search") {
    scheduleVisiblePreviews();
    if (searchDirty && $("q").value.trim()) { searchDirty = false; $("search-form").requestSubmit(); }
  }
}
for(const view of Object.keys(viewSections)) $("nav-"+view)?.addEventListener("click",()=>setView(view));
$("find-music").addEventListener("click",()=>{setView("search");$("q").focus();});
$("show-queue").addEventListener("click",()=>{renderQueue();setView("queue");$("content").scrollTop=0;$("queue-h").focus({preventScroll:true});});
let libraryFingerprint = "";
let libraryGenre = "", searchDirty = false;
let genreOptions = [], genreAliases = new Map();
const genreSearch = $("library-genre-search");
function chooseLibraryGenre(key, syncInput = true) {
  libraryGenre = key;
  if (syncInput) genreSearch.value = genreOptions.find(genre => genre.key === key)?.label || "";
  $("clear-library-genre").hidden = !genreSearch.value && !libraryGenre;
  filterLibrary();
}
function updateGenreControls(genres) {
  genres.sort((a,b) => a.label.localeCompare(b.label));
  if (JSON.stringify(genres) === JSON.stringify(genreOptions)) return;
  genreOptions = genres;
  const controls = $("library-genres");
  const focused = controls.contains(document.activeElement) ? document.activeElement.dataset.genre : null;
  const preserveText = [genreSearch, $("clear-library-genre")].includes(document.activeElement);
  $("library-genre-options").replaceChildren(...genres.map(genre => el("option", {value:genre.label})));
  const top = genres.filter(genre => genre.key !== "unsorted" && genre.plays > 0).sort((a,b) => b.plays - a.plays).slice(0, 8);
  controls.hidden = top.length === 0;
  controls.replaceChildren(...top.map(genre => {
    const button = el("button", {type:"button", "data-genre":genre.key, "aria-pressed":String(genre.key === libraryGenre)}, genre.label);
    button.addEventListener("click", () => chooseLibraryGenre(libraryGenre === genre.key ? "" : genre.key));
    return button;
  }));
  chooseLibraryGenre(genres.some(genre => genre.key === libraryGenre) ? libraryGenre : "", !preserveText);
  if (focused !== null) ([...controls.children].find(button => button.dataset.genre === focused) || genreSearch).focus();
}

function pickTypedGenre(allowAlias = false) {
  const input = genreSearch.value.trim().toLocaleLowerCase();
  if (!input) return chooseLibraryGenre("");
  const match = genreOptions.find(genre => genre.label.toLocaleLowerCase() === input);
  const key = match?.key ?? (allowAlias ? genreAliases.get(input) : null);
  if (key) chooseLibraryGenre(key);
}
genreSearch.addEventListener("input", () => {
  $("clear-library-genre").hidden = !genreSearch.value && !libraryGenre;
  pickTypedGenre();
});
$("library-genre-form").addEventListener("submit", event => {
  event.preventDefault();
  pickTypedGenre(true);
  if (matchMedia("(max-width:720px)").matches) $("view-title").focus();
});
$("clear-library-genre").addEventListener("click", () => {
  genreSearch.focus();
  chooseLibraryGenre("");
});
async function loadLibrary() {
  $("library-error").textContent = "";
  try {
    const { results, genres = [], genre_keys = {} } = await api("/api/library?genre_filters=1");
    results.forEach(t => savedSources.add(sourceKey(t)));
    pool = [...new Map([...pool, ...results].map((r) => [sourceKey(r), r])).values()];
    const list = $("library-list"), active = document.activeElement;
    const index = [...list.children].findIndex((row) => row.contains(active));
    const fingerprint = JSON.stringify(results);
    updateSongStates();
    genreAliases = new Map(Object.entries(genre_keys).map(([label, key]) => [label.trim().toLocaleLowerCase(), key]));
    updateGenreControls(genres);
    if(fingerprint === libraryFingerprint) return;
    libraryFingerprint = fingerprint;
    list.replaceChildren(...results.map(track => el("article", {class:"library-record", "data-artist":track.channel || track.artist || "Unknown artist", "data-genre":genre_keys[track.genre || ""] || "unsorted"}, songButton(track, "library"))));
    updateSongStates();
    if (index >= 0) (list.children[Math.min(index, list.children.length - 1)]?.querySelector("button") || $("refresh-library")).focus();
    $("library-count").textContent = results.length + (results.length === 1 ? " recording" : " recordings");
    $("library-empty").hidden = Boolean(results.length);
    const selected = $("library-artist").value;
    const artists = [...new Set(results.map(t => t.channel || t.artist || "Unknown artist"))].sort((a,b) => a.localeCompare(b));
    $("library-artist").replaceChildren(el("option", {value:""}, "All artists"), ...artists.map(a => el("option", {value:a}, a)));
    $("library-artist").value = artists.includes(selected) ? selected : "";
    filterLibrary();
    if (!currentTrack && !queue.length) { await fillQueue(); renderQueue(); prepare(); }
  } catch (err) {
    $("library-count").textContent = "";
    $("library-error").textContent = err.message + " Use Refresh to try again.";
  }
}
function filterLibrary() {
  const artist = $("library-artist").value;
  const query = $("library-filter").value.trim().toLocaleLowerCase();
  const rows = [...$("library-list").children];
  rows.forEach(row => { row.hidden = Boolean(artist && row.dataset.artist !== artist || libraryGenre && row.dataset.genre !== libraryGenre || query && !row.textContent.toLocaleLowerCase().includes(query)); });
  for (const button of $("library-genres").children) button.setAttribute("aria-pressed", String(button.dataset.genre === libraryGenre));
  const count = rows.filter(row => !row.hidden).length;
  $("library-count").textContent = count + (count === 1 ? " recording" : " recordings");
}
$("library-artist").addEventListener("change", filterLibrary);
$("library-filter").addEventListener("input", filterLibrary);
$("refresh-library").addEventListener("click", loadLibrary);
try { $("include-long-mixes").checked = localStorage.getItem("music:include-long-mixes") === "true"; } catch {}
$("include-long-mixes").addEventListener("change", () => {
  try { localStorage.setItem("music:include-long-mixes", String($("include-long-mixes").checked)); } catch {}
  searchDirty = true;
});

function updateNowPlaying() {
  capturePlaybackQueue();
  queuePlaybackCheckIn();
  renderQueueTimeline();
  if (currentTrack) {
    recentSeed = {title:currentTrack.title || "", channel:currentTrack.channel || currentTrack.artist || ""};
    try { localStorage.setItem("music:last-track", JSON.stringify(recentSeed)); } catch {}
  }
  updateSongStates();
  $("now-cover").replaceChildren(cover(currentTrack));
  $("rail-cover").replaceChildren(cover(currentTrack));
  $("rail-title").textContent = currentTrack?.title || "Choose a song";
  $("rail-artist").textContent = currentTrack?.channel || currentTrack?.artist || "";
  $("now-title").textContent = currentTrack?.title || "Choose a song";
  $("now-artist").textContent = currentTrack?.channel || currentTrack?.artist || "";
  updateTransport();
  if ("mediaSession" in navigator && window.MediaMetadata && currentTrack) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: currentTrack.title, artist: currentTrack.channel || currentTrack.artist || "" });
  }
}
function updateTransport() {
  const player = decks[deckIndex], total = currentJob?.playback?.duration || currentTrack?.duration || player.duration;
  updateSongStates();
  if ($("play").dataset.paused !== String(player.paused)) {
    $("play").replaceChildren(musicIcon(player.paused ? "M8 5l11 7-11 7z" : "M5 3h5v18H5zM14 3h5v18h-5z"));
    $("play").dataset.paused = String(player.paused);
  }
  $("play").setAttribute("aria-label", player.paused ? "Play" : "Pause");
  $("play").setAttribute("aria-busy", String(Boolean(currentTrack && (!player.dataset.mediaUrl || (!player.paused && player.readyState < 3)))));
  $("elapsed").textContent = duration(player.currentTime) || "0:00";
  $("total").textContent = duration(total) || "0:00";
  $("seek").disabled = !Number.isFinite(total) || total <= 0 || blending;
  if (Number.isFinite(total) && total > 0) {
    $("seek").max = total;
    if (!seekingPointer) $("seek").value = player.currentTime;
  }
}
for (const player of decks) for (const event of ["timeupdate", "play", "pause", "loadedmetadata", "durationchange", "ended", "waiting", "canplay"]) player.addEventListener(event, updateTransport);
$("seek").addEventListener("pointerdown", () => { seekingPointer = true; });
for (const event of ["pointerup", "pointercancel"]) window.addEventListener(event, () => {
  if (seekingPointer) { seekingPointer = false; updateTransport(); }
});
$("seek").addEventListener("blur", () => { seekingPointer = false; updateTransport(); });
$("seek").addEventListener("input", () => { decks[deckIndex].currentTime = Number($("seek").value); });
$("volume").addEventListener("input", () => { for (const deck of decks) deck.volume = Number($("volume").value); });
function updateShuffle() { $("shuffle-toggle").setAttribute("aria-pressed", String($("queue-mode").value === "shuffle")); }
$("shuffle-toggle").addEventListener("click", () => {
  $("queue-mode").value = $("queue-mode").value === "shuffle" ? "order" : "shuffle";
  if ($("queue-mode").value === "shuffle") { queue = shuffled(queue); renderQueue(); }
  $("queue-mode").dispatchEvent(new Event("change"));
});
$("queue-mode").addEventListener("change", updateShuffle);
for (const id of ["allow-new", "search-previews", "autoplay", "queue-mode", "fade", "dj", "volume"]) {
  try {
    const value = localStorage.getItem("music:" + id);
    if (value !== null) {
      if ($(id).type === "checkbox") $(id).checked = value === "true";
      else if ($(id).type === "select-one") { if ([...$(id).options].some((o) => o.value === value)) $(id).value = value; }
      else if (Number.isFinite(Number(value)) && Number(value) >= Number($(id).min) && Number(value) <= Number($(id).max)) $(id).value = value;
    }
  } catch { /* Playback works when browser storage is disabled. */ }
  $(id).addEventListener("change", () => { try { localStorage.setItem("music:" + id, $(id).type === "checkbox" ? $(id).checked : $(id).value); } catch {} });
}
for (const deck of decks) deck.volume = Number($("volume").value);
updateShuffle(); updateTransport(); loadLibrary();
let rememberedFade = Number($("fade").value) || 4;
$("fade-enabled").checked = Number($("fade").value) > 0;
$("fade-enabled").addEventListener("change", () => {
  if (!$("fade-enabled").checked) rememberedFade = Number($("fade").value) || rememberedFade;
  $("fade").value = $("fade-enabled").checked ? rememberedFade : 0;
  $("fade").dispatchEvent(new Event("input"));
  $("fade").dispatchEvent(new Event("change"));
});
$("fade").addEventListener("input", () => { $("fade-enabled").checked = Number($("fade").value) > 0; });
if ("mediaSession" in navigator) {
  for (const [action, fn] of Object.entries({ play: () => playHere(), pause: () => smoothPause(), nexttrack: () => advance(true), previoustrack: () => previousTrack() })) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

function updateNext() {
  updateSongStates();
  const track = queue[0], job = preparedJob(track);
  $("next-title").textContent = track?.title || ($("autoplay").checked ? "No song queued" : "Autoplay is off");
  $("next-artist").textContent = track?.channel || track?.artist || "";
  if ($("next-cover").dataset.source !== (sourceKey(track) || "")) {
    $("next-cover").dataset.source = sourceKey(track) || "";
    $("next-cover").replaceChildren(cover(track));
  }
  $("next-readiness").textContent = !track ? "" : failedPreparation(job) ? "Preparation failed" : job?.media_url ? "Ready to play" : "Preparing audio";
  $("bar-next").textContent = track ? "Up next · " + track.title : "Up next · " + ($("autoplay").checked ? "No song queued" : "Autoplay off");
}
setInterval(updateNext, 1000);
setInterval(()=>{if(!document.hidden) loadLibrary();}, 15000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden) loadLibrary();});

function closeProfile(restore=false) {
  $("profile-menu").hidden = true;
  $("profile-toggle").setAttribute("aria-expanded", "false");
  if (restore) $("profile-toggle").focus();
}
$("profile-toggle").addEventListener("click", () => {
  const open = $("profile-menu").hidden;
  $("profile-menu").hidden = !open;
  $("profile-toggle").setAttribute("aria-expanded", String(open));
});
$("nav-settings").addEventListener("click", () => { closeProfile(); $("view-title").focus(); });
document.addEventListener("keydown", e => { if(e.key === "Escape" && !$("profile-menu").hidden) { e.preventDefault(); closeProfile(true); } });
document.addEventListener("click", e => { if(!$("profile-menu").contains(e.target) && !$("profile-toggle").contains(e.target)) closeProfile(); });

async function moreSearch() {
  if (searchLoading || searchOffset === null) return;
  searchLoading = true;
  const version = searchVersion;
  $("load-more-search").disabled = true;
  try {
    const {results, next_offset} = await api("/api/search", {method:"POST", json:{query:searchQuery, offset:searchOffset, include_long:$("include-long-mixes").checked}});
    if (version !== searchVersion) return;
    const fresh = results.filter(t => !visibleResults.some(v => sourceKey(v) === sourceKey(t)));
    visibleResults.push(...fresh);
    $("results").append(...fresh.map(searchRow));
    if (playbackSearchQuery === searchQuery && currentTrack) { queue.push(...fresh.filter(t => !heard.has(t.url) && !queue.some(q => sourceKey(q) === sourceKey(t)))); renderQueue(); }
    scheduleVisiblePreviews();
    searchOffset = next_offset ?? null;
    if (searchOffset === null && document.activeElement === $("load-more-search")) $("results").lastElementChild?.querySelector("button")?.focus();
    $("load-more-search").hidden = searchOffset === null;
    $("search-status").textContent = visibleResults.length + " songs";
    updateSongStates();
    requestAnimationFrame(() => {
      if (version === searchVersion && document.body.dataset.view === "search" && searchOffset !== null && $("load-more-search").getBoundingClientRect().top < $("content").getBoundingClientRect().bottom + 100) moreSearch();
    });
  } catch(e) { $("search-status").textContent = e.message; $("search-status").classList.add("is-error"); }
  finally { searchLoading = false; $("load-more-search").disabled = false; }
}
$("load-more-search").addEventListener("click", moreSearch);
if ("IntersectionObserver" in window) new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting) && document.body.dataset.view === "search") moreSearch();
}, {root:$("content"), rootMargin:"100px"}).observe($("load-more-search"));

// Size ten desktop search rows to the actual scroll viewport; mobile keeps touch-sized rows.
new ResizeObserver(([entry]) => {
  $("pick").style.setProperty("--search-row-height", Math.max(56, entry.contentRect.height / 10) + "px");
}).observe($("content"));

// Count actual playback progression; seeking forward does not count as listening.
for (const deck of decks) deck.addEventListener("timeupdate", () => {
  if (deck !== decks[deckIndex] || !currentTrack) return;
  const source=sourceKey(currentTrack), time=deck.currentTime;
  if (listeningSample.source !== source) listeningSample={source,time,seconds:0,saved:false};
  const delta=time-listeningSample.time; listeningSample.time=time;
  if (!deck.paused && !deck.seeking && delta>0 && delta<2) listeningSample.seconds+=delta;
  const threshold=Math.min(30,(currentTrack.duration || 300)*.8);
  if (!listeningSample.saved && listeningSample.seconds>=threshold) {listeningHistory.record(currentTrack,"played");listeningSample.saved=true;}
});
$("clear-history").addEventListener("click", () => {
  listeningHistory.clear(); heard.clear(); skipped=[]; recommendationSeed="";
  listeningSample={source:sourceKey(currentTrack),time:decks[deckIndex].currentTime,seconds:0,saved:false};
  history=[]; renderQueueTimeline();
  capturePlaybackQueue();
  queuePlaybackCheckIn();
  $("history-status").textContent="Listening history cleared.";
});

// Device ownership and queue snapshots travel with the existing playback heartbeat.
const recordingId = /^(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})$/;
const deviceKey = "music:playback-device:" + document.body.dataset.user;
let deviceId, sequence = 0, queueRev = 0;
try {
  const saved = JSON.parse(sessionStorage.getItem(deviceKey));
  if (/^[a-f0-9]{32}$/.test(saved?.id)) {
    deviceId = saved.id;
    sequence = saved.sequence || 0;
    queueRev = saved.queueRev || 0;
  }
} catch { /* A storage-disabled tab can still check in. */ }
const newDeviceId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
deviceId ||= newDeviceId();
const ua = navigator.userAgent;
const [deviceKind, deviceName] = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? ["ipad", "iPad"]
  : /iPhone|iPod/.test(ua) ? ["iphone", "iPhone"]
  : /Android/.test(ua) ? ["android", "Android browser"]
  : /Windows/.test(ua) ? ["windows", "Windows browser"]
  : /Macintosh/.test(ua) ? ["mac", "Mac browser"] : ["other", "Web browser"];
const onlineSeconds = 15;
let playbackEpoch = 0, sentQueueRev = 0, queueSignature = "", queueSnapshot = null;
let checkingIn = false, checkInQueued = false, localPlayPending = null, localPlay = null, stalled = false;
let deviceReady = false, deviceRegistered = false, ownsPlayback = false, remoteOwner = null;
const handledCommands = new Set(), pendingAcks = new Set();

function rememberPlaybackCommand(id) {
  handledCommands.add(id);
  if (handledCommands.size > 64) handledCommands.delete(handledCommands.values().next().value);
}
function queuePlaybackCheckIn() {
  if (checkInQueued) return;
  checkInQueued = true;
  queueMicrotask(checkIn);
}
function markPlaybackStarted() {
  if (localPlayPending !== null) localPlay = localPlayPending;
  localPlayPending = null;
  queuePlaybackCheckIn();
}
function capturePlaybackQueue() {
  const currentId = sourceKey(currentTrack);
  if (!recordingId.test(currentId)) {
    if (!queueSnapshot?.track_ids.length) return;
    queueSnapshot = {track_ids:[], index:-1};
    queueSignature = JSON.stringify(queueSnapshot);
    ++queueRev;
    return;
  }
  const after = queue.map(sourceKey).filter(id => recordingId.test(id)).slice(0, 999);
  const before = history.slice(-999).map(sourceKey).filter(id => recordingId.test(id));
  before.splice(0, Math.max(0, before.length + after.length - 999));
  const snapshot = {track_ids:[...before, currentId, ...after], index:before.length};
  const signature = JSON.stringify(snapshot);
  if (signature === queueSignature) return;
  queueSignature = signature;
  queueSnapshot = snapshot;
  ++queueRev;
}
function playbackSnapshot() {
  const player = decks[deckIndex], currentId = sourceKey(currentTrack);
  const status = player.paused || player.ended ? "paused"
    : stalled || player.seeking || player.readyState < 3 ? "buffering" : "playing";
  const total = currentJob?.playback?.duration || currentTrack?.duration || player.duration;
  const clean = (value, limit) => String(value || "").replace(/[\x00-\x1f]/g, " ").slice(0, limit);
  const track = recordingId.test(currentId) ? {
    id:currentId, title:clean(currentTrack.title, 500), channel:clean(currentTrack.channel || currentTrack.artist, 300)
  } : null;
  return {
    device_id:deviceId, playing:status !== "paused", track,
    position:track ? Math.min(86400, Math.max(0, startPosition ?? player.currentTime)) : null,
    device_info:{
      name:deviceName, kind:deviceKind, sequence:++sequence, epoch:localPlay ?? playbackEpoch,
      local_play:localPlay !== null && status !== "paused", status, queue_rev:queueRev,
      ...(Number.isFinite(total) && total > 0 ? {duration:Math.min(86400, total)} : {}),
      ...(queueSnapshot && queueRev !== sentQueueRev ? {queue:queueSnapshot} : {}),
      ...(pendingAcks.size ? {acks:[...pendingAcks]} : {})
    }
  };
}
async function checkIn() {
  if (!deviceReady || checkingIn || !checkInQueued) return;
  checkInQueued = false;
  checkingIn = true;
  const json = playbackSnapshot(), info = json.device_info;
  localPlay = null;
  try { sessionStorage.setItem(deviceKey, JSON.stringify({id:deviceId, sequence, queueRev})); } catch {}
  try {
    const {epoch, command, controls} = await api("/api/playback/activity", {method:"POST", json});
    if (!deviceRegistered) {
      deviceRegistered = true;
      renderRemotePlayback();
    }
    const restarted = Number.isSafeInteger(epoch) && epoch < playbackEpoch;
    if (Number.isSafeInteger(epoch)) playbackEpoch = epoch;
    if (info.queue) sentQueueRev = info.queue_rev;
    if (restarted) { sentQueueRev = 0; ownsPlayback = false; checkInQueued = true; }
    if (info.local_play && Number.isSafeInteger(epoch) && epoch > info.epoch && !command) {
      ownsPlayback = true;
      remoteOwner = null;
    } else if (command?.action === "pause" || (Number.isSafeInteger(epoch) && epoch > info.epoch && !command)) {
      ownsPlayback = false;
    }
    for (const id of info.acks || []) pendingAcks.delete(id);
    if (command?.action === "pause") {
      const retained = command.id && !command.id.startsWith("active-");
      if (!retained || !handledCommands.has(command.id)) {
        applyPlaybackPause(command);
        if (retained) rememberPlaybackCommand(command.id);
      }
      if (retained) pendingAcks.add(command.id);
      checkInQueued = true;
    } else if (command?.action === "play" && command.id && command.resume && !handledCommands.has(command.id)) {
      // Check-ins continue while the handoff loads, so reserve the ID before starting it.
      rememberPlaybackCommand(command.id);
      applyPlaybackCommand(command);
    }
    for (const control of controls || []) {
      await applyPlaybackControl(control);
      checkInQueued = true;
    }
  } catch {
    if (info.local_play && localPlay === null && wantPlayback) localPlay = info.epoch;
  }
  finally {
    checkingIn = false;
    if (checkInQueued) queueMicrotask(checkIn);
  }
}

function pauseDevicePlayback() {
  // Invalidate a pending selection, job poll or crossfade before acknowledging.
  ++requestVersion;
  ++blendVersion; blending = false; plan = null; planKey = "";
  clearTimeout(timer);
  localPlay = localPlayPending = null;
  wantPlayback = false;
  ++pauseVersion;
  for (const deck of decks) deck.pause();
  gains.forEach((gain, i) => {
    gain.gain.cancelScheduledValues(audioContext.currentTime);
    gain.gain.value = i === deckIndex ? 1 : 0;
  });
}

async function applyPlaybackControl({action, position}) {
  if (action === "play") playHere(false);
  else if (action === "pause") pauseDevicePlayback();
  else if (action === "next") await advance(true, false);
  else if (action === "previous") previousTrack(false);
  else if (action === "seek" && Number.isFinite(position)) {
    startPosition = Math.max(0, position);
    startPlayback(decks[deckIndex]);
  }
}

function applyPlaybackPause(command) {
  remoteOwner = command.epoch === playbackEpoch ? command.device_id || null : null;
  pauseDevicePlayback();
  if (remoteDevice?.id !== remoteOwner) clearRemotePlayback();
  refreshRemotePlayback();
}

async function applyPlaybackCommand(command) {
  pauseDevicePlayback();
  ownsPlayback = true;
  remoteOwner = null;
  const {track_ids:ids, index, position} = command.resume;
  const version = requestVersion, epoch = playbackEpoch, source = remoteDevice?.track;
  try {
    if (!Array.isArray(ids) || !Number.isInteger(index) || !recordingId.test(ids[index]) || !Number.isFinite(position)) throw new Error();
    const {results = []} = await api("/api/library").catch(() => ({}));
    if (version !== requestVersion || epoch !== playbackEpoch) return;
    const available = new Map([...visibleResults, ...pool, ...results].map(track => [sourceKey(track), track]));
    const tracks = ids.slice(0, 1000).map((id, i) => {
      if (!recordingId.test(id)) return null;
      const track = available.get(id) || (!id.startsWith("local-") && {
        id, url:"https://www.youtube.com/watch?v=" + id, title:source?.id === id ? source.title : id,
        channel:source?.id === id ? source.channel : ""
      });
      return track ? {...track, playlistEntry:command.id + ":" + i} : null;
    });
    if (!tracks[index]) throw new Error();
    clearRemotePlayback();
    manualQueue.clear();
    history = tracks.slice(0, index).filter(Boolean);
    queue = tracks.slice(index + 1).filter(Boolean);
    playbackSearchQuery = null;
    const listening = listen(tracks[index], true, "queue", false, {position:Math.max(0, position), playing:command.playing !== false});
    const listenVersion = requestVersion;
    if (await listening && listenVersion === requestVersion && epoch === playbackEpoch) {
      pendingAcks.add(command.id);
      queuePlaybackCheckIn();
    }
  } catch {
    if (version === requestVersion) {
      ownsPlayback = false;
      showHandoffMessage("Could not load playback here. Try again.");
    }
  } finally {
    completedHandoff = command.id;
    if (pendingTakeover === command.id) pendingTakeover = null;
    renderRemotePlayback();
  }
}

for (const player of decks) for (const event of ["play", "playing", "waiting", "stalled", "pause", "seeked", "durationchange", "ended", "error"]) {
  player.addEventListener(event, () => {
    if (player !== decks[deckIndex]) return;
    if (event === "play") markPlaybackStarted();
    if (event === "waiting" || (event === "stalled" && player.readyState < 3)) stalled = true;
    if (["playing", "pause", "ended"].includes(event)) stalled = false;
    if (!player.paused && !player.ended) clearRemotePlayback();
    queuePlaybackCheckIn();
  });
}

const remoteBar = $("remote-playback"), remoteButton = $("takeover"), remoteProgress = $("remote-progress");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let remoteDevice = null, remoteExpiry, remoteProgressTimer, readingDevices = false;
let pendingTakeover = null, completedHandoff = null, takeoverTimer, handoffMessageTimer;
const idleHere = () => decks[deckIndex].paused || decks[deckIndex].ended;
const remoteAge = () => remoteDevice.age + (performance.now() - remoteDevice.receivedAt) / 1000;
const canTakeOver = () => deviceRegistered && remoteDevice?.queue_rev > 0 && remoteAge() < onlineSeconds && !pendingTakeover;

function clearRemotePlayback() {
  remoteDevice = null;
  renderRemotePlayback();
}
function showHandoffMessage(message) {
  const status = $("handoff-message");
  status.textContent = message;
  clearTimeout(handoffMessageTimer);
  if (message) handoffMessageTimer = setTimeout(() => { status.textContent = ""; }, 6000);
}
function renderRemotePlayback() {
  clearTimeout(remoteExpiry);
  clearTimeout(remoteProgressTimer);
  const hidden = !remoteDevice || !idleHere() || document.hidden;
  if (hidden && !document.hidden && remoteBar.contains(document.activeElement)) $("play").focus({preventScroll:true});
  remoteBar.hidden = hidden;
  if (remoteBar.hidden) return;
  const {name, track, duration:total, position, status} = remoteDevice;
  const age = remoteAge(), fresh = age < onlineSeconds;
  const moving = status === "playing";
  const available = canTakeOver();
  const state = pendingTakeover ? "Switching playback…" : !fresh ? "Last played on " + name
    : (status === "paused" ? "Paused on " : status === "buffering" ? "Buffering on " : "Playing on ") + name;
  $("remote-title").textContent = track.title;
  $("remote-device").textContent = state;
  $("remote-playing-icon").hidden = status === "paused" || !fresh;
  $("remote-paused-icon").hidden = status !== "paused" && fresh;
  remoteButton.setAttribute("aria-disabled", String(!available));
  remoteButton.setAttribute("aria-busy", String(Boolean(pendingTakeover)));
  remoteButton.setAttribute("aria-label", track.title + ". " + state + (available ? ". Switch to this browser." : ""));
  const elapsed = moving && fresh ? age : 0;
  const ratio = seconds => total > 0 && Number.isFinite(position) ? Math.max(0, Math.min(1, (position + seconds) / total)) : 0;
  remoteProgress.style.transition = "none";
  remoteProgress.style.transform = "scaleX(" + ratio(elapsed) + ")";
  if (!fresh) return;
  remoteExpiry = setTimeout(renderRemotePlayback, (onlineSeconds - age) * 1000);
  const travel = Math.min(onlineSeconds - age, total - position - elapsed);
  if (moving && Number.isFinite(position) && travel > 0 && !reducedMotion.matches) {
    remoteProgressTimer = setTimeout(() => {
      remoteProgress.style.transition = "transform " + travel + "s linear";
      remoteProgress.style.transform = "scaleX(" + ratio(elapsed + travel) + ")";
    }, 25);
  }
}
async function refreshRemotePlayback() {
  if (document.hidden || !idleHere() || readingDevices) return;
  readingDevices = true;
  try {
    const {devices} = await api("/api/playback/devices?device_id=" + deviceId);
    if (!idleHere() || document.hidden || pendingTakeover) return;
    const candidates = devices.filter(device => device.id !== deviceId && device.track && device.active !== false && !device.following);
    const row = candidates.find(device => device.active) || candidates.find(device => device.playing) ||
      candidates.find(device => device.id === remoteOwner) ||
      (!ownsPlayback && !remoteOwner && candidates.filter(device => device.queue_rev > 0).sort((a, b) => a.age - b.age)[0]);
    if (row && Number.isFinite(row.age)) {
      remoteDevice = {...row, status:row.status || (row.playing ? "playing" : "paused"), receivedAt:performance.now()};
    }
    renderRemotePlayback();
  } catch { /* Let the displayed snapshot age out if the server drops offline. */ }
  finally { readingDevices = false; }
}
remoteButton.addEventListener("click", async () => {
  if (!canTakeOver()) return;
  const source = remoteDevice.id;
  unlock();
  pendingTakeover = true;
  renderRemotePlayback();
  try {
    const result = await api("/api/playback/takeover", {method:"POST", json:{from:source, to:deviceId}});
    pendingTakeover = completedHandoff === result.id ? null : result.id;
    renderRemotePlayback();
    if (result.source_paused === false) showHandoffMessage("The other device may still be playing.");
    clearTimeout(takeoverTimer);
    takeoverTimer = setTimeout(() => {
      if (pendingTakeover !== result.id) return;
      pendingTakeover = null;
      showHandoffMessage("Could not switch playback. Try again.");
      renderRemotePlayback();
    }, 15000);
    queuePlaybackCheckIn();
  } catch (error) {
    pendingTakeover = null;
    showHandoffMessage(error.status === 409 && error.message === "Leave Listen Together first."
      ? "Leave Listen Together before switching playback." : "Could not switch playback. Try again.");
    renderRemotePlayback();
    refreshRemotePlayback();
  }
});
document.addEventListener("visibilitychange", () => {
  renderRemotePlayback();
  if (!document.hidden) {
    queuePlaybackCheckIn();
    refreshRemotePlayback();
  }
});
reducedMotion.addEventListener?.("change", renderRemotePlayback);
async function startDevicePlayback() {
  // A duplicated tab can inherit sessionStorage. Keep its check-ins distinct.
  if (navigator.locks) {
    const claimed = await new Promise(resolve => {
      navigator.locks.request(deviceKey + ":" + deviceId, {ifAvailable:true}, lock => {
        resolve(Boolean(lock));
        if (lock) return new Promise(release => window.addEventListener("pagehide", release, {once:true}));
      }).catch(() => resolve(true));
    });
    if (!claimed) {
      deviceId = newDeviceId();
      sequence = 0;
      startDevicePlayback();
      return;
    }
  }
  deviceReady = true;
  checkInQueued = false;
  queuePlaybackCheckIn();
  refreshRemotePlayback();
  setInterval(() => {
    queuePlaybackCheckIn();
    refreshRemotePlayback();
  }, 5000);
}
updateNowPlaying(); updateNext();
startDevicePlayback();
