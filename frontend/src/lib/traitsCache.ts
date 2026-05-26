import { get, set, del, createStore } from "idb-keyval";

/**
 * IndexedDB-backed cache for per-collection trait enumeration.
 *
 * Schema: one entry per `(chainId, contract)`. Each entry contains
 * the full enumerated state - per-token attributes, the aggregated
 * trait counts, rarity scores and ranks, plus bookkeeping for
 * reveal detection (the URIs we sampled during enumeration so we
 * can check on later visits whether the collection has changed).
 *
 * The cache is per-browser-per-device and intentionally unbounded:
 * trait data is small (~3 KB compact JSON per typical collection)
 * and stale entries are dirt cheap to overwrite when their
 * contract's `totalSupply` rises or the metadata host swaps URLs.
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
  /** ms epoch when enumeration finished. */
  enumeratedAt: number;
  /** Lifecycle status. `all_identical` is set when every token's
   *  attributes parse to the same set - signals to UI that the
   *  filter rail has nothing to offer. */
  status: "enumerating" | "complete" | "failed" | "all_identical";
  /** `totalSupply` at enumeration time. If the chain's totalSupply
   *  later exceeds this, we re-enumerate the new tokens
   *  incrementally. */
  totalSupply: number;
  /** A handful of `(tokenId, tokenURI)` pairs sampled during
   *  enumeration. On subsequent visits we re-call `tokenURI(id)`
   *  for a few random samples and compare; any mismatch indicates
   *  a reveal / baseURI swap and we invalidate the cache. */
  sampledTokenURIs: Array<{ tokenId: string; uri: string }>;
  /** trait_type -> value -> count across the collection. */
  traitCounts: Record<string, Record<string, number>>;
  /** tokenId (string) -> array of {trait_type, value}. Used for
   *  per-token filtering and detail display. */
  tokenAttributes: Record<string, TokenAttribute[]>;
  /** tokenId -> rarity score (sum of supply/count for each trait). */
  rarityScores: Record<string, number>;
  /** tokenId -> 1-based rank by descending rarity score. */
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
    // IndexedDB write failures (quota exceeded, private mode) are
    // non-fatal: the next visit just re-enumerates.
  }
}

export async function clearTraitCache(
  chainId: number,
  contract: string,
): Promise<void> {
  try {
    await del(cacheKey(chainId, contract), traitsStore);
  } catch {
    // Silently ignore.
  }
}
