"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { hasHypersync } from "@/lib/hypersync/client";

/**
 * Global collections index — a periodically-refreshed static snapshot at
 * `/data/monad-collections.json` (built by scripts/build-collections-
 * index.mjs via GitHub Actions, served from the static deploy).
 *
 * Per-chain: only Monad has a snapshot for now. Other chains return null
 * and `/explore` falls back to the registry-only path.
 *
 * Schema v4 (2026-05): added uniqueSenders, mintCount, secondaryCount,
 * selfTransferCount, top1/top10HolderPct, holderRatio, marketplace sales
 * fields, and explicit `tier` (0-3). See scripts/build-collections-index.mjs
 * for the producer side.
 */

export interface IndexedCollection {
  address: string;
  name: string | null;
  symbol: string | null;
  totalSupply: string | null;
  is721: boolean;
  is1155: boolean;
  // ─── transfer stats ───
  transferCount?: number;
  mintCount?: number;
  burnCount?: number;
  selfTransferCount?: number;
  uniqueHolders?: number;
  uniqueSenders?: number;
  firstTransferBlock?: number;
  lowestTokenId?: string | null;
  // ─── recent-window stats (overwrite each run) ───
  recent24h?: number;
  recent7d?: number;
  recent30d?: number;
  recentMints24h?: number;
  recentMints7d?: number;
  recentReceivers24h?: number;
  recentReceivers7d?: number;
  recentSenders24h?: number;
  recentSenders7d?: number;
  // ─── holder concentration (computed in full rescan only) ───
  top1HolderPct?: number | null;
  top10HolderPct?: number | null;
  holderRatio?: number | null;
  // ─── marketplace sales (when MintiMarketplace is deployed) ───
  sales24h?: number;
  sales7d?: number;
  volume24h?: string;
  volume7d?: string;
  uniqueBuyers24h?: number;
  uniqueBuyers7d?: number;
  uniqueSellers24h?: number;
  uniqueSellers7d?: number;
  // ─── tier ───
  // 0 = hidden by default (spam / broken)
  // 1 = indexed but unranked (shown under "show all")
  // 2 = explore-eligible (real activity)
  // 3 = curated (registry — assigned client-side, never by the build script)
  tier?: 0 | 1 | 2 | 3;
}

/** Time-window options for "Trending" sort. */
export type ActivityWindow = "24h" | "7d" | "30d" | "all";

/** Sort keys exposed by the explore UI. */
export type SortKey = "trending" | "holders" | "newest" | "name";

/** Pull the right activity number for a given window. */
export function activityIn(c: IndexedCollection, window: ActivityWindow): number {
  if (window === "24h") return c.recent24h ?? 0;
  if (window === "7d") return c.recent7d ?? 0;
  if (window === "30d") return c.recent30d ?? 0;
  return c.transferCount ?? 0;
}

/**
 * Mint-only ratio — what fraction of all transfers are mints (from = 0x0).
 * High ratio = airdrop dust; people minted/were-airdropped but no resale.
 */
export function mintRatio(c: IndexedCollection): number {
  const t = c.transferCount ?? 0;
  if (t === 0) return 0;
  return Math.min((c.mintCount ?? 0) / t, 1);
}

/** Per-window mint ratio — useful for spotting current airdrop bursts. */
export function recentMintRatio(c: IndexedCollection, window: ActivityWindow): number {
  if (window === "24h") {
    const t = c.recent24h ?? 0;
    return t === 0 ? 0 : (c.recentMints24h ?? 0) / t;
  }
  if (window === "7d") {
    const t = c.recent7d ?? 0;
    return t === 0 ? 0 : (c.recentMints7d ?? 0) / t;
  }
  return mintRatio(c);
}

/**
 * Velocity score: today vs the prior 6-day average. >1 means accelerating.
 * Capped at 10 to prevent brand-new collections with tiny baselines from
 * dominating. Returns null if there isn't enough data.
 */
export function velocity(c: IndexedCollection): number | null {
  const today = c.recent24h ?? 0;
  const week = c.recent7d ?? 0;
  if (week === 0) return null;
  const prior6dAvg = Math.max((week - today) / 6, 0);
  if (prior6dAvg < 1) {
    // Brand new or basically idle until today
    return today > 0 ? 5 : null;
  }
  return Math.min(today / prior6dAvg, 10);
}

