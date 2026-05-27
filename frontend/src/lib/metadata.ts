import { IPFS_GATEWAYS } from "@/config/constants";
import type { NftMetadata } from "@/types/nft";
import {
  canProxyUrl,
  markProxyPreferred,
  proxyUrlFor,
  shouldUseProxy,
} from "@/lib/proxyRouter";

/**
 * Frontend metadata resolution is indexer-first (collection-level sample
 * images + per-token imageUrlTemplate substitution cover the vast majority
 * of render paths without ever calling a metadata host from the browser).
 *
 * For the remaining direct fetches (token detail page, trait enumeration,
 * legacy fallbacks): IPFS-shaped URIs race public gateways, and HTTP
 * URIs go directly to the host — except for hosts on the worker
 * allowlist (`PROXY_HOST_PATTERNS`) which don't send CORS headers and
 * must be routed through `ipfs-cache.devskibb.workers.dev/proxy?url=…`
 * to be readable from the browser. A direct fetch that fails with a
 * TypeError (the browser's CORS-block signature) is retried through the
 * proxy and the host gets remembered as "proxy-preferred" for 24h.
 */

/**
 * Hosts whose DNS is gone or known permanently broken — fast-fail
 * before issuing any network request so the console isn't spammed.
 */
const DEAD_HOSTS = [
  /^([a-z0-9-]+\.)?codepunks\.fun$/i,
];

function isDeadHost(url: string): boolean {
  try {
    const host = new URL(url).host;
    return DEAD_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/**
 * Pull a `(cid, path)` pair out of any IPFS-shaped URL.
 *
 * Strategy (in order):
 *   1. Direct `ipfs://<cid>/<path>` extraction. Fast path for the
 *      common case where the URI is well-formed. We accept anything
 *      after the scheme as the CID — even if it doesn't strictly match
 *      a known CID prefix — because broken contracts that return
 *      `ipfs://gateway/...` would otherwise leak through to a 404.
 *   2. Subdomain pattern `https://<cid>.ipfs.<host>/<path>`.
 *   3. Path pattern `https://<host>/ipfs/<cid>/<path>`.
 *   4. Fallback: search for the LAST CID-shaped substring (`Qm…` or
 *      `baf…`) anywhere in the URI. Handles malformed nested forms like
 *      `ipfs://gateway/ipfs/<real-cid>/<path>`.
 *
 * Step 4 uses a permissive CID pattern. CIDv1-base32-sha256 is 59 chars,
 * so we accept `baf[a-z2-7]{52,}`. A 44-char Qm-prefix CIDv0 is also
 * accepted. Older too-strict patterns (>60 chars) were rejecting valid
 * CIDs and causing `fetch("ipfs://…")` calls the browser can't handle.
 */
const CID_PATTERN =
  /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{52,})/gi;

function looksLikeCid(s: string): boolean {
  if (!s) return false;
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{52,})$/i.test(s);
}

function findLastCid(uri: string): { idx: number; cid: string } | null {
  let last: { idx: number; cid: string } | null = null;
  let match: RegExpExecArray | null;
  CID_PATTERN.lastIndex = 0;
  while ((match = CID_PATTERN.exec(uri)) !== null) {
    last = { idx: match.index, cid: match[1] };
  }
  return last;
}

function parseIpfsUri(uri: string): { cid: string; path: string } | null {
  if (!uri) return null;

  // 1. ipfs:// direct
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    const slash = rest.indexOf("/");
    const cidGuess = slash >= 0 ? rest.slice(0, slash) : rest;
    const pathGuess = slash >= 0 ? rest.slice(slash) : "";
    if (looksLikeCid(cidGuess)) {
      return { cid: cidGuess, path: pathGuess };
    }
    // Malformed (e.g. ipfs://gateway/ipfs/<cid>/…) — fall through to search
  }

  // 2. Subdomain form: https://<cid>.ipfs.<host>/<path>
  const sub = uri.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub && looksLikeCid(sub[1])) {
    return { cid: sub[1], path: sub[2] || "" };
  }

  // 3. Path form: https://<host>/ipfs/<cid>/<path>
  const pth = uri.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth && looksLikeCid(pth[1])) {
    return { cid: pth[1], path: (pth[2] || "") + (pth[3] || "") };
  }

  // 4. Fallback: find ANY CID anywhere in the URI (handles malformed
  // nested forms like ipfs://gateway/ipfs/<real-cid>/<path>).
  const last = findLastCid(uri);
  if (last) {
    const after = uri.slice(last.idx + last.cid.length);
    const path = after.startsWith("/") ? after : after ? "/" + after : "";
    return { cid: last.cid, path };
  }

  return null;
}

