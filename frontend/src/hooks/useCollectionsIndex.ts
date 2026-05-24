"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { hasHypersync } from "@/lib/hypersync/client";

/**
 * Global collections index — the union of:
 *
 *   1. A periodically-refreshed static snapshot at
 *      `/data/monad-collections.json` (built by scripts/build-collections-
 *      index.mjs via GitHub Actions, served from the static deploy).
 *   2. (TODO) A client-side Hypersync delta from the snapshot's lastBlock
 *      to chain tip, picking up anything new since the build.
 *
 * Per-chain: only Monad has a snapshot for now. Other chains return null
 * and `/explore` falls back to the registry-only path.
 */

export interface IndexedCollection {
  address: string;
  name: string | null;
  symbol: string | null;
  totalSupply: string | null;
  is721: boolean;
  is1155: boolean;
  // ─── snapshot v2 fields (may be missing on older snapshots) ───
  transferCount?: number;
  uniqueHolders?: number;
  firstTransferBlock?: number;
  lowestTokenId?: string | null;
}

export interface CollectionsIndex {
  chainId: number;
  lastBlock: number;
  builtAt: number;
  schemaVersion?: number;
  collections: IndexedCollection[];
}

/**
 * Score a collection's likely legitimacy. Higher = more likely real. Used
 * for both default sort order AND name-collision dedupe (winner per name).
 *
 * Heuristics (sum):
 *   - transferCount     — direct activity signal
 *   - uniqueHolders × 5 — distinct ownership weighted higher than raw txns
 *
 * Both are sourced from the snapshot's per-contract running tallies.
 */
export function legitimacyScore(c: IndexedCollection): number {
  return (c.transferCount ?? 0) + (c.uniqueHolders ?? 0) * 5;
}

/**
 * Collapse duplicate-name collections into one entry per name. The winner is
 * the entry with the highest legitimacy score. Collections with no name
 * (or only a symbol) fall back to symbol-keyed dedupe so "BAYC ticker only"
 * scams still collapse.
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

/**
 * Substring search + activity-based ranking.
 *
 *   - Dedupes by name (keeps the highest-activity winner per name)
 *   - Sorts by `legitimacyScore` descending so high-activity collections
 *     surface first
 *   - With an empty query, returns the top `limit` by score (default
 *     /explore landing view)
 *   - With a query, scores matches the same way then truncates
 */
export function searchIndex(
  index: CollectionsIndex | undefined,
  query: string,
  limit = 50,
): IndexedCollection[] {
  if (!index) return [];
  const deduped = dedupeByName(index.collections);
  const q = query.trim().toLowerCase();

  const matched = q
    ? deduped.filter((c) => {
        const name = (c.name || "").toLowerCase();
        const symbol = (c.symbol || "").toLowerCase();
        const addr = c.address.toLowerCase();
        return name.includes(q) || symbol.includes(q) || addr.startsWith(q);
      })
    : deduped;

  matched.sort((a, b) => legitimacyScore(b) - legitimacyScore(a));
  return matched.slice(0, limit);
}

/** Suggestion: when hasSnapshot is false, callers should fall back to
 *  registry-only search. Lets us add chains incrementally. */
export { hasHypersync as _hasHypersync };
