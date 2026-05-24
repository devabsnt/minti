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

/**
 * Rewrite ANY IPFS gateway URL to our edge-cached proxy. The proxy races
 * all configured gateways internally on cold reads and serves cache hits
 * in <50ms — way faster than the browser doing serial gateway fallback.
 *
 * Falls back to ipfs.io path-style when the proxy is unset (e.g. local
 * dev without the worker deployed).
 */
function rewriteIpfsUrl(url: string): string {
  if (!url) return url;
  const base = IPFS_PROXY_BASE || "https://ipfs.io/ipfs/";
  if (url.startsWith(base)) return url;
  // Subdomain pattern: https://<cid>.ipfs.<host>/path
  const sub = url.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub) return `${base}${sub[1]}${sub[2] || ""}`;
  // Path-style pattern: https://<host>/ipfs/<cid>/path
  const pth = url.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth) return `${base}${pth[1]}${pth[2] || ""}${pth[3] || ""}`;
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
