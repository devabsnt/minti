"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { IPFS_GATEWAYS } from "@/config/constants";
import { resolveUri, toCanonicalIpfsUri } from "@/lib/metadata";

// How many times to retry the whole gateway ladder before showing the
// placeholder, and the base backoff between retries (doubles each time:
// 1s, 2s, 4s). Tuned so a grid that fails to paint on first mount
// (connection contention) recovers automatically within a few seconds.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

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
  // Retry counter. A "retry" restarts the whole gateway ladder from
  // scratch and forces a fresh <img> element (via the `key` below), so
  // a load that failed/stalled on the first paint — common when a whole
  // grid mounts at once and the browser queues requests past the
  // per-host connection cap — gets another shot instead of a permanent
  // placeholder. This is the automatic equivalent of the user hitting
  // refresh.
  const [attempt, setAttempt] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If rawUri isn't already ipfs://, try to extract a CID from src so we
  // can still step across gateways when the JSON hardcoded a gateway URL.
  const ipfsUri =
    rawUri && rawUri.startsWith("ipfs://") ? rawUri : toCanonicalIpfsUri(src);

  const handleError = useCallback(() => {
    // 1. Step across the IPFS gateway ladder first.
    if (ipfsUri && gatewayIdx + 1 < IPFS_GATEWAYS.length) {
      setGatewayIdx(gatewayIdx + 1);
      setLoaded(false);
      return;
    }
    // 2. Ladder exhausted (or non-IPFS URL). Retry the whole load a few
    //    times with backoff before giving up — first-load failures are
    //    usually transient (connection contention on a full grid, cold
    //    CDN edge, a momentarily-flaky gateway), which is exactly why a
    //    manual refresh tends to fix them.
    if (attempt < MAX_ATTEMPTS) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        setGatewayIdx(0);
        setLoaded(false);
        setAttempt((a) => a + 1);
      }, delay);
      return;
    }
    // 3. Out of retries — show the placeholder.
    setAllFailed(true);
    onAllFailed?.();
  }, [ipfsUri, gatewayIdx, attempt, onAllFailed]);

  // Clear any pending retry once the media loads or the component
  // unmounts, so a late retry can't stomp a successful load.
  useEffect(() => {
    if (loaded && retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [loaded]);

  // Cold path: use the URL as given (after ipfs:// → public gateway
  // rewriting). On error step gatewayIdx forward and resolve to the
  // next public gateway directly.
  let currentSrc: string;
  if (ipfsUri && gatewayIdx > 0) {
    currentSrc = resolveUri(ipfsUri, gatewayIdx);
  } else {
    currentSrc = rewriteIpfsUrl(src);
  }

  // Per-attempt watchdog. <img> reliably fires onError for real errors
  // (404/DNS/CORS), but a request that's merely QUEUED behind the
  // browser's per-host connection limit — or a gateway that TCP-accepts
  // then hangs — never fires either event. The watchdog treats a
  // too-slow load as an error so `handleError` can advance the ladder
  // or schedule a retry. Kept lenient (12s) so it doesn't false-trip on
  // genuinely-slow-but-progressing loads; the retry path is what
  // ultimately recovers a stalled first paint.
  useEffect(() => {
    if (loaded || allFailed) return;
    const WATCHDOG_MS = 12_000;
    const timer = setTimeout(() => {
      if (!loaded) handleError();
    }, WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [loaded, allFailed, currentSrc, attempt, handleError]);

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
          key={`v${attempt}`}
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
          key={`f${attempt}`}
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
          key={`i${attempt}`}
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
