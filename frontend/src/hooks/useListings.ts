"use client";

import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import { MINTI_MARKETPLACE_ADDRESS, isMarketplaceDeployed } from "@/config/chains";
import { PAGE_SIZE, LISTING_STALE_TIME } from "@/config/constants";
import mintiAbi from "@/lib/abi/MintiMarketplace.json";
import type { Listing, ListingWithId } from "@/types/marketplace";

export function useAllListings(page: number) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();

  return useQuery({
    queryKey: ["all-listings", browseChainId, page],
    queryFn: async (): Promise<{ listings: ListingWithId[]; total: number }> => {
      const client = getPublicClient(browseChainId);

      const count = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getTotalListingCount",
      })) as bigint;

      if (count === 0n) return { listings: [], total: 0 };

      const offset = BigInt(page * PAGE_SIZE);
      const ids = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getAllListingIds",
        args: [offset, BigInt(PAGE_SIZE)],
      })) as bigint[];

      if (ids.length === 0) return { listings: [], total: Number(count) };

      const rawListings = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getListingsByIds",
        args: [ids],
      })) as Listing[];

      const listings: ListingWithId[] = rawListings.map((l, i) => ({
        ...l,
        listingId: ids[i],
      }));

      return { listings, total: Number(count) };
    },
    enabled: isMarketplaceDeployed,
    staleTime: LISTING_STALE_TIME,
  });
}

export function useCollectionListings(
  collectionAddress: `0x${string}` | undefined,
  page: number
) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();

  return useQuery({
    queryKey: ["collection-listings", browseChainId, collectionAddress, page],
    queryFn: async (): Promise<{ listings: ListingWithId[]; total: number }> => {
      const client = getPublicClient(browseChainId);

      const count = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionListingCount",
        args: [collectionAddress!],
      })) as bigint;

      if (count === 0n) return { listings: [], total: 0 };

      const offset = BigInt(page * PAGE_SIZE);
      const ids = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionListingIds",
        args: [collectionAddress!, offset, BigInt(PAGE_SIZE)],
      })) as bigint[];

      if (ids.length === 0) return { listings: [], total: Number(count) };

      const rawListings = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getListingsByIds",
        args: [ids],
      })) as Listing[];

      const listings: ListingWithId[] = rawListings.map((l, i) => ({
        ...l,
        listingId: ids[i],
      }));

      return { listings, total: Number(count) };
    },
    enabled: !!collectionAddress && isMarketplaceDeployed,
    staleTime: LISTING_STALE_TIME,
  });
}
