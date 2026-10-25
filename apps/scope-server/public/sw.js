// sw.js — the service worker that makes the phone layout installable.
//
// It is deliberately almost empty. Chrome will only offer "Add to Home screen"
// for a page whose origin registers a worker with a fetch handler, and that is
// the only thing this file is for. Everything the app actually shows comes from
// this machine over the Wi-Fi, behind a token that changes when the server
// restarts, so caching the app shell or any API response would mean serving a
// stale UI, a stale credential or a 401 from a cache — the opposite of what a
// live session view is for. Requests go to the network untouched.
//
// The one exception is the offline card: a standalone install has no address bar
// and no browser error page, so a failed launch would otherwise sit on a blank
// screen with nothing to tap. `mobile-offline.html` is cached at install and
// served in place of a *navigation* that could not reach the server.

const OFFLINE_URL = "/mobile-offline.html";
const CACHE = "pi-scope-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `reload` skips the HTTP cache: this is the copy that has to survive when
    // the network does not.
    await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Drop caches from an older version of this worker.
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Only navigations are considered at all. Everything else — the API, the SSE
  // stream, media, the token-bearing fetches — is left entirely to the browser,
  // so this worker can never reorder, cache or replay a live request.
  if (request.mode !== "navigate") return;
  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch {
      const cache = await caches.open(CACHE);
      return (await cache.match(OFFLINE_URL)) || Response.error();
    }
  })());
});
