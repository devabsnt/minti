"use client";

import { useQuery } from "@tanstack/react-query";

import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import { EVMFS_TOKEN_VIEWER } from "@/lib/evmfs";

const VIEWER_ABI = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [
      { name: "manifestHash", type: "bytes32" },
      { name: "manifestBlock", type: "uint64" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/**
 * Fetch the data: URL that EVMFSTokenViewer returns for a given token id.
 * The result is a self-contained HTML page that, when loaded in an iframe,
 * fetches the metadata + image directly from EVMFS via RPC.
 *
 * Cached aggressively by react-query because the result is content-addressed:
 * given the same (hash, block, id) it never changes.
 */
export function useTokenViewerUri(
  manifestHash: `0x${string}` | undefined,
  manifestBlock: bigint | number | undefined,
  tokenId: bigint | undefined
) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();
  const viewerAddress = EVMFS_TOKEN_VIEWER[browseChainId];

  return useQuery({
    queryKey: [
      "evmfs-token-viewer-uri",
      browseChainId,
      manifestHash,
      manifestBlock?.toString(),
      tokenId?.toString(),
    ],
    enabled:
      !!viewerAddress &&
      !!manifestHash &&
      manifestBlock !== undefined &&
      tokenId !== undefined,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const client = getPublicClient(browseChainId);
      const result = (await client.readContract({
        address: viewerAddress!,
        abi: VIEWER_ABI,
        functionName: "tokenURI",
        args: [manifestHash!, BigInt(manifestBlock!), tokenId!],
      })) as string;
      return result;
    },
  });
}
