import { env } from "../env.js";

/**
 * Stub crawler loop. Will fill in over the next iterations:
 *   - bootstrap: scan from block 0 to current tip using the RPC source,
 *     populating `collections` + `tokens` + `activity`
 *   - poll: every CRAWLER_POLL_SECONDS, fetch the new block range and
 *     process events incrementally
 *
 * The loop runs in the same process as the API. Two concurrent tasks
 * inside one Node process is fine on Railway — we can split later if
 * one drowns the other.
 *
 * For now this just logs a heartbeat so we can confirm the scheduler
 * works end-to-end when deployed. Real ingestion comes next turn.
 */
export function startCrawler() {
  const cadenceMs = env.CRAWLER_POLL_SECONDS * 1000;
  console.log(
    `[crawler] stub loop starting, cadence=${env.CRAWLER_POLL_SECONDS}s, bootstrap=${env.RUN_BOOTSTRAP}`,
  );

  let tick = 0;
  const handle = setInterval(() => {
    tick += 1;
    if (tick % 6 === 0) {
      // Reduce noise: log every 6 ticks (~1 min at 10s cadence).
      console.log(`[crawler] heartbeat #${tick}`);
    }
  }, cadenceMs);

  // Clean up if the process is shutting down (Railway sends SIGTERM
  // on redeploys).
  const shutdown = () => {
    clearInterval(handle);
    console.log("[crawler] stopped");
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