/**
 * Legacy momentum (fractional change) — kept for the badge UI which expects
 * a +/- percent. Computed from velocity for consistency.
 */
export function momentum(c: IndexedCollection): number | null {
  const v = velocity(c);
  if (v == null) return null;
  return v - 1;
}

/**
 * Trending score — blends recent velocity, real buyer diversity, holder
 * growth proxy, and (if marketplace is deployed) actual sale activity.
 * Higher = hotter. Used as the primary sort when window-specific sort.
 *
 * Heuristic weights are tuned for Monad's cheap-block environment where
 * raw transfer count is the easiest signal to fake. The buyer/sender
 * cardinalities and mint-ratio penalties are the load-bearing terms.
 */
export function trendingScore(c: IndexedCollection, window: ActivityWindow): number {
  const activity = activityIn(c, window);
  if (activity < 3) return 0;

  // Diversity (window-aware where available)
  const recvCount =
    window === "24h" ? c.recentReceivers24h ?? 0 :
    window === "7d" ? c.recentReceivers7d ?? 0 :
    c.uniqueHolders ?? 0;
  const sndCount =
    window === "24h" ? c.recentSenders24h ?? 0 :
    window === "7d" ? c.recentSenders7d ?? 0 :
    c.uniqueSenders ?? 0;

  const v = velocity(c) ?? 1;

  // Logged volume so whales don't dominate
  const activityScore = Math.log(1 + activity) * 1.5;
  const diversityScore = Math.log(1 + recvCount) + Math.log(1 + sndCount) * 0.7;
  const velocityScore = Math.log(1 + v) * 2;

  // Marketplace sales (if any) — heavily weighted because they're the most
  // organic signal we have.
  const sales =
    window === "24h" ? c.sales24h ?? 0 :
    window === "7d" ? c.sales7d ?? 0 :
    (c.sales7d ?? 0); // "30d"/"all" fall back to 7d (we don't keep 30d sales)
  const buyers =
    window === "24h" ? c.uniqueBuyers24h ?? 0 :
    window === "7d" ? c.uniqueBuyers7d ?? 0 :
    (c.uniqueBuyers7d ?? 0);
  const salesScore = sales > 0 ? Math.log(1 + sales) * 3 + Math.log(1 + buyers) * 2 : 0;

  // Penalties
  const mintR = recentMintRatio(c, window);
  const mintPenalty = mintR > 0.85 ? 5 : mintR > 0.65 ? 2 : 0; // airdrop-heavy

  const concentrationPenalty = (() => {
    if (typeof c.top10HolderPct !== "number") return 0;
    if (c.top10HolderPct > 0.9) return 6;
    if (c.top10HolderPct > 0.8) return 3;
    if (c.top10HolderPct > 0.7) return 1;
    return 0;
  })();

  return (
    activityScore +
    diversityScore +
    velocityScore +
    salesScore -
    mintPenalty -
    concentrationPenalty
  );
}

/**
 * Stricter filter than `isLikelyReal` — meant for the trending hero on
 * /explore where we want only collections people are *actually* trading.
 *
 * Conditions:
 *   - clears `isLikelyReal`
 *   - secondary transfers (non-mint) must exceed a real-trading floor in the
 *     window — catches "deployed yesterday, dumped 1000 mints, gone tomorrow"
 *   - top10 holder concentration <70% (when we have a value)
 */
export function isTrendable(
  c: IndexedCollection,
  windowActivity: number,
): boolean {
  if (!isLikelyReal(c)) return false;
  if ((c.uniqueHolders ?? 0) < 30) return false;
  if (windowActivity < 5) return false;

  // Secondary (non-mint) movement must exist — catches airdrop bursts.
  const mintR = recentMintRatio(c, "24h");
  if (mintR > 0.85) return false;

  // Concentration cap (only when known — full-rescan-only field)
  if (typeof c.top10HolderPct === "number" && c.top10HolderPct > 0.7) return false;

  return true;
}

