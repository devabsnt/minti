import type { NextRequest } from "next/server";

/**
 * Same-origin CORS proxy for collection metadata. Hosted under our own
 * origin, so the browser does no CORS check on the response — we just
 * fetch upstream server-side and forward the body.
 *
 * Runs on Vercel's edge network. The previous proxy (Cloudflare worker
 * at `ipfs-cache.devskibb.workers.dev/proxy`) was getting 502'd by
 * upstreams like scatter that filter Cloudflare worker IP ranges.
 *
 * No allowlist by design — collections constantly invent new metadata
 * hosts and an allowlist would be perpetually out of date. Instead we
 * gate on invariants that prevent the worst abuses:
 *
 *   - `https:` scheme only (no http://, no file://, no data:)
 *   - Reject obvious private hosts (localhost, *.local, 10/8, 192.168/16,
 *     169.254/16, 172.16/12). Stops SSRF to a network neighbor.
 *   - 2MB response cap — collection metadata is <5KB; anything bigger
 *     is either an image being fetched the wrong way or abuse.
 *   - Restrict response content-type to JSON / text / image so this
 *     can't be repurposed as a generic file-mirror proxy.
 *
 * Edge runtime + aggressive caching keeps cost negligible.
 */

export const runtime = "edge";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_CONTENT_TYPES = [
  "application/json",
  "text/json",
  "text/plain",
  "image/",
];

/** Block private / link-local / loopback IPs so this isn't an SSRF tool. */
function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  // Strip port
  const hostname = h.split(":")[0];
  // IPv6 loopback
  if (hostname === "::1" || hostname === "[::1]") return true;
  // IPv4 literal check
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 192.168.0.0/16,
  // 172.16.0.0/12, 100.64.0.0/10 (CGNAT).
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function contentTypeIsAllowed(ct: string | null): boolean {
  if (!ct) return true; // Many upstreams omit content-type; allow.
  const lower = ct.toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((prefix) => lower.startsWith(prefix));
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return new Response("Usage: /api/proxy?url=<https-url>", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid url parameter", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (parsed.protocol !== "https:") {
    return new Response("Only https URLs supported", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (isPrivateOrLocalHost(parsed.host)) {
    return new Response("Private hosts are not proxied", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Mimic a real browser request. Many anti-scrape gates reject the
  // default fetch User-Agent ("Vercel-Edge-Runtime") or similar bot
  // identifiers, so we send a realistic browser fingerprint.
  const upstreamHeaders: HeadersInit = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, image/*, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${parsed.protocol}//${parsed.host}/`,
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: upstreamHeaders,
      cache: "no-store",
      redirect: "follow",
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "upstream_fetch_failed", message: String(err) }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          // Soft-cache failures for 60s so a 30-card mount doesn't
          // re-hammer the upstream after one bad response.
          "Cache-Control": "public, max-age=60, s-maxage=60",
        },
      },
    );
  }

  const ct = upstream.headers.get("content-type");
  if (!contentTypeIsAllowed(ct)) {
    return new Response(`Disallowed content-type: ${ct}`, {
      status: 415,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Size guard. Honor Content-Length if present; otherwise let the
  // body stream and abort if it exceeds MAX_BYTES.
  const declared = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return new Response(`Response too large: ${declared} bytes`, {
      status: 413,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const respHeaders = new Headers();
  for (const k of ["content-type", "content-length", "etag", "last-modified"]) {
    const v = upstream.headers.get(k);
    if (v) respHeaders.set(k, v);
  }
  // Cache: 200 for 7 days (NFT metadata is effectively immutable
  // post-reveal). 4xx for 1 hour (client error from upstream POV).
  // 5xx for 60s (transient).
  let cacheTtl = 604800;
  if (!upstream.ok) cacheTtl = upstream.status >= 500 ? 60 : 3600;
  respHeaders.set("Cache-Control", `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`);

  // Stream the body through a size-capping TransformStream so an
  // upstream that lies about content-length can't blow past MAX_BYTES.
  const body = upstream.body;
  if (!body) {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }
  let bytesSeen = 0;
  const capped = body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytesSeen += chunk.byteLength;
        if (bytesSeen > MAX_BYTES) {
          controller.error(new Error("response exceeded MAX_BYTES"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(capped, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
