"use client";

import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import { resolveMetadata } from "@/lib/metadata";
import { getFromCache, setInCache, metadataCacheKey } from "@/lib/cache";
import {
  createRpcPool,
  executeBatchedMulticalls,
  encodeCall,
  decodeResult,
  type MulticallRequest,
} from "@/lib/rpcPool";
import type { NftMetadata } from "@/types/nft";
import type { Abi } from "viem";

const TOKEN_URI_ABI = [
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "tokenURI",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "uint256", name: "id" }],
    name: "uri",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

const METADATA_STALE_TIME = 24 * 60 * 60 * 1000;

/**
 * Single-token metadata hook (for detail pages).
 */
export function useNftMetadata(
  nftContract: `0x${string}` | undefined,
  tokenId: bigint | undefined,
  isERC1155 = false
) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  return useQuery({
    queryKey: ["nft-metadata", browseChainId, nftContract, tokenId?.toString()],
    queryFn: async (): Promise<NftMetadata> => {
      const cacheKey = metadataCacheKey(browseChainId, nftContract!, tokenId!.toString());
      const cached = await getFromCache<NftMetadata>(cacheKey);
      if (cached) return cached;

      // Use rpcPool to share node-health state with the batch path —
      // a 429 on one path now backs off the other path too.
      const userRpc = getEffectiveRpc(browseChainId);
      const pool = createRpcPool(browseChainId, userRpc);
      const funcName = isERC1155 ? "uri" : "tokenURI";
      const calls: MulticallRequest[] = [
        encodeCall(nftContract!, TOKEN_URI_ABI, funcName, [tokenId!]),
      ];
      const results = await executeBatchedMulticalls(pool, calls);
      const flat = results.flat();
      const uri = flat[0]
        ? decodeResult<string>(TOKEN_URI_ABI, funcName, flat[0])
        : null;
      if (!uri) {
        throw new Error("tokenURI returned empty");
      }

      const metadata = await resolveMetadata(uri, tokenId!);
      await setInCache(cacheKey, metadata);
      return metadata;
    },
    enabled: !!nftContract && tokenId != null,
    staleTime: METADATA_STALE_TIME,
    gcTime: METADATA_STALE_TIME,
    // 1 retry only. Most metadata fetch failures are CORS (the host
    // doesn't send Access-Control-Allow-Origin) or 404, neither of
    // which gets better with retries - we'd just spam the console.
    // The single retry handles the rare transient network blip.
    retry: 1,
  });
}

/**
 * Batch metadata hook — fetches tokenURI for multiple tokens in a single
 * Multicall3 request, then resolves all metadata JSON in parallel.
 * Results are seeded into the single-token query cache so individual
 * useNftMetadata calls don't re-fetch.
 */
export interface BatchToken {
  contractAddress: `0x${string}`;
  tokenId: bigint;
  isERC1155?: boolean;
}

export function useBatchNftMetadata(tokens: BatchToken[]) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: [
      "batch-nft-metadata",
      browseChainId,
      tokens.map((t) => `${t.contractAddress}:${t.tokenId}`).join(","),
    ],
    queryFn: async (): Promise<Map<string, NftMetadata>> => {
      const results = new Map<string, NftMetadata>();
      if (tokens.length === 0) return results;

      const userRpc = getEffectiveRpc(browseChainId);

      // Check IndexedDB cache for every token in parallel. Sequential
      // awaits were costing ~5ms per token = visible blocking time for
      // wallets with dozens of NFTs before anything renders on refresh.
      const cacheChecks = await Promise.all(
        tokens.map(async (t) => {
          const key = metadataCacheKey(browseChainId, t.contractAddress, t.tokenId.toString());
          const cached = await getFromCache<NftMetadata>(key);
          return { token: t, cacheKey: key, cached };
        }),
      );

      const uncached: { index: number; token: BatchToken; cacheKey: string }[] = [];
      for (let i = 0; i < cacheChecks.length; i++) {
        const { token: t, cacheKey: key, cached } = cacheChecks[i];
        if (cached) {
          results.set(`${t.contractAddress}:${t.tokenId}`, cached);
          // Seed single-token cache so individual hook calls don't re-fetch
          queryClient.setQueryData(
            ["nft-metadata", browseChainId, t.contractAddress, t.tokenId.toString()],
            cached
          );
        } else {
          uncached.push({ index: i, token: t, cacheKey: key });
        }
      }

      if (uncached.length === 0) return results;

      // Batch tokenURI calls via Multicall3
      const calls: MulticallRequest[] = uncached.map(({ token }) =>
        encodeCall(
          token.contractAddress,
          TOKEN_URI_ABI,
          token.isERC1155 ? "uri" : "tokenURI",
          [token.tokenId]
        )
      );

      const pool = createRpcPool(browseChainId, userRpc);
      const batchResults = await executeBatchedMulticalls(pool, calls);
      const flat = batchResults.flat();

      // Resolve metadata JSON in parallel (IPFS/HTTP fetches)
      const resolvePromises = uncached.map(async ({ token, cacheKey }, i) => {
        const entry = flat[i];
        if (!entry || !entry.success) return;

        const funcName = token.isERC1155 ? "uri" : "tokenURI";
        const uri = decodeResult<string>(TOKEN_URI_ABI, funcName, entry);
        if (!uri) return;

        try {
          const metadata = await resolveMetadata(uri, token.tokenId);
          await setInCache(cacheKey, metadata);

          const mapKey = `${token.contractAddress}:${token.tokenId}`;
          results.set(mapKey, metadata);

          // Seed single-token cache
          queryClient.setQueryData(
            ["nft-metadata", browseChainId, token.contractAddress, token.tokenId.toString()],
            metadata
          );
        } catch {
          // Metadata resolve failed — skip this token
        }
      });

      await Promise.allSettled(resolvePromises);
      return results;
    },
    enabled: tokens.length > 0,
    staleTime: METADATA_STALE_TIME,
    gcTime: METADATA_STALE_TIME,
  });
}
