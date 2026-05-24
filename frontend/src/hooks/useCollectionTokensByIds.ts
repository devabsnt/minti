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
import type { CollectionToken } from "./useCollectionTokens";

const ERC721_ABI = [
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "ownerOf",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

/**
 * Fetch ownerOf for an arbitrary, caller-supplied list of token IDs.
 *
 * Used by the trait-filter flow: the index manifest provides the filtered
 * subset of token IDs, this hook resolves their owners via Multicall3.
 */
export function useCollectionTokensByIds(
  collectionAddress: `0x${string}` | undefined,
  ids: readonly bigint[],
) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  const idsKey = ids.map((i) => i.toString()).join(",");

  return useQuery({
    queryKey: ["collection-tokens-by-ids", browseChainId, collectionAddress, idsKey],
    enabled: !!collectionAddress && ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<CollectionToken[]> => {
      if (!collectionAddress || ids.length === 0) return [];
      const pool = createRpcPool(browseChainId, getEffectiveRpc(browseChainId));

      const calls: MulticallRequest[] = ids.map((id) =>
        encodeCall(collectionAddress, ERC721_ABI, "ownerOf", [id]),
      );
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
  });
}
