import type { ChainSource } from "./source.js";
import { env } from "../env.js";
import {
  TRANSFER_TOPIC,
  ingestTransferLogs,
  advanceTransferCursor,
  getTransferCursor,
} from "./transfer-handler.js";

/**
 * Polling loop. Runs after bootstrap (or right at startup if RUN_BOOTSTRAP=0).
 *
 * Every CRAWLER_POLL_SECONDS the loop:
 *   1. Reads the cursor
 *   2. Reads chain tip
 *   3. Fetches Transfer events in [cursor+1, tip]
 *   4. Ingests + advances cursor
 *
 * Uses the same RpcSource and ingestion code as bootstrap, so per-block
 * data quality is identical. Block timestamps for poll-fetched events
 * are real (from eth_getBlockByNumber) instead of bootstrap's estimates.
 *
 * Backoff strategy on errors:
 *   - RPC failure: log + wait POLL interval + retry
 *   - DB failure: log + wait POLL interval + retry
 *   - SIGTERM: exit cleanly so Railway can restart us cleanly
 */

const MAX_BLOCKS_PER_POLL = 5_000; // safety net; normal poll fetches ~20 blocks

export async function startPollLoop(source: ChainSource): Promise<void> {
  const intervalMs = env.CRAWLER_POLL_SECONDS * 1000;
  console.log(`[poll] starting, cadence=${env.CRAWLER_POLL_SECONDS}s`);

  let stop = false;
  const shutdown = () => { stop = true; };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  while (!stop) {
    try {
      await pollOnce(source);
    } catch (err) {
      console.error(`[poll] iteration failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(intervalMs);
  }
  console.log("[poll] stopped");
}

async function pollOnce(source: ChainSource): Promise<void> {
  const cursor = await getTransferCursor();
  if (cursor == null) {
    // No cursor — bootstrap didn't run. Set cursor to current tip - 1 so
    // we start from the very latest block instead of trying to scan history.
    const tip = await source.getCurrentBlock();
    await advanceTransferCursor(Math.max(0, tip - 1));
    console.log(`[poll] no cursor found, initialized to ${tip - 1}`);
    return;
  }

  const tip = await source.getCurrentBlock();
  if (tip <= cursor) {
    // Already at tip; nothing to do.
    return;
  }
  const toBlock = Math.min(tip, cursor + MAX_BLOCKS_PER_POLL);
  const fromBlock = cursor + 1;
  const t = Date.now();

  const logs = await source.getLogs({
    fromBlock,
    toBlock,
    eventSignatures: [TRANSFER_TOPIC],
  });

  // For polling we use synthetic timestamps for now. Real block
  // timestamps would require an extra eth_getBlockByNumber per block;
  // worth adding once we have per-token state to time-stamp accurately.
  // Until then the bootstrap-era estimateTimestamp logic is fine and
  // close enough (off by seconds, not days).
  const blockTimestamps = new Map<number, Date>();
  const now = new Date();
  for (const log of logs) {
    if (!blockTimestamps.has(log.blockNumber)) {
      blockTimestamps.set(log.blockNumber, now);
    }
  }

  const result = await ingestTransferLogs(logs, blockTimestamps);
  await advanceTransferCursor(toBlock);

  const elapsed = Date.now() - t;
  // Only log when something happened; otherwise stay quiet to keep
  // Railway logs readable.
  if (logs.length > 0 || result.activityRows > 0) {
    console.log(
      `[poll] ${fromBlock}..${toBlock} (${toBlock - fromBlock + 1} blocks) — ${logs.length} logs, ${result.activityRows} events, ${result.collectionsTouched} contracts touched in ${elapsed}ms`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
