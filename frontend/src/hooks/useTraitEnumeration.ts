"use client";

import { useEffect, useRef, useState } from "react";
import type { Abi } from "viem";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useRpc } from "@/providers/RpcProvider";
import {
  createRpcPool,
  executeBatchedMulticalls,
  encodeCall,
  decodeResult,
  type MulticallRequest,
} from "@/lib/rpcPool";
import { resolveMetadata } from "@/lib/metadata";
import {
  getTraitCache,
  setTraitCache,
  type CachedTraitData,
  type TokenAttribute,
} from "@/lib/traitsCache";

/**
 * Client-side trait enumeration for a collection.
 *
 * Behavior:
 *   1. On mount, check IndexedDB for a complete cache.
 *   2. If cached, sample-check 3 random cached tokenURIs against
 *      the chain. Any mismatch = the collection was re-revealed,
 *      invalidate and re-enumerate.
 *   3. If no cache or invalidated, walk every token from
 *      `tokenIdStart` to `tokenIdStart + totalSupply - 1`:
 *        - Multicall3 batches of 100 token IDs to fetch tokenURI
 *        - Up to 30 in-flight JSON fetches in parallel
 *        - Parse attributes, accumulate counts
 *      Progress is exposed as a 0..1 ratio while running.
 *   4. Compute per-token rarity score (sum of supply/count for each
 *      attribute the token has) and rank.
 *   5. Persist to IndexedDB.
 *
 * Pass `enabled: false` to skip enumeration (e.g. when an EVMFS
 * manifest is available - that source is canonical and there's no
 * point doing a separate RPC walk).
 */
