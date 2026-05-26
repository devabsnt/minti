// Public IPFS gateways. The browser races these in parallel for metadata
// JSON and steps through them on <img> error for images. All three send
// CORS headers and serve content-addressed data, so any working one is
// equivalent. The Cloudflare worker proxy is no longer in the path —
// indexer-side template substitution covers the cases that used to need
// CORS-proxying for centralized hosts (scatter, lootgo, R2, etc.).
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

export const PAGE_SIZE = 20;
export const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const LISTING_STALE_TIME = 30_000; // 30 seconds
export const PRICE_HISTORY_BLOCK_RANGE = 100_000n; // ~14 days on mainnet
