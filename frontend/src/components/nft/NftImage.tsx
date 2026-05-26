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
   * Set to true for above-the-fold media (hero, collection page header)
   * to get higher fetch priority and eager loading. Defaults to lazy.
   */
  priority?: boolean;
}

/**
 * Universal NFT media renderer. Despite the `Image` name (kept for
 * compatibility with all current call sites) this picks the correct
 * element based on URL extension or data-URI MIME type:
 *
 *   - `<img>`  — png/jpg/gif/webp/avif/svg/bmp/apng + everything default
 *   - `<video>` — mp4/webm/mov/m4v/ogv/mkv  (muted autoplay, loops)
 *   - `<audio>` — mp3/wav/m4a/ogg/opus/flac (with placeholder thumbnail)
 *   - `<iframe>` — html/htm + `data:text/html` (sandboxed)
 *
 * Generative NFTs that store an HTML data-URI as their image (common for
 * on-chain art) get the iframe path automatically. Audio collections get
 * a placeholder card with the audio inline.
 */

type MediaKind = "image" | "video" | "audio" | "iframe";

function detectMediaKind(url: string): MediaKind {
  if (!url) return "image";
  if (url.startsWith("data:")) {
    if (url.startsWith("data:image/")) return "image";
    if (url.startsWith("data:video/")) return "video";
    if (url.startsWith("data:audio/")) return "audio";
    if (url.startsWith("data:text/html")) return "iframe";
    return "image";
  }
  // Pull the last `.ext` before any query or fragment. URLs without an
  // extension (gateway-served, no suffix) default to image — most are.
  const m = url.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
  if (!m || !m[1]) return "image";
  const ext = m[1].toLowerCase();
  if (/^(mp4|webm|mov|m4v|ogv|mkv|3gp)$/.test(ext)) return "video";
  if (/^(mp3|wav|m4a|ogg|oga|opus|flac|weba)$/.test(ext)) return "audio";
  if (/^(html|htm|xhtml)$/.test(ext)) return "iframe";
  // jpg, jpeg, png, gif, webp, avif, svg, bmp, ico, apng, jp2, jxl, tif, tiff —
  // all fall through to image. Browser will reject anything it doesn't
  // recognize via the <img>'s error handler.
  return "image";
}

/**
 * Rewrite a URL to a browser-loadable form, normalizing IPFS-shaped URLs
 * to our preferred gateway (`IPFS_GATEWAYS[0]`).
 *
 * Why we rewrite already-gatewayed URLs:
 *   `ipfs.io` (which the indexer used as default when it stored
 *   sample_image_url / image_url_template) frequently returns binary
 *   files with `Content-Type: application/octet-stream` instead of the
 *   correct image MIME. Chrome's Opaque Response Blocking (ORB) then
 *   refuses to deliver those responses to `<img>` tags, throwing
 *   ERR_BLOCKED_BY_ORB. `w3s.link` (and others) send proper MIME types
 *   and don't trigger ORB. We extract the CID + path from any IPFS
 *   gateway URL and re-host through our preferred gateway.
 *
 * Schemes handled:
 *   - data: / blob: → unchanged
 *   - ipfs:// → preferred gateway
 *   - ar:// → arweave.net
 *   - subdomain-style `<cid>.ipfs.<host>/<path>` → preferred gateway
 *   - path-style `<host>/ipfs/<cid>/<path>` → preferred gateway
 *   - everything else → unchanged
 */
const CID_RE = /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{52,})/i;

function looksLikeCid(s: string | undefined): boolean {
  return !!s && new RegExp(`^${CID_RE.source}$`, "i").test(s);
}

function rewriteIpfsUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  const preferred = IPFS_GATEWAYS[0];

  if (url.startsWith("ipfs://") || url.startsWith("ipfs:/")) {
    const stripped = url.replace(/^ipfs:\/{1,2}/i, "");
    return `${preferred}${stripped}`;
  }

  if (url.startsWith("ar://")) {
    return "https://arweave.net/" + url.slice("ar://".length);
  }

  // Subdomain-style gateway: https://<cid>.ipfs.<host>/<path>
  const sub = url.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/i);
  if (sub && looksLikeCid(sub[1])) {
    return `${preferred}${sub[1]}${sub[2] ?? ""}`;
  }

  // Path-style gateway: https://<host>/ipfs/<cid>/<path>
  const pth = url.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i);
  if (pth && looksLikeCid(pth[1])) {
    return `${preferred}${pth[1]}${pth[2] ?? ""}${pth[3] ?? ""}`;
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
  // rewriting). On error step gatewayIdx forward and resolve to the
  // next public gateway directly.
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
        aria-label={alt || "NFT media unavailable"}
      >
        <span className="text-foreground-secondary/30 text-4xl">?</span>
      </div>
    );
  }

  const kind = detectMediaKind(currentSrc);

  return (
    <div className={`relative overflow-hidden bg-background-tertiary ${className}`}>
      {!loaded && kind !== "audio" && (
        <div className="absolute inset-0 animate-pulse bg-background-tertiary" />
      )}
      {kind === "video" && (
        <video
          src={currentSrc}
          muted
          loop
          autoPlay
          playsInline
          preload={priority ? "auto" : "metadata"}
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoadedData={() => setLoaded(true)}
          onError={handleError}
        />
      )}
      {kind === "audio" && (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-3">
          <span className="text-foreground-secondary/40 text-3xl" aria-hidden>
            ♪
          </span>
          <audio
            src={currentSrc}
            controls
            preload="metadata"
            className="w-full max-w-full"
            onLoadedData={() => setLoaded(true)}
            onError={handleError}
          />
        </div>
      )}
      {kind === "iframe" && (
        // sandbox = sandboxed iframe with scripts allowed but no
        // same-origin access. Required for generative on-chain art that
        // ships its own JS. Explicitly NOT allowing top-navigation or
        // forms — minimize attack surface for a media tile.
        <iframe
          src={currentSrc}
          title={alt}
          sandbox="allow-scripts"
          loading={priority ? "eager" : "lazy"}
          referrerPolicy="no-referrer"
          className={`w-full h-full border-0 transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          onError={handleError}
        />
      )}
      {kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
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
      )}
    </div>
  );
}
