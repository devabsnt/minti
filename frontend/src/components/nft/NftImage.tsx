"use client";

import { useState, useCallback } from "react";
import { IPFS_GATEWAYS, IPFS_PROXY_BASE } from "@/config/constants";
import { resolveUri } from "@/lib/metadata";

interface NftImageProps {
  src: string;
  rawUri?: string; // original ipfs:// or ar:// URI for gateway fallback
  alt: string;
  className?: string;
  /**
   * Set to true for above-the-fold images (hero, collection page header)
   * to get higher fetch priority and eager loading. Defaults to lazy.
   */
  priority?: boolean;
}

// Hosts that block cross-origin image loads via referrer/CORP/etc. We
// route their image URLs through our worker's /proxy endpoint so they
// render. The worker has the corresponding host allowlist.
const HOSTS_NEEDING_PROXY = [
  /^([a-z0-9-]+\.)?scatter\.art$/i,
  /^([a-z0-9-]+\.)?pancakeswap\.com$/i,
  /^([a-z0-9-]+\.)?lootgo\.app$/i,
  /^([a-z0-9-]+\.)?codepunks\.fun$/i,
  /^([a-z0-9-]+\.)?madness\.finance$/i,
  /^([a-z0-9-]+\.)?wengoods\.io$/i,
  /^s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
  /^[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/i,
  /^[a-z0-9-]+\.r2\.dev$/i,
  /^gateway\.lighthouse\.storage$/i,
];

/**
 * Rewrite ANY image URL to a browser-loadable HTTPS URL. This is the
 * LAST LINE OF DEFENSE — if anything other than `https://...` or
 * `data:...` makes it into `<img src=>` we cause an ERR_UNKNOWN_URL_SCHEME
 * console error. Routes:
 *
 *   - `ipfs://<cid>/<path>` and `ipfs:/<cid>/<path>` (broken single-slash
 *     variant some contracts return) → proxy `/ipfs/<cid>/<path>`
 *   - `ar://<txid>` → arweave.net
 *   - Path-style gateway URL → proxy
 *   - Subdomain-style gateway URL → proxy
 *   - Centralized CORS-blocked host → proxy `/proxy?url=...`
 *   - data: URIs and everything else → unchanged
 *
 * The proxy itself races all known gateways internally on cold reads
 * and serves cache hits in <50ms.
 */
function rewriteIpfsUrl(url: string): string {
  if (!url) return url;

  // Data URIs and bare schemes that the browser handles natively
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  const base = IPFS_PROXY_BASE || "https://ipfs.io/ipfs/";
  if (url.startsWith(base)) return url;

  // ipfs:// or ipfs:/ (single slash — broken but seen in the wild)
  if (url.startsWith("ipfs://") || url.startsWith("ipfs:/")) {
    const stripped = url.replace(/^ipfs:\/{1,2}/i, "");
    return `${base}${stripped}`;
  }

  // ar://
  if (url.startsWith("ar://")) {
    return "https://arweave.net/" + url.slice("ar://".length);
  }

  // Subdomain pattern: https://<cid>.ipfs.<host>/path
  const sub = url.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub) return `${base}${sub[1]}${sub[2] || ""}`;
  // Path-style pattern: https://<host>/ipfs/<cid>/path
  const pth = url.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth) return `${base}${pth[1]}${pth[2] || ""}${pth[3] || ""}`;

  // Centralized hosts that need CORS proxying for `<img>` to work
  try {
    const host = new URL(url).host;
    if (IPFS_PROXY_BASE && HOSTS_NEEDING_PROXY.some((re) => re.test(host))) {
      const root = IPFS_PROXY_BASE.replace(/\/ipfs\/?$/, "");
      return `${root}/proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {
    // Not a valid URL — pass through unchanged
  }

  return url;
}

export function NftImage({
  src,
  rawUri,
  alt,
  className = "",
  priority = false,
}: NftImageProps) {
  const [gatewayIdx, setGatewayIdx] = useState(0);
  const [allFailed, setAllFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const handleError = useCallback(() => {
    if (rawUri && rawUri.startsWith("ipfs://")) {
      const nextIdx = gatewayIdx + 1;
      if (nextIdx < IPFS_GATEWAYS.length) {
        setGatewayIdx(nextIdx);
        setLoaded(false);
        return;
      }
    }
    setAllFailed(true);
  }, [rawUri, gatewayIdx]);

  // Pick the source URL. Cold path: route through the cached proxy
  // (rewriteIpfsUrl handles every gateway URL shape). On <img>-error we
  // step through IPFS_GATEWAYS as a defensive fallback.
  const baseSrc =
    rawUri && rawUri.startsWith("ipfs://") && gatewayIdx > 0
      ? resolveUri(rawUri, gatewayIdx)
      : src;
  const currentSrc = rewriteIpfsUrl(baseSrc);

  if (!src || allFailed) {
    return (
      <div
        className={`bg-background-tertiary flex items-center justify-center ${className}`}
        role="img"
        aria-label={alt || "NFT image unavailable"}
      >
        <span className="text-foreground-secondary/30 text-4xl">?</span>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden bg-background-tertiary ${className}`}>
      {!loaded && (
        <div className="absolute inset-0 animate-pulse bg-background-tertiary" />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={currentSrc}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ fetchpriority: priority ? "high" : "auto" } as any)}
        decoding="async"
        referrerPolicy="no-referrer"
        className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={handleError}
      />
    </div>
  );
}
