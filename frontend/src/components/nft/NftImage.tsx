"use client";

import { useState, useCallback } from "react";
import { IPFS_GATEWAYS } from "@/config/constants";
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

/**
 * Rewrite an image URL to a browser-loadable form. `<img>` rendering is
 * NOT subject to CORS — the browser just paints the bytes — so the only
 * URLs we touch here are the ones the browser can't natively load:
 *
 *   - data: / blob: → unchanged
 *   - ipfs:// → public gateway (IPFS_GATEWAYS[0])
 *   - ar:// → arweave.net
 *   - anything else → unchanged. The browser handles cross-origin image
 *     display fine without a proxy; previous worker rewrites here just
 *     added a rate-limited hop in front of hosts that work direct.
 */
function rewriteIpfsUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  if (url.startsWith("ipfs://") || url.startsWith("ipfs:/")) {
    const stripped = url.replace(/^ipfs:\/{1,2}/i, "");
    return `${IPFS_GATEWAYS[0]}${stripped}`;
  }

  if (url.startsWith("ar://")) {
    return "https://arweave.net/" + url.slice("ar://".length);
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

  // Cold path: use the URL as given (after ipfs:// → public gateway
  // rewriting). On <img>-error step gatewayIdx forward and resolve to
  // the next public gateway directly.
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
