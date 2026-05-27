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

// Cloudflare worker that owns the IPFS cache + /proxy?url= allowlist.
// Mirrors cloudflare-worker-ipfs/src/index.js. When set, metadata fetches
// for hosts on PROXY_HOST_PATTERNS will be routed through
// `${WORKER_PROXY_URL}/proxy?url=…` instead of hitting the origin host
// directly — necessary because the origin hosts in question don't send
// `Access-Control-Allow-Origin: *` and the browser cannot read their
// responses without the worker rewriting CORS headers on the way back.
export const WORKER_PROXY_URL = "https://ipfs-cache.devskibb.workers.dev";

// Mirror of PROXY_ALLOWED_HOST_PATTERNS in the worker. Keep these two
// lists in sync: hosts the worker accepts AND we know CORS-block from
// the browser. Hosts not on this list are fetched directly (most do
// send CORS, and proxying everything would waste worker quota).
export const PROXY_HOST_PATTERNS: readonly RegExp[] = [
  /^([a-z0-9-]+\.)?scatter\.art$/i,
  /^([a-z0-9-]+\.)?pancakeswap\.com$/i,
  /^([a-z0-9-]+\.)?lootgo\.app$/i,
  /^([a-z0-9-]+\.)?codepunks\.fun$/i,
  /^([a-z0-9-]+\.)?madness\.finance$/i,
  /^([a-z0-9-]+\.)?wengoods\.io$/i,
  /^s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
  /^[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/i,
  /^[a-z0-9-]+\.r2\.dev$/i,
  /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/i,
  /^gateway\.lighthouse\.storage$/i,
  /^ipfs\.4everland\.io$/i,
  /^[a-z0-9-]+\.mypinata\.cloud$/i,
];
