import { IPFS_GATEWAYS } from "@/config/constants";
import type { NftMetadata } from "@/types/nft";

/**
 * Pull a `(cid, path)` pair out of any IPFS-shaped URL. Matches:
 *   - ipfs://<cid>/<path>
 *   - https://<cid>.ipfs.<host>/<path>            (subdomain style)
 *   - https://<host>/ipfs/<cid>/<path>            (path style)
 * Returns null if the URL isn't recognisable as IPFS.
 */
function parseIpfsUri(uri: string): { cid: string; path: string } | null {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    const idx = rest.indexOf("/");
    return idx >= 0
      ? { cid: rest.slice(0, idx), path: rest.slice(idx) }
      : { cid: rest, path: "" };
  }
  const sub = uri.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub) return { cid: sub[1], path: sub[2] || "" };
  const pth = uri.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth) return { cid: pth[1], path: (pth[2] || "") + (pth[3] || "") };
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

async function fetchWithGatewayFallback(uri: string): Promise<string> {
  const ipfs = parseIpfsUri(uri);

  // Non-IPFS URI — just fetch directly.
  if (!ipfs) {
    const response = await fetch(resolveUri(uri), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: ${response.status}`);
    }
    return response.text();
  }

  // IPFS-shaped URI — try each gateway in turn.
  let lastError: Error | null = null;
  for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
    try {
      const url = IPFS_GATEWAYS[i] + ipfs.cid + ipfs.path;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return response.text();
      lastError = new Error(`gateway ${i}: ${response.status}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError || new Error("All IPFS gateways failed");
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
  const imageRaw: string = raw.image || raw.image_url || raw.image_data || "";

  return {
    name: raw.name || `#${tokenId.toString()}`,
    description: raw.description || "",
    image: resolveUri(imageRaw),
    rawImageUri: imageRaw.startsWith("ipfs://") || imageRaw.startsWith("ar://") ? imageRaw : undefined,
    animationUrl: raw.animation_url ? resolveUri(raw.animation_url) : undefined,
    attributes: raw.attributes || [],
    externalUrl: raw.external_url,
    raw,
  };
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