export interface CollectionsIndex {
  chainId: number;
  lastBlock: number;
  builtAt: number;
  schemaVersion?: number;
  marketplaceAddress?: string | null;
  fullRescan?: boolean;
  collections: IndexedCollection[];
}

/** Patterns associated with scam / airdrop-promo collection names. */
const SPAM_NAME_RE =
  /\$|🚀|💎|🎁|💰|⭐|free|claim|airdrop|reward|bonus|www\.|https?:|\.com|\.io|\.xyz\b|\.eth\b|t\.me\/|telegram|discord\.gg/i;

/**
 * Patterns that suggest the contract is a DeFi/infra NFT rather than a
 * collectible — Uniswap V3 LP positions, lending receipts, vault shares,
 * name-service records, etc.
 */
const DEFI_INFRA_NAME_RE =
  /uniswap|sushiswap|pancakeswap|aave|compound|maker\b|curve\b|balancer|pendle|gmx|kuru|crocswap|monadex|nadfun|nostra|izumi|kintsu|magma|amphor|stork|pyth|clob|orderbook|order\s*book|\bperp\b|\bswap\b|\bexchange\b|\brouter\b|lp\b|liquidity\s+position|\bposition\s*(nft|v\d|manager)\b|\bvault\b|\bstake\b|staking\b|lending\b|yield\b|\bdebt\b|atoken|name\s+service|registrar\b|\bdomain\b|\bname\s+manager\b|\bsbt\b|soulbound|\bpoap\b|attestation|\bcertificate\b|\bbadge\b|\bproof\s+of\b|\bachievement\b/i;

// Operational NFTs (orderbook positions, LPs that constantly reshuffle, etc.)
// have absurd transfer-per-holder ratios.
const MAX_TRANSFERS_PER_HOLDER = 100;

/**
 * Score a collection's likely legitimacy. Higher = more likely real. Used
 * for dedupe tie-breaks (e.g. duplicate-name collision: keep the higher score).
 *
 * Note: the build-script-assigned `tier` is the primary filter; legitimacy
 * score is a finer-grained signal used for ordering ties.
 */
export function legitimacyScore(c: IndexedCollection): number {
  const transferCount = c.transferCount ?? 0;
  const uniqueHolders = c.uniqueHolders ?? 0;
  const uniqueSenders = c.uniqueSenders ?? 0;
  const mintCount = c.mintCount ?? 0;
  const secondary = Math.max(0, transferCount - mintCount);

  // Holder count is the dominant signal — wide distribution = real.
  let score = secondary + uniqueHolders * 25 + uniqueSenders * 15;

  if (c.totalSupply) {
    const supply = Number(c.totalSupply);
    if (supply > 0) {
      score += Math.min(uniqueHolders / supply, 1) * 200;
      score += Math.min((secondary / supply) * 20, 200);
    }
  }

  if (c.firstTransferBlock && c.firstTransferBlock > 0) {
    score += 30;
  }

  // Name penalties
  const name = c.name || "";
  const symbol = c.symbol || "";
  if (!name && !symbol) score -= 5000;
  if (SPAM_NAME_RE.test(name) || SPAM_NAME_RE.test(symbol)) score -= 3000;
  if (DEFI_INFRA_NAME_RE.test(name) || DEFI_INFRA_NAME_RE.test(symbol)) score -= 5000;
  if (name && (name.length < 2 || name.length > 40)) score -= 50;

  // Concentration penalty
  if (typeof c.top10HolderPct === "number") {
    if (c.top10HolderPct > 0.9) score -= 2000;
    else if (c.top10HolderPct > 0.8) score -= 800;
    else if (c.top10HolderPct > 0.7) score -= 200;
  }

  // Mint-ratio penalty — collections that are 100% mint with no resale
  const mr = mintRatio(c);
  if (mr > 0.95 && uniqueHolders < 100) score -= 1500;

  // Operational NFT extreme churn
  if (uniqueHolders > 0) {
    const tph = transferCount / uniqueHolders;
    if (tph > MAX_TRANSFERS_PER_HOLDER) {
      score -= Math.min((tph / MAX_TRANSFERS_PER_HOLDER) * 3000, 50000);
    }
  }

  return score;
}

