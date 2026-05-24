"use client";

import { useEffect } from "react";

/**
 * Register the service worker once the page is interactive. Renders
 * nothing; this is a side-effect-only component.
 *
 * The SW (public/sw.js) caches IPFS proxy responses in Cache Storage so
 * NFT images and metadata persist across reloads. See sw.js for details.
 *
 * We register on mount rather than at script-eval time so the page's
 * initial render isn't blocked by the SW install handshake.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Wait until after first paint so we don't compete with initial work.
    const id = window.setTimeout(() => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => {
          // Failures are non-fatal — the site works fine without the SW,
          // it just won't benefit from persistent image caching.
          console.warn("[sw] registration failed", err);
        });
    }, 1500);
    return () => window.clearTimeout(id);
  }, []);

  return null;
}
