"use client";

import { useState, useCallback } from "react";
import { IPFS_GATEWAYS } from "@/config/constants";
import { resolveUri } from "@/lib/metadata";

interface NftImageProps {
  src: string;
  rawUri?: string; // original ipfs:// or ar:// URI for gateway fallback
  alt: string;
  className?: string;
}

/**
 * Reroute every IPFS gateway URL to ipfs.io/ipfs/<cid>/path. This handles
 * the two failure modes we see in practice:
 *
 *   - Subdomain-style URLs (e.g. https://bafy....ipfs.dweb.link/...) trip
 *     the browser's cross-origin-embedder-policy check ("NotSameOrigin").
 *   - Path-style URLs on restricted gateways (e.g. gateway.pinata.cloud
 *     for non-Pinata pins) return 403 with bad CORS headers.
 *
 * ipfs.io is permissive for cross-origin <img> embeds and serves any CID.
 */
function normalizeIpfsGatewayUrl(url: string): string {
  if (!url) return url;
  // Already canonical
  if (url.startsWith("https://ipfs.io/ipfs/")) return url;
  // Subdomain pattern: https://<cid>.ipfs.<host>/path
  const sub = url.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub) return `https://ipfs.io/ipfs/${sub[1]}${sub[2] || ""}`;
  // Path-style pattern: https://<host>/ipfs/<cid>/path
  const pth = url.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth) return `https://ipfs.io/ipfs/${pth[1]}${pth[2] || ""}${pth[3] || ""}`;
  return url;
}

export function NftImage({ src, rawUri, alt, className = "" }: NftImageProps) {
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

  // Determine the current URL to try. Subdomain-style IPFS gateways get
  // rewritten to path-style so the browser doesn't block them under COEP.
  const baseSrc =
    rawUri && rawUri.startsWith("ipfs://") && gatewayIdx > 0
      ? resolveUri(rawUri, gatewayIdx)
      : src;
  const currentSrc = normalizeIpfsGatewayUrl(baseSrc);

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
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={handleError}
      />
    </div>
  );
}
