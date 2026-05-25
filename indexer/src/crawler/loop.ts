import { env } from "../env.js";
import { runBootstrap } from "./bootstrap.js";
import { RpcSource } from "./rpc-source.js";

/**
 * Crawler orchestrator. Runs in the same Node process as the API.
 *
 * Lifecycle:
 *   1. Construct the RpcSource over the configured MONAD_RPC pool.
 *   2. If RUN_BOOTSTRAP=1, sweep Transfer events from the cursor up to
 *      the chain tip. Idempotent + resumable — re-runs are no-ops once
 *      caught up.
 *   3. (NEXT TURN) Start the polling loop to keep up with new blocks.
 *      For now we just log heartbeats so we can see the process is
 *      alive between cron-style polls.
 *
 * Errors during bootstrap are logged but don't crash the API. Railway
 * keeps the service alive so we can debug via /health and the logs.
 */
export async function startCrawler() {
  const source = new RpcSource(env.MONAD_RPC);
  console.log(
    `[crawler] starting with ${env.MONAD_RPC.length} RPCs, bootstrap=${env.RUN_BOOTSTRAP}, poll=${env.CRAWLER_POLL_SECONDS}s`,
  );

  if (env.RUN_BOOTSTRAP) {
    try {
      const result = await runBootstrap(source);
      console.log(
        `[crawler] bootstrap finished: ${result.totalActivityRows} events, ${result.totalCollectionsTouched} collections, ${(result.elapsedMs / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      // Log but don't propagate — we don't want a bootstrap failure
      // to take down the API. The cursor in crawler_state is unchanged
      // for any chunk that failed, so the next restart resumes cleanly.
      console.error(
        `[crawler] bootstrap aborted: ${err instanceof Error ? err.message : err}`,
      );
    }
  } else {
    console.log("[crawler] bootstrap skipped (RUN_BOOTSTRAP=0)");
  }

  // Polling loop is next turn. For now, heartbeat so we can confirm
  // the crawler process is still alive after bootstrap completes.
  let tick = 0;
  const handle = setInterval(() => {
    tick += 1;
    if (tick % 6 === 0) {
      console.log(`[crawler] idle heartbeat #${tick} (poll loop not yet implemented)`);
    }
  }, env.CRAWLER_POLL_SECONDS * 1000);

  const shutdown = () => {
    clearInterval(handle);
    console.log("[crawler] stopped");
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
