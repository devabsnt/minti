"use client";

import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import { MINTI_MARKETPLACE_ADDRESS, isMarketplaceDeployed } from "@/config/chains";
import { LISTING_STALE_TIME } from "@/config/constants";
import mintiAbi from "@/lib/abi/MintiMarketplace.json";
import type { Bid, BidWithId, CollectionOffer, CollectionOfferWithId } from "@/types/marketplace";

export function useCollectionBids(
  collectionAddress: `0x${string}` | undefined
) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();

  return useQuery({
    queryKey: ["collection-bids", browseChainId, collectionAddress],
    queryFn: async (): Promise<BidWithId[]> => {
      const client = getPublicClient(browseChainId);

      const count = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionBidCount",
        args: [collectionAddress!],
      })) as bigint;

      if (count === 0n) return [];

      const ids = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionBidIds",
        args: [collectionAddress!, 0n, count],
      })) as bigint[];

      const rawBids = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getBidsByIds",
        args: [ids],
      })) as Bid[];

      return rawBids.map((b, i) => ({ ...b, bidId: ids[i] }));
    },
    enabled: !!collectionAddress && isMarketplaceDeployed,
    staleTime: LISTING_STALE_TIME,
  });
}

export function useCollectionOffers(
  collectionAddress: `0x${string}` | undefined
) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();

  return useQuery({
    queryKey: ["collection-offers", browseChainId, collectionAddress],
    queryFn: async (): Promise<CollectionOfferWithId[]> => {
      const client = getPublicClient(browseChainId);

      const count = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionOfferCount",
        args: [collectionAddress!],
      })) as bigint;

      if (count === 0n) return [];

      const ids = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionOfferIds",
        args: [collectionAddress!, 0n, count],
      })) as bigint[];

      const rawOffers = (await client.readContract({
        address: MINTI_MARKETPLACE_ADDRESS,
        abi: mintiAbi,
        functionName: "getCollectionOffersByIds",
        args: [ids],
      })) as CollectionOffer[];

      return rawOffers.map((o, i) => ({ ...o, offerId: ids[i] }));
    },
    enabled: !!collectionAddress && isMarketplaceDeployed,
    staleTime: LISTING_STALE_TIME,
  });
}
