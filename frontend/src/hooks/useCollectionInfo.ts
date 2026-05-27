"use client";

import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import { resolveMetadata, resolveUri } from "@/lib/metadata";
import { getFromCache, setInCache } from "@/lib/cache";
import { useIndexerCollection } from "@/hooks/useIndexerCollections";
import {
  createRpcPool,
  executeBatchedMulticalls,
  encodeCall,
  decodeResult,
  type MulticallRequest,
} from "@/lib/rpcPool";
import type { Abi } from "viem";

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
] as const satisfies Abi;

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
  const { getEffectiveRpc } = useRpc();
  // Indexer already does the icon + name discovery during enrichment.
  // Reading it here lets enriched collections skip the on-chain probe
  // entirely — saving up to 5 tokenURI + metadata fetches per visit.
  const indexerCollection = useIndexerCollection(contractAddress);
  const indexerSampleImage =
    indexerCollection.data?.collection?.sampleImageUrl ?? null;
  const indexerName = indexerCollection.data?.collection?.name ?? null;
  const indexerSymbol = indexerCollection.data?.collection?.symbol ?? null;

  return useQuery({
    queryKey: [
      "collection-info",
      browseChainId,
      contractAddress,
      indexerSampleImage,
    ],
    queryFn: async (): Promise<CollectionInfo> => {
      const cacheKey = `collection_info_${browseChainId}_${contractAddress}`;

      const cached = await getFromCache<CollectionInfo>(cacheKey);
      if (cached && cached.iconUrl) return cached;

      const addr = contractAddress!;
      const userRpc = getEffectiveRpc(browseChainId);
      const pool = createRpcPool(browseChainId, userRpc);

      // Batch name + symbol into a single multicall when we need either.
      const calls: MulticallRequest[] = [];
      const needName = !indexerName;
      const needSymbol = !indexerSymbol;
      if (needName) calls.push(encodeCall(addr, COLLECTION_ABI, "name", []));
      if (needSymbol) calls.push(encodeCall(addr, COLLECTION_ABI, "symbol", []));

      let nameResult: string | null = indexerName;
      let symbolResult: string | null = indexerSymbol;
      if (calls.length > 0) {
        const out = (await executeBatchedMulticalls(pool, calls)).flat();
        let idx = 0;
        if (needName) {
          const r = out[idx++];
          nameResult = r ? decodeResult<string>(COLLECTION_ABI, "name", r) : null;
        }
        if (needSymbol) {
          const r = out[idx++];
          symbolResult = r ? decodeResult<string>(COLLECTION_ABI, "symbol", r) : null;
        }
      }

      // Icon: prefer the indexer's sampleImageUrl. Fall back to a
      // narrow on-chain probe (IDs 1, 0) only when the indexer has
      // nothing — the wider 5-ID probe wasted up to 5 sequential RPC
      // round-trips on collections that simply don't have low IDs.
      let iconUrl: string | null = indexerSampleImage
        ? resolveUri(indexerSampleImage)
        : null;
      if (!iconUrl) {
        const idCalls: MulticallRequest[] = [
          encodeCall(addr, COLLECTION_ABI, "tokenURI", [1n]),
          encodeCall(addr, COLLECTION_ABI, "tokenURI", [0n]),
        ];
        const uriResults = (await executeBatchedMulticalls(pool, idCalls)).flat();
        for (let i = 0; i < uriResults.length; i++) {
          const entry = uriResults[i];
          if (!entry || !entry.success) continue;
          const uri = decodeResult<string>(COLLECTION_ABI, "tokenURI", entry);
          if (!uri) continue;
          try {
            const meta = await resolveMetadata(uri, i === 0 ? 1n : 0n);
            if (meta.image) {
              iconUrl = meta.image;
              break;
            }
          } catch {
            continue;
          }
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
