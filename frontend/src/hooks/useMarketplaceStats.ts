"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { isMarketplaceDeployed } from "@/config/chains";
import { useCollectionsIndex } from "@/hooks/useCollectionsIndex";

/**
 * Per-collection marketplace stats — floor price, highest collection offer,
 * and 24h/7d volume on the MintiMarketplace contract.
 *
 * Sales metrics (volume24h/7d, recent sale count, unique buyers) are read
 * from the pre-built snapshot at `/data/monad-collections.json`. The build
 * script indexes ItemSold events directly via Hypersync — see
 * scripts/build-collections-index.mjs `scanMarketplaceSales`. As soon as
 * `MARKETPLACE_ADDRESS` is set in the GitHub Actions secrets and the next
 * cron runs, these fields populate automatically.
 *
 * Floor price + active listings/offers still require live RPC reads
 * (they change too fast to snapshot). Those are TODO — fill in when
 * the marketplace is deployed and the on-chain enumerate helpers are
 * wired up.
 */

export interface MarketplaceStats {
  floorPrice: bigint | null;
  highestOffer: bigint | null;
  volume24h: bigint | null;
  volume7d: bigint | null;
  totalVolume: bigint | null;
  recentSales: number;
  recentSales7d: number;
  uniqueBuyers24h: number;
  uniqueBuyers7d: number;
}

const EMPTY: MarketplaceStats = {
  floorPrice: null,
  highestOffer: null,
  volume24h: null,
  volume7d: null,
  totalVolume: null,
  recentSales: 0,
  recentSales7d: 0,
  uniqueBuyers24h: 0,
  uniqueBuyers7d: 0,
};

/**
 * Pull marketplace stats for one collection out of the snapshot. Cheap —
 * no network calls beyond the snapshot fetch (which is already cached by
 * react-query for an hour and by the service worker indefinitely).
 */
export function useMarketplaceStats(
  contractAddress: `0x${string}` | undefined,
) {
  const { browseChainId } = useBrowseChain();
  const { data: index } = useCollectionsIndex();

  return useQuery({
    queryKey: [
      "marketplace-stats",
      browseChainId,
      contractAddress,
      index?.builtAt,
    ],
    enabled: !!contractAddress && !!index,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<MarketplaceStats> => {
      if (!index || !contractAddress) return EMPTY;
      const lower = contractAddress.toLowerCase();
      const entry = index.collections.find(
        (c) => c.address.toLowerCase() === lower,
      );
      if (!entry) return EMPTY;
      return {
        // TODO: floor + highestOffer require live RPC. Wire when
        // MintiMarketplace deploys and we have on-chain enumerators.
        floorPrice: null,
        highestOffer: null,
        volume24h: entry.volume24h ? BigInt(entry.volume24h) : null,
        volume7d: entry.volume7d ? BigInt(entry.volume7d) : null,
        totalVolume: null,
        recentSales: entry.sales24h ?? 0,
        recentSales7d: entry.sales7d ?? 0,
        uniqueBuyers24h: entry.uniqueBuyers24h ?? 0,
        uniqueBuyers7d: entry.uniqueBuyers7d ?? 0,
      };
    },
  });
}

/**
 * Bulk variant — used wherever a grid wants to show per-card stats.
 * Returns a Map keyed by lowercased contract address. Backed by the
 * same snapshot so no per-contract network calls.
 */
export function useBulkMarketplaceStats(addresses: string[]) {
  const { browseChainId } = useBrowseChain();
  const { data: index } = useCollectionsIndex();

  return useQuery({
    queryKey: [
      "marketplace-stats-bulk",
      browseChainId,
      index?.builtAt,
      addresses.length,
      addresses[0],
    ],
    enabled: addresses.length > 0 && !!index,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<Map<string, MarketplaceStats>> => {
      const out = new Map<string, MarketplaceStats>();
      if (!index) return out;
      const wanted = new Set(addresses.map((a) => a.toLowerCase()));
      for (const c of index.collections) {
        const k = c.address.toLowerCase();
        if (!wanted.has(k)) continue;
        out.set(k, {
          floorPrice: null,
          highestOffer: null,
          volume24h: c.volume24h ? BigInt(c.volume24h) : null,
          volume7d: c.volume7d ? BigInt(c.volume7d) : null,
          totalVolume: null,
          recentSales: c.sales24h ?? 0,
          recentSales7d: c.sales7d ?? 0,
          uniqueBuyers24h: c.uniqueBuyers24h ?? 0,
          uniqueBuyers7d: c.uniqueBuyers7d ?? 0,
        });
      }
      return out;
    },
  });
}

export { isMarketplaceDeployed };
