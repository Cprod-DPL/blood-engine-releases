"use strict";
// Network first, so every launch online runs the latest release; the last
// files fetched keep the game playable offline. One copy per file: entries are
// keyed without the `?v=` that index.html adds.

const CACHE = "blood-engine";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.pathname.endsWith("version.txt") === false) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((r) => r || Response.error()))
  );
});
