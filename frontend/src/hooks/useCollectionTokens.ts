"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useRpc } from "@/providers/RpcProvider";
import {
  createRpcPool,
  executeBatchedMulticalls,
  encodeCall,
  decodeResult,
  type MulticallRequest,
} from "@/lib/rpcPool";
import type { Abi } from "viem";

const ERC721_ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "ownerOf",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

export interface CollectionToken {
  tokenId: bigint;
  owner: string;
}

const BROWSE_PAGE_SIZE = 24;

/**
 * Browse a collection by paginating through token IDs.
 * Fetches ownerOf for each ID via Multicall3 to verify it exists and get the owner.
 */
export function useCollectionTokens(
  collectionAddress: `0x${string}` | undefined,
  page: number
) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  const totalSupplyQuery = useQuery({
    queryKey: ["collection-total-supply", browseChainId, collectionAddress],
    queryFn: async (): Promise<number> => {
      const pool = createRpcPool(browseChainId, getEffectiveRpc(browseChainId));
      const calls: MulticallRequest[] = [
        encodeCall(collectionAddress!, ERC721_ABI, "totalSupply", []),
      ];
      const results = await executeBatchedMulticalls(pool, calls);
      const flat = results.flat();
      const supply = flat[0] ? decodeResult<bigint>(ERC721_ABI, "totalSupply", flat[0]) : null;
      return supply ? Number(supply) : 0;
    },
    enabled: !!collectionAddress,
    staleTime: 60_000,
  });

  const totalSupply = totalSupplyQuery.data ?? 0;

  const tokensQuery = useQuery({
    queryKey: ["collection-tokens", browseChainId, collectionAddress, page],
    queryFn: async (): Promise<CollectionToken[]> => {
      if (totalSupply === 0) return [];

      const userRpc = getEffectiveRpc(browseChainId);
      const pool = createRpcPool(browseChainId, userRpc);

      // Calculate page range — token IDs from (page * pageSize) to ((page+1) * pageSize - 1)
      const start = page * BROWSE_PAGE_SIZE;
      const end = Math.min(start + BROWSE_PAGE_SIZE, totalSupply);
      if (start >= totalSupply) return [];

      const calls: MulticallRequest[] = [];
      const ids: bigint[] = [];
      for (let id = start; id < end; id++) {
        ids.push(BigInt(id));
        calls.push(encodeCall(collectionAddress!, ERC721_ABI, "ownerOf", [BigInt(id)]));
      }

      const results = await executeBatchedMulticalls(pool, calls);
      const flat = results.flat();

      const tokens: CollectionToken[] = [];
      for (let i = 0; i < flat.length; i++) {
        const entry = flat[i];
        if (!entry || !entry.success) continue;
        const owner = decodeResult<string>(ERC721_ABI, "ownerOf", entry);
        if (owner && owner !== "0x0000000000000000000000000000000000000000") {
          tokens.push({ tokenId: ids[i], owner });
        }
      }

      return tokens;
    },
    enabled: !!collectionAddress && totalSupply > 0,
    staleTime: 30_000,
  });

  return {
    tokens: tokensQuery.data ?? [],
    totalSupply,
    totalPages: Math.ceil(totalSupply / BROWSE_PAGE_SIZE),
    isLoading: totalSupplyQuery.isLoading || tokensQuery.isLoading,
    pageSize: BROWSE_PAGE_SIZE,
  };
}
