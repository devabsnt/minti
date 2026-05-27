import { get, set, del, createStore } from "idb-keyval";

/**
 * IndexedDB-backed cache for per-collection trait enumeration.
 *
 * Two stores cooperate to avoid the historic "two caches that don't
 * talk to each other" problem:
 *
 *   - `nft-metadata` (in `cache.ts`) holds full per-token JSON keyed
 *     by `${chainId}-${contract}-${tokenId}`. Populated whenever a
 *     card render or detail modal fetches a token.
 *   - `trait-enumeration` (this file) holds the rolled-up aggregate
 *     per collection. It is **derived from** the metadata cache,
 *     never a separate sweep.
 *
 * `mergeTokenIntoAggregate` is the single write path: every successful
 * metadata fetch (cards, detail modals, the enumerator's fill loop)
 * calls it, and the topbar filter consumes the resulting aggregate.
 *
 * Status lifecycle:
 *   - `partial`: some tokens enumerated, more outstanding. Topbar shows
 *     the filter immediately so users can act on what we have.
 *   - `complete`: every token enumerated, rarity ranks computed.
 *   - `all_identical`: every token shares the same attribute set, no
 *     filterable variation.
 *   - `failed`: aggregation produced nothing usable.
 *
 * The cache is per-browser-per-device and intentionally unbounded:
 * trait data is small (~3 KB compact JSON per typical collection).
 */

const traitsStore = createStore("minti-cache", "trait-enumeration");

export interface TokenAttribute {
  trait_type: string;
  value: string;
}

export interface CachedTraitData {
  /** Lowercased contract address. */
  contract: string;
  chainId: number;
  /** ms epoch when the aggregate was last updated (any write). */
  enumeratedAt: number;
  status: "partial" | "enumerating" | "complete" | "failed" | "all_identical";
  /** `totalSupply` known at enumeration time. */
  totalSupply: number;
  /** Sampled `(tokenId, tokenURI)` pairs from the original tokenURI sweep.
   *  Re-sampled on revisit to detect reveals / baseURI swaps. */
  sampledTokenURIs: Array<{ tokenId: string; uri: string }>;
  /** trait_type -> value -> count across the enumerated set. */
  traitCounts: Record<string, Record<string, number>>;
  /** tokenId -> attributes array. */
  tokenAttributes: Record<string, TokenAttribute[]>;
  /** Rarity score per token (sum of supply/count). Recomputed lazily. */
  rarityScores: Record<string, number>;
  /** Rarity rank per token (1 = rarest). Recomputed lazily. */
  rarityRanks: Record<string, number>;
}

const cacheKey = (chainId: number, contract: string): string =>
  `${chainId}-${contract.toLowerCase()}`;

export async function getTraitCache(
  chainId: number,
  contract: string,
): Promise<CachedTraitData | undefined> {
  try {
    return await get<CachedTraitData>(cacheKey(chainId, contract), traitsStore);
  } catch {
    return undefined;
  }
}

export async function setTraitCache(data: CachedTraitData): Promise<void> {
  try {
    await set(cacheKey(data.chainId, data.contract), data, traitsStore);
  } catch {
    /* quota / private mode — non-fatal */
  }
}

export async function clearTraitCache(
  chainId: number,
  contract: string,
): Promise<void> {
  try {
    await del(cacheKey(chainId, contract), traitsStore);
  } catch {
    /* ignore */
  }
}

// ── Aggregation primitives ────────────────────────────────────────

/**
 * Recompute rarity scores + ranks from `tokenAttributes` + `traitCounts`.
 * Cheap relative to the cost of running an enumeration, so we redo it
 * whenever new tokens get merged in. score = sum(supply / count); higher
 * = rarer. Ranks are 1-based, ascending by descending score.
 */
export function computeRarity(data: CachedTraitData): void {
  const enumeratedSupply = Object.keys(data.tokenAttributes).length || data.totalSupply || 1;
  const rarityScores: Record<string, number> = {};
  for (const [tokenIdStr, attrs] of Object.entries(data.tokenAttributes)) {
    let score = 0;
    for (const a of attrs) {
      const count = data.traitCounts[a.trait_type]?.[a.value] ?? 1;
      score += enumeratedSupply / count;
    }
    rarityScores[tokenIdStr] = score;
  }
  const sorted = Object.entries(rarityScores).sort((a, b) => b[1] - a[1]);
  const rarityRanks: Record<string, number> = {};
  sorted.forEach(([id], idx) => {
    rarityRanks[id] = idx + 1;
  });
  data.rarityScores = rarityScores;
  data.rarityRanks = rarityRanks;
}

