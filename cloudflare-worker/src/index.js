/**
 * Minti — Hypersync CORS proxy with token rotation + pacing.
 *
 * Two things on top of the basic CORS forwarder:
 *
 *   1. Multi-token rotation. Envio's free plan caps each API token at
 *      500 RPM. Supplying multiple comma-separated tokens via the
 *      `HYPERSYNC_TOKENS` secret multiplies the effective ceiling. The
 *      proxy round-robins by picking whichever token is next free.
 *
 *   2. Per-token pacer. Each token is limited to `RATE_PER_TOKEN_PER_SEC`
 *      requests/sec (set just under Envio's per-token cap). When a request
 *      arrives and no token is free yet, it waits up to
 *      `MAX_QUEUE_DELAY_MS` for one to free up. Beyond that we shed load
 *      by returning 429 to the client — better than burning the token's
 *      budget on requests the client has already given up on.
 *
 * Note on Worker isolates: in-memory state is per-isolate, so high-traffic
 * regions may run N isolates each with its own pacer. The effective
 * sustained throughput is roughly N × (tokens × RATE_PER_TOKEN_PER_SEC).
 * For our scale (low-thousands of users) this is a feature, not a bug —
 * regional isolates self-balance and we don't pay for Durable Objects.
 *
 * Deploy: `wrangler deploy` from this directory.
 * Secrets:
 *   wrangler secret put HYPERSYNC_TOKENS   # comma-separated list
 * (or the legacy single-token form:)
 *   wrangler secret put HYPERSYNC_TOKEN
 */

const UPSTREAM = "https://monad.hypersync.xyz";

// 480 RPM each, leaving headroom under Envio's 500 RPM/token cap. Convert
// to milliseconds-between-requests as the pacer's underlying unit.
const RATE_PER_TOKEN_PER_SEC = 8;
const MIN_GAP_MS = 1000 / RATE_PER_TOKEN_PER_SEC;

// Maximum time we'll hold a client request before falling back to 429.
// Tuned so that wallet scans (which fire several requests in sequence)
// don't pile up enough to look like a hung page.
const MAX_QUEUE_DELAY_MS = 2000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── token registry ────────────────────────────────────────────────
// Parsed once per isolate and reused. Each entry tracks the next time
// the token may be used (a continuous token bucket of capacity 1).
let tokensCache = null;
let tokensCacheKey = null;

function getTokens(env) {
  // Re-parse if the env shape changed (e.g. secret rotation in dashboard).
  const key = (env.HYPERSYNC_TOKENS || "") + "|" + (env.HYPERSYNC_TOKEN || "");
  if (tokensCache && tokensCacheKey === key) return tokensCache;

  const raw = env.HYPERSYNC_TOKENS || env.HYPERSYNC_TOKEN || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  tokensCache = list.map((token) => ({ token, nextAvailable: 0 }));
  tokensCacheKey = key;
  return tokensCache;
}

/**
 * Find the token with the earliest `nextAvailable` and reserve a slot on it.
 * Returns `{ entry }` on success or `{ retryAfterMs }` when the soonest slot
 * is further out than the client-tolerable delay.
 *
 * Reservation is greedy — we bump `nextAvailable` before we know if the
 * upstream request will succeed. On 429 we push `nextAvailable` further
 * forward using the Retry-After hint, so a flapping token cools off
 * naturally without us having to track failure state separately.
 */
async function reserveToken(env) {
  const tokens = getTokens(env);
  if (tokens.length === 0) return { entry: null }; // unauthenticated mode

  let best = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].nextAvailable < best.nextAvailable) best = tokens[i];
  }
  const now = Date.now();
  const wait = best.nextAvailable - now;
  if (wait > MAX_QUEUE_DELAY_MS) {
    return { retryAfterMs: wait };
  }
  if (wait > 0) await sleep(wait);
  best.nextAvailable = Math.max(Date.now(), best.nextAvailable) + MIN_GAP_MS;
  return { entry: best };
}

/** Push a token's earliest-available timestamp forward by `ms`. */
function coolToken(entry, ms) {
  if (!entry) return;
  entry.nextAvailable = Math.max(entry.nextAvailable, Date.now() + ms);
}

export default {
  async fetch(req, env) {
    // Preflight — browsers send OPTIONS before the real POST.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // Reserve a token (may wait up to MAX_QUEUE_DELAY_MS).
    const reservation = await reserveToken(env);
    if (reservation.retryAfterMs != null) {
      const retrySec = Math.ceil(reservation.retryAfterMs / 1000);
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: "Hypersync proxy is at capacity; please retry shortly.",
          retryAfter: retrySec,
        }),
        {
          status: 429,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            "Retry-After": String(retrySec),
          },
        },
      );
    }

    const entry = reservation.entry;
    const authHeader = entry ? { Authorization: `Bearer ${entry.token}` } : {};

    // Read the body once — req.text() consumes the stream.
    const body = req.method === "POST" ? await req.text() : undefined;

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...authHeader,
        },
        body,
      });

      // If upstream throttles us, push this token's cooldown forward so the
      // pacer naturally avoids it until Envio's retry window expires.
      if (upstreamResp.status === 429) {
        const retryHeader = upstreamResp.headers.get("retry-after");
        const retryMs = retryHeader
          ? Math.max(1000, Number(retryHeader) * 1000)
          : 5_000;
        coolToken(entry, retryMs);
      }

      // Copy upstream response headers + slap CORS on. Skip content-encoding
      // because the body's already been decoded by `fetch` and re-emitting
      // the original encoding header would break browser decoding.
      const headers = new Headers();
      for (const [k, v] of upstreamResp.headers.entries()) {
        if (k.toLowerCase() === "content-encoding") continue;
        headers.set(k, v);
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers,
      });
    } catch (err) {
      // Network blip / DNS — cool the token briefly so the next request
      // tries a different one if available.
      coolToken(entry, 2_000);
      return new Response(
        JSON.stringify({ error: "proxy failure", message: String(err) }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
  },
};