const TOKEN_URI_ABI = [
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "tokenURI",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

export type EnumerationStatus =
  | "idle"
  | "checking"
  | "enumerating"
  | "complete"
  | "failed"
  | "all_identical";

export interface EnumerationState {
  status: EnumerationStatus;
  /** 0..1; only meaningful when status === 'enumerating'. */
  progress: number;
  enumeratedCount: number;
  totalSupply: number;
  traitCounts: Record<string, Record<string, number>>;
  tokenAttributes: Record<string, TokenAttribute[]>;
  rarityScores: Record<string, number>;
  rarityRanks: Record<string, number>;
}

const INITIAL_STATE: EnumerationState = {
  status: "idle",
  progress: 0,
  enumeratedCount: 0,
  totalSupply: 0,
  traitCounts: {},
  tokenAttributes: {},
  rarityScores: {},
  rarityRanks: {},
};

const URI_BATCH_SIZE = 100;
const JSON_CONCURRENCY = 30;
const SAMPLE_SIZE = 3;

export function useTraitEnumeration(
  contract: string | undefined,
  totalSupply: number | undefined,
  tokenIdStart: number = 1,
  enabled: boolean = true,
): EnumerationState {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();
  const [state, setState] = useState<EnumerationState>(INITIAL_STATE);
  const cancelRef = useRef(false);
  // Stable identity for the run so async chains can self-cancel
  // when the contract/totalSupply changes mid-walk.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (!contract || !totalSupply || totalSupply <= 0) return;
    const myRunId = ++runIdRef.current;
    cancelRef.current = false;
    const contractLower = contract.toLowerCase();
    const userRpc = getEffectiveRpc(browseChainId);

    async function run() {
      setState((s) => ({ ...s, status: "checking" }));

      // 1. Cache lookup
      const cached = await getTraitCache(browseChainId, contractLower);
      if (myRunId !== runIdRef.current) return;

      if (
        cached &&
        cached.status === "complete" &&
        cached.totalSupply === totalSupply &&
        cached.sampledTokenURIs.length > 0
      ) {
        const stillValid = await verifyCacheBySampling(
          contract!,
          cached,
          browseChainId,
          userRpc,
        );
        if (myRunId !== runIdRef.current) return;
        if (stillValid) {
          setState({
            status: "complete",
            progress: 1,
            enumeratedCount: Object.keys(cached.tokenAttributes).length,
            totalSupply: cached.totalSupply,
            traitCounts: cached.traitCounts,
            tokenAttributes: cached.tokenAttributes,
            rarityScores: cached.rarityScores,
            rarityRanks: cached.rarityRanks,
          });
          return;
        }
      }

      // 2. Full enumeration
      setState((s) => ({
        ...s,
        status: "enumerating",
        progress: 0,
        enumeratedCount: 0,
        totalSupply: totalSupply!,
      }));

      const result = await enumerate({
        contract: contract!,
        chainId: browseChainId,
        totalSupply: totalSupply!,
        tokenIdStart,
        userRpc,
        onProgress: (count) => {
          if (myRunId !== runIdRef.current) return;
          setState((s) => ({
            ...s,
            enumeratedCount: count,
            progress: count / totalSupply!,
          }));
        },
        cancelled: () => cancelRef.current || myRunId !== runIdRef.current,
      });
      if (myRunId !== runIdRef.current) return;

      if (!result) {
        setState((s) => ({ ...s, status: "failed" }));
        return;
      }

      await setTraitCache(result);

      const tokenCount = Object.keys(result.tokenAttributes).length;
      setState({
        status: result.status,
        progress: 1,
        enumeratedCount: tokenCount,
        totalSupply: result.totalSupply,
        traitCounts: result.traitCounts,
        tokenAttributes: result.tokenAttributes,
        rarityScores: result.rarityScores,
        rarityRanks: result.rarityRanks,
      });
    }

    run().catch((err) => {
      if (process.env.NODE_ENV !== "production") {
        console.error("[useTraitEnumeration] failed:", err);
      }
      if (myRunId === runIdRef.current) {
        setState((s) => ({ ...s, status: "failed" }));
      }
    });

    return () => {
      cancelRef.current = true;
    };
    // getEffectiveRpc identity changes only when the RPC pool changes,
    // not per render. browseChainId and contract drive the actual work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, totalSupply, tokenIdStart, browseChainId, enabled]);

  return state;
}

/**
 * Sample-check cached entries: re-fetch `tokenURI(id)` for a few
 * randomly-chosen tokens and compare against the cached URI. Any
 * mismatch indicates a reveal / baseURI swap and the cache is stale.
 */
async function verifyCacheBySampling(
  contract: string,
  cached: CachedTraitData,
  chainId: number,
  userRpc: string | undefined,
): Promise<boolean> {
  if (cached.sampledTokenURIs.length === 0) return true; // nothing to verify
  // Pick a random subset of the cached samples.
  const samples = shuffle(cached.sampledTokenURIs).slice(0, SAMPLE_SIZE);
  const pool = createRpcPool(chainId, userRpc);
  const calls: MulticallRequest[] = samples.map((s) =>
    encodeCall(contract as `0x${string}`, TOKEN_URI_ABI, "tokenURI", [
      BigInt(s.tokenId),
    ]),
  );
  try {
    const results = await executeBatchedMulticalls(pool, calls);
    const flat = results.flat();
    for (let i = 0; i < samples.length; i++) {
      const entry = flat[i];
      if (!entry || !entry.success) continue; // skip unverifiable samples
      const uri = decodeResult<string>(TOKEN_URI_ABI, "tokenURI", entry);
      if (uri && uri !== samples[i].uri) return false;
    }
    return true;
  } catch {
    // If sampling failed entirely (RPCs all down), trust the cache.
    return true;
  }
}

interface EnumerateParams {
  contract: string;
  chainId: number;
  totalSupply: number;
  tokenIdStart: number;
  userRpc: string | undefined;
  onProgress: (count: number) => void;
  cancelled: () => boolean;
}

async function enumerate(params: EnumerateParams): Promise<CachedTraitData | null> {
  const { contract, chainId, totalSupply, tokenIdStart, userRpc } = params;
  const contractLower = contract.toLowerCase();
  const pool = createRpcPool(chainId, userRpc);

  // Build the token-ID list: tokenIdStart through tokenIdStart + supply - 1.
  const tokenIds: bigint[] = [];
  for (let i = 0; i < totalSupply; i++) {
    tokenIds.push(BigInt(tokenIdStart + i));
  }

  // Step A: Multicall3-batched tokenURI fetches.
  // Each batch is one RPC round trip returning up to URI_BATCH_SIZE URIs.
  const uriByTokenId = new Map<string, string>();
  const sampledForReveal: Array<{ tokenId: string; uri: string }> = [];

  for (let i = 0; i < tokenIds.length; i += URI_BATCH_SIZE) {
    if (params.cancelled()) return null;
    const chunk = tokenIds.slice(i, i + URI_BATCH_SIZE);
    const calls: MulticallRequest[] = chunk.map((id) =>
      encodeCall(contractLower as `0x${string}`, TOKEN_URI_ABI, "tokenURI", [id]),
    );
    try {
      const results = await executeBatchedMulticalls(pool, calls);
      const flat = results.flat();
      for (let j = 0; j < chunk.length; j++) {
        const entry = flat[j];
        if (!entry || !entry.success) continue;
        const uri = decodeResult<string>(TOKEN_URI_ABI, "tokenURI", entry);
        if (uri) {
          const tokenIdStr = chunk[j].toString();
          uriByTokenId.set(tokenIdStr, uri);
          // Sample the first chunk's first 5 tokens for reveal verification.
          if (sampledForReveal.length < 5 && i === 0 && j < 5) {
            sampledForReveal.push({ tokenId: tokenIdStr, uri });
          }
        }
      }
    } catch {
      // Continue with the chunks we did get. Missing tokens just
      // won't be enumerated; UI shows partial data.
    }
  }

  // Step B: parallel JSON fetches for each URI, with concurrency cap.
  const tokenAttributes: Record<string, TokenAttribute[]> = {};
  const entries = Array.from(uriByTokenId.entries());
  let fetchedCount = 0;

  for (let i = 0; i < entries.length; i += JSON_CONCURRENCY) {
    if (params.cancelled()) return null;
    const wave = entries.slice(i, i + JSON_CONCURRENCY);
    await Promise.all(
      wave.map(async ([tokenIdStr, uri]) => {
        try {
          const meta = await resolveMetadata(uri, BigInt(tokenIdStr));
          if (Array.isArray(meta.attributes) && meta.attributes.length > 0) {
            tokenAttributes[tokenIdStr] = (
              meta.attributes as Array<{ trait_type?: string; value?: unknown }>
            )
              .filter(
                (a) => a && typeof a.trait_type === "string" && a.value != null,
              )
              .map((a) => ({
                trait_type: a.trait_type as string,
                value: String(a.value),
              }));
          }
        } catch {
          // Skip tokens whose JSON failed (CORS, 404, parse error).
        }
      }),
    );
    fetchedCount += wave.length;
    params.onProgress(Math.min(fetchedCount, totalSupply));
  }

  // Step C: aggregate counts.
  const traitCounts: Record<string, Record<string, number>> = {};
  for (const attrs of Object.values(tokenAttributes)) {
    for (const a of attrs) {
      if (!traitCounts[a.trait_type]) traitCounts[a.trait_type] = {};
      traitCounts[a.trait_type][a.value] =
        (traitCounts[a.trait_type][a.value] ?? 0) + 1;
    }
  }

  // Detect "all identical": every token has the same attributes set.
  // Cheap heuristic: every trait value has count === totalSupply.
  let allIdentical = Object.keys(tokenAttributes).length > 1;
  for (const type of Object.keys(traitCounts)) {
    const counts = Object.values(traitCounts[type]);
    if (counts.length !== 1 || counts[0] < Object.keys(tokenAttributes).length) {
      allIdentical = false;
      break;
    }
  }

  // Step D: per-token rarity score and rank.
  // score = sum(supply / count) for each trait. Higher = rarer.
  const enumeratedSupply = Object.keys(tokenAttributes).length || totalSupply;
  const rarityScores: Record<string, number> = {};
  for (const [tokenIdStr, attrs] of Object.entries(tokenAttributes)) {
    let score = 0;
    for (const a of attrs) {
      const count = traitCounts[a.trait_type]?.[a.value] ?? 1;
      score += enumeratedSupply / count;
    }
    rarityScores[tokenIdStr] = score;
  }

  // 1-based rank by descending score.
  const sorted = Object.entries(rarityScores).sort((a, b) => b[1] - a[1]);
  const rarityRanks: Record<string, number> = {};
  sorted.forEach(([id], idx) => {
    rarityRanks[id] = idx + 1;
  });

  const result: CachedTraitData = {
    contract: contractLower,
    chainId,
    enumeratedAt: Date.now(),
    status: allIdentical ? "all_identical" : "complete",
    totalSupply,
    sampledTokenURIs: sampledForReveal,
    traitCounts,
    tokenAttributes,
    rarityScores,
    rarityRanks,
  };
  return result;
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
