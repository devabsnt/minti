// Browser-friendly IPFS gateways only. Pinata's public gateway blocks
// cross-origin requests (no Access-Control-Allow-Origin header) for any
// content not pinned to their service, so every fetch is wasted CORS
// noise. The list below is gateways that reliably send CORS headers for
// arbitrary CIDs.
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://4everland.io/ipfs/",
  "https://w3s.link/ipfs/",
];

export const PAGE_SIZE = 20;
export const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const LISTING_STALE_TIME = 30_000; // 30 seconds
export const PRICE_HISTORY_BLOCK_RANGE = 100_000n; // ~14 days on mainnet
