// Public IPFS gateways. Browser races these in parallel for metadata
// JSON and steps through them on <img>-error for images. All send CORS
// headers and content-addressed data, so any working one is equivalent.
//
// `ipfs.io` is the default because it has the broadest content
// availability (longest-running public gateway). The fallback ladder
// catches ORB-blocked images that `ipfs.io` mis-MIMEs (mostly `.webp`,
// `.avif`, sometimes `.svg`) by re-trying through `w3s.link`/4everland.
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

export const PAGE_SIZE = 20;
export const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const LISTING_STALE_TIME = 30_000; // 30 seconds
export const PRICE_HISTORY_BLOCK_RANGE = 100_000n; // ~14 days on mainnet
