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
}

export interface CollectionsIndex {
  chainId: number;
  lastBlock: number;
  builtAt: number;
  collections: IndexedCollection[];
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
 * Simple substring search over the index. Matches name OR symbol OR a
 * prefix of the address. Case-insensitive. Returns up to `limit` hits.
 */
export function searchIndex(
  index: CollectionsIndex | undefined,
  query: string,
  limit = 50,
): IndexedCollection[] {
  if (!index) return [];
  const q = query.trim().toLowerCase();
  if (!q) return index.collections.slice(0, limit);

  const out: IndexedCollection[] = [];
  for (const c of index.collections) {
    const name = (c.name || "").toLowerCase();
    const symbol = (c.symbol || "").toLowerCase();
    const addr = c.address.toLowerCase();
    if (name.includes(q) || symbol.includes(q) || addr.startsWith(q)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Suggestion: when hasSnapshot is false, callers should fall back to
 *  registry-only search. Lets us add chains incrementally. */
export { hasHypersync as _hasHypersync };
