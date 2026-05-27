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
 * Cheap standalone totalSupply lookup. One multicall, long staleTime —
 * cached aggressively so callers that just need supply (synthetic
 * browse, trait enumeration) don't trigger the per-page ownerOf scan.
 */
export function useCollectionTotalSupply(
  collectionAddress: `0x${string}` | undefined,
) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();
  return useQuery({
    queryKey: ["collection-total-supply", browseChainId, collectionAddress],
    queryFn: async (): Promise<number> => {
      const pool = createRpcPool(browseChainId, getEffectiveRpc(browseChainId));
      const calls: MulticallRequest[] = [
        encodeCall(collectionAddress!, ERC721_ABI, "totalSupply", []),
      ];
      const results = await executeBatchedMulticalls(pool, calls);
      const flat = results.flat();
      const supply = flat[0]
        ? decodeResult<bigint>(ERC721_ABI, "totalSupply", flat[0])
        : null;
      return supply ? Number(supply) : 0;
    },
    enabled: !!collectionAddress,
    staleTime: 60_000,
  });
}

/**
 * Browse a collection by paginating through token IDs.
 * Fetches ownerOf for each ID via Multicall3 to verify it exists and get the owner.
 *
 * `options.scanEnabled` defaults to true. Pass `false` to opt out of the
 * per-page ownerOf scan while keeping the cheap `totalSupply` query —
 * useful when a synthetic browse path (placeholder owners + templated
 * thumbnails) can serve the grid without confirming ownership of every
 * tile. The brute scan eats RPC quota that should go to the wallet
 * scan on fresh collections, so callers that already know totalSupply
 * from another source should skip it.
 */
export function useCollectionTokens(
  collectionAddress: `0x${string}` | undefined,
  page: number,
  options?: { scanEnabled?: boolean },
) {
  const scanEnabled = options?.scanEnabled ?? true;
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
    enabled: !!collectionAddress && totalSupply > 0 && scanEnabled,
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
