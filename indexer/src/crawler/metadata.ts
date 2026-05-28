/**
 * Pure metadata-resolution primitives. No DB, no RPC, no env — just
 * functions that take a string in and return a string out. Mirrors the
 * shape of `scripts/lib/precheck.mjs` so behavior stays consistent
 * across the cron-style snapshot path (still running) and the indexer.
 *
 * Used by:
 *   - enrichment.ts (per-collection sample fetch at index time)
 *   - the eventual per-token metadata fetcher (polling loop)
 *
 * Server-side has no CORS, so we reach scatter / lootgo / R2 buckets
 * directly. For IPFS we race public gateways and take the first 200.
 */

const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

const FETCH_TIMEOUT_MS = 8_000;

// CIDv0 (Qm-prefix base58, 46 chars) OR CIDv1 (base32 sha256, 59 chars).
const CID_RE = /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{52,})/i;

function looksLikeCid(s: string): boolean {
  return CID_RE.test(s) && new RegExp(`^${CID_RE.source}$`, "i").test(s);
}

export function parseIpfsLike(uri: string): { cid: string; path: string } | null {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    const slash = rest.indexOf("/");
    const cid = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash) : "";
    if (looksLikeCid(cid)) return { cid, path };
  }
  const sub = uri.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub && sub[1] && looksLikeCid(sub[1])) return { cid: sub[1], path: sub[2] ?? "" };
  const pth = uri.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth && pth[1] && looksLikeCid(pth[1])) {
    return { cid: pth[1], path: (pth[2] ?? "") + (pth[3] ?? "") };
  }
  return null;
}

/**
 * Pull an image URL out of an arbitrary NFT metadata JSON. The spec
 * says `image`, but in practice we see many variants — try them all.
 */