/**
 * Default-view filter. If the build script set tier=0, that's authoritative.
 * Otherwise apply the same checks the script does. Assumes a v4 snapshot
 * with mintCount / uniqueSenders populated — run the collections-index job
 * once before deploying to ensure the static JSON has these fields.
 */
export function isLikelyReal(c: IndexedCollection): boolean {
  // Prefer the snapshot's tier when available
  if (typeof c.tier === "number") return c.tier >= 2;

  const holders = c.uniqueHolders ?? 0;
  const transfers = c.transferCount ?? 0;
  const mints = c.mintCount ?? 0;
  const secondary = Math.max(0, transfers - mints);
  const senders = c.uniqueSenders ?? 0;

  if (holders < 10) return false;
  if (transfers < 20) return false;
  if (!c.name || !c.symbol) return false;

  const name = c.name;
  const symbol = c.symbol;
  if (SPAM_NAME_RE.test(name) || SPAM_NAME_RE.test(symbol)) return false;
  if (DEFI_INFRA_NAME_RE.test(name) || DEFI_INFRA_NAME_RE.test(symbol)) return false;

  if (c.totalSupply) {
    const supply = Number(c.totalSupply);
    if (supply > 0 && holders / supply < 0.05) return false;
  }

  // Engagement floor — non-mint transfers per holder must clear 1.5×
  if (secondary / Math.max(holders, 1) < 1.5) return false;

  // Sender diversity — at least two distinct senders other than the minter
  if (senders < 2) return false;

  if (transfers / holders > MAX_TRANSFERS_PER_HOLDER) return false;

  return true;
}

/**
 * Per-collection warning signals for the collection page. Caller decides
 * how to render. Returned in priority order; first 3 are usually enough.
 */
export interface CollectionWarning {
  kind:
    | "concentration"
    | "airdrop"
    | "low-activity"
    | "mint-dump"
    | "operational"
    | "broken-metadata"
    | "scam-name"
    | "wash-suspect";
  severity: "info" | "warn" | "alert";
  message: string;
}

export function collectionWarnings(c: IndexedCollection): CollectionWarning[] {
  const out: CollectionWarning[] = [];
  const name = c.name || "";
  const symbol = c.symbol || "";
  const transfers = c.transferCount ?? 0;
  const holders = c.uniqueHolders ?? 0;
  const senders = c.uniqueSenders ?? 0;
  const mr = mintRatio(c);
  const selfRatio = transfers > 0 ? (c.selfTransferCount ?? 0) / transfers : 0;

  if (SPAM_NAME_RE.test(name) || SPAM_NAME_RE.test(symbol)) {
    out.push({
      kind: "scam-name",
      severity: "alert",
      message: "Name matches common scam/airdrop patterns",
    });
  }

  if (!c.name || !c.symbol) {
    out.push({
      kind: "broken-metadata",
      severity: "warn",
      message: "Missing name or symbol on the contract",
    });
  }

  if (typeof c.top10HolderPct === "number" && c.top10HolderPct > 0.7) {
    out.push({
      kind: "concentration",
      severity: c.top10HolderPct > 0.85 ? "alert" : "warn",
      message: `Top 10 wallets hold ${Math.round(c.top10HolderPct * 100)}% of supply`,
    });
  }
  if (typeof c.top1HolderPct === "number" && c.top1HolderPct > 0.5) {
    out.push({
      kind: "concentration",
      severity: "alert",
      message: `One wallet holds ${Math.round(c.top1HolderPct * 100)}% of supply`,
    });
  }

  if (mr > 0.85 && holders < 200) {
    out.push({
      kind: "airdrop",
      severity: "warn",
      message: `${Math.round(mr * 100)}% of transfers are mints — likely airdropped, not actively traded`,
    });
  }

  if (senders < 2 && holders > 5) {
    out.push({
      kind: "mint-dump",
      severity: "warn",
      message: "No secondary transfers — every holder received their token directly from the creator",
    });
  }

  if (selfRatio > 0.2) {
    out.push({
      kind: "wash-suspect",
      severity: "alert",
      message: `${Math.round(selfRatio * 100)}% of transfers are wallet-to-self (wash signal)`,
    });
  }

  if (holders > 0 && transfers / holders > MAX_TRANSFERS_PER_HOLDER) {
    out.push({
      kind: "operational",
      severity: "info",
      message:
        "Very high transfer-to-holder ratio — likely a DeFi or utility NFT, not a collectible",
    });
  }

  if (holders > 0 && holders < 5 && transfers < 10) {
    out.push({
      kind: "low-activity",
      severity: "info",
      message: "Very small holder count and trading history",
    });
  }

  return out;
}

