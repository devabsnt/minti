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
import { useIndexerCollection } from "@/hooks/useIndexerCollections";
import {
  aggregateTokenIds,
  getAggregateForCollection,
  type CachedTraitData,
  type TokenAttribute,
} from "@/lib/traitsCache";
import { runFillLoop } from "@/lib/traitFillLoop";

/**
 * Client-side trait enumeration that gap-fills the metadata cache.
 *
 * Flow:
 *   1. Seed state from `getAggregateForCollection` — topbar filter is
 *      usable immediately, even with partial data.
 *   2. Verify cached samples haven't shifted (reveal detection runs on
 *      the main thread because it needs the shared RPC pool state).
 *   3. Run `runFillLoop` — multicall encoding (when no indexer
 *      template is available), JSON fetching, attribute aggregation,
 *      and IndexedDB writes. Progress is reported after each wave.
 *
 * The audit's §6 suggested a Web Worker for this loop. That refactor
 * proved flaky under Vercel's bundling — workers spawned but silently
 * failed in production, leaving the topbar stuck at 0%. JSON parsing
 * for ~30 parallel fetches is tiny relative to the network time, so
 * main-thread is acceptable. If we revisit worker offloading, do it
 * with a working e2e test first.
 *
 * Pass `enabled: false` to skip enumeration (EVMFS manifest path).
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
  | "partial"
  | "complete"
  | "failed"
  | "all_identical";

export interface EnumerationState {
  status: EnumerationStatus;
  /** 0..1; meaningful when status is `enumerating` or `partial`. */
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

// Number of cached samples to re-fetch on revisit for reveal detection.
const SAMPLE_SIZE = 3;

