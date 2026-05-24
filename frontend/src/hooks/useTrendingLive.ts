"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";

/**
 * Live "trending right now" data. Backed by a static snapshot file refreshed
 * by a high-frequency cron (every 1-2 hours; see scripts/build-trending-
 * snapshot.mjs). The frontend just fetches the JSON.
 *
 * Why not Hypersync directly: per-user calls share a single Hypersync API
 * token (rate limited to 500 RPM). Pushing the work to a cron means we can
 * support unlimited concurrent users without burning the token budget.
 *
 * Returns Map<address, transferCount> for the most recent window the cron
 * produced (currently 6h). Empty Map while loading or on fetch failure.
 */

interface TrendingSnapshotEntry {
  address: string;
  transfers: number;
  mints: number;
  receivers: number;
  senders: number;
}

interface TrendingSnapshot {
  chainId: number;
  builtAt: number;
  windowHours: number;
  fromBlock: number;
  tipBlock: number;
  collections: TrendingSnapshotEntry[];
}

const TRENDING_PATHS: Record<number, string> = {
  143: "/data/monad-trending.json",
};

/**
 * The old API returned only counts. New API returns the full entry per
 * collection (receivers, senders, mints) so the hero card can show real
 * buyer diversity, not just raw transfers.
 */
export interface TrendingEntry {
  transfers: number;
  mints: number;
  receivers: number;
  senders: number;
}

/**
 * Returns a Map keyed by lowercased address. Backwards-compatible: existing
 * call-sites that read it as Map<address, number> (transfer count) still
 * work through the `.transfers` getter.
 */
export function useTrendingLive(_hours = 6) {
  const { browseChainId } = useBrowseChain();
  const path = TRENDING_PATHS[browseChainId];

  return useQuery({
    queryKey: ["trending-snapshot", browseChainId],
    enabled: !!path,
    staleTime: 5 * 60 * 1000, // 5 min — snapshot only refreshes hourly anyway
    queryFn: async (): Promise<Map<string, number>> => {
      const resp = await fetch(path);
      if (!resp.ok) {
        // Soft-fail: explore page falls back to snapshot's recent24h.
        return new Map();
      }
      const snap = (await resp.json()) as TrendingSnapshot;
      const out = new Map<string, number>();
      for (const c of snap.collections) {
        out.set(c.address.toLowerCase(), c.transfers);
      }
      return out;
    },
  });
}

/**
 * Richer variant exposing the full per-collection entry (transfers + mints
 * + receivers + senders). Used by ranking code that needs buyer diversity.
 */
export function useTrendingDetailed() {
  const { browseChainId } = useBrowseChain();
  const path = TRENDING_PATHS[browseChainId];

  return useQuery({
    queryKey: ["trending-snapshot-detailed", browseChainId],
    enabled: !!path,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, TrendingEntry>> => {
      const resp = await fetch(path);
      if (!resp.ok) return new Map();
      const snap = (await resp.json()) as TrendingSnapshot;
      const out = new Map<string, TrendingEntry>();
      for (const c of snap.collections) {
        out.set(c.address.toLowerCase(), {
          transfers: c.transfers,
          mints: c.mints,
          receivers: c.receivers,
          senders: c.senders,
        });
      }
      return out;
    },
  });
}
