"use client";

import { useState, useCallback, useEffect, useRef } from "react";
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
  /**
   * Called after the gateway ladder is exhausted (or the watchdog
   * timeout fires) with no successful load. Parent components can use
   * this to trigger a per-token metadata fetch as a last-resort
   * fallback — covers the case where a collection's image-URL template
   * has a single extension baked in (`.png`) but some tokens are
   * actually a different format (`.gif`, `.mp4`).
   */
  onAllFailed?: () => void;
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

/**
 * Use the URL the collection actually gave us. Only convert what the
 * browser literally can't load natively:
 *   - data: / blob: → unchanged
 *   - ipfs:// → public gateway (browser doesn't speak ipfs scheme)
 *   - ar:// → arweave.net (browser doesn't speak arweave scheme)
 *   - anything https → unchanged, including IPFS gateway URLs the
 *     collection chose. If it fails, the onError handler steps to the
 *     next gateway in our list using the extracted CID.
 *
 * Adds a `?filename=foo.ext` hint when the URL is `ipfs.io` AND the
 * extension is one Chrome's ORB blocks (webp/avif/svg/mp4/etc). The
 * hint tells ipfs.io to serve with the correct Content-Type. Doesn't
 * change behavior for any other host.
 */
function maybeAddFilenameHint(url: string): string {
  if (!url.startsWith("https://ipfs.io/")) return url;
  if (/[?&]filename=/i.test(url)) return url;
  const m = url.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
  if (!m || !m[1]) return url;
  const ext = m[1].toLowerCase();
  // Only formats ORB is known to block on ipfs.io.
  if (!/^(webp|avif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|opus|html|htm)$/i.test(ext)) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}filename=media.${ext}`;
}

function rewriteIpfsUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  if (url.startsWith("ipfs://") || url.startsWith("ipfs:/")) {
    const stripped = url.replace(/^ipfs:\/{1,2}/i, "");
    return maybeAddFilenameHint(`${IPFS_GATEWAYS[0]}${stripped}`);
  }
  if (url.startsWith("ar://")) {
    return "https://arweave.net/" + url.slice("ar://".length);
  }

  // For existing https URLs: pass through, but add the filename hint
  // when ipfs.io is the host and the file type is ORB-prone.
  return maybeAddFilenameHint(url);
}

export function NftImage({
  src,
  rawUri,
  alt,
  className = "",
  priority = false,
  onAllFailed,
}: NftImageProps) {
  const [gatewayIdx, setGatewayIdx] = useState(0);
  const [allFailed, setAllFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Wall-clock at first mount — drives the global ceiling watchdog so
  // a token whose gateways all hang doesn't keep extending its deadline
  // each time the per-gateway watchdog advances the ladder. Set inside
  // the watchdog effect itself the first time it runs (lazy seed).
  const mountedAtRef = useRef<number>(0);

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
    onAllFailed?.();
  }, [ipfsUri, gatewayIdx, onAllFailed]);

  // Cold path: use the URL as given (after ipfs:// → public gateway
  // rewriting). On error step gatewayIdx forward and resolve to the
  // next public gateway directly.
  let currentSrc: string;
  if (ipfsUri && gatewayIdx > 0) {
    currentSrc = resolveUri(ipfsUri, gatewayIdx);
  } else {
    currentSrc = rewriteIpfsUrl(src);
  }

  // Per-gateway watchdog (6s) and a global 15s ceiling. Without the
  // ceiling, a token whose every gateway TCP-hangs would burn a fresh
  // watchdog window for each — 3 gateways × 12s = 36s of spinner
  // before a placeholder. With the ceiling, the worst case is 15s.
  // Hard placeholder after that beats a stalled UI.
  useEffect(() => {
    if (loaded || allFailed) return;
    if (mountedAtRef.current === 0) mountedAtRef.current = Date.now();
    const PER_GATEWAY_MS = 6_000;
    const GLOBAL_CEILING_MS = 15_000;
    const elapsed = Date.now() - mountedAtRef.current;
    const remainingCeiling = Math.max(0, GLOBAL_CEILING_MS - elapsed);
    const perGateway = setTimeout(() => {
      if (!loaded) handleError();
    }, PER_GATEWAY_MS);
    // remainingCeiling can be 0 when a parent rerender remounts the
    // effect after the global window has already elapsed. Schedule a
    // microtask in that case so we don't synchronously setState during
    // the effect body.
    const global = setTimeout(
      () => {
        if (!loaded) {
          setAllFailed(true);
          onAllFailed?.();
        }
      },
      remainingCeiling > 0 ? remainingCeiling : 0,
    );
    return () => {
      clearTimeout(perGateway);
      clearTimeout(global);
    };
  }, [loaded, allFailed, currentSrc, handleError, onAllFailed]);

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
          referrerPolicy="origin"
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
          referrerPolicy="origin"
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          onError={handleError}
        />
      )}
    </div>
  );
}
