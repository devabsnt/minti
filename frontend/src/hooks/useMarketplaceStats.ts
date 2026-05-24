"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { isMarketplaceDeployed } from "@/config/chains";

/**
 * Per-collection marketplace stats — floor price, highest collection offer,
 * and 24h volume on the MintiMarketplace contract. Stub for now: the
 * marketplace contract isn't deployed on Monad mainnet yet, so every call
 * resolves to nulls. When the contract goes live, fill in the queryFn —
 * everything downstream (`/explore` ranking, collection-page header,
 * /wallet listed-tab) will pick the data up automatically.
 *
 * When implemented, the queryFn should:
 *   - Scan ItemListed / ItemSold / BidAccepted / CollectionOfferAccepted
 *     events from MintiMarketplace via Hypersync (free, fast, can do
 *     bulk lookups across many collections in one query)
 *   - Compute floor = min(active listing prices for this contract)
 *   - Compute highestOffer = max(active collection offer amounts)
 *   - Compute volume24h = sum(sold price) where sold-at > now() - 24h
 *
 * The same Hypersync proxy + cache pattern used in `useHypersyncWalletScan`
 * applies — keep results in IndexedDB, deltas only.
 */

export interface MarketplaceStats {
  floorPrice: bigint | null;
  highestOffer: bigint | null;
  volume24h: bigint | null;
  totalVolume: bigint | null;
  recentSales: number;
}

const EMPTY: MarketplaceStats = {
  floorPrice: null,
  highestOffer: null,
  volume24h: null,
  totalVolume: null,
  recentSales: 0,
};

export function useMarketplaceStats(
  contractAddress: `0x${string}` | undefined,
) {
  const { browseChainId } = useBrowseChain();

  return useQuery({
    queryKey: ["marketplace-stats", browseChainId, contractAddress],
    enabled: !!contractAddress && isMarketplaceDeployed,
    staleTime: 60_000,
    queryFn: async (): Promise<MarketplaceStats> => {
      // TODO: when MintiMarketplace is deployed, scan events here.
      return EMPTY;
    },
  });
}

/**
 * Bulk variant — used by /explore to rank collections by marketplace
 * activity once the contract is live. Returns a Map keyed by lowercased
 * contract address. Currently a no-op map.
 */
export function useBulkMarketplaceStats(addresses: string[]) {
  const { browseChainId } = useBrowseChain();

  return useQuery({
    queryKey: ["marketplace-stats-bulk", browseChainId, addresses.length, addresses[0]],
    enabled: addresses.length > 0 && isMarketplaceDeployed,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, MarketplaceStats>> => {
      // TODO: single Hypersync query for all addresses, group by contract.
      return new Map();
    },
  });
}
