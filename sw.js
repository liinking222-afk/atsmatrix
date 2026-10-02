/* ATSMATRIX service worker: offline app shell + CDN libs; network-first for live data.
   Never touches Gemini traffic and never caches URLs that carry an api_key. */
'use strict';
const VERSION = 'atsm-v3-2026-10-02e';
const SHELL_CACHE = 'atsm-shell-' + VERSION, DATA_CACHE = 'atsm-data-v1', TILE_CACHE = 'atsm-tiles-v1', LIB_CACHE = 'atsm-lib-v1', FONT_CACHE = 'atsm-fonts-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/icon.svg'];
const CDN = [
  'https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Share+Tech+Mono&display=swap',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js'
];
const MAX_DATA = 80, MAX_TILES = 400;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL);
    await Promise.all(CDN.map(async u => { try{ const r = await fetch(new Request(u, { mode: 'cors', credentials: 'omit' })); if(r.ok) await c.put(u, r); }catch(err){} }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for(const k of await caches.keys()) if(k.startsWith('atsm-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
async function trim(name, max){ const c = await caches.open(name); const keys = await c.keys(); for(let i = 0; i < keys.length - max; i++) await c.delete(keys[i]); }
async function networkFirst(req, cacheName, { timeout = 0, fallbackUrl = null, max = 0 } = {}){
  const c = await caches.open(cacheName);
  try{
    const net = fetch(req);
    const r = timeout ? await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]) : await net;
    if(r && r.ok && (r.type === 'basic' || r.type === 'cors')){
      if(cacheName === DATA_CACHE){ // store a copy stamped with the time it was fetched (CORS hides the Date header)
        const copy = new Response(await r.clone().blob(), { status: r.status, statusText: r.statusText, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'x-atsm-cached-at': new Date().toISOString() } });
        await c.put(req, copy); if(max) trim(cacheName, max);
      } else await c.put(req, r.clone());
    }
    return r;
  }catch(err){
    const hit = await c.match(req, { ignoreSearch: false }) || (fallbackUrl && await c.match(fallbackUrl));
    if(hit){ // label it so the page can say "offline copy" instead of pretending it is live
      const h = new Headers(hit.headers); h.set('X-ATSM-Offline-Cache', hit.headers.get('x-atsm-cached-at') || hit.headers.get('date') || 'unknown time');
      return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers: h });
    }
    throw err;
  }
}
async function cacheFirst(req, cacheName, max = 0){
  const c = await caches.open(cacheName);
  const hit = await c.match(req) || (cacheName === SHELL_CACHE ? null : await caches.match(req));
  if(hit) return hit;
  const r = await fetch(req);
  if(r && (r.ok || r.type === 'opaque')){ await c.put(req, r.clone()); if(max) trim(cacheName, max); }
  return r;
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if(url.hostname === 'generativelanguage.googleapis.com') return;            // Gemini: never intercepted or cached
  if(/[?&]api_key=/i.test(url.search)) return;                                // keyed NASA URLs: straight to network, never cached
  if(/(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)$/.test(url.hostname)) return; // Live TV: never cached
  if(url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return e.respondWith(cacheFirst(req, FONT_CACHE, 30)); // stencil + mono fonts work offline
  if(/(^|\.)(huggingface\.co|hf\.co)$/.test(url.hostname) || /xethub/.test(url.hostname)) return; // local-model weights: Transformers.js caches them itself
  if(url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/(@huggingface\/transformers|onnxruntime-web)@/.test(url.pathname)) return e.respondWith(cacheFirst(req, LIB_CACHE, 40)); // pinned local-engine runtime (works offline once loaded)
  if(url.origin === self.location.origin){
    if(req.mode === 'navigate') return e.respondWith(networkFirst(req, SHELL_CACHE, { timeout: 4000, fallbackUrl: './index.html' }));
    return e.respondWith(networkFirst(req, SHELL_CACHE, { timeout: 4000 }));
  }
  if(CDN.includes(url.href)) return e.respondWith(caches.match(url.href).then(hit => hit || fetch(req)));
  if(url.hostname.endsWith('tile.openstreetmap.org')) return e.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
  e.respondWith(networkFirst(req, DATA_CACHE, { max: MAX_DATA }));             // live data: fresh when online, last copy when offline
});
