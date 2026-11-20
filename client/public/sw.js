/**
 * codiq POS-offline v1 — hand-rolled till service worker (zero deps).
 *
 * Its ONE irreplaceable job is offline BOOT of the till route after a power
 * cut; queueing and flushing are page-driven (Background Sync is Chromium-only
 * anyway). A one-route offline scope reimplements workbox's precache +
 * cleanup in a page of auditable code instead of a transitive build tree.
 *
 * Scope discipline — fetch is answered ONLY for:
 *   (a) GET /assets/*                  → cache-first (hashed, immutable);
 *   (b) navigations to the till route  → network-first, cached shell fallback;
 *   (c) Google Fonts CSS + font files  → stale-while-revalidate.
 * EVERYTHING else — «/», the dashboards, /api/* — gets NO respondWith call:
 * browser default, byte-identical behavior for every non-till surface.
 */

/* Both placeholders are rewritten by scripts/generate-sw-manifest.mjs as the
   LAST step of `pnpm build`. A stale list would 404 inside addAll — which is
   atomic, so the SW simply never installs: fail-safe, offline stays absent. */
const BUILD_HASH = "__BUILD_HASH__";
self.__PRECACHE__ = [];

const PRECACHE_NAME = "codiq-till-" + BUILD_HASH;
const FONT_CACHE_NAME = "codiq-till-fonts";
const TILL_ROUTE = /^\/merchant\/stores\/[^/]+\/till\/?$/;

/* NOT addAll. The server's SPA catch-all answers 200 text/html for ANY
   unmatched path — including a chunk this manifest names that a deploy has
   already purged — so addAll's "atomic, a 404 aborts install" fail-safe is
   FALSE on this origin: it would happily commit HTML under a .js URL and
   brick the till at the next offline boot. Every entry is fetched and
   verified (ok + the content type its extension promises) before the cache
   commits; one mismatch fails the whole install, and offline simply stays
   absent until a coherent build serves the manifest. */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE_NAME)
      .then((cache) =>
        Promise.all(
          self.__PRECACHE__.map((url) =>
            fetch(url, { cache: "no-cache" }).then((response) => {
              const type = response.headers.get("content-type") || "";
              const isShell = url === "/index.html";
              const typeOk = isShell
                ? type.indexOf("text/html") !== -1
                : type.indexOf("javascript") !== -1 || type.indexOf("text/css") !== -1;
              if (!response.ok || !typeOk) throw new Error("codiq-till precache mismatch: " + url + " (" + response.status + " " + type + ")");
              return cache.put(url, response);
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

/* skipWaiting + clients.claim is safe for THIS scope only because TillPage has
   no post-boot dynamic imports (sw-precache.guard.mjs pins that assumption):
   an already-running old till cannot request an old chunk after activation.
   The fonts cache is shared across builds and survives the sweep. */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.indexOf("codiq-till-") === 0 && key !== PRECACHE_NAME && key !== FONT_CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/* The server's SPA catch-all answers 200 text/html for ANY unmatched path —
   including a STALE hashed asset URL after a deploy. Persisting that HTML
   under a .js name would hard-brick the till on module-MIME rejection, so a
   network response is cached ONLY when it is ok AND actually JS or CSS. */
function cacheableAsset(response) {
  if (!response || !response.ok) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  return type.indexOf("javascript") !== -1 || type.indexOf("text/css") !== -1;
}

function assetResponse(request) {
  return caches.open(PRECACHE_NAME).then((cache) =>
    cache.match(request).then((hit) => {
      if (hit) return hit;
      /* Any codiq-till-* cache second: an old build's chunk keeps a till that
         is already open alive across a deploy until its next reload. */
      return caches.match(request).then((anyHit) => {
        if (anyHit) return anyHit;
        return fetch(request).then((response) => {
          if (cacheableAsset(response)) {
            const copy = response.clone();
            cache.put(request, copy).catch(() => undefined);
          }
          return response;
        });
      });
    }),
  );
}

function tillNavigationResponse(request) {
  return fetch(request).catch(() =>
    caches.match("/index.html").then((shell) => {
      if (shell) return shell;
      /* addAll is atomic, so a missing shell means the cache was evicted. A
         plain refusal beats a rejected respondWith (opaque browser error). */
      return new Response("لا اتصال بالخادم — أعد المحاولة عند عودة الشبكة.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }),
  );
}

/* Both font hosts serve ACAO:*, but the stylesheet <link> is still a no-cors
   request, so opaque responses are accepted alongside ok ones. Offline with
   nothing cached degrades to system Arabic type — acceptable. */
function fontResponse(event) {
  return caches.open(FONT_CACHE_NAME).then((cache) =>
    cache.match(event.request).then((hit) => {
      const refresh = fetch(event.request).then((response) => {
        if (response && (response.ok || response.type === "opaque")) {
          const copy = response.clone();
          cache.put(event.request, copy).catch(() => undefined);
        }
        return response;
      });
      if (hit) {
        event.waitUntil(refresh.catch(() => undefined));
        return hit;
      }
      return refresh.catch(() => Response.error());
    }),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.indexOf("/assets/") === 0) {
      event.respondWith(assetResponse(request));
      return;
    }
    if (request.mode === "navigate" && TILL_ROUTE.test(url.pathname)) {
      event.respondWith(tillNavigationResponse(request));
    }
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(fontResponse(event));
  }
});
