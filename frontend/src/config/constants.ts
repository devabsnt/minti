/**
 * Edge-cached IPFS proxy. Deployed in cloudflare-worker-ipfs/. Fronts the
 * public gateways with parallel-race + 1-year CDN cache. Always prefer
 * this over hitting gateways directly — cold reads land at the fastest
 * gateway, warm reads come back in <50ms from Cloudflare's edge.
 *
 * Leave empty to bypass and use the raw gateway list below (e.g. on
 * localhost when the proxy isn't reachable).
 */
export const IPFS_PROXY_BASE = "https://ipfs-cache.devskibb.workers.dev/ipfs/";

// Fallback gateway list used when the proxy is unset or returns an error.
// Browser-friendly only — Pinata's public gateway blocks cross-origin
// requests for content not pinned to their service.
export const IPFS_GATEWAYS = [
  IPFS_PROXY_BASE || "https://ipfs.io/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://4everland.io/ipfs/",
  "https://w3s.link/ipfs/",
];

export const PAGE_SIZE = 20;
export const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const LISTING_STALE_TIME = 30_000; // 30 seconds
export const PRICE_HISTORY_BLOCK_RANGE = 100_000n; // ~14 days on mainnet
