/* Caderneta — service worker.
 * Arquivos do app: rede primeiro (atualização chega sozinha), cache quando offline.
 * Fontes do Google: cache primeiro. Chamadas ao Apps Script nunca passam pelo cache. */
const VERSAO = "caderneta-v1";
const ARQUIVOS = ["./", "index.html", "styles.css", "core.js", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copia = res.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;

  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copia = res.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))));
});
