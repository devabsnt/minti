import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { collections } from "../db/schema.js";
import { env } from "../env.js";

/**
 * Tier classification job. Ports `assignTier` from
 * scripts/build-collections-index.mjs into a SQL-driven UPDATE — cheaper
 * than streaming every row through Node.
 *
 * Tier semantics (frontend reads these):
 *   0 — hidden by default (spam, broken, microdust)
 *   1 — indexed but unranked ("show hidden" shows these)
 *   2 — explore-eligible (real holder distribution, real trading)
 *   3 — curated (registry-marked; assigned client-side via the
 *       on-chain EVMFS registry, never by this job)
 *
 * The heuristic is deliberately conservative — easier to bump a real
 * collection up via metadata fixes than to scrub fake activity from
 * tier 2 later. Numbers tuned for Monad's airdrop-heavy mix.
 */

// Patterns recognized as spam / airdrop-promo collection names.
const SPAM_NAME_RE =
  /\$|🚀|💎|🎁|💰|⭐|🔥|✨|🎉|free\b|claim|airdrop|reward|bonus|voucher|coupon|prize|winner|\bwin\b|giveaway|whitelist\b|\bwl\b|mystery\s*box|gift\s*card|redeem|\bdrop\b|earn\b|payout|cashback|invite\b|presale|\bIDO\b|\bICO\b|www\.|https?:|\.com|\.io|\.xyz\b|\.eth\b|\.fi\b|\.app\b|t\.me\/|telegram|discord\.gg|\bvisit\b|\bsign\s*up\b|\bsignup\b/i;

// Patterns suggesting DeFi infrastructure NFTs rather than collectibles.
const DEFI_INFRA_NAME_RE =
  /uniswap|sushiswap|pancakeswap|\bpancake\b|\bpcs\b|aave|compound|maker\b|curve\b|balancer|pendle|gmx|kuru|crocswap|monadex|nadfun|nostra|izumi|kintsu|magma|amphor|stork|pyth|clob|orderbook|velodrome|aerodrome|camelot|quickswap|octoswap|trader\s*joe|algebra|slipstream|steer\b|clmm|\bperp\b|\bswap\b|\bexchange\b|\brouter\b|lp\b|liquidity\s+position|\bv\d\s*positions?\b|\bpositions?\s+nft\b|\bposition\s*(nft|v\d|manager|token)\b|\bvault\b|\bstake\b|staking\b|lending\b|yield\b|\bdebt\b|atoken|name\s+service|registrar\b|\bdomain\b|\bname\s+manager\b|\bsbt\b|soulbound|\bpoap\b|attestation|\bcertificate\b|\bbadge\b|voting\s*escrow|\bescrow\b|\bve[A-Z][a-zA-Z]*\b|governance/i;

function classifyName(name: string | null, symbol: string | null): "spam" | "defi" | "ok" {
  if (name && SPAM_NAME_RE.test(name)) return "spam";
  if (symbol && SPAM_NAME_RE.test(symbol)) return "spam";
  if (name && DEFI_INFRA_NAME_RE.test(name)) return "defi";
  if (symbol && DEFI_INFRA_NAME_RE.test(symbol)) return "defi";
  return "ok";
}

interface CollectionRow {
  address: string;
  name: string | null;
  symbol: string | null;
  is721: boolean;
  is1155: boolean;
  metadataChecked: boolean;
  metadataBroken: boolean;
  transferCount: number;
  mintCount: number;
  uniqueHolders: number;
  uniqueSenders: number;
}

function computeTier(c: CollectionRow): 0 | 1 | 2 {
  if (!c.name && !c.symbol) return 0;
  const named = classifyName(c.name, c.symbol);
  if (named !== "ok") return 0;
  if (c.metadataChecked && c.metadataBroken) return 0;
  if (!c.is721 && !c.is1155 && !c.name) return 0;

  const holders = c.uniqueHolders;
  const transfers = c.transferCount;
  const senders = c.uniqueSenders;
  const mints = c.mintCount;
  const secondary = Math.max(0, transfers - mints);

  if (holders < 5) return 0;
  if (transfers < 5) return 0;
  // Mint-and-dead microdust
  if (mints > 0 && transfers === mints && holders < 50) return 0;

  // Tier 2: explore-eligible
  const wideDistribution = holders >= 25 && senders >= 3 && secondary >= 10;
  if (wideDistribution) return 2;
  return 1;
}

