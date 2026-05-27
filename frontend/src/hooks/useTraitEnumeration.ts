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
import { getDeadHosts } from "@/lib/proxyRouter";
import type { WorkerOutMessage } from "@/lib/workers/traitEnumeration.worker";

/**
 * Client-side trait enumeration that gap-fills the metadata cache and
 * runs the heavy work in a Web Worker so the main thread stays
 * interactive while large collections enumerate.
 *
 * Flow:
 *   1. Seed state from `getAggregateForCollection` — topbar filter is
 *      usable immediately, even with partial data.
 *   2. Verify cached samples haven't shifted (reveal detection runs on
 *      the main thread because it needs the shared RPC pool state).
 *   3. Spawn a worker that runs `runFillLoop` — multicall encoding,
 *      JSON fetching, attribute aggregation, and IndexedDB writes all
 *      happen off the main thread.
 *   4. On each progress message, re-read the aggregate from IndexedDB
 *      and publish it to React state.
 *   5. On unmount or dep change, cancel + terminate the worker.
 *
 * If the browser can't spawn a worker (SSR, unusual config), the fill
 * loop runs inline on the main thread — same code path either way.
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
  const workerRef = useRef<Worker | null>(null);

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

      // 2. Run the fill loop. Prefer a Web Worker so multicall encoding
      //    + JSON parsing don't block paint on big collections. Fall
      //    back to inline execution if worker construction fails (SSR,
      //    blocked by CSP, unusual config).
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

      // Helper: finalize and publish terminal state.
      const publishFinal = async () => {
        const finalAgg = await getAggregateForCollection(
          browseChainId,
          contractLower,
        );
        if (myRunId !== runIdRef.current || !finalAgg) return;
        const enumeratedCount = Object.keys(finalAgg.tokenAttributes).length;
        const finalProgress =
          totalSupply! > 0 ? Math.min(1, enumeratedCount / totalSupply!) : 0;
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
          enumeratedCount,
          totalSupply: finalAgg.totalSupply,
          traitCounts: finalAgg.traitCounts,
          tokenAttributes: finalAgg.tokenAttributes,
          rarityScores: finalAgg.rarityScores,
          rarityRanks: finalAgg.rarityRanks,
        });
      };

      const worker = spawnWorker();
      if (worker) {
        workerRef.current?.terminate();
        workerRef.current = worker;

        await new Promise<void>((resolve) => {
          worker.onmessage = async (event: MessageEvent<WorkerOutMessage>) => {
            const msg = event.data;
            if (msg.runId !== myRunId) return;
            if (msg.type === "progress") {
              await publishProgress();
            } else if (msg.type === "done" || msg.type === "error") {
              await publishFinal();
              worker.terminate();
              if (workerRef.current === worker) workerRef.current = null;
              resolve();
            }
          };
          worker.onerror = () => {
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            resolve();
          };
          worker.postMessage({
            type: "start",
            runId: myRunId,
            payload: {
              contract: contractLower,
              chainId: browseChainId,
              totalSupply: totalSupply!,
              tokenIdStart,
              userRpc,
              seenTokenIds: Array.from(seenIds),
              indexerTemplate,
              deadHosts: getDeadHosts(),
            },
          });
        });
      } else {
        // Worker unavailable — run inline. Same code path; main thread
        // pays the cost.
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
        await publishFinal();
      }
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
      const worker = workerRef.current;
      if (worker) {
        worker.postMessage({ type: "cancel", runId: myRunId });
        worker.terminate();
        workerRef.current = null;
      }
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

// ── Worker construction ─────────────────────────────────────────

/**
 * Spawn the trait enumeration worker. Returns null in environments
 * where Web Workers aren't available (SSR, CSP, very old browsers).
 * Caller falls back to inline execution in that case.
 */
function spawnWorker(): Worker | null {
  if (typeof window === "undefined") return null;
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(
      new URL("@/lib/workers/traitEnumeration.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return null;
  }
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