export function resolveUri(uri: string, gatewayIndex = 0): string {
  if (!uri) return "";
  const ipfs = parseIpfsUri(uri);
  if (ipfs) {
    const gateway = IPFS_GATEWAYS[gatewayIndex % IPFS_GATEWAYS.length];
    return gateway + ipfs.cid + ipfs.path;
  }
  if (uri.startsWith("ar://")) {
    return "https://arweave.net/" + uri.slice("ar://".length);
  }
  return uri;
}

/**
 * Normalize ANY IPFS-shaped URL to canonical `ipfs://<cid>/<path>`. Lets
 * <img> consumers carry the CID through error fallback so they can step
 * across gateways even when the metadata JSON returned a hardcoded
 * gateway URL instead of `ipfs://`. Returns undefined for non-IPFS URLs.
 */
export function toCanonicalIpfsUri(uri: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("ipfs://")) return uri;
  if (uri.startsWith("ar://")) return uri;
  const parsed = parseIpfsUri(uri);
  if (parsed) return `ipfs://${parsed.cid}${parsed.path}`;
  return undefined;
}

/**
 * Fetch the URL with retries on transient failures.
 *
 * Retryable:
 *   - TypeError (network failure, preflight timeout, CORS-opaque)
 *   - 429 Too Many Requests (with longer backoff and Retry-After
 *     honored when present)
 *   - 5xx
 *
 * Terminal: any other 4xx (404, etc).
 *
 * The 429 path uses a separate backoff schedule because rate limits
 * usually want seconds, not the sub-second short backoff that suits
 * network blips. We also clamp the Retry-After value so a hostile
 * gateway can't stall us forever.
 */
async function fetchTextWithRetry(
  url: string,
  attempts = 3,
  timeoutMs = 10_000,
): Promise<string> {
  let lastErr: Error | null = null;
  // Pick the initial URL: route through the worker proxy if the host is
  // on the allowlist OR previously CORS-failed. On a TypeError below we
  // retry once through the proxy and remember the host for next time.
  let effectiveUrl = shouldUseProxy(url) ? proxyUrlFor(url) : url;
  let proxiedAlready = effectiveUrl !== url;
  for (let i = 0; i < attempts; i++) {
    let delayBeforeNext = 200 * Math.pow(3, i); // 200ms, 600ms default
    try {
      const response = await fetch(effectiveUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        credentials: "omit",
        // `origin` (not `no-referrer`) lets hosts that gate CORS on the
        // Referer header still serve us. Sends `https://minti.art/` only,
        // not the full path — privacy-equivalent for the "don't leak
        // token paths" goal that the original no-referrer was protecting.
        referrerPolicy: "origin",
      });
      if (response.ok) return await response.text();
      if (response.status === 429) {
        // Rate-limited: retryable with longer backoff. Respect
        // Retry-After header when present (seconds or HTTP-date).
        // Clamp to 10s so a hostile/buggy gateway can't park us.
        const retryAfter = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        delayBeforeNext = Math.min(10_000, retryAfter ?? 1500 * (i + 1));
        lastErr = new Error("rate limited (429)");
      } else if (response.status >= 400 && response.status < 500) {
        // Other 4xx (404 etc) is terminal.
        throw new Error(`Failed to fetch metadata: ${response.status}`);
      } else if (proxiedAlready) {
        // 5xx through the proxy: the Cloudflare worker negative-caches
        // upstream 5xx for 60s, so retrying gets the same 502 back
        // unchanged. Treat as terminal to stop the console-spam storm.
        throw new Error(`Failed to fetch metadata: ${response.status}`);
      } else {
        // 5xx on a direct fetch — retryable, default short backoff.
        lastErr = new Error(`Failed to fetch metadata: ${response.status}`);
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Abort/timeout/typeerror - all retryable, short backoff.
      // TypeError on a direct fetch is the browser's CORS-block tell.
      // If the host is on the worker allowlist, swap to the proxy URL
      // for the remaining attempts AND remember this host so future
      // calls skip the wasted direct attempt.
      if (
        !proxiedAlready &&
        lastErr instanceof TypeError &&
        canProxyUrl(url)
      ) {
        markProxyPreferred(url);
        effectiveUrl = proxyUrlFor(url);
        proxiedAlready = true;
        // Don't wait the full backoff — proxy is a different host
        delayBeforeNext = 0;
      }
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayBeforeNext));
    }
  }
  throw lastErr ?? new Error("Failed to fetch metadata");
}