export function useTraitEnumeration(
  contract: string | undefined,
  totalSupply: number | undefined,
  tokenIdStart: number = 1,
  enabled: boolean = true,
): EnumerationState {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();
  const indexerCollection = useIndexerCollection(contract);
  const [state, setState] = useState<EnumerationState>(INITIAL_STATE);
  const cancelRef = useRef(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (!contract || !totalSupply || totalSupply <= 0) return;
    const myRunId = ++runIdRef.current;
    cancelRef.current = false;
    const contractLower = contract.toLowerCase();
    const userRpc = getEffectiveRpc(browseChainId);
    const indexerTemplate =
      indexerCollection.data?.collection?.tokenUriTemplate ?? null;

    async function run() {
      setState((s) => ({ ...s, status: "checking" }));

      // 1. Seed from existing aggregate
      let aggregate = await getAggregateForCollection(
        browseChainId,
        contractLower,
      );
      if (myRunId !== runIdRef.current) return;

      if (aggregate) {
        const stillValid = await verifyAggregateBySampling(
          contractLower,
          aggregate,
          browseChainId,
          userRpc,
        );
        if (myRunId !== runIdRef.current) return;
        if (!stillValid) aggregate = undefined;
      }

      const initialCount = aggregate
        ? Object.keys(aggregate.tokenAttributes).length
        : 0;
      const isAlreadyComplete =
        aggregate &&
        aggregate.totalSupply === totalSupply &&
        (aggregate.status === "complete" ||
          aggregate.status === "all_identical") &&
        initialCount >= totalSupply!;

      if (isAlreadyComplete && aggregate) {
        setState({
          status:
            aggregate.status === "all_identical" ? "all_identical" : "complete",
          progress: 1,
          enumeratedCount: initialCount,
          totalSupply: aggregate.totalSupply,
          traitCounts: aggregate.traitCounts,
          tokenAttributes: aggregate.tokenAttributes,
          rarityScores: aggregate.rarityScores,
          rarityRanks: aggregate.rarityRanks,
        });
        return;
      }

      const partialState = (
        progress: number,
        count: number,
        agg: CachedTraitData | undefined,
      ): EnumerationState => ({
        status: "partial",
        progress,
        enumeratedCount: count,
        totalSupply: totalSupply!,
        traitCounts: agg?.traitCounts ?? {},
        tokenAttributes: agg?.tokenAttributes ?? {},
        rarityScores: agg?.rarityScores ?? {},
        rarityRanks: agg?.rarityRanks ?? {},
      });

      setState(
        partialState(
          totalSupply! > 0 ? initialCount / totalSupply! : 0,
          initialCount,
          aggregate,
        ),
      );

      const seenIds = aggregateTokenIds(aggregate);
      setState((s) => ({ ...s, status: "enumerating" }));

      // Helper: re-read aggregate and publish to React state.
      const publishProgress = async () => {
        const fresh = await getAggregateForCollection(
          browseChainId,
          contractLower,
        );
        if (myRunId !== runIdRef.current) return;
        const enumeratedCount = Object.keys(
          fresh?.tokenAttributes ?? {},
        ).length;
        const progress =
          totalSupply! > 0 ? Math.min(1, enumeratedCount / totalSupply!) : 0;
        setState(partialState(progress, enumeratedCount, fresh));
      };

      // 2. Run the fill loop inline. JSON parsing for ~30 parallel
      //    fetches doesn't move the needle on main-thread perf; the
      //    network round-trip is the bottleneck.
      await runFillLoop({
        contract: contractLower,
        chainId: browseChainId,
        totalSupply: totalSupply!,
        tokenIdStart,
        userRpc,
        seenTokenIds: seenIds,
        indexerTemplate,
        onProgress: () => {
          void publishProgress();
        },
        cancelled: () => cancelRef.current || myRunId !== runIdRef.current,
      });

      // 3. Publish terminal state.
      const finalAgg = await getAggregateForCollection(
        browseChainId,
        contractLower,
      );
      if (myRunId !== runIdRef.current || !finalAgg) return;
      const finalCount = Object.keys(finalAgg.tokenAttributes).length;
      const finalProgress =
        totalSupply! > 0 ? Math.min(1, finalCount / totalSupply!) : 0;
      setState({
        status:
          finalAgg.status === "all_identical"
            ? "all_identical"
            : finalAgg.status === "complete"
              ? "complete"
              : finalAgg.status === "failed"
                ? "failed"
                : "partial",
        progress: finalProgress,
        enumeratedCount: finalCount,
        totalSupply: finalAgg.totalSupply,
        traitCounts: finalAgg.traitCounts,
        tokenAttributes: finalAgg.tokenAttributes,
        rarityScores: finalAgg.rarityScores,
        rarityRanks: finalAgg.rarityRanks,
      });
    }

    run().catch((err) => {
      if (process.env.NODE_ENV !== "production") {
        console.error("[useTraitEnumeration] failed:", err);
      }
      if (myRunId === runIdRef.current) {
        setState((s) => ({
          ...s,
          status: s.enumeratedCount > 0 ? "partial" : "failed",
        }));
      }
    });

    return () => {
      cancelRef.current = true;
    };
    // getEffectiveRpc identity changes only when the RPC pool changes,
    // not per render. browseChainId / contract / totalSupply drive work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contract,
    totalSupply,
    tokenIdStart,
    browseChainId,
    enabled,
    indexerCollection.data?.collection?.tokenUriTemplate,
  ]);

  return state;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Re-fetch a few of the cached `tokenURI` samples and compare against
 * what the chain returns now. Any mismatch indicates a reveal / baseURI
 * swap and the aggregate is stale.
 */
async function verifyAggregateBySampling(
  contract: string,
  aggregate: CachedTraitData,
  chainId: number,
  userRpc: string | undefined,
): Promise<boolean> {
  if (aggregate.sampledTokenURIs.length === 0) return true;
  const samples = shuffle(aggregate.sampledTokenURIs).slice(0, SAMPLE_SIZE);
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
      if (!entry || !entry.success) continue;
      const uri = decodeResult<string>(TOKEN_URI_ABI, "tokenURI", entry);
      if (uri && uri !== samples[i].uri) return false;
    }
    return true;
  } catch {
    return true;
  }
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
