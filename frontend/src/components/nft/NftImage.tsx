"use client";

import { useState, useCallback } from "react";
import { IPFS_GATEWAYS, IPFS_PROXY_BASE } from "@/config/constants";
import { resolveUri, toCanonicalIpfsUri } from "@/lib/metadata";

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
 * Rewrite ANY image URL to a browser-loadable HTTPS URL. Routes:
 *
 *   - data: / blob: → unchanged (browser handles natively)
 *   - ipfs:// → public IPFS gateway (IPFS_GATEWAYS[0])
 *   - ar:// → arweave.net
 *   - Subdomain / path-style gateway URL → unchanged (already a public gateway)
 *   - Centralized CORS-blocked host → worker `/proxy?url=...` (the worker's
 *     only remaining job)
 *   - Anything else → unchanged
 */
function rewriteIpfsUrl(url: string): string {
  if (!url) return url;

  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  const ipfsGateway = IPFS_GATEWAYS[0];

  // ipfs:// or ipfs:/ (single slash — broken but seen in the wild)
  if (url.startsWith("ipfs://") || url.startsWith("ipfs:/")) {
    const stripped = url.replace(/^ipfs:\/{1,2}/i, "");
    return `${ipfsGateway}${stripped}`;
  }

  if (url.startsWith("ar://")) {
    return "https://arweave.net/" + url.slice("ar://".length);
  }

  // Subdomain / path-style gateway URLs come in CORS-clean already.
  // Don't rewrite — let the browser hit them directly so its cache works
  // and so a 502 from one gateway doesn't bring down the whole grid.
  if (/^https?:\/\/[^./]+\.ipfs\.[^/]+/.test(url)) return url;
  if (/^https?:\/\/[^/]+\/ipfs\//.test(url)) return url;

  // Centralized CORS-blocked host → worker /proxy?url=
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

  // If rawUri isn't already ipfs://, try to extract a CID from src so we
  // can still step across gateways when the JSON hardcoded a gateway URL.
  const ipfsUri =
    rawUri && rawUri.startsWith("ipfs://") ? rawUri : toCanonicalIpfsUri(src);

  const handleError = useCallback(() => {
    if (ipfsUri) {
      const nextIdx = gatewayIdx + 1;
      if (nextIdx < IPFS_GATEWAYS.length) {
        setGatewayIdx(nextIdx);
        setLoaded(false);
        return;
      }
    }
    setAllFailed(true);
  }, [ipfsUri, gatewayIdx]);

  // Cold path: route through the cached worker proxy (gatewayIdx 0).
  // On <img>-error we step gatewayIdx forward and resolve to that
  // gateway DIRECTLY — skipping rewriteIpfsUrl, which would rewrite us
  // back to the worker and defeat the fallback.
  let currentSrc: string;
  if (ipfsUri && gatewayIdx > 0) {
    currentSrc = resolveUri(ipfsUri, gatewayIdx);
  } else {
    currentSrc = rewriteIpfsUrl(src);
  }

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