/** Parse the `Retry-After` header (seconds OR HTTP-date). */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

async function fetchWithGatewayFallback(uri: string): Promise<string> {
  // BELT-AND-SUSPENDERS: parseIpfsUri should catch every ipfs:/* form,
  // but if it ever returns null for one we still must not call
  // fetch("ipfs://…") — the browser rejects with "URL scheme not
  // supported". Strip the scheme + slashes and route to a public gateway.
  if (/^ipfs:\/{1,2}/i.test(uri)) {
    const stripped = uri.replace(/^ipfs:\/{1,2}/i, "");
    const gateway = IPFS_GATEWAYS[0] ?? "https://ipfs.io/ipfs/";
    return fetchTextWithRetry(gateway + stripped);
  }

  const ipfs = parseIpfsUri(uri);

  // Non-IPFS URI. Two paths:
  //   - Known-dead host (codepunks.fun, etc.) → throw immediately.
  //   - Anything else → fetch with retry. Same host returning 200 for
  //     most tokens but a flaky failure for a few is the signature of
  //     a transient (rate limit, TCP reset) — retry usually wins.
  if (!ipfs) {
    const resolved = resolveUri(uri);
    if (isDeadHost(resolved)) {
      throw new Error("Metadata host is dead");
    }
    return fetchTextWithRetry(resolved);
  }

  // IPFS-shaped URI — race all gateways in parallel. Whichever returns
  // first wins; we abort the losers via AbortController so the browser
  // stops downloading their bodies (saves bandwidth and console noise).
  //
  // The IPFS_GATEWAYS list starts with our own Cloudflare cache worker
  // (when configured) which usually replies in <50ms for repeat reads.
  const ctrls = IPFS_GATEWAYS.map(() => new AbortController());
  // Auto-cancel everything after 10s as a global timeout
  const globalTimeout = setTimeout(
    () => ctrls.forEach((c) => c.abort()),
    10_000,
  );

  const attempts = IPFS_GATEWAYS.map(async (gateway, i) => {
    const url = gateway + ipfs.cid + ipfs.path;
    const response = await fetch(url, { signal: ctrls[i].signal });
    if (!response.ok) throw new Error(`gateway ${gateway}: ${response.status}`);
    const text = await response.text();
    return { text, idx: i };
  });

  try {
    const winner = await Promise.any(attempts);
    // Cancel all losers so their pending downloads stop
    ctrls.forEach((c, i) => {
      if (i !== winner.idx) c.abort();
    });
    return winner.text;
  } catch (err) {
    // Every gateway failed
    const inner =
      err instanceof AggregateError && err.errors[0] instanceof Error
        ? err.errors[0]
        : (err as Error);
    throw inner || new Error("All IPFS gateways failed");
  } finally {
    clearTimeout(globalTimeout);
  }
}

/**
 * `{id}` template variants per ERC-1155 spec and common deviations:
 *
 *   - Padded hex (64 chars): spec-correct ERC-1155 form
 *   - Decimal: every "1.json" / "2.json" collection
 *   - Unpadded hex: some Polygon/optimism collections
 *
 * We try them in order on 404 so a contract whose actual files are at
 * `1.json` still resolves even though it returned `baseURI + {id}`.
 */
function idVariants(tokenId: bigint): string[] {
  const decimal = tokenId.toString();
  const padded = tokenId.toString(16).padStart(64, "0");
  const unpadded = tokenId.toString(16);
  return [padded, decimal, unpadded];
}

export async function resolveMetadata(
  uri: string,
  tokenId: bigint
): Promise<NftMetadata> {
  // data: URIs don't need {id} expansion or gateway fallback.
  if (uri.startsWith("data:")) {
    return parseMetadataJson(decodeDataUri(uri), tokenId);
  }

  const hasTemplate = uri.includes("{id}");
  const variants = hasTemplate ? idVariants(tokenId) : [""];

  let lastErr: Error | null = null;
  for (const v of variants) {
    const resolvedUri = hasTemplate ? uri.replace(/\{id\}/g, v) : uri;
    try {
      const jsonString = await fetchWithGatewayFallback(resolvedUri);
      return parseMetadataJson(jsonString, tokenId);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Only retry with alternate variants on plausibly-recoverable failures
      // (404 / not found). For non-template URIs there's just the one path
      // to try anyway.
    }
  }
  throw lastErr ?? new Error("Failed to resolve metadata");
}

