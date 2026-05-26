// Public IPFS gateways. Browser races these in parallel for metadata
// JSON and steps through them on <img>-error for images. All send CORS
// headers and content-addressed data, so any working one is equivalent.
//
// Order matters: `IPFS_GATEWAYS[0]` is the default rendering gateway.
// `w3s.link` first because `ipfs.io` is bad about returning proper MIME
// types for binary files (.webp, .avif, etc.) — Chrome's ORB blocks
// those responses with ERR_BLOCKED_BY_ORB. `w3s.link` sets correct
// `Content-Type` headers and renders cleanly.
export const IPFS_GATEWAYS = [
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
  "https://ipfs.io/ipfs/",
];

export const PAGE_SIZE = 20;
export const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const LISTING_STALE_TIME = 30_000; // 30 seconds
export const PRICE_HISTORY_BLOCK_RANGE = 100_000n; // ~14 days on mainnet
