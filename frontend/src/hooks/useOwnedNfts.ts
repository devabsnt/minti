"use client";

import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import {
  createRpcPool,
  executeBatchedMulticalls,
  getMulticallBatchSize,
  encodeCall,
  decodeResult,
  sleep,
  type MulticallRequest,
  type MulticallResult,
} from "@/lib/rpcPool";
import type { Abi } from "viem";

const ERC721_ABI = [
  {
    inputs: [{ type: "address", name: "owner" }],
    name: "balanceOf",
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
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "owner" },
      { type: "uint256", name: "index" },
    ],
    name: "tokenOfOwnerByIndex",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "bytes4", name: "interfaceId" }],
    name: "supportsInterface",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

const ERC721_ENUMERABLE_INTERFACE_ID = "0x780e9d63" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Absolute upper bound for brute-force scan */
const MAX_OWNEROF_SCAN = 20_000;

/** Stop scanning after this many consecutive zero-address/revert results.
 *  Must be high enough to handle collections with gaps or non-zero start IDs,
 *  but low enough to detect the end of a collection without wasting requests. */
const CONSECUTIVE_ZERO_STOP = 50;

export interface OwnedToken {
  contractAddress: `0x${string}`;
  tokenId: bigint;
}

/**
 * Scan ownerOf across a token ID range via Multicall3.
 *
 * Strategy:
 * - Batch size is per-chain (20 for Monad, 150 for Ethereum)
 * - Each "wave" dispatches one batch per available RPC node concurrently
 * - Early stop: found all expectedBalance tokens OR 5 consecutive zero-address/revert
 * - If totalSupply is known, use it as the cap; otherwise scan up to MAX_OWNEROF_SCAN
 */
export async function batchOwnerOfScan(
  chainId: number,
  userRpc: string | undefined,
  contractAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
  maxTokenId: bigint,
  expectedBalance?: number,
): Promise<OwnedToken[]> {
  const cap = maxTokenId > BigInt(MAX_OWNEROF_SCAN)
    ? BigInt(MAX_OWNEROF_SCAN)
    : maxTokenId;

  const batchSize = getMulticallBatchSize(chainId);
  const pool = createRpcPool(chainId, userRpc);
  // Use all available RPCs as concurrent workers
  const parallelism = Math.min(pool.nodes.length, 8);

  const normalizedOwner = ownerAddress.toLowerCase();
  const tokens: OwnedToken[] = [];
  let consecutiveZero = 0;
  let done = false;

  // Build batches of `batchSize` IDs each — one multicall per batch
  const allBatches: { start: bigint; end: bigint }[] = [];
  for (let s = 0n; s < cap; s += BigInt(batchSize)) {
    const e = s + BigInt(batchSize) > cap ? cap : s + BigInt(batchSize);
    allBatches.push({ start: s, end: e });
  }

  // Process in waves — each wave dispatches `parallelism` batches concurrently
  for (let waveStart = 0; waveStart < allBatches.length && !done; waveStart += parallelism) {
    const waveBatches = allBatches.slice(waveStart, waveStart + parallelism);

    const waveResults = await Promise.all(
      waveBatches.map(async (batch) => {
        const calls: MulticallRequest[] = [];
        const ids: bigint[] = [];
        for (let id = batch.start; id < batch.end; id++) {
          ids.push(id);
          calls.push(encodeCall(contractAddress, ERC721_ABI, "ownerOf", [id]));
        }
        const batchPool = createRpcPool(chainId, userRpc);
        const results = await executeBatchedMulticalls(batchPool, calls);
        return { ids, results: results.flat() };
      })
    );

    // Process results IN ORDER to track consecutive zeros
    for (const { ids, results } of waveResults) {
      if (done) break;
      for (let i = 0; i < results.length; i++) {
        const entry = results[i];
        if (!entry || !entry.success || entry.returnData === "0x") {
          consecutiveZero++;
        } else {
          const owner = decodeResult<string>(ERC721_ABI, "ownerOf", entry);
          if (!owner || owner.toLowerCase() === ZERO_ADDRESS) {
            consecutiveZero++;
          } else {
            consecutiveZero = 0;
            if (owner.toLowerCase() === normalizedOwner) {
              tokens.push({ contractAddress, tokenId: ids[i] });
            }
          }
        }

        // Stop: found all tokens
        if (expectedBalance && tokens.length >= expectedBalance) {
          done = true;
          break;
        }

        // Stop: past the end of the collection (5 consecutive zero/revert)
        if (consecutiveZero >= CONSECUTIVE_ZERO_STOP) {
          done = true;
          break;
        }
      }
    }

    // Small delay between waves to stay under rate limits
    if (!done && waveStart + parallelism < allBatches.length) {
      await sleep(50);
    }
  }

  return tokens;
}