/**
 * Collapse duplicate-name collections into one entry per name. The winner is
 * the entry with the highest legitimacy score.
 */
export function dedupeByName(items: IndexedCollection[]): IndexedCollection[] {
  const winners = new Map<string, IndexedCollection>();
  const keep = [];
  for (const c of items) {
    const key = (c.name || c.symbol || c.address).toLowerCase();
    const incumbent = winners.get(key);
    if (!incumbent || legitimacyScore(c) > legitimacyScore(incumbent)) {
      winners.set(key, c);
    }
  }
  for (const c of items) {
    const key = (c.name || c.symbol || c.address).toLowerCase();
    if (winners.get(key) === c) keep.push(c);
  }
  return keep;
}

// Snapshot location is per-chain. Add chains here as snapshots are built.
const SNAPSHOT_PATHS: Record<number, string> = {
  143: "/data/monad-collections.json",
};

export function hasSnapshot(chainId: number): boolean {
  return chainId in SNAPSHOT_PATHS;
}

export function useCollectionsIndex() {
  const { browseChainId } = useBrowseChain();
  const snapshotPath = SNAPSHOT_PATHS[browseChainId];

  return useQuery({
    queryKey: ["collections-index", browseChainId],
    enabled: !!snapshotPath,
    staleTime: 60 * 60 * 1000, // 1 hour
    queryFn: async (): Promise<CollectionsIndex> => {
      const resp = await fetch(snapshotPath);
      if (!resp.ok) {
        throw new Error(`Snapshot fetch failed: ${resp.status}`);
      }
      const snapshot = (await resp.json()) as CollectionsIndex;
      return snapshot;
    },
  });
}

export interface SearchOptions {
  query?: string;
  limit?: number;
  /** Trending window. Only used when sortKey === "trending". Default "all". */
  window?: ActivityWindow;
  sortKey?: SortKey;
  /** Type filter: "721" | "1155" | "any". */
  tokenType?: "721" | "1155" | "any";
}

/**
 * Substring search + flexible ranking.
 */
export function searchIndex(
  index: CollectionsIndex | undefined,
  options: SearchOptions = {},
): IndexedCollection[] {
  if (!index) return [];
  const {
    query = "",
    limit = 50,
    window = "all",
    sortKey = "trending",
    tokenType = "any",
  } = options;

  const deduped = dedupeByName(index.collections);
  const q = query.trim().toLowerCase();

  const matched = deduped.filter((c) => {
    if (tokenType === "721" && !c.is721) return false;
    if (tokenType === "1155" && !c.is1155) return false;
    if (!q) return true;
    const name = (c.name || "").toLowerCase();
    const symbol = (c.symbol || "").toLowerCase();
    const addr = c.address.toLowerCase();
    return name.includes(q) || symbol.includes(q) || addr.startsWith(q);
  });

  matched.sort((a, b) => {
    if (sortKey === "trending") {
      const aa = trendingScore(a, window);
      const bb = trendingScore(b, window);
      if (aa !== bb) return bb - aa;
      return legitimacyScore(b) - legitimacyScore(a);
    }
    if (sortKey === "holders") {
      return (b.uniqueHolders ?? 0) - (a.uniqueHolders ?? 0);
    }
    if (sortKey === "newest") {
      return (b.firstTransferBlock ?? 0) - (a.firstTransferBlock ?? 0);
    }
    // name
    return (a.name || "").localeCompare(b.name || "");
  });

  return matched.slice(0, limit);
}

/** Suggestion: when hasSnapshot is false, callers should fall back to
 *  registry-only search. Lets us add chains incrementally. */
export { hasHypersync as _hasHypersync };