function decodeDataUri(uri: string): string {
  if (uri.startsWith("data:application/json;base64,")) {
    return atob(uri.slice("data:application/json;base64,".length));
  }
  if (uri.startsWith("data:application/json,")) {
    return decodeURIComponent(uri.slice("data:application/json,".length));
  }
  if (uri.startsWith("data:application/json;utf8,")) {
    return uri.slice("data:application/json;utf8,".length);
  }
  throw new Error(`Unsupported data: URI`);
}

function parseMetadataJson(jsonString: string, tokenId: bigint): NftMetadata {
  const raw = JSON.parse(jsonString);

  // Prefer `image`/`image_url`. Fall back to `image_data` which per the
  // OpenSea spec is raw SVG/HTML body — wrap it in a data: URI so the
  // browser can render it from `<img src=>`. Without this wrap, on-chain
  // SVG collections (NFTs2Me, many "100% on-chain" launches) render as
  // 404s and their cards get pruned by our "no image = hide" rule.
  let image = raw.image || raw.image_url || "";
  if (!image && raw.image_data) {
    image = svgToDataUri(raw.image_data);
  } else if (image && looksLikeRawSvgOrHtml(image)) {
    // Some contracts misuse `image` for raw SVG/HTML body. Wrap if so.
    image = svgToDataUri(image);
  }

  return {
    name: raw.name || `#${tokenId.toString()}`,
    description: raw.description || "",
    image: image ? resolveUri(image) : "",
    // Normalize to canonical ipfs:// so NftImage can step across gateways
    // on error — even when the JSON hardcoded a 4everland/dweb URL whose
    // specific gateway is 502ing today.
    rawImageUri: typeof image === "string" ? toCanonicalIpfsUri(image) : undefined,
    animationUrl: raw.animation_url ? resolveUri(raw.animation_url) : undefined,
    attributes: raw.attributes || [],
    externalUrl: raw.external_url,
    raw,
  };
}

function looksLikeRawSvgOrHtml(s: string): boolean {
  const trimmed = s.trim().slice(0, 64).toLowerCase();
  return (
    trimmed.startsWith("<svg") ||
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<!doctype")
  );
}

function svgToDataUri(body: string): string {
  // If the caller already wrapped it, pass through.
  if (body.startsWith("data:")) return body;
  // Base64 encode to handle any character safely.
  // btoa requires Latin-1 — use URL encoding + unescape for unicode safety.
  try {
    const utf8 = unescape(encodeURIComponent(body));
    return `data:image/svg+xml;base64,${btoa(utf8)}`;
  } catch {
    // Fallback to URL-encoded utf-8 (works for ASCII-only SVGs)
    return `data:image/svg+xml;utf8,${encodeURIComponent(body)}`;
  }
}

// ─── BaseURI extrapolation ─────────────────────────────────────────
// Many collections expose token URIs of the form `ipfs://CID/<id>.json` (or
// with no extension, or with different extensions per token). For
// thumbnail grids we don't need to read every token's metadata from chain
// — once we have ONE reference token's tokenURI + image URL, we can
// synthesize the rest by string-replacing the tokenId.
//
// This is intentionally cheap and best-effort: we look for an exact
// occurrence of the reference tokenId (as decimal AND as hex) in the
// reference URL. If found, we swap it for the target tokenId. If not
// (some collections use random per-token CIDs or off-chain APIs), the
// caller falls back to per-token resolution.

/**
 * Try to derive the image URL for `targetTokenId` from a known reference.
 * Returns null when the reference URL doesn't contain a recognisable
 * tokenId substring — in which case the caller should fetch normally.
 *
 * Heuristic: scan for the reference tokenId expressed as decimal, then as
 * hex (padded and unpadded). Whichever appears in the URL is the
 * substitution slot. Last-occurrence wins (collections often have the CID
 * earlier in the URL — that part is content-addressed and shouldn't be
 * rewritten).
 */
