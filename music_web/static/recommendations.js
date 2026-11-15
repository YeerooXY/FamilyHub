"use strict";
// Metadata-based song identity, not an acoustic fingerprint. Keep search results intact.
(function(root) {
  const normalize = value => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  function identity(track) {
    let title = String(track?.title || ""), artist = track?.artist || track?.channel || "";
    const reversedNightcore = /^nightcore/i.test(title);
    title = title.replace(/^(?:nightcore|8d audio|lyrics)\s*[-\u2013\u2014:]\s*/i, "");
    const parts = title.split(/\s+[-\u2013\u2014]\s+/);
    if (parts.length > 1) {
      if (reversedNightcore && /\b(?:ft|feat)\.?/i.test(parts[1])) { title=parts[0]; artist=parts[1]; }
      else { artist = parts.shift(); title = parts.join(" - "); }
    }
    artist = normalize(artist.replace(/\s*-?\s*Topic$|VEVO$/i, "").replace(/\s+(?:ft\.?|feat\.?)\s+.*/i, ""));
    title = title.replace(/[([][^)\]]*[)\]]/g, " ").replace(/\b(?:ft\.?|feat\.?)\s+.*/i, "")
      .replace(/\b(?:official|music video|audio only|audio|lyrics?|visuali[sz]er|hd|hq|4k|8d|nightcore|slowed|reverb|sped up)\b/gi, " ");
    return {artist, title:normalize(title)};
  }
  function same(a,b) {
    if (!a || !b) return false;
    if (a.url && a.url === b.url) return true;
    const x=identity(a), y=identity(b);
    return Boolean(x.title && x.title===y.title && x.artist && x.artist===y.artist);
  }
  function createHistory(storage, user, now=Date.now) {
    const key="music:history:v1:"+encodeURIComponent(user); let entries=[];
    try { const data=JSON.parse(storage.getItem(key)); if(Array.isArray(data)) entries=data.filter(e=>e && typeof e.at==="number" && typeof e.track?.title==="string" && ["played","skipped","queued"].includes(e.kind)); } catch {}
    const trim=()=>{entries=entries.filter(e=>now()-e.at<90*86400000).slice(-500);};
    const save=()=>{trim();try {storage.setItem(key,JSON.stringify(entries));}catch{}};
    trim();
    return {
      record(track,kind) { if(!track)return; const t={title:String(track.title||"").slice(0,300),artist:identity(track).artist,genre:track.genre||"",url:track.url||""}; entries=entries.filter(e=>!(same(e.track,t)&&e.kind===kind));entries.push({track:t,kind,at:now()});save(); },
      recent(track) { trim();return entries.some(e=>e.kind!=="queued" && now()-e.at<(e.kind==="skipped"?7:1)*86400000 && same(e.track,track)); },
      affinity(track) { trim(); const a=identity(track).artist; return Math.max(-4,Math.min(4,entries.filter(e=>identity(e.track).artist===a).reduce((sum,e)=>sum+(e.kind==="skipped"?-.5:1),0))); },
      clear() {entries=[];try{storage.removeItem(key);}catch{}},
      entries:()=>entries.slice()
    };
  }
  function unique(candidates, excluded=[]) {
    const result=[];for(const track of candidates) if(![...excluded,...result].some(t=>same(t,track))) result.push(track);return result;
  }
  function similar(seed, track) {
    if (!seed || !track) return false;
    const a=identity(seed).artist, b=identity(track).artist;
    const genre=t=>normalize(t.genre)==="unsorted" ? "" : normalize(t.genre);
    const x=genre(seed), y=genre(track);
    // Missing genre evidence only permits the seed artist; known conflicts are excluded.
    if (x && y && x!==y) return false;
    return Boolean(a && b && (a===b || x && x===y));
  }
  const api={identity,same,unique,createHistory,similar};
  if(typeof module!=="undefined") module.exports=api; else root.MusicRecommendations=api;
})(globalThis);