export function extractImageField(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const props = (j.properties && typeof j.properties === "object")
    ? (j.properties as Record<string, unknown>)
    : null;
  const propsImageObj = props && typeof props.image === "object"
    ? (props.image as Record<string, unknown>)
    : null;
  const propsImageUrlObj = props && typeof props.image_url === "object"
    ? (props.image_url as Record<string, unknown>)
    : null;
  const candidates: unknown[] = [
    j.image,
    j.image_url,
    j.imageUrl,
    j.imageURL,
    j.imageUri,
    j.imageURI,
    j.image_data,
    propsImageObj?.value,
    props?.image,
    propsImageUrlObj?.value,
    props?.image_url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

export function resolveImageUriToHttps(image: string | null): string | null {
  if (!image || typeof image !== "string") return null;
  if (image.startsWith("data:")) return image;
  if (image.startsWith("ar://")) {
    return "https://arweave.net/" + image.slice("ar://".length);
  }
  const ipfs = parseIpfsLike(image);
  if (ipfs) return `${IPFS_GATEWAYS[0]}${ipfs.cid}${ipfs.path}`;
  if (image.startsWith("http://") || image.startsWith("https://")) return image;
  return null;
}

function decodeDataUriJson(uri: string): string | null {
  if (uri.startsWith("data:application/json;base64,")) {
    return Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8");
  }
  if (uri.startsWith("data:application/json,")) {
    return decodeURIComponent(uri.slice("data:application/json,".length));
  }
  if (uri.startsWith("data:application/json;utf8,")) {
    return uri.slice("data:application/json;utf8,".length);
  }
  return null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`) as Error & {
        httpStatus?: number;
        retryAfterMs?: number;
      };
      err.httpStatus = resp.status;
      if (resp.status === 429) {
        err.retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
      }
      throw err;
    }
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

/** Parse a `Retry-After` header (seconds or HTTP-date) → ms, clamped. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(30_000, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(30_000, date - Date.now()));
  return 0;
}

/**
 * Fetch text with retry on rate-limit (429) and transient 5xx. Rate-
 * limited gateways (Pinata's `*.mypinata.cloud`, some R2 buckets) will
 * 429 a burst of concurrent requests; without this, every token in a
 * collection on such a host fails and the whole collection is marked
 * broken. Honors `Retry-After`, clamps to 30s, gives up after `attempts`.
 *
 * Terminal (no retry): any non-429 4xx (404 etc) — those won't get
 * better by waiting.
 */
async function fetchTextWithRetry(
  url: string,
  timeoutMs: number,
  attempts = 4,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchWithTimeout(url, timeoutMs);
    } catch (err) {
      const e = err as Error & { httpStatus?: number; retryAfterMs?: number };
      lastErr = e;
      const status = e.httpStatus;
      // Non-429 client errors are terminal.
      if (status != null && status >= 400 && status < 500 && status !== 429) {
        throw e;
      }
      if (i < attempts - 1) {
        // 429 → honor Retry-After (or exponential default). 5xx /
        // network → exponential backoff with jitter.
        const base =
          status === 429
            ? e.retryAfterMs && e.retryAfterMs > 0
              ? e.retryAfterMs
              : 1000 * (i + 1)
            : 300 * Math.pow(2, i);
        const jitter = Math.floor(Math.random() * 250);
        await sleep(base + jitter);
      }
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the metadata JSON for a tokenURI. Handles:
 *   - data:application/json URIs (inline)
 *   - ipfs:// and gateway-shaped URLs (race public gateways)
 *   - direct https URLs (one-shot fetch)
 *
 * Returns null on any failure — caller decides whether to mark the
 * collection broken or retry later.
 */
export async function fetchMetadataJson(uri: string): Promise<unknown | null> {
  if (!uri) return null;
  if (uri.startsWith("data:")) {
    const decoded = decodeDataUriJson(uri);
    if (!decoded) return null;
    try { return JSON.parse(decoded); } catch { return null; }
  }
  const ipfs = parseIpfsLike(uri);
  if (ipfs) {
    const ctrls = IPFS_GATEWAYS.map(() => new AbortController());
    const attempts = IPFS_GATEWAYS.map(async (gw, i) => {
      const t = setTimeout(() => ctrls[i]!.abort(), FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(`${gw}${ipfs.cid}${ipfs.path}`, { signal: ctrls[i]!.signal });
        if (!resp.ok) throw new Error(`${resp.status}`);
        return await resp.text();
      } finally {
        clearTimeout(t);
      }
    });
    try {
      const text = await Promise.any(attempts);
      ctrls.forEach((c) => c.abort());
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    try {
      // Retry-aware: rate-limited gateways (Pinata etc.) 429 bursts;
      // retrying with Retry-After backoff recovers the token instead
      // of dropping it and marking the whole collection broken.
      const text = await fetchTextWithRetry(uri, FETCH_TIMEOUT_MS);
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }
  return null;
}

export function expandIdTemplate(uri: string, tokenId: bigint): string {
  if (!uri || !uri.includes("{id}")) return uri;
  const dec = tokenId.toString();
  const hex64 = tokenId.toString(16).padStart(64, "0");
  return uri.replace(/\{id\}/g, hex64).replace(/\{decimalId\}/g, dec);
}

/**
 * Given a resolved image URL for a known sample tokenId, try to detect
 * where the tokenId appears and produce a `{id}`-templated string.
 * Returns null when the URL doesn't contain a recognizable tokenId slot
 * (content-addressed per token, or data: URI).
 */
export function buildImageUrlTemplate(
  resolvedImageUrl: string | null,
  sampleTokenId: bigint,
): string | null {
  if (!resolvedImageUrl) return null;
  if (resolvedImageUrl.startsWith("data:")) return null;
  const refDec = sampleTokenId.toString();
  const refHex = sampleTokenId.toString(16);
  const refHexPad = refHex.padStart(64, "0");

  const candidates = [refHexPad, refDec];
  if (refHex !== refDec) candidates.push(refHex);

  const isBoundary = (ch: string | undefined): boolean =>
    ch == null || !/[A-Za-z0-9]/.test(ch);

  for (const refStr of candidates) {
    // Scan from right to left through EVERY occurrence of refStr. Take
    // the rightmost one where both sides are non-alphanumeric (so we
    // don't mistake a "1" inside a CID or a timestamp for the tokenId
    // slot). Previously we only checked the absolute last occurrence
    // and gave up if its boundaries failed — that missed collections
    // like scatter's `?tokenId=1&v=177578...` where the timestamp has
    // more digits past the real id.
    let searchFrom = resolvedImageUrl.length;
    while (true) {
      const idx = resolvedImageUrl.lastIndexOf(refStr, searchFrom - 1);
      if (idx === -1) break;
      const before = resolvedImageUrl[idx - 1];
      const after = resolvedImageUrl[idx + refStr.length];
      if (isBoundary(before) && isBoundary(after)) {
        return (
          resolvedImageUrl.slice(0, idx) +
          "{id}" +
          resolvedImageUrl.slice(idx + refStr.length)
        );
      }
      searchFrom = idx;
    }
  }
  return null;
}
