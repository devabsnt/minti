/**
 * Minti service worker — persistent cache for NFT images + metadata.
 *
 * Why this exists:
 *
 *   The browser's HTTP cache is fast but volatile. Under memory pressure
 *   (or after an idle period) it evicts entries aggressively, especially
 *   for tabs that have been in the background. Wallets with hundreds of
 *   NFTs blow past the per-origin HTTP cache budget and start re-fetching
 *   images every refresh.
 *
 *   The Cache Storage API (`caches.open(...)`) is a different bucket:
 *   per-origin, persistent across sessions, survives reloads, and the
 *   browser only evicts it under serious storage pressure (and even then
 *   politely — you can keep working with it).
 *
 * Strategy:
 *
 *   For requests to our IPFS cache proxy (https://ipfs-cache.*.workers.dev/)
 *   we use a cache-first strategy: serve from Cache Storage if present,
 *   otherwise fetch + store. Everything else (Next assets, RPC, Hypersync)
 *   passes through untouched.
 *
 *   The IPFS content is content-addressed (CID in the URL) so it can NEVER
 *   change. Cached entries are valid forever and we never need to revalidate.
 *
 * Lifecycle:
 *
 *   - Cache name includes a version; bump it to force-invalidate all
 *     cached entries (e.g. if you change the cache key shape).
 *   - On activation, old cache buckets are cleaned up.
 *
 * Registered from `app/layout.tsx` on the client.
 */

const CACHE_NAME = "minti-ipfs-v2";
const PROXY_HOST = "ipfs-cache.devskibb.workers.dev";

self.addEventListener("install", (event) => {
  // Take over from any previous worker immediately
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any stale caches from previous versions
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("minti-ipfs-") && n !== CACHE_NAME).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Only intercept requests to our IPFS proxy. Everything else passes through.
  if (url.host !== PROXY_HOST) return;

  event.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) {
    // Background revalidate is unnecessary because IPFS CIDs are immutable.
    return cached;
  }

  try {
    const resp = await fetch(req);
    // Only cache successful responses. 4xx/5xx might be transient — we want
    // the next attempt to actually retry from the network.
    if (resp.ok) {
      // Response bodies are streams — `.clone()` lets us put one copy in
      // the cache and return the other to the page.
      cache.put(req, resp.clone()).catch(() => {
        // Quota exhausted or storage pressure — give up silently. Next
        // session the page will refetch.
      });
    }
    return resp;
  } catch (err) {
    // Network failure — re-throw so the page sees a real error rather
    // than a cached miss masquerading as success.
    throw err;
  }
}
