"use client";

import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import { resolveMetadata } from "@/lib/metadata";
import { getFromCache, setInCache } from "@/lib/cache";

const COLLECTION_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "tokenURI",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface CollectionInfo {
  name: string | null;
  symbol: string | null;
  iconUrl: string | null;
}

/**
 * Fetch basic collection info: name, symbol, and an icon image
 * derived from token ID 0 or 1's metadata image.
 */
export function useCollectionInfo(contractAddress: `0x${string}` | undefined) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();

  return useQuery({
    queryKey: ["collection-info", browseChainId, contractAddress],
    queryFn: async (): Promise<CollectionInfo> => {
      const cacheKey = `collection_info_${browseChainId}_${contractAddress}`;

      const cached = await getFromCache<CollectionInfo>(cacheKey);
      if (cached) return cached;

      const client = getPublicClient(browseChainId);
      const addr = contractAddress!;

      // Fetch name and symbol in parallel
      const [nameResult, symbolResult] = await Promise.all([
        client
          .readContract({ address: addr, abi: COLLECTION_ABI, functionName: "name" })
          .catch(() => null),
        client
          .readContract({ address: addr, abi: COLLECTION_ABI, functionName: "symbol" })
          .catch(() => null),
      ]);

      // Try to get icon from early token IDs
      let iconUrl: string | null = null;
      for (const id of [1n, 0n, 2n, 3n, 4n]) {
        try {
          const uri = (await client.readContract({
            address: addr,
            abi: COLLECTION_ABI,
            functionName: "tokenURI",
            args: [id],
          })) as string;

          const meta = await resolveMetadata(uri, id);
          if (meta.image) {
            iconUrl = meta.image;
            break;
          }
        } catch {
          continue;
        }
      }

      const info: CollectionInfo = {
        name: (nameResult as string) || null,
        symbol: (symbolResult as string) || null,
        iconUrl,
      };

      await setInCache(cacheKey, info);
      return info;
    },
    enabled: !!contractAddress,
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
  });
}
