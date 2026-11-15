"use strict";
// Page-local audio only: no signed upstream URLs, persistent cache or stale playlists.
window.MusicPrefixCache = (() => {
  const entries = new Map(), completed = new Set(), pending = new Set();
  const limit = 8 * 1024 * 1024, ttl = 120000;
  let bytes = 0, wanted = [], workers = 0;
  const absolute = path => new URL(path, location.origin).href;
  function prune() {
    for (const [url, entry] of entries) {
      if (Date.now() - entry.created > ttl || bytes > limit) {
        entries.delete(url); bytes -= entry.size || 0;
        completed.delete(url.slice(0, url.lastIndexOf('/') + 1) + 'index.m3u8');
      }
    }
  }
  async function request(url, binary) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {credentials:'same-origin', signal:controller.signal});
      if (!response.ok) throw new Error('Audio unavailable');
      const result = binary ? await response.arrayBuffer() : await response.text();
      if ((binary ? result.byteLength : result.length) > 1024 * 1024) throw new Error('Audio preview too large');
      return result;
    } finally { clearTimeout(timer); }
  }
  function cache(url) {
    prune();
    if (entries.has(url)) return entries.get(url).promise;
    const entry = {created:Date.now(), size:0};
    entries.set(url, entry);
    entry.promise = request(url, true).then(data => {
      if (entries.get(url) === entry) { entry.size = data.byteLength; bytes += entry.size; prune(); }
      return data;
    }).catch(error => { if (entries.get(url) === entry) entries.delete(url); throw error; });
    return entry.promise;
  }
  async function prefix(job) {
    const url = absolute(job.media_url), base = new URL('.', url);
    if (base.origin !== location.origin || !/^\/api\/jobs\/[^/]+\/media\/$/.test(base.pathname)) return;
    const playlist = await request(url, false);
    const target = Math.min(12, (job.playback?.start || 0) + 6);
    let elapsed = 0, length = 0;
    const assets = ['init.mp4'];
    for (const line of playlist.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF:')) length = Number.parseFloat(line.slice(8)) || 0;
      if (/^seg\d{5}\.m4s$/.test(line)) {
        assets.push(line); elapsed += length;
        if (elapsed >= target || assets.length >= 7) break;
      }
    }
    if (assets.length === 1) return;
    for (const name of assets) await cache(new URL(name, base).href);
    if (elapsed >= target || assets.length >= 7 || playlist.includes('#EXT-X-ENDLIST')) completed.add(url);
  }
  function drain() {
    while (workers < 2 && wanted.length) {
      const job = wanted.shift(), url = absolute(job.media_url);
      if (completed.has(url) || pending.has(url)) continue;
      pending.add(url); workers++;
      prefix(job).catch(() => {}).finally(() => { pending.delete(url); workers--; drain(); });
    }
  }
  function warm(jobs) {
    if (!window.Hls?.isSupported()) return;
    prune();
    wanted = jobs.filter(job => job?.media_url).slice(0, 14);
    drain();
  }
  function loader(Base) {
    return class extends Base {
      load(context, config, callbacks) {
        prune();
        const entry = context.responseType === 'arraybuffer' && entries.get(absolute(context.url));
        if (!entry) return super.load(context, config, callbacks);
        this.cancelled = false;
        const start = performance.now();
        entry.promise.then(data => {
          if (this.cancelled) return;
          Object.assign(this.stats, {loaded:data.byteLength, total:data.byteLength, chunkCount:1});
          Object.assign(this.stats.loading, {start, first:performance.now(), end:performance.now()});
          callbacks.onSuccess({url:context.url, data:data.slice(0)}, this.stats, context, null);
        }).catch(() => { if (!this.cancelled) super.load(context, config, callbacks); });
      }
      abort() { this.cancelled = true; super.abort(); }
      destroy() { this.cancelled = true; super.destroy(); }
    };
  }
  return {warm, loader};
})();