export function extrapolateImageUrl(
  referenceImageUrl: string,
  referenceTokenId: bigint,
  targetTokenId: bigint,
): string | null {
  if (!referenceImageUrl) return null;
  if (referenceTokenId === targetTokenId) return referenceImageUrl;

  const candidates: Array<{ refStr: string; targetStr: string }> = [];
  const refDec = referenceTokenId.toString();
  const refHex = referenceTokenId.toString(16);
  const refHexPad = refHex.padStart(64, "0");
  const targetDec = targetTokenId.toString();
  const targetHex = targetTokenId.toString(16);
  const targetHexPad = targetHex.padStart(64, "0");
  candidates.push({ refStr: refHexPad, targetStr: targetHexPad });
  candidates.push({ refStr: refDec, targetStr: targetDec });
  if (refHex !== refDec) {
    candidates.push({ refStr: refHex, targetStr: targetHex });
  }

  for (const { refStr, targetStr } of candidates) {
    const idx = referenceImageUrl.lastIndexOf(refStr);
    if (idx === -1) continue;
    // Avoid false matches inside the CID — only accept if the slot is
    // bounded by non-base58/hex characters (path separator, dot, query).
    const before = referenceImageUrl[idx - 1];
    const after = referenceImageUrl[idx + refStr.length];
    const isBoundary = (ch: string | undefined) =>
      ch == null || !/[A-Za-z0-9]/.test(ch);
    if (!isBoundary(before) || !isBoundary(after)) continue;

    return (
      referenceImageUrl.slice(0, idx) +
      targetStr +
      referenceImageUrl.slice(idx + refStr.length)
    );
  }
  return null;
}

/**
 * Build a templatized URI from a reference URI + reference tokenId so
 * the template can be expanded for arbitrary other tokenIds without a
 * tokenURI multicall. Returns `referenceUri` unchanged if it already
 * contains `{id}`, the templatized form with `{id}` substituted where
 * the reference id appeared, or null when no boundary-safe slot for
 * the reference id is found (per-token unique CIDs, off-chain APIs).
 *
 * Same boundary heuristic as `extrapolateImageUrl` — only accept slots
 * where the surrounding characters are non-alphanumeric so we don't
 * rewrite part of a CID.
 */
export function buildUriTemplate(
  referenceUri: string,
  referenceTokenId: bigint,
): string | null {
  if (!referenceUri) return null;
  if (referenceUri.includes("{id}")) return referenceUri;
  const refDec = referenceTokenId.toString();
  const refHex = referenceTokenId.toString(16);
  const refHexPad = refHex.padStart(64, "0");
  const candidates = [refHexPad, refDec, ...(refHex !== refDec ? [refHex] : [])];
  for (const refStr of candidates) {
    const idx = referenceUri.lastIndexOf(refStr);
    if (idx === -1) continue;
    const before = referenceUri[idx - 1];
    const after = referenceUri[idx + refStr.length];
    const isBoundary = (ch: string | undefined) =>
      ch == null || !/[A-Za-z0-9]/.test(ch);
    if (!isBoundary(before) || !isBoundary(after)) continue;
    return (
      referenceUri.slice(0, idx) +
      "{id}" +
      referenceUri.slice(idx + refStr.length)
    );
  }
  return null;
}

/** Expand a `{id}`-containing template for the given tokenId. */
export function expandUriTemplate(template: string, tokenId: bigint): string {
  if (!template.includes("{id}")) return template;
  // Prefer decimal substitution — most collections that template their
  // baseURI use decimal IDs. ERC-1155 spec's padded-hex is rarer in the
  // wild than the spec implies; `resolveMetadata`'s `idVariants` will
  // try padded hex as a fallback if the decimal-expanded URL 404s.
  return template.replace(/\{id\}/g, tokenId.toString());
}

/**
 * Probe extension variants for a synthesized URL. Used when a collection
 * has heterogeneous file extensions (e.g. most tokens are .png but a few
 * are .gif). Returns the first variant that responds 200.
 *
 * Best-effort and slow (one HEAD per variant). Only call this from places
 * that need it — most callers can use `extrapolateImageUrl` directly and
 * trust the inferred extension.
 */
export async function findWorkingExtension(
  urlWithExtension: string,
  alternatives: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp"],
): Promise<string | null> {
  const m = urlWithExtension.match(/^(.*)\.([a-z0-9]+)(\?[^#]*|#.*)?$/i);
  if (!m) return urlWithExtension;
  const [, base, ext, suffix = ""] = m;
  const order = [ext, ...alternatives.filter((e) => e !== ext)];
  for (const candidate of order) {
    const candidateUrl = `${base}.${candidate}${suffix}`;
    try {
      const resp = await fetch(candidateUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) return candidateUrl;
    } catch {
      // try next
    }
  }
  return null;
}
