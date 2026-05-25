/**
 * Cloudflare worker base. Kept ONLY for the `/proxy?url=` CORS-proxy
 * endpoint that lets us read centralized metadata hosts (scatter.art,
 * lootgo.app, S3/R2 buckets, etc.) which don't send CORS headers.
 *
 * Not used for IPFS — public gateways below are content-addressed and
 * race themselves browser-side, so adding a worker hop in front of them
 * just doubled the failure surface and spammed the console with 502s
 * whenever any CID was unreachable.
 */
export const IPFS_PROXY_BASE = "https://ipfs-cache.devskibb.workers.dev/ipfs/";

// Public IPFS gateways. The browser races these in parallel for metadata
// JSON and steps through them on <img> error for images. All four send
// CORS headers and serve content-addressed data, so any working one is
// equivalent — no need for a custom proxy in front.
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

export const PAGE_SIZE = 20;
export const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const LISTING_STALE_TIME = 30_000; // 30 seconds
export const PRICE_HISTORY_BLOCK_RANGE = 100_000n; // ~14 days on mainnet
