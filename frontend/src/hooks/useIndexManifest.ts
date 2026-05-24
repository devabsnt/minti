"use client";

import { useQuery } from "@tanstack/react-query";

import { useBrowseChain } from "@/providers/ChainProvider";
import { fetchEvmfsJson, type EvmfsContract } from "@/lib/evmfs";

/**
 * Schema of the optional compact trait-index manifest a creator publishes
 * alongside their metadata. Specified in PIVOT-PLAN.md "Index manifest format".
 */
export interface IndexManifest {
  version: number;
  name: string;
  symbol: string;
  total: number;
  metadata: { hash: `0x${string}`; block: number };
  image?: { hash: `0x${string}`; block: number };
  traits: Array<{ id: number; t: string[] }>;
  /**
   * Optional: ordered names of the trait categories. If present, position i
   * in each token's `t` array corresponds to category i.
   */
  traitTypes?: string[];
}

export function useIndexManifest(
  hash: `0x${string}` | undefined,
  block: bigint | number | undefined,
  evmfsContract?: EvmfsContract
) {
  const { browseChainId } = useBrowseChain();

  return useQuery({
    queryKey: ["evmfs-index-manifest", browseChainId, hash, block?.toString(), evmfsContract],
    enabled:
      !!hash &&
      hash !== "0x0000000000000000000000000000000000000000000000000000000000000000" &&
      block !== undefined,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    queryFn: () =>
      fetchEvmfsJson<IndexManifest>({
        chainId: browseChainId,
        block: Number(block!),
        hash: hash!,
        evmfsContract,
      }),
  });
}
