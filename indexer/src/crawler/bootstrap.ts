import type { ChainSource } from "./source.js";
import {
  TRANSFER_TOPIC,
  ingestTransferLogs,
  advanceTransferCursor,
  getTransferCursor,
} from "./transfer-handler.js";

/**
 * Bootstrap: sweep Transfer events from the cursor (or block 0) up to
 * the current chain tip. Resumable across restarts via
 * crawler_state.last_block_processed.
 *
 * Two performance levers vs naive sequential sweep:
 *   - WAVE_SIZE chunks fire in parallel each cycle (round-robin across
 *     the RPC pool inside RpcSource means they naturally spread across
 *     providers).
 *   - CHUNK_SIZE is sized larger than the slowest provider's likely
 *     window. RpcSource's adaptive halving handles providers that
 *     reject the range, transparently.
 *
 * Cursor advances only after every chunk in a wave completes. If any
 * chunk in a wave throws, we don't advance — the next start retries
 * the whole wave. Inserts are idempotent so the retry is free.
 *
 * Timestamps are estimated from block-time math during bootstrap to
 * avoid an eth_getBlockByNumber per block. Polling does the real
 * lookup once it's processing a handful of blocks per cycle.
 */

const CHUNK_SIZE = 10_000;
const WAVE_SIZE = 5; // matches the size of the Monad public RPC pool
const RETRY_BACKOFF_MS = 5_000;
const MONAD_AVG_BLOCK_MS = 500;
// Estimated genesis timestamp. Used only for early-block activity rows;
// the polling loop replaces with real timestamps once it takes over.
const GENESIS_TIME = new Date("2026-01-01T00:00:00Z").getTime();

export interface BootstrapResult {
  startedAtBlock: number;
  endedAtBlock: number;
  wavesProcessed: number;
  totalActivityRows: number;
  totalCollectionsTouched: number;
  elapsedMs: number;
}

function estimateTimestamp(blockNumber: number): Date {
  return new Date(GENESIS_TIME + blockNumber * MONAD_AVG_BLOCK_MS);
}

async function processChunk(
  source: ChainSource,
  fromBlock: number,
  toBlock: number,
): Promise<{ activityRows: number; collectionsTouched: number; logCount: number }> {
  const logs = await source.getLogs({
    fromBlock,
    toBlock,
    eventSignatures: [TRANSFER_TOPIC],
  });

  // Synthesize block timestamps. Cheap for bootstrap; the poll loop
  // will use real eth_getBlockByNumber timestamps later.
  const blockTimestamps = new Map<number, Date>();
  for (const log of logs) {
    if (!blockTimestamps.has(log.blockNumber)) {
      blockTimestamps.set(log.blockNumber, estimateTimestamp(log.blockNumber));
    }
  }

  const result = await ingestTransferLogs(logs, blockTimestamps);
  return { ...result, logCount: logs.length };
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
    `[bootstrap] starting: fromBlock=${fromBlock}, tip=${tip}, chunk=${CHUNK_SIZE}, wave=${WAVE_SIZE}`,
  );
  if (fromBlock > tip) {
    console.log(`[bootstrap] already caught up (cursor=${resumeAt}, tip=${tip})`);
    return {
      startedAtBlock: fromBlock,
      endedAtBlock: tip,
      wavesProcessed: 0,
      totalActivityRows: 0,
      totalCollectionsTouched: 0,
      elapsedMs: Date.now() - start,
    };
  }

  let cursor = fromBlock;
  let waves = 0;
  let totalActivityRows = 0;
  let totalCollectionsTouched = 0;

  while (cursor <= tip) {
    const waveStart = cursor;
    const waveStartTime = Date.now();
    const chunks: Array<{ from: number; to: number }> = [];
    for (let i = 0; i < WAVE_SIZE && cursor <= tip; i++) {
      const chunkEnd = Math.min(cursor + CHUNK_SIZE - 1, tip);
      chunks.push({ from: cursor, to: chunkEnd });
      cursor = chunkEnd + 1;
    }
    const waveEnd = chunks[chunks.length - 1]!.to;

    let results;
    try {
      results = await Promise.all(
        chunks.map((c) => processChunk(source, c.from, c.to)),
      );
    } catch (err) {
      console.error(
        `[bootstrap] wave [${waveStart}..${waveEnd}] failed: ${err instanceof Error ? err.message : err}. Backing off ${RETRY_BACKOFF_MS}ms and retrying same wave.`,
      );
      cursor = waveStart; // rewind so we retry the same wave
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    let waveActivity = 0;
    let waveCollections = 0;
    let waveLogs = 0;
    for (const r of results) {
      waveActivity += r.activityRows;
      waveCollections += r.collectionsTouched;
      waveLogs += r.logCount;
    }
    totalActivityRows += waveActivity;
    totalCollectionsTouched += waveCollections;

    // Cursor only moves forward once every chunk in this wave landed
    // its inserts successfully. Idempotent inserts mean a partial wave
    // followed by a retry is safe.
    await advanceTransferCursor(waveEnd);
    waves += 1;

    const waveElapsedMs = Date.now() - waveStartTime;
    const totalElapsed = Math.round((Date.now() - start) / 1000);
    const pct = Math.round(((waveEnd - fromBlock) / Math.max(1, tip - fromBlock)) * 100);
    console.log(
      `[bootstrap] ${waveEnd}/${tip} (${pct}%) — ${waves} waves, ${totalActivityRows} events, ${totalElapsed}s elapsed (last wave: ${waveElapsedMs}ms, ${waveLogs} logs across ${chunks.length} chunks)`,
    );
  }

  const elapsedMs = Date.now() - start;
  console.log(
    `[bootstrap] complete: ${waves} waves, ${totalActivityRows} activity rows, ${totalCollectionsTouched} unique collections touched, ${(elapsedMs / 1000 / 60).toFixed(1)} min total`,
  );
  return {
    startedAtBlock: fromBlock,
    endedAtBlock: tip,
    wavesProcessed: waves,
    totalActivityRows,
    totalCollectionsTouched,
    elapsedMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