/**
 * Batch tokenOfOwnerByIndex calls for ERC721Enumerable contracts.
 */
async function batchEnumerate(
  chainId: number,
  userRpc: string | undefined,
  contractAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
  balance: number
): Promise<OwnedToken[]> {
  const count = Math.min(balance, 200);
  const calls: MulticallRequest[] = [];
  for (let i = 0; i < count; i++) {
    calls.push(
      encodeCall(contractAddress, ERC721_ABI, "tokenOfOwnerByIndex", [
        ownerAddress,
        BigInt(i),
      ])
    );
  }

  const pool = createRpcPool(chainId, userRpc);
  const batchResults = await executeBatchedMulticalls(pool, calls);
  const tokens: OwnedToken[] = [];
  for (const batch of batchResults) {
    for (const entry of batch) {
      const tokenId = decodeResult<bigint>(ERC721_ABI, "tokenOfOwnerByIndex", entry);
      if (tokenId != null) {
        tokens.push({ contractAddress, tokenId });
      }
    }
  }
  return tokens;
}

/**
 * Hook: fetch owned NFTs for a list of collection addresses.
 * 1. Batch balanceOf + supportsInterface + totalSupply for all collections
 * 2. For enumerable: use tokenOfOwnerByIndex
 * 3. For non-enumerable: ownerOf scan 0..totalSupply with 5-consecutive-zero stop
 */
export function useOwnedNfts(
  ownerAddress: `0x${string}` | undefined,
  collectionAddresses: string[]
) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  return useQuery({
    queryKey: ["owned-nfts", browseChainId, ownerAddress, collectionAddresses],
    queryFn: async (): Promise<OwnedToken[]> => {
      if (!ownerAddress || collectionAddresses.length === 0) return [];

      const userRpc = getEffectiveRpc(browseChainId);
      const allTokens: OwnedToken[] = [];

      // Step 1: Batch metadata calls for all collections at once
      const metaCalls: MulticallRequest[] = [];
      for (const col of collectionAddresses) {
        const addr = col as `0x${string}`;
        metaCalls.push(encodeCall(addr, ERC721_ABI, "balanceOf", [ownerAddress]));
        metaCalls.push(encodeCall(addr, ERC721_ABI, "supportsInterface", [ERC721_ENUMERABLE_INTERFACE_ID]));
        metaCalls.push(encodeCall(addr, ERC721_ABI, "totalSupply", []));
      }

      const pool = createRpcPool(browseChainId, userRpc);
      const metaResults = await executeBatchedMulticalls(pool, metaCalls);
      const flatMeta: MulticallResult[] = metaResults.flat();
      if (flatMeta.length === 0) return [];

      // Step 2: For each collection, decide strategy
      for (let ci = 0; ci < collectionAddresses.length; ci++) {
        const contractAddress = collectionAddresses[ci] as `0x${string}`;
        const balanceResult = flatMeta[ci * 3];
        const interfaceResult = flatMeta[ci * 3 + 1];
        const totalSupplyResult = flatMeta[ci * 3 + 2];

        const balance = balanceResult
          ? decodeResult<bigint>(ERC721_ABI, "balanceOf", balanceResult)
          : null;

        if (!balance || balance === 0n) continue;

        const isEnumerable = interfaceResult
          ? decodeResult<boolean>(ERC721_ABI, "supportsInterface", interfaceResult)
          : false;

        if (isEnumerable) {
          const found = await batchEnumerate(browseChainId, userRpc, contractAddress, ownerAddress, Number(balance));
          allTokens.push(...found);
        } else {
          // Use totalSupply as cap, fallback to MAX_OWNEROF_SCAN
          let scanCap = BigInt(MAX_OWNEROF_SCAN);
          const totalSupply = totalSupplyResult
            ? decodeResult<bigint>(ERC721_ABI, "totalSupply", totalSupplyResult)
            : null;
          if (totalSupply && totalSupply > 0n) {
            scanCap = totalSupply;
          }

          const found = await batchOwnerOfScan(
            browseChainId, userRpc, contractAddress, ownerAddress,
            scanCap, Number(balance),
          );
          if (found.length > 0) {
            allTokens.push(...found);
          } else {
            // Balance > 0 but scan found nothing — sentinel for UI
            allTokens.push({ contractAddress, tokenId: BigInt(-1) });
          }
        }
      }

      return allTokens;
    },
    enabled: !!ownerAddress && collectionAddresses.length > 0,
    staleTime: 60_000,
  });
}
