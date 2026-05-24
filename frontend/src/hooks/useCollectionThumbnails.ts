"use client";

import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useRpc } from "@/providers/RpcProvider";
import { resolveMetadata, extrapolateImageUrl } from "@/lib/metadata";
import {
  getFromCache,
  setInCache,
  metadataCacheKey,
} from "@/lib/cache";
import type { NftMetadata } from "@/types/nft";
import type { Abi } from "viem";

/**
 * Cheap-thumbnail hook for grids that need an image per token but don't
 * need full metadata for each one.
 *
 * Strategy:
 *   1. Read tokenURI for ONE reference token (the lowest known tokenId).
 *      One on-chain call + one IPFS fetch.
 *   2. Try to derive image URLs for the other tokenIds by string-replacing
 *      the reference tokenId in the reference image URL
 *      ({@link extrapolateImageUrl}). Returns null if the URL isn't
 *      pattern-based.
 *   3. For tokens where extrapolation succeeded, the caller gets a synth
 *      URL immediately — no network call. For tokens where it failed,
 *      the caller should fall back to per-token metadata fetch.
 *
 * Returned shape:
 *   {
 *     referenceMetadata,        // full metadata for the reference token
 *     imageUrlFor(tokenId),     // synth URL or null when pattern unknown
 *     isLoading, error
 *   }
 *
 * Notes:
 *   - data: URIs always force per-token fetch — patterns don't apply.
 *   - ERC-1155 collections with `{id}` template are NOT supported here
 *     (the {id} variants flow inside resolveMetadata is per-token already).
 *   - For collections where extensions differ across tokens (most .png with
 *     occasional .gif), the synth URL might 404; the underlying <img> tag
 *     should handle the load-error and the caller can probe via
 *     `findWorkingExtension` if needed.
 */

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

export interface CollectionThumbnails {
  referenceMetadata: NftMetadata | null;
  referenceTokenId: bigint | null;
  imageUrlFor: (tokenId: bigint) => string | null;
}

export function useCollectionThumbnails(
  contractAddress: `0x${string}` | undefined,
  referenceTokenId: bigint | undefined,
  isERC1155 = false,
) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();

  return useQuery<CollectionThumbnails>({
    queryKey: [
      "collection-thumbnails",
      browseChainId,
      contractAddress,
      referenceTokenId?.toString(),
    ],
    enabled: !!contractAddress && referenceTokenId != null,
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: async () => {
      const key = metadataCacheKey(
        browseChainId,
        contractAddress!,
        referenceTokenId!.toString(),
      );
      let metadata = await getFromCache<NftMetadata>(key);
      if (!metadata) {
        const client = getPublicClient(browseChainId);
        const uri = (await client.readContract({
          address: contractAddress!,
          abi: TOKEN_URI_ABI,
          functionName: isERC1155 ? "uri" : "tokenURI",
          args: [referenceTokenId!],
        })) as string;
        metadata = await resolveMetadata(uri, referenceTokenId!);
        await setInCache(key, metadata);
      }

      const refImage = metadata.image;
      const refTokenId = referenceTokenId!;

      return {
        referenceMetadata: metadata,
        referenceTokenId: refTokenId,
        imageUrlFor: (tokenId: bigint) => {
          if (tokenId === refTokenId) return refImage;
          return extrapolateImageUrl(refImage, refTokenId, tokenId);
        },
      };
    },
  });
}
