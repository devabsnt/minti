"use client";

import { useQuery } from "@tanstack/react-query";

import { useBrowseChain } from "@/providers/ChainProvider";
import {
  fetchManifest,
  fetchEntryBytes,
  findEntry,
  type Manifest,
  type ManifestEntry,
  type EvmfsContract,
} from "@/lib/evmfs";

export interface EvmfsTokenMetadata {
  name?: string;
  description?: string;
  image?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  [key: string]: unknown;
}

/**
 * Fetch a single token's metadata directly from the EVMFS metadata manifest.
 * Avoids round-tripping through the ERC721 `tokenURI` (which for EVMFS
 * collections is an HTML data URL, not JSON).
 *
 * Resolution rules: tokens may be addressed by either filename ("1.json", "1")
 * or by 1-based index in the manifest. We try both.
 */
export function useEvmfsTokenMetadata(
  metadataManifest: `0x${string}` | undefined,
  metadataBlock: bigint | number | undefined,
  tokenId: bigint | number | undefined,
  evmfsContract?: EvmfsContract
) {
  const { browseChainId } = useBrowseChain();

  return useQuery({
    queryKey: [
      "evmfs-token-metadata",
      browseChainId,
      metadataManifest,
      metadataBlock?.toString(),
      tokenId?.toString(),
      evmfsContract,
    ],
    enabled: !!metadataManifest && metadataBlock !== undefined && tokenId !== undefined,
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: async (): Promise<EvmfsTokenMetadata> => {
      const manifest = await fetchManifest({
        chainId: browseChainId,
        block: Number(metadataBlock!),
        hash: metadataManifest!,
        evmfsContract,
      });
      const id = Number(tokenId);
      const entry = resolveEntry(manifest, id);
      if (!entry) {
        throw new Error(`token #${id} not in metadata manifest`);
      }
      const bytes = await fetchEntryBytes(browseChainId, entry, evmfsContract);
      const text = new TextDecoder().decode(bytes);
      return JSON.parse(text) as EvmfsTokenMetadata;
    },
  });
}

function resolveEntry(manifest: Manifest, tokenId: number): ManifestEntry | undefined {
  // Try common filename conventions first.
  return (
    findEntry(manifest, `${tokenId}.json`) ??
    findEntry(manifest, `${tokenId}`) ??
    findEntry(manifest, tokenId - 1) ?? // 0-indexed position
    findEntry(manifest, tokenId) // 1-indexed accident
  );
}

/**
 * Fetch and cache the entire metadata manifest. Useful for trait aggregation
 * when no index manifest is available.
 */
export function useEvmfsManifest(
  manifestHash: `0x${string}` | undefined,
  manifestBlock: bigint | number | undefined,
  evmfsContract?: EvmfsContract
) {
  const { browseChainId } = useBrowseChain();
  return useQuery({
    queryKey: ["evmfs-manifest", browseChainId, manifestHash, manifestBlock?.toString(), evmfsContract],
    enabled: !!manifestHash && manifestBlock !== undefined,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    queryFn: () =>
      fetchManifest({
        chainId: browseChainId,
        block: Number(manifestBlock!),
        hash: manifestHash!,
        evmfsContract,
      }),
  });
}
