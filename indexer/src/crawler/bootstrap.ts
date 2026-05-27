import type { ChainSource, ChainLog } from "./source.js";
import { env } from "../env.js";
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
// A wave is one Promise.all over WAVE_SIZE chunks. If a single RPC
// hangs (TCP accepted but no response), the whole wave hangs forever
// because Promise.all waits for ALL chunks. 90s is generous for a real
// wave (~5 chunks × ~10s normal) but short enough that a stuck wave
// fails fast and the retry loop picks a different RPC ordering.
const WAVE_TIMEOUT_MS = 90_000;
const MONAD_AVG_BLOCK_MS = 500;
const BLOCKS_PER_DAY = (24 * 60 * 60 * 1000) / MONAD_AVG_BLOCK_MS;
// Estimated genesis timestamp. Used only for early-block activity rows
// when we don't have real per-block timestamps; close enough for sort
// order. Polling captures real `now()` for each event.
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

/** RPC fetch only — no DB write. Returns the raw logs for the wave loop
 * to aggregate and persist serially. */
async function fetchChunk(
  source: ChainSource,
  fromBlock: number,
  toBlock: number,
): Promise<ChainLog[]> {
  return source.getLogs({
    fromBlock,
    toBlock,
    eventSignatures: [TRANSFER_TOPIC],
  });
}

function describePgError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: string; detail?: string; severity?: string };
  const parts = [e.message];
  if (e.code) parts.push(`code=${e.code}`);
  if (e.detail) parts.push(`detail=${e.detail}`);
  return parts.join(" | ");
}

export async function runBootstrap(
  source: ChainSource,
  opts: { startBlock?: number; endBlock?: number } = {},
): Promise<BootstrapResult> {
  const start = Date.now();
  const resumeAt = await getTransferCursor();
  const tip = opts.endBlock ?? (await source.getCurrentBlock());

  // Bounded indexer: bootstrap covers only the retention window. Older
  // history is intentionally not indexed — keeps storage bounded by
  // design, no separate "backfill+prune" dance. A token whose last
  // Transfer was before this cutoff simply doesn't appear in our DB
  // until it transfers again (the polling loop will catch it then).
  const retentionCutoff = Math.max(0, tip - Math.floor(env.RETENTION_DAYS * BLOCKS_PER_DAY));
  const cursorOrCutoff = resumeAt != null
    ? Math.max(resumeAt + 1, retentionCutoff)
    : retentionCutoff;
  const fromBlock = opts.startBlock ?? cursorOrCutoff;

  console.log(
    `[bootstrap] starting: fromBlock=${fromBlock}, tip=${tip}, retentionDays=${env.RETENTION_DAYS} (cutoff=${retentionCutoff}), chunk=${CHUNK_SIZE}, wave=${WAVE_SIZE}`,
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

    let allLogs: ChainLog[];
    try {
      // RPC fetches run concurrently across the pool — this is the slow,
      // I/O-bound part that benefits from parallelism. Wrapped in a
      // wave-level timeout because a single stuck RPC (TCP accepted but
      // no body) would otherwise park `Promise.all` forever and never
      // surface anywhere.
      const fetched = await Promise.race([
        Promise.all(chunks.map((c) => fetchChunk(source, c.from, c.to))),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`wave timeout after ${WAVE_TIMEOUT_MS}ms`)),
            WAVE_TIMEOUT_MS,
          ),
        ),
      ]);
      allLogs = [];
      for (const arr of fetched) {
        for (let i = 0; i < arr.length; i++) allLogs.push(arr[i]!);
      }
    } catch (err) {
      console.error(
        `[bootstrap] wave [${waveStart}..${waveEnd}] fetch failed: ${describePgError(err)}. Backing off ${RETRY_BACKOFF_MS}ms and retrying same wave.`,
      );
      cursor = waveStart;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    // DB writes happen ONCE per wave, sequentially. Avoids 5 concurrent
    // INSERT ... ON CONFLICT statements racing each other on the same
    // collections rows, which would surface as "could not serialize" /
    // "tuple concurrently updated" errors under load.
    const waveLogCount = allLogs.length;
    const blockTimestamps = new Map<number, Date>();
    for (const log of allLogs) {
      if (!blockTimestamps.has(log.blockNumber)) {
        blockTimestamps.set(log.blockNumber, estimateTimestamp(log.blockNumber));
      }
    }

    let ingested;
    try {
      ingested = await ingestTransferLogs(allLogs, blockTimestamps);
    } catch (err) {
      console.error(
        `[bootstrap] wave [${waveStart}..${waveEnd}] DB write failed: ${describePgError(err)}. Backing off ${RETRY_BACKOFF_MS}ms and retrying same wave.`,
      );
      cursor = waveStart;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    totalActivityRows += ingested.activityRows;
    totalCollectionsTouched += ingested.collectionsTouched;

    // Cursor only moves forward once every chunk in this wave landed
    // its inserts successfully. Idempotent inserts mean a partial wave
    // followed by a retry is safe.
    await advanceTransferCursor(waveEnd);
    waves += 1;

    const waveElapsedMs = Date.now() - waveStartTime;
    const totalElapsed = Math.round((Date.now() - start) / 1000);
    const pct = Math.round(((waveEnd - fromBlock) / Math.max(1, tip - fromBlock)) * 100);
    console.log(
      `[bootstrap] ${waveEnd}/${tip} (${pct}%) — ${waves} waves, ${totalActivityRows} events, ${totalElapsed}s elapsed (last wave: ${waveElapsedMs}ms, ${waveLogCount} logs across ${chunks.length} chunks)`,
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
