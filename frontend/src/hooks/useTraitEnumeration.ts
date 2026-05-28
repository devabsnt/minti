"use client";

import { useMemo } from "react";
import { useIndexerCollectionTraits } from "@/hooks/useIndexerCollections";
import type { ApiTraitsManifest } from "@/lib/indexerApi";
import type { TokenAttribute } from "@/lib/traitsCache";

/**
 * Trait state for a collection's filter UI, sourced ENTIRELY from the
 * indexer's pre-built manifest (`/api/collections/:address/traits`).
 *
 * The indexer's trait worker walks every token's `tokenURI`, resolves
 * the metadata (honoring each contract's own host), and stores a
 * compact dictionary-encoded manifest. The frontend just inflates it.
 * There is no client-side enumeration anymore — that path was slow and
 * unreliable (rate-limited gateways, CORS, serial fetching) and is what
 * the indexer system replaced.
 *
 * States returned:
 *   - `checking`      manifest request in flight (brief, network-fast)
 *   - `complete`      full manifest — filter is live
 *   - `partial`       worker mid-walk; show the traits gathered so far
 *   - `all_identical` collection has no per-token trait variation
 *   - `idle`          no manifest yet (404 / pending / failed) — the
 *                     filter UI hides itself. No stuck spinner: if the
 *                     indexer hasn't finished this collection, we simply
 *                     don't show a filter until it has.
 */

export type EnumerationStatus =
  | "idle"
  | "checking"
  | "enumerating"
  | "partial"
  | "complete"
  | "failed"
  | "all_identical";

export interface EnumerationState {
  status: EnumerationStatus;
  /** 0..1; meaningful when status is `partial`. */
  progress: number;
  enumeratedCount: number;
  totalSupply: number;
  traitCounts: Record<string, Record<string, number>>;
  tokenAttributes: Record<string, TokenAttribute[]>;
  rarityScores: Record<string, number>;
  rarityRanks: Record<string, number>;
}

const INITIAL_STATE: EnumerationState = {
  status: "idle",
  progress: 0,
  enumeratedCount: 0,
  totalSupply: 0,
  traitCounts: {},
  tokenAttributes: {},
  rarityScores: {},
  rarityRanks: {},
};

/**
 * `totalSupply` and `tokenIdStart` are retained in the signature for
 * call-site compatibility but are no longer used — the manifest carries
 * its own totalSupply. `enabled` gates the manifest fetch (e.g. pass
 * false when an EVMFS on-chain manifest is the source instead).
 */
export function useTraitEnumeration(
  contract: string | undefined,
  _totalSupply?: number | undefined,
  _tokenIdStart: number = 1,
  enabled: boolean = true,
): EnumerationState {
  const indexerTraits = useIndexerCollectionTraits(enabled ? contract : undefined);

  return useMemo(() => {
    if (!enabled) return INITIAL_STATE;
    if (indexerTraits.isLoading) {
      return { ...INITIAL_STATE, status: "checking" };
    }
    const d = indexerTraits.data;
    if (!d || !d.manifest) {
      // 404 (not yet built), or pending/failed with no manifest. Hide
      // the filter rather than spin — it'll appear once the worker
      // finishes this collection.
      return INITIAL_STATE;
    }
    if (d.status === "all_identical") {
      // No per-token variation — return empty trait maps so the filter
      // UI hides itself (it keys off traitCounts being empty). The
      // `all_identical` status is informational.
      return {
        ...INITIAL_STATE,
        status: "all_identical",
        progress: 1,
        enumeratedCount: d.tokenCount ?? 0,
        totalSupply: d.totalSupply ? Number(d.totalSupply) : 0,
      };
    }
    if (d.status === "complete" || d.status === "partial") {
      return decodeIndexerManifest(d.manifest, d.status, d.totalSupply);
    }
    return INITIAL_STATE;
  }, [enabled, indexerTraits.isLoading, indexerTraits.data]);
}

/**
 * Inflate the indexer's dictionary-encoded manifest into the
 * `EnumerationState` the filter UI consumes. Dereferences value
 * indices through `traitValues`, builds `traitCounts`, and computes
 * rarity scores/ranks.
 */
function decodeIndexerManifest(
  manifest: ApiTraitsManifest,
  status: "complete" | "partial",
  totalSupplyStr: string | null,
): EnumerationState {
  const traitTypes = manifest.traitTypes ?? [];
  const traitValues = manifest.traitValues ?? [];
  const traits = manifest.traits ?? [];
  const totalSupply = totalSupplyStr ? Number(totalSupplyStr) : traits.length;

  const traitCounts: Record<string, Record<string, number>> = {};
  const tokenAttributes: Record<string, TokenAttribute[]> = {};
  for (const tt of traitTypes) traitCounts[tt] = {};

  for (const entry of traits) {
    const attrs: TokenAttribute[] = [];
    const indices = entry.t ?? [];
    for (let i = 0; i < indices.length; i++) {
      const vIdx = indices[i];
      if (vIdx == null || vIdx < 0) continue;
      const traitType = traitTypes[i];
      const value = traitValues[i]?.[vIdx];
      if (!traitType || value == null) continue;
      attrs.push({ trait_type: traitType, value });
      traitCounts[traitType][value] = (traitCounts[traitType][value] ?? 0) + 1;
    }
    tokenAttributes[entry.id] = attrs;
  }

  const enumeratedCount = Object.keys(tokenAttributes).length || 1;
  const rarityScores: Record<string, number> = {};
  for (const [id, attrs] of Object.entries(tokenAttributes)) {
    let score = 0;
    for (const a of attrs) {
      const count = traitCounts[a.trait_type]?.[a.value] ?? 1;
      score += enumeratedCount / count;
    }
    rarityScores[id] = score;
  }
  const sorted = Object.entries(rarityScores).sort((a, b) => b[1] - a[1]);
  const rarityRanks: Record<string, number> = {};
  sorted.forEach(([id], idx) => {
    rarityRanks[id] = idx + 1;
  });

  const count = Object.keys(tokenAttributes).length;
  return {
    status,
    progress: status === "partial" && totalSupply > 0
      ? Math.min(1, count / totalSupply)
      : 1,
    enumeratedCount: count,
    totalSupply,
    traitCounts,
    tokenAttributes,
    rarityScores,
    rarityRanks,
  };
}
