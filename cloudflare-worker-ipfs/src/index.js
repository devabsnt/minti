/**
 * Minti — IPFS edge cache.
 *
 * IPFS public gateways are slow. They serially fetch from the DHT, have
 * variable latencies (often >1 s for cold reads), and the connection has
 * to be re-established by every browser tab that loads an NFT image.
 *
 * This Worker fixes both problems:
 *
 *   1. **Edge cache.** Cloudflare's `caches.default` is a free CDN cache.
 *      Once a CID has been fetched once in any region, all subsequent
 *      requests to that region's colo hit the cache in <50ms. We set
 *      `Cache-Control: public, immutable, max-age=31536000` since IPFS
 *      content is content-addressed and never changes.
 *
 *   2. **Gateway racing.** On cold reads we fire all configured gateways
 *      simultaneously via Promise.any() and take whichever responds first.
 *      Cold-read latency drops from "slowest gateway timeout" to "fastest
 *      gateway response" — typically 200-800ms instead of 5-10s.
 *
 * Usage from the frontend:
 *   https://ipfs-cache.<account>.workers.dev/ipfs/<cid>/<path...>
 *
 * Works for images AND metadata JSON — the worker is content-agnostic.
 *
 * Deploy: `wrangler deploy` from this directory.
 * Cost: free up to 100k requests/day. Cache hits don't count against the
 *       request limit on most pricing tiers (verify in dashboard).
 */

// Public IPFS gateways known to serve CORS headers for arbitrary CIDs.
// Order doesn't matter — we race them. Subdomain forms (where supported)
// avoid path-namespace collisions and tend to resolve faster.
//
// Trimmed to gateways that actually respond in production. Specifically
// dropped:
//   - flk-ipfs.xyz: frequently returns 502/504 even for valid CIDs
//   - 4everland.io: aggressive rate limiting from worker IPs
// Added:
//   - cf-ipfs.com: Cloudflare's own (back online for many CIDs)
//   - storry.tv: backed by web3.storage, faster than nftstorage.link lately
const GATEWAYS = [
  (cid, path) => `https://ipfs.io/ipfs/${cid}${path}`,
  (cid, path) => `https://dweb.link/ipfs/${cid}${path}`,
  (cid, path) => `https://w3s.link/ipfs/${cid}${path}`,
  (cid, path) => `https://nftstorage.link/ipfs/${cid}${path}`,
  (cid, path) => `https://${cid}.ipfs.cf-ipfs.com${path}`,
  (cid, path) => `https://storry.tv/ipfs/${cid}${path}`,
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// 1 year — content-addressed data never changes.
const CACHE_CONTROL = "public, immutable, max-age=31536000, s-maxage=31536000";

const FETCH_TIMEOUT_MS = 6_000;

function parsePath(url) {
  // Accept either /ipfs/<cid>/<path...> (legacy gateway shape) or
  // /<cid>/<path...> (root shape). Reject anything else.
  let path = url.pathname;
  if (path.startsWith("/ipfs/")) path = path.slice("/ipfs/".length);
  else if (path.startsWith("/")) path = path.slice(1);
  if (!path) return null;
  const slash = path.indexOf("/");
  if (slash === -1) return { cid: path, rest: "" };
  return { cid: path.slice(0, slash), rest: path.slice(slash) };
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      cf: {
        // Tell Cloudflare to also cache the upstream-side fetch when
        // possible. Origin cache key collides with our own caches.default
        // entry only if shapes match, so this is just extra speedup.
        cacheTtl: 60 * 60 * 24 * 365,
        cacheEverything: true,
      },
    });
    // Promise.any treats any rejection as a "loser" — we have to throw
    // on non-2xx ourselves to skip slow-but-broken gateways.
    if (!resp.ok) throw new Error(`gateway returned ${resp.status}`);
    return resp;
  } finally {
    clearTimeout(t);
  }
}

async function raceGateways(cid, rest) {
  const attempts = GATEWAYS.map((mk) => fetchWithTimeout(mk(cid, rest), FETCH_TIMEOUT_MS));
  return await Promise.any(attempts);
}

export default {
  async fetch(req, _env, ctx) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const parsed = parsePath(url);
    if (!parsed) {
      return new Response("Usage: /ipfs/<cid>/<path>", {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
      });
    }

    // Cache lookup — Cloudflare uses the full URL as the key by default.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });

    let cached = await cache.match(cacheKey);
    if (cached) {
      // Tag a header so we can verify edge-cache hits from the browser DevTools.
      const headers = new Headers(cached.headers);
      headers.set("x-cache", "HIT");
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }

    // Cold read — race the gateways.
    let upstream;
    try {
      upstream = await raceGateways(parsed.cid, parsed.rest);
    } catch (err) {
      // Promise.any rejects with AggregateError when every attempt failed.
      return new Response(
        JSON.stringify({
          error: "all_gateways_failed",
          message: String(err?.errors?.[0] || err),
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // Re-emit with our own cache headers + CORS. Strip content-encoding
    // because `fetch` has already decoded.
    const respHeaders = new Headers();
    const passthrough = [
      "content-type",
      "content-length",
      "etag",
      "last-modified",
      "accept-ranges",
    ];
    for (const k of passthrough) {
      const v = upstream.headers.get(k);
      if (v) respHeaders.set(k, v);
    }
    respHeaders.set("Cache-Control", CACHE_CONTROL);
    respHeaders.set("x-cache", "MISS");
    for (const [k, v] of Object.entries(CORS_HEADERS)) respHeaders.set(k, v);

    // Tee the response body — one half streams to the client, the other
    // half goes into the cache via `ctx.waitUntil` so the request finishes
    // before the cache write blocks anything.
    const [forClient, forCache] = upstream.body.tee();
    const cachedResp = new Response(forCache, {
      status: 200,
      headers: respHeaders,
    });
    ctx.waitUntil(cache.put(cacheKey, cachedResp));

    return new Response(forClient, {
      status: 200,
      headers: respHeaders,
    });
  },
};
