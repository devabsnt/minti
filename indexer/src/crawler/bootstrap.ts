import type { ChainSource } from "./source.js";
import {
  TRANSFER_TOPIC,
  ingestTransfers,
  getTransferCursor,
} from "./transfer-handler.js";

/**
 * Bootstrap: sweep Transfer events from the cursor (or block 0) up to
 * the current chain tip, in CHUNK_SIZE-block windows. Resumable across
 * restarts via crawler_state.last_block_processed — we just pick up
 * wherever the cursor is.
 *
 * One-time cost on first deploy. After this completes, the regular
 * poll loop takes over.
 *
 * IMPORTANT: we don't fetch block timestamps yet — that'd add an
 * eth_getBlockByNumber per unique block, blowing up the query budget.
 * For bootstrap we synthesize a timestamp from block-time math
 * (Monad ~0.5s blocks) so the `activity.timestamp` column is roughly
 * right. The polling loop can do proper per-block timestamp fetches
 * once it's only processing a handful of blocks per cycle.
 */

const CHUNK_SIZE = 5_000;
const MONAD_AVG_BLOCK_MS = 500;
// Estimated genesis time for Monad mainnet. Adjust if you actually know
// the real timestamp of block 0 — for our use this is "good enough for
// charting" and Activity gets the real timestamp once polling takes over.
const GENESIS_TIME = new Date("2026-01-01T00:00:00Z").getTime();

export interface BootstrapResult {
  startedAtBlock: number;
  endedAtBlock: number;
  chunksProcessed: number;
  totalActivityRows: number;
  totalCollectionsTouched: number;
  elapsedMs: number;
}

function estimateTimestamp(blockNumber: number): Date {
  return new Date(GENESIS_TIME + blockNumber * MONAD_AVG_BLOCK_MS);
}

export async function runBootstrap(
  source: ChainSource,
  opts: { startBlock?: number; endBlock?: number } = {},
): Promise<BootstrapResult> {
  const start = Date.now();
  const resumeAt = await getTransferCursor();
  const fromBlock = opts.startBlock ?? (resumeAt != null ? resumeAt + 1 : 0);
  const tip = opts.endBlock ?? (await source.getCurrentBlock());

  console.log(
    `[bootstrap] starting: fromBlock=${fromBlock}, tip=${tip}, chunkSize=${CHUNK_SIZE}`,
  );
  if (fromBlock > tip) {
    console.log(`[bootstrap] already caught up (cursor=${resumeAt}, tip=${tip})`);
    return {
      startedAtBlock: fromBlock,
      endedAtBlock: tip,
      chunksProcessed: 0,
      totalActivityRows: 0,
      totalCollectionsTouched: 0,
      elapsedMs: Date.now() - start,
    };
  }

  let cursor = fromBlock;
  let chunks = 0;
  let totalActivityRows = 0;
  let totalCollectionsTouched = 0;

  while (cursor <= tip) {
    const chunkEnd = Math.min(cursor + CHUNK_SIZE - 1, tip);
    const chunkStart = Date.now();
    let logs;
    try {
      logs = await source.getLogs({
        fromBlock: cursor,
        toBlock: chunkEnd,
        eventSignatures: [TRANSFER_TOPIC],
      });
    } catch (err) {
      console.error(
        `[bootstrap] chunk [${cursor}..${chunkEnd}] failed: ${err instanceof Error ? err.message : err}`,
      );
      // Sleep + retry the same chunk. If RPCs are flaky we'd rather
      // wait than corrupt the cursor by skipping ahead.
      await sleep(5_000);
      continue;
    }

    // Build a timestamp map. For now we use estimated timestamps —
    // see file-level comment for the trade-off.
    const blockTimestamps = new Map<number, Date>();
    for (const log of logs) {
      if (!blockTimestamps.has(log.blockNumber)) {
        blockTimestamps.set(log.blockNumber, estimateTimestamp(log.blockNumber));
      }
    }

    const result = await ingestTransfers(logs, chunkEnd, blockTimestamps);
    totalActivityRows += result.activityRows;
    totalCollectionsTouched += result.collectionsTouched;
    chunks += 1;

    const elapsed = Date.now() - chunkStart;
    if (chunks % 10 === 0 || chunkEnd === tip) {
      const pct = Math.round(((chunkEnd - fromBlock) / Math.max(1, tip - fromBlock)) * 100);
      const totalElapsed = Math.round((Date.now() - start) / 1000);
      console.log(
        `[bootstrap] ${chunkEnd}/${tip} (${pct}%) — ${chunks} chunks, ${totalActivityRows} events, ${totalElapsed}s elapsed (last chunk: ${elapsed}ms, ${logs.length} logs)`,
      );
    }

    cursor = chunkEnd + 1;
  }

  const elapsedMs = Date.now() - start;
  console.log(
    `[bootstrap] complete: ${chunks} chunks, ${totalActivityRows} activity rows, ${totalCollectionsTouched} unique collections touched, ${(elapsedMs / 1000).toFixed(1)}s total`,
  );
  return {
    startedAtBlock: fromBlock,
    endedAtBlock: tip,
    chunksProcessed: chunks,
    totalActivityRows,
    totalCollectionsTouched,
    elapsedMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