/**
 * Recompute tier for every collection. Cheap because the heuristic is
 * pure-function over already-stored columns. We stream the rows through
 * Node so we can apply the spam/defi regex (Postgres regex would be
 * less readable + harder to keep aligned with frontend logic if we
 * ever needed to mirror it).
 */
export async function refreshTiers(): Promise<{ updated: number; elapsedMs: number; tier0: number; tier1: number; tier2: number }> {
  const t = Date.now();
  const PAGE = 1000;
  let offset = 0;
  let totalUpdated = 0;
  let t0 = 0, t1 = 0, t2 = 0;

  while (true) {
    // ORDER BY required: without it Postgres can return different
    // orderings across calls and `LIMIT … OFFSET …` will skip rows.
    // veDUST was getting skipped on every pass for exactly this reason.
    const rows = await db
      .select({
        address: collections.address,
        name: collections.name,
        symbol: collections.symbol,
        is721: collections.is721,
        is1155: collections.is1155,
        metadataChecked: collections.metadataChecked,
        metadataBroken: collections.metadataBroken,
        transferCount: collections.transferCount,
        mintCount: collections.mintCount,
        uniqueHolders: collections.uniqueHolders,
        uniqueSenders: collections.uniqueSenders,
        currentTier: collections.tier,
      })
      .from(collections)
      .orderBy(asc(collections.address))
      .limit(PAGE)
      .offset(offset);
    if (rows.length === 0) break;

    // Bucket addresses by new tier so we can do ≤3 batched updates per page.
    const byTier = new Map<0 | 1 | 2, string[]>([[0, []], [1, []], [2, []]]);
    for (const r of rows) {
      const newTier = computeTier(r);
      if (newTier === 0) t0++; else if (newTier === 1) t1++; else t2++;
      if (newTier !== r.currentTier) {
        byTier.get(newTier)!.push(r.address);
      }
    }
    // Small batches + Drizzle's inArray (compiles to `IN (...)`) keeps
    // individual UPDATEs fast and lock-friendly. The previous ANY(array)
    // form had postgres-js expand into one $param per element AND was
    // sometimes timing out under concurrent stats/poll contention.
    const UPDATE_BATCH = 50;
    for (const [newTier, addrs] of byTier) {
      if (addrs.length === 0) continue;
      for (let i = 0; i < addrs.length; i += UPDATE_BATCH) {
        const slice = addrs.slice(i, i + UPDATE_BATCH);
        await db
          .update(collections)
          .set({ tier: newTier, updatedAt: sql`now()` })
          .where(inArray(collections.address, slice));
      }
      totalUpdated += addrs.length;
    }
    offset += PAGE;
  }

  return { updated: totalUpdated, elapsedMs: Date.now() - t, tier0: t0, tier1: t1, tier2: t2 };
}

function describePgError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: string; detail?: string; severity?: string; routine?: string };
  const parts: string[] = [];
  if (e.code) parts.push(`code=${e.code}`);
  if (e.severity) parts.push(`severity=${e.severity}`);
  if (e.routine) parts.push(`routine=${e.routine}`);
  if (e.detail) parts.push(`detail=${e.detail}`);
  parts.push(e.message);
  return parts.join(" | ");
}

export async function startTierLoop(): Promise<void> {
  const intervalMs = env.TIER_REFRESH_SECONDS * 1000;
  console.log(`[tier] starting, cadence=${env.TIER_REFRESH_SECONDS}s`);
  let stop = false;
  process.once("SIGTERM", () => { stop = true; });
  process.once("SIGINT", () => { stop = true; });
  while (!stop) {
    try {
      const r = await refreshTiers();
      console.log(`[tier] reclassified ${r.updated} (T0=${r.tier0} T1=${r.tier1} T2=${r.tier2}) in ${r.elapsedMs}ms`);
    } catch (err) {
      console.error(`[tier] refresh failed: ${describePgError(err)}`);
    }
    await sleep(intervalMs);
  }
  console.log("[tier] stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
