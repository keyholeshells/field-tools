// Field Tools service worker. Keeps the app's own files so it opens with no signal.
// Tracks aren't kept here: the app saves them in IndexedDB. Bump VERSION when files change.
const VERSION = "2026-10-24c";
const CACHE = "field-tools-" + VERSION;
const FILES = ["./", "index.html", "app.js", "styles.css", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.png"];

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("field-tools-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;          // the site's track list and the tracks go straight to the network
    // Pages (any ?k=...) get index.html; everything else by its path. Network first so
    // updates arrive; the saved copy when there's no signal.
    const key = req.mode === "navigate" ? "index.html" : url.pathname.replace(/^.*\//, "") || "index.html";
    e.respondWith(fetch(req).then(res => {
        if (res.ok && req.mode !== "navigate") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
        return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(key, { ignoreSearch: true })).then(hit => hit || caches.match(req, { ignoreSearch: true }))
        .then(hit => hit || new Response("You're offline and this part of Field Tools isn't saved yet. Open it once with signal.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }))));
});