function normalizeAttributes(
  raw: unknown,
): TokenAttribute[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => a as { trait_type?: string; value?: unknown })
    .filter((a) => a && typeof a.trait_type === "string" && a.value != null)
    .map((a) => ({
      trait_type: a.trait_type as string,
      value: String(a.value),
    }));
}

/**
 * In-process locks per cache key so concurrent metadata fetches don't
 * race the read-modify-write cycle. Each key serializes its own writes.
 */
const writeLocks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  writeLocks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === prev.then(() => next)) {
      writeLocks.delete(key);
    }
  }
}

/**
 * Merge a single token's attributes into the aggregate. Idempotent: if
 * the same `(chainId, contract, tokenId)` is merged twice with the same
 * attributes, counts don't double. Creates the aggregate entry on first
 * call.
 *
 * Designed to be called from every metadata-fetch success path:
 * `useNftMetadata`, `useBatchNftMetadata`, and the trait enumerator's
 * fill loop. Status starts at `partial` and only `useTraitEnumeration`
 * promotes it to `complete` (when totalSupply is reached) or
 * `all_identical` (when the variation check passes).
 */
export async function mergeTokenIntoAggregate(
  chainId: number,
  contract: string,
  tokenId: string,
  attributesRaw: unknown,
  hints?: { totalSupply?: number },
): Promise<void> {
  const attributes = normalizeAttributes(attributesRaw);
  // Empty attributes still count as "seen" so the enumerator doesn't
  // re-fetch tokens that legitimately have none. We just don't put them
  // in traitCounts.
  const key = cacheKey(chainId, contract);
  await withLock(key, async () => {
    const existing = (await getTraitCache(chainId, contract)) ?? {
      contract: contract.toLowerCase(),
      chainId,
      enumeratedAt: 0,
      status: "partial" as const,
      totalSupply: hints?.totalSupply ?? 0,
      sampledTokenURIs: [],
      traitCounts: {},
      tokenAttributes: {},
      rarityScores: {},
      rarityRanks: {},
    };

    // If we already have a different set of attributes for this token,
    // back out the old counts before writing the new ones — handles the
    // case where a collection was re-revealed and a token's attributes
    // shifted.
    const prior = existing.tokenAttributes[tokenId];
    if (prior && prior.length > 0) {
      for (const a of prior) {
        const bucket = existing.traitCounts[a.trait_type];
        if (!bucket) continue;
        bucket[a.value] = Math.max(0, (bucket[a.value] ?? 0) - 1);
        if (bucket[a.value] === 0) delete bucket[a.value];
        if (Object.keys(bucket).length === 0) {
          delete existing.traitCounts[a.trait_type];
        }
      }
    }

    existing.tokenAttributes[tokenId] = attributes;
    for (const a of attributes) {
      if (!existing.traitCounts[a.trait_type]) {
        existing.traitCounts[a.trait_type] = {};
      }
      existing.traitCounts[a.trait_type][a.value] =
        (existing.traitCounts[a.trait_type][a.value] ?? 0) + 1;
    }
    existing.enumeratedAt = Date.now();
    if (hints?.totalSupply && hints.totalSupply > existing.totalSupply) {
      existing.totalSupply = hints.totalSupply;
    }
    // Promote `failed` back to `partial` on a successful merge — any new
    // data is better than no data. `complete` / `all_identical` stay
    // sticky until the enumerator explicitly re-evaluates.
    if (existing.status === "failed") existing.status = "partial";
    if (existing.status === "enumerating") existing.status = "partial";

    computeRarity(existing);
    await setTraitCache(existing);
  });
}

/**
 * Return the current aggregate for a collection — used by hooks that
 * want to seed their state from cache without triggering a full
 * enumeration. May be undefined for a never-seen collection.
 */
export async function getAggregateForCollection(
  chainId: number,
  contract: string,
): Promise<CachedTraitData | undefined> {
  return getTraitCache(chainId, contract);
}

/** Convenience: which token IDs are already in the aggregate? */
export function aggregateTokenIds(data: CachedTraitData | undefined): Set<string> {
  if (!data) return new Set();
  return new Set(Object.keys(data.tokenAttributes));
}
