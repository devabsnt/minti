/// <reference lib="webworker" />

import { runFillLoop } from "@/lib/traitFillLoop";

/**
 * Web Worker entrypoint for trait enumeration. Receives a start message
 * with everything the fill loop needs, runs `runFillLoop` (which does
 * the multicall encoding, JSON fetching, and aggregation off the main
 * thread), and posts periodic progress updates.
 *
 * IndexedDB writes happen here via `mergeTokenIntoAggregate` (called
 * inside `runFillLoop`). Workers have full IndexedDB access, so the
 * main thread can just re-read the aggregate after each progress tick.
 *
 * Cancellation is cooperative: the main thread sets `cancelled = true`
 * by posting `{ type: "cancel" }`, and the next iteration of the fill
 * loop notices and returns early.
 */

type StartMessage = {
  type: "start";
  runId: number;
  payload: {
    contract: string;
    chainId: number;
    totalSupply: number;
    tokenIdStart: number;
    userRpc: string | undefined;
    seenTokenIds: string[];
    indexerTemplate: string | null;
  };
};

type CancelMessage = { type: "cancel"; runId: number };

type InMessage = StartMessage | CancelMessage;

export type WorkerOutMessage =
  | { type: "progress"; runId: number; mergedCount: number; totalToFetch: number }
  | { type: "done"; runId: number }
  | { type: "error"; runId: number; message: string };

let cancelledRunId = -1;

self.addEventListener("message", (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    cancelledRunId = msg.runId;
    return;
  }
  if (msg.type !== "start") return;

  const { runId, payload } = msg;
  runFillLoop({
    contract: payload.contract,
    chainId: payload.chainId,
    totalSupply: payload.totalSupply,
    tokenIdStart: payload.tokenIdStart,
    userRpc: payload.userRpc,
    seenTokenIds: new Set(payload.seenTokenIds),
    indexerTemplate: payload.indexerTemplate,
    onProgress: (mergedCount, totalToFetch) => {
      if (cancelledRunId >= runId) return;
      const out: WorkerOutMessage = {
        type: "progress",
        runId,
        mergedCount,
        totalToFetch,
      };
      self.postMessage(out);
    },
    cancelled: () => cancelledRunId >= runId,
  })
    .then(() => {
      const out: WorkerOutMessage = { type: "done", runId };
      self.postMessage(out);
    })
    .catch((err: unknown) => {
      const out: WorkerOutMessage = {
        type: "error",
        runId,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(out);
    });
});

// TypeScript: ensure this file is treated as a module.
export {};
