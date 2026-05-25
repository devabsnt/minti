import { env } from "../env.js";
import { runBootstrap } from "./bootstrap.js";
import { startEnrichment } from "./enrichment.js";
import { startPollLoop } from "./poll.js";
import { pruneOldActivity, startPruneLoop } from "./pruning.js";
import { RpcSource } from "./rpc-source.js";
import { startStatsLoop } from "./stats.js";
import { startTierLoop } from "./tier.js";

/**
 * Crawler orchestrator. Six tasks run inside one Node process:
 *
 *   1. Bootstrap — initial sweep from cutoff (now − RETENTION_DAYS) to
 *      current tip. Runs once. Resumes from cursor across restarts.
 *   2. Polling — continuous ingestion of new blocks at the tip.
 *   3. Enrichment — fills `name`, `symbol`, `totalSupply`, sample image,
 *      etc. for collections missing that data. Gated on RUN_ENRICHMENT.
 *   4. Stats refresh — recomputes per-collection counters from the live
 *      `activity` and `tokens` tables.
 *   5. Tier classification — assigns tier 0-2 based on stats + names.
 *   6. Pruning — daily cleanup of activity rows past retention window.
 *
 * Tasks 2-6 run forever after their respective starts. Each installs a
 * SIGTERM handler so Railway can gracefully recycle the service.
 */
export async function startCrawler() {
  const source = new RpcSource(env.MONAD_RPC);
  console.log(
    `[crawler] starting: ${env.MONAD_RPC.length} RPCs, bootstrap=${env.RUN_BOOTSTRAP}, enrich=${env.RUN_ENRICHMENT}, retention=${env.RETENTION_DAYS}d`,
  );

  // 0. On-deploy prune. Catches:
  //    - Stale data when RETENTION_DAYS is reduced (e.g. 60 → 30)
  //    - Drift if the daily prune loop was stalled on previous deploy
  //    - General hygiene: every deploy normalizes the DB to the policy
  // No-op when there's nothing to prune (e.g. fresh DB right after a
  // TRUNCATE, or recently-pruned state).
  try {
    const { deleted, elapsedMs } = await pruneOldActivity();
    if (deleted > 0) {
      console.log(`[crawler] on-deploy prune: removed ${deleted} stale rows in ${elapsedMs}ms`);
    } else {
      console.log(`[crawler] on-deploy prune: nothing to remove (DB is within retention)`);
    }
  } catch (err) {
    console.error(`[crawler] on-deploy prune failed: ${err instanceof Error ? err.message : err}`);
    // Don't abort — bootstrap can still proceed without a successful prune.
  }

  // 1. Bootstrap (blocking — we want this done before polling starts so
  // there's no overlap window where the cursor jumps confusingly).
  if (env.RUN_BOOTSTRAP) {
    try {
      const result = await runBootstrap(source);
      console.log(
        `[crawler] bootstrap finished: ${result.totalActivityRows} events, ${result.totalCollectionsTouched} collections, ${(result.elapsedMs / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.error(
        `[crawler] bootstrap aborted: ${err instanceof Error ? err.message : err}`,
      );
      // Keep going — the periodic jobs are still valuable even if
      // bootstrap died. They'll pick up newly-polled data once polling
      // starts below.
    }
  } else {
    console.log("[crawler] bootstrap skipped (RUN_BOOTSTRAP=0)");
  }

  // 2-6 run concurrently. Each catches its own errors internally and
  // loops forever; top-level failures here would be unrecoverable bugs.
  const tasks: Array<{ name: string; promise: Promise<void> }> = [
    { name: "poll", promise: startPollLoop(source) },
    { name: "stats", promise: startStatsLoop() },
    { name: "tier", promise: startTierLoop() },
    { name: "prune", promise: startPruneLoop() },
  ];
  if (env.RUN_ENRICHMENT) {
    tasks.push({ name: "enrich", promise: startEnrichment() });
  }
  for (const task of tasks) {
    task.promise.catch((err) => {
      console.error(`[${task.name}] top-level failure:`, err);
    });
  }
}
