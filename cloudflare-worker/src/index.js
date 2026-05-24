/**
 * Minti — Hypersync CORS proxy.
 *
 * Envio's public Hypersync endpoint (https://monad.hypersync.xyz) does not
 * send CORS headers, so browser-origin requests get blocked at preflight.
 * This Worker is a stateless forwarder that adds `Access-Control-Allow-*`
 * headers on responses and passes everything else through verbatim.
 *
 * Deploy: `wrangler deploy` from this directory.
 * Cost: free up to 100k requests/day on Cloudflare's hobby tier.
 */

const UPSTREAM = "https://monad.hypersync.xyz";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(req, env) {
    // Preflight — browsers send OPTIONS before the real POST.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // HYPERSYNC_TOKEN is set via `wrangler secret put HYPERSYNC_TOKEN`. The
    // key stays in the Worker — it's never sent to the browser.
    const authHeader = env.HYPERSYNC_TOKEN
      ? { Authorization: `Bearer ${env.HYPERSYNC_TOKEN}` }
      : {};

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...authHeader,
        },
        body: req.method === "POST" ? await req.text() : undefined,
      });

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
