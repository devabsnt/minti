/**
 * Local-only metadata refresh tool.
 *
 * Reads `frontend/public/data/monad-collections.json` from disk, runs the
 * precheck against a configurable subset of collections, applies the
 * retroactive `imageUrlTemplate` derivation to every collection that has
 * a `sampleImageUrl`, and writes the snapshot back.
 *
 * Skips everything the full builder does (Hypersync chain sweep, recent
 * window, enrichment, marketplace pass). Iteration loop drops from
 * ~10-15 min in CI to ~1-2 min locally. Use this for tweaking
 * `extractImageField` / `buildImageUrlTemplate` without burning CI minutes.
 *
 * Targets (mutually exclusive; first one set wins):
 *   --addresses=0x...,0x... — explicit list, any tier
 *   --recheck-no-image      — collections checked & not-broken with
 *                             sampleImageUrl=null (default if no flag)
 *   --backfill              — every collection without metadataChecked
 *   --all                   — every collection that's not tier-0 spam
 *
 * Other flags:
 *   --dry-run               — compute results, log summary, DON'T write
 *   --limit=N               — cap targets to first N matches (debug)
 *   --snapshot=PATH         — override snapshot path
 *
 * Usage:
 *   cd scripts && node refresh-metadata.mjs --recheck-no-image
 *   node scripts/refresh-metadata.mjs --addresses=0xabc,0xdef --dry-run
 *
 * After it lands, commit + push the snapshot manually so Vercel
 * redeploys. Coordinate with the cron — if a delta run is in flight when
 * you push, the cron's rebase-retry usually resolves the overlap, but
 * pushing during the cron window adds noise.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http } from "viem";
import { buildImageUrlTemplate, precheckAll } from "./lib/precheck.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── config ────────────────────────────────────────────────────────

const CHAIN_ID = 143;
const DEFAULT_RPCS = [
  "https://rpc-mainnet.monadinfra.com",
  "https://rpc3.monad.xyz",
  "https://rpc4.monad.xyz",
];
const RPC_URLS = (process.env.MONAD_RPC || DEFAULT_RPCS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SNAPSHOT_PATH_DEFAULT = path.join(
  __dirname, "..", "frontend", "public", "data", "monad-collections.json",
);

// Same spam regex as the builder; duplicate here to avoid importing the
// whole indexing module. If the patterns ever change in the builder, the
// builder runs subsequently to canonicalize tier-0 anyway.
const SPAM_NAME_RE =
  /\$|🚀|💎|🎁|💰|⭐|🔥|✨|🎉|free\b|claim|airdrop|reward|bonus|voucher|coupon|prize|winner|\bwin\b|giveaway|whitelist\b|\bwl\b|mystery\s*box|gift\s*card|redeem|\bdrop\b|earn\b|payout|cashback|invite\b|presale|\bIDO\b|\bICO\b|www\.|https?:|\.com|\.io|\.xyz\b|\.eth\b|\.fi\b|\.app\b|t\.me\/|telegram|discord\.gg|\bvisit\b|\bsign\s*up\b|\bsignup\b/i;

// ── arg parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: "recheck-no-image", dryRun: false, limit: Infinity, snapshot: SNAPSHOT_PATH_DEFAULT };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") { args.dryRun = true; continue; }
    if (raw === "--recheck-no-image") { args.mode = "recheck-no-image"; continue; }
    if (raw === "--backfill") { args.mode = "backfill"; continue; }
    if (raw === "--all") { args.mode = "all"; continue; }
    if (raw.startsWith("--addresses=")) {
      args.mode = "addresses";
      args.addresses = new Set(raw.slice("--addresses=".length).split(",").map((s) => s.trim().toLowerCase()));
      continue;
    }
    if (raw.startsWith("--limit=")) { args.limit = Number(raw.slice("--limit=".length)); continue; }
    if (raw.startsWith("--snapshot=")) { args.snapshot = raw.slice("--snapshot=".length); continue; }
    console.warn(`Unknown arg: ${raw}`);
  }
  return args;
}

// ── viem client rotator (matches builder pattern) ─────────────────

let rpcIdx = 0;
function nextClient() {
  const url = RPC_URLS[rpcIdx++ % RPC_URLS.length];
  return createPublicClient({
    chain: defineChain({
      id: CHAIN_ID,
      name: "Monad",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    }),
    transport: http(url, { timeout: 30_000 }),
  });
}

// ── target selection ──────────────────────────────────────────────

function selectTargets(collections, mode, addresses) {
  return collections.filter((c) => {
    if (!c.name && !c.symbol) return false;
    if (SPAM_NAME_RE.test(c.name || "") || SPAM_NAME_RE.test(c.symbol || "")) return false;
    if (mode === "addresses") return addresses.has(c.address.toLowerCase());
    if (mode === "all") return c.tier !== 0;
    if (mode === "backfill") return !c.metadataChecked;
    // recheck-no-image: checked, not broken, no sample image. The set the
    // widened extraction is most likely to rescue.
    return c.metadataChecked && !c.metadataBroken && !c.sampleImageUrl;
  });
}

// ── main ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Loading snapshot from ${args.snapshot}...`);
  const snapshot = JSON.parse(readFileSync(args.snapshot, "utf8"));
  console.log(`  schemaVersion=${snapshot.schemaVersion}, ${snapshot.collections.length} collections`);

  const targets = selectTargets(snapshot.collections, args.mode, args.addresses);
  const limited = targets.slice(0, args.limit);
  console.log(`Selected ${limited.length} target${limited.length === 1 ? "" : "s"} via mode=${args.mode}${limited.length < targets.length ? ` (limited from ${targets.length})` : ""}`);

  if (limited.length === 0 && args.mode !== "addresses") {
    console.log("Nothing to do — applying retroactive imageUrlTemplate only.");
  }

  // Map by lowercased address for O(1) merge later
  const byAddr = new Map(snapshot.collections.map((c) => [c.address.toLowerCase(), c]));

  // Run precheck on selected targets
  const precheckPayload = limited.map((c) => ({
    address: c.address,
    is721: !!c.is721,
    is1155: !!c.is1155,
    sampleTokenId: c.lowestTokenId ?? "1",
  }));

  const startedAt = Date.now();
  const results = await precheckAll(precheckPayload, {
    getClient: nextClient,
    attempts: RPC_URLS.length,
    onProgress: (done, total, elapsedMs) => {
      const batchIdx = Math.floor(done / 20) - 1;
      if (done >= total || (batchIdx >= 0 && batchIdx % 5 === 0)) {
        const pct = Math.round((done / total) * 100);
        const elapsed = Math.round(elapsedMs / 1000);
        console.log(`  ${done}/${total} (${pct}%), ${elapsed}s elapsed`);
      }
    },
  });
  const elapsedTotal = Math.round((Date.now() - startedAt) / 1000);

  // Apply results
  let updatedBroken = 0, updatedImage = 0, updatedTemplate = 0;
  for (const [addr, res] of results) {
    const c = byAddr.get(addr);
    if (!c || !res.metadataChecked) continue;
    const wasBroken = !!c.metadataBroken;
    const hadImage = !!c.sampleImageUrl;
    const hadTemplate = !!c.imageUrlTemplate;
    c.metadataChecked = true;
    c.metadataBroken = !!res.metadataBroken;
    c.tokenUriTemplate = res.tokenUriTemplate ?? null;
    c.sampleImageUrl = res.sampleImageUrl ?? null;
    c.imageUrlTemplate = res.imageUrlTemplate ?? null;
    c.isOnChainMetadata = !!res.isOnChainMetadata;
    if (c.metadataBroken !== wasBroken) updatedBroken++;
    if (!!c.sampleImageUrl !== hadImage) updatedImage++;
    if (!!c.imageUrlTemplate !== hadTemplate) updatedTemplate++;
  }

  // Retroactive template derivation — runs on EVERY collection with a
  // sampleImageUrl that lacks a template. Pure-CPU pass, no fetches.
  let retroDerived = 0;
  for (const c of snapshot.collections) {
    if (c.sampleImageUrl && !c.imageUrlTemplate) {
      const sampleTid = c.lowestTokenId ?? "1";
      const template = buildImageUrlTemplate(c.sampleImageUrl, sampleTid);
      if (template) {
        c.imageUrlTemplate = template;
        retroDerived++;
      }
    }
  }

  // Histogram
  let mdChecked = 0, mdBroken = 0, mdWithImage = 0, mdWithTemplate = 0, mdOnChain = 0;
  for (const c of snapshot.collections) {
    if (c.metadataChecked) mdChecked++;
    if (c.metadataBroken) mdBroken++;
    if (c.sampleImageUrl) mdWithImage++;
    if (c.imageUrlTemplate) mdWithTemplate++;
    if (c.isOnChainMetadata) mdOnChain++;
  }

  console.log(`\nPrecheck complete (${elapsedTotal}s).`);
  console.log(`  Changes from this run:`);
  console.log(`    metadataBroken flipped: ${updatedBroken}`);
  console.log(`    sampleImageUrl flipped: ${updatedImage}`);
  console.log(`    imageUrlTemplate flipped: ${updatedTemplate}`);
  console.log(`    retroactive templates derived: ${retroDerived}`);
  console.log(`  Snapshot totals:`);
  console.log(`    metadata: ${mdChecked}/${snapshot.collections.length} checked, ${mdBroken} broken, ${mdWithImage} with image, ${mdWithTemplate} with template, ${mdOnChain} on-chain`);

  if (args.dryRun) {
    console.log(`\n--dry-run set, not writing.`);
    return;
  }

  // Bump builtAt so the frontend's react-query cache knows there's new data
  snapshot.builtAt = Date.now();
  writeFileSync(args.snapshot, JSON.stringify(snapshot));
  const sizeKb = (JSON.stringify(snapshot).length / 1024).toFixed(0);
  console.log(`\nWrote ${args.snapshot} (${sizeKb} KB)`);
  console.log(`Next: git add frontend/public/data/monad-collections.json && git commit && git push`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
