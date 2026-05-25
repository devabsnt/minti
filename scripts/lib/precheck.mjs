/**
 * Metadata precheck primitives shared between the full builder
 * (`build-collections-index.mjs`) and the local refresh tool
 * (`refresh-metadata.mjs`). All HTTP/multicall logic for resolving a
 * collection's sample metadata lives here so the two callers can't drift
 * apart.
 *
 * Server-side has no CORS, so this reaches scatter / lootgo / R2 buckets
 * that the browser can't. We bake the discovered image URL (and a
 * `{id}`-templated form when the URL contains the tokenId in a
 * boundary-safe slot) into the snapshot so the frontend can paint
 * thumbnails with zero runtime metadata fetches.
 */

// ── constants ─────────────────────────────────────────────────────

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Public IPFS gateways racing in parallel — same set as the frontend,
// minus dweb.link (chronic 504 on cold reads).
export const PRECHECK_IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

export const PRECHECK_FETCH_TIMEOUT_MS = 8_000;

// Default batch size — small because each batch triggers ≤N HTTP fetches.
// Override per-caller as needed.
export const PRECHECK_BATCH_SIZE = 20;

export const TOKEN_URI_ABI = [
  {
    name: "tokenURI",
    inputs: [{ type: "uint256", name: "tokenId" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    name: "uri",
    inputs: [{ type: "uint256", name: "id" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

// CIDv1 (base32 sha256, 59 chars) OR CIDv0 (Qm-prefix base58, 46 chars).
const CID_RE = /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{52,})/i;

function looksLikeCid(s) {
  return !!s && CID_RE.test(s) && new RegExp(`^${CID_RE.source}$`, "i").test(s);
}

// ── URL helpers ───────────────────────────────────────────────────

export function parseIpfsLike(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    const slash = rest.indexOf("/");
    const cid = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash) : "";
    if (looksLikeCid(cid)) return { cid, path };
  }
  const sub = uri.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub && looksLikeCid(sub[1])) return { cid: sub[1], path: sub[2] || "" };
  const pth = uri.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth && looksLikeCid(pth[1])) {
    return { cid: pth[1], path: (pth[2] || "") + (pth[3] || "") };
  }
  return null;
}

export function resolveImageUriToHttps(image) {
  if (!image || typeof image !== "string") return null;
  if (image.startsWith("data:")) return image;
  if (image.startsWith("ar://")) {
    return "https://arweave.net/" + image.slice("ar://".length);
  }
  const ipfs = parseIpfsLike(image);
  if (ipfs) return `${PRECHECK_IPFS_GATEWAYS[0]}${ipfs.cid}${ipfs.path}`;
  if (image.startsWith("http://") || image.startsWith("https://")) return image;
  return null;
}

function decodeDataUriJson(uri) {
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

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchMetadataJson(uri) {
  if (!uri) return null;
  if (uri.startsWith("data:")) {
    const decoded = decodeDataUriJson(uri);
    if (!decoded) return null;
    try { return JSON.parse(decoded); } catch { return null; }
  }
  // IPFS-shaped: race public gateways. Any 200 wins.
  const ipfs = parseIpfsLike(uri);
  if (ipfs) {
    const ctrls = PRECHECK_IPFS_GATEWAYS.map(() => new AbortController());
    const attempts = PRECHECK_IPFS_GATEWAYS.map(async (gw, i) => {
      const t = setTimeout(() => ctrls[i].abort(), PRECHECK_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(`${gw}${ipfs.cid}${ipfs.path}`, { signal: ctrls[i].signal });
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
  // Centralized URL. Node has no CORS, so a direct fetch reaches scatter
  // and friends even if the browser can't.
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    try {
      const text = await fetchWithTimeout(uri, PRECHECK_FETCH_TIMEOUT_MS);
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }
  return null;
}

// ── JSON shape helpers ────────────────────────────────────────────

/**
 * Pull an image URL out of an arbitrary NFT metadata JSON. The OpenSea
 * spec says `image`, but in practice we see:
 *   - `image` / `image_url` — most common
 *   - `imageUrl` / `imageURL` — camelCase variants (NFTs2Me, some custom)
 *   - `imageUri` / `imageURI` — Solidity-style naming
 *   - `image_data` — raw SVG body per OpenSea spec
 *   - nested `properties.image{,_url}.value` / direct nested form — older
 *     ERC-1155 spec form, still used by a few collections
 *
 * Returns the first stringly-non-empty value found, or null.
 */
export function extractImageField(json) {
  if (!json || typeof json !== "object") return null;
  const candidates = [
    json.image,
    json.image_url,
    json.imageUrl,
    json.imageURL,
    json.imageUri,
    json.imageURI,
    json.image_data,
    json.properties?.image?.value,
    json.properties?.image,
    json.properties?.image_url?.value,
    json.properties?.image_url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

export function expandIdTemplate(uri, tokenId) {
  if (!uri || !uri.includes("{id}")) return uri;
  const dec = tokenId.toString();
  const hex64 = tokenId.toString(16).padStart(64, "0");
  // ERC-1155 spec wants the 64-char padded hex; some collections shipped
  // decimal anyway. Try padded first since that's what the spec mandates.
  return uri.replace(/\{id\}/g, hex64).replace(/\{decimalId\}/g, dec);
}

/**
 * Given a resolved image URL for a known sample tokenId, try to detect
 * where the tokenId appears and produce a `{id}`-templated string. Lets
 * the frontend render every token's thumbnail by `template.replace('{id}',
 * tokenId)` instead of doing a per-token metadata fetch.
 *
 * Returns null when the URL doesn't contain a recognizable tokenId slot —
 * either it's content-addressed (image is at `ipfs://<unique-CID-per-
 * token>/...`, no template possible) or the URL is a data: URI (the
 * image IS the content, no template needed).
 */
export function buildImageUrlTemplate(resolvedImageUrl, sampleTokenId) {
  if (!resolvedImageUrl) return null;
  if (resolvedImageUrl.startsWith("data:")) return null;
  const tid = BigInt(sampleTokenId);
  const refDec = tid.toString();
  const refHex = tid.toString(16);
  const refHexPad = refHex.padStart(64, "0");

  // Try padded hex first (ERC-1155 spec), then decimal, then unpadded hex.
  const candidates = [refHexPad, refDec];
  if (refHex !== refDec) candidates.push(refHex);

  const isBoundary = (ch) => ch == null || !/[A-Za-z0-9]/.test(ch);
  for (const refStr of candidates) {
    // lastIndexOf so the CID (early in the URL, also alphanumeric) isn't
    // mistaken for the tokenId.
    const idx = resolvedImageUrl.lastIndexOf(refStr);
    if (idx === -1) continue;
    const before = resolvedImageUrl[idx - 1];
    const after = resolvedImageUrl[idx + refStr.length];
    if (!isBoundary(before) || !isBoundary(after)) continue;
    return (
      resolvedImageUrl.slice(0, idx) +
      "{id}" +
      resolvedImageUrl.slice(idx + refStr.length)
    );
  }
  return null;
}

// ── RPC / batch ───────────────────────────────────────────────────

/**
 * Multicall tokenURI / uri for a batch of contracts. Each batch entry must
 * have { address, sampleTokenId, is721, is1155 }. Returns an array of
 * strings (or null when the call failed/returned empty) parallel to the
 * input array.
 */
export async function tokenUriBatch(client, contracts) {
  const calls = contracts.map((c) => ({
    address: c.address,
    abi: TOKEN_URI_ABI,
    functionName: c.is1155 && !c.is721 ? "uri" : "tokenURI",
    args: [BigInt(c.sampleTokenId)],
  }));
  const results = await client.multicall({
    contracts: calls,
    multicallAddress: MULTICALL3_ADDRESS,
    allowFailure: true,
  });
  return results.map((r) =>
    r.status === "success" && typeof r.result === "string" && r.result.length > 0
      ? r.result
      : null,
  );
}

/**
 * Resolve a batch of collections to precheck results.
 *
 * Each result has:
 *   metadataChecked     — true on RPC + extraction success path, false if
 *                         the RPC multicall itself errored (the batch
 *                         caller may want to retry on a different client).
 *   metadataBroken      — true if tokenURI reverted, returned empty, or
 *                         JSON couldn't be resolved.
 *   tokenUriTemplate    — raw string returned by tokenURI/uri.
 *   sampleImageUrl      — the image field of the resolved JSON, mapped
 *                         to an https/data URL.
 *   imageUrlTemplate    — `{id}`-templated form of sampleImageUrl when
 *                         the URL contains the tokenId.
 *   isOnChainMetadata   — tokenURI was a data: URI.
 */
export async function precheckMetadataBatch(client, batch) {
  const results = new Map();
  let uris;
  try {
    uris = await tokenUriBatch(client, batch);
  } catch (err) {
    for (const c of batch) {
      results.set(c.address.toLowerCase(), { metadataChecked: false });
    }
    return results;
  }

  await Promise.all(
    batch.map(async (c, i) => {
      const addr = c.address.toLowerCase();
      const rawUri = uris[i];
      if (!rawUri) {
        results.set(addr, {
          metadataChecked: true,
          metadataBroken: true,
          tokenUriTemplate: null,
          sampleImageUrl: null,
          imageUrlTemplate: null,
          isOnChainMetadata: false,
        });
        return;
      }
      const concrete = expandIdTemplate(rawUri, BigInt(c.sampleTokenId));
      const isOnChain = concrete.startsWith("data:");
      const json = await fetchMetadataJson(concrete);
      if (!json) {
        results.set(addr, {
          metadataChecked: true,
          metadataBroken: true,
          tokenUriTemplate: rawUri,
          sampleImageUrl: null,
          imageUrlTemplate: null,
          isOnChainMetadata: isOnChain,
        });
        return;
      }
      const rawImage = extractImageField(json);
      const sampleImageUrl = rawImage ? resolveImageUriToHttps(rawImage) : null;
      const imageUrlTemplate = sampleImageUrl
        ? buildImageUrlTemplate(sampleImageUrl, c.sampleTokenId)
        : null;
      results.set(addr, {
        metadataChecked: true,
        metadataBroken: false,
        tokenUriTemplate: rawUri,
        sampleImageUrl,
        imageUrlTemplate,
        isOnChainMetadata: isOnChain,
      });
    }),
  );
  return results;
}

/**
 * Run precheck on `collections`. Each entry must have
 * { address, sampleTokenId, is721, is1155 }.
 *
 * Caller supplies:
 *   getClient(): returns a viem PublicClient. Will be called once per
 *                attempt; rotate across an RPC pool inside this fn.
 *   attempts:    how many client rotations to try per batch.
 *   batchSize:   override default 20 if your RPC tolerates more.
 *   onProgress(done, total, elapsedMs): periodic callback for logging.
 */
export async function precheckAll(collections, { getClient, attempts = 1, batchSize = PRECHECK_BATCH_SIZE, onProgress } = {}) {
  if (!getClient) throw new Error("precheckAll: getClient is required");
  const out = new Map();
  if (collections.length === 0) return out;

  const startTime = Date.now();
  for (let i = 0; i < collections.length; i += batchSize) {
    const batch = collections.slice(i, i + batchSize);
    let lastErr = null;
    let batchResults = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const client = getClient();
      try {
        batchResults = await precheckMetadataBatch(client, batch);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (batchResults) {
      for (const [addr, res] of batchResults) out.set(addr, res);
    } else {
      // RPC exhausted — mark as un-checked so future runs retry.
      if (lastErr) {
        console.warn(`  precheck batch ${i} failed after ${attempts} attempts: ${lastErr.message}`);
      }
      for (const c of batch) {
        out.set(c.address.toLowerCase(), { metadataChecked: false });
      }
    }

    if (onProgress) {
      const done = Math.min(i + batchSize, collections.length);
      onProgress(done, collections.length, Date.now() - startTime);
    }
  }
  return out;
}
