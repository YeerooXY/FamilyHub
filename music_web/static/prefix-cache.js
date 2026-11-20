"use strict";
// The HLS loader and one speculative opening share page-local segment bytes.
window.MusicPrefixCache = (() => {
  const entries = new Map();
  const active = new Map();
  const limit = 8 * 1024 * 1024, ttl = 120000, assetLimit = 1024 * 1024;
  const assetPath = /^\/api\/jobs\/[^/]+\/media\/(?:init\.mp4|seg\d{5}\.m4s)$/;
  let bytes = 0, warming = null;
  const absolute = path => new URL(path, location.origin).href;
  const eligible = () => !document.hidden && navigator.onLine !== false
    && navigator.connection?.type === "wifi" && !navigator.connection.saveData;
  const cacheable = url => url.origin === location.origin && !url.search && assetPath.test(url.pathname);
  function prune() {
    for (const [url, entry] of entries) {
      if (entry.data && (Date.now() - entry.touched > ttl || bytes > limit)) {
        entries.delete(url);
        bytes -= entry.data.byteLength;
      }
    }
  }
  function remember(url, data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength > assetLimit) return;
    const old = entries.get(url);
    if (old?.data) bytes -= old.data.byteLength;
    entries.delete(url);
    entries.set(url, {data, touched:Date.now()});
    bytes += data.byteLength;
    prune();
  }
  async function request(url, binary, signal) {
    const response = await fetch(url, {credentials:"same-origin", redirect:"error",
      headers:{"X-FamilyHub-Activity":"background"}, signal:AbortSignal.any([signal, AbortSignal.timeout(5000)])});
    if (!response.ok || !response.body) throw new Error("Audio unavailable");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > assetLimit) throw new Error("Audio preview too large");
        chunks.push(value);
      }
    } finally { reader.cancel().catch(() => {}); }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return binary ? data.buffer : new TextDecoder().decode(data);
  }
  function cancel() {
    if (!warming) return;
    warming.controller.abort();
    for (const entry of entries.values()) if (entry.owner === warming && !entry.readers) entry.controller.abort();
    warming = null;
  }
  async function warm(job) {
    const url = eligible() && job?.media_url && new URL(job.media_url, location.origin);
    if (!url || url.origin !== location.origin || url.search || !/^\/api\/jobs\/[^/]+\/media\/index\.m3u8$/.test(url.pathname)) {
      cancel(); return;
    }
    if (warming?.url === url.href) return;
    cancel(); prune();
    const current = warming = {url:url.href, controller:new AbortController()};
    try {
      const playlist = await request(url, false, current.controller.signal);
      const opening = playlist.split(/\r?\n/).filter(line => /^seg\d{5}\.m4s$/.test(line)).slice(0, 3);
      if (!opening.length) { if (warming === current) cancel(); return; }
      for (const name of ["init.mp4", ...opening]) {
        if (warming !== current || !eligible()) return;
        const asset = new URL(name, url).href;
        if (entries.has(asset) || active.has(asset)) continue;
        const controller = new AbortController();
        const entry = {controller, owner:current, readers:0};
        entries.set(asset, entry);
        entry.promise = request(asset, true, controller.signal).then(data => {
          if (entries.get(asset) === entry) remember(asset, data);
          return data;
        }).finally(() => { if (entries.get(asset) === entry) entries.delete(asset); });
        await entry.promise;
      }
      if (opening.length < 3 && !playlist.includes("#EXT-X-ENDLIST") && warming === current) warming = null;
    } catch { if (warming === current) cancel(); }
  }
  function loader(Base) {
    return class extends Base {
      load(context, config, callbacks) {
        const url = new URL(context.url, location.origin);
        if (context.responseType !== "arraybuffer" || context.rangeEnd || !cacheable(url))
          return super.load(context, config, callbacks);
        const network = () => {
          const key = url.href;
          active.set(key, (active.get(key) || 0) + 1);
          this.releaseNetwork = () => {
            const count = active.get(key) - 1;
            if (count) active.set(key, count); else active.delete(key);
            this.releaseNetwork = null;
          };
          return super.load(context, config, {...callbacks,
            onSuccess: (response, ...args) => {
              this.releaseNetwork?.();
              if (response.data?.byteLength <= assetLimit) remember(key, response.data.slice(0));
              callbacks.onSuccess(response, ...args);
            },
            onError: (...args) => { this.releaseNetwork?.(); callbacks.onError(...args); },
            onTimeout: (...args) => { this.releaseNetwork?.(); callbacks.onTimeout(...args); }});
        };
        prune();
        const entry = entries.get(url.href);
        if (!entry || entry.controller?.signal.aborted) return network();
        const start = performance.now();
        if (entry.data) {
          entry.touched = Date.now();
          entries.delete(url.href); entries.set(url.href, entry);
        } else {
          entry.readers++;
          this.release = () => {
            if (--entry.readers === 0 && entry.owner.controller.signal.aborted) entry.controller.abort();
            this.release = null;
          };
        }
        Promise.resolve(entry.data || entry.promise).then(data => {
          if (this.cancelled) return;
          Object.assign(this.stats, {loaded:data.byteLength, total:data.byteLength, chunkCount:1});
          Object.assign(this.stats.loading, {start, first:performance.now(), end:performance.now()});
          callbacks.onSuccess({url:context.url, data:data.slice(0)}, this.stats, context, null);
        }, () => { if (!this.cancelled) network(); }).finally(() => this.release?.());
      }
      abort() { this.cancelled = true; this.release?.(); this.releaseNetwork?.(); super.abort(); }
      destroy() { this.cancelled = true; this.release?.(); this.releaseNetwork?.(); super.destroy(); }
    };
  }
  document.addEventListener("visibilitychange", () => { if (!eligible()) cancel(); });
  navigator.connection?.addEventListener?.("change", () => { if (!eligible()) cancel(); });
  window.addEventListener("offline", cancel);
  return {eligible, warm, cancel, loader};
})();
