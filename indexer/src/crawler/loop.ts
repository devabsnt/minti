import { env } from "../env.js";
import { runBootstrap } from "./bootstrap.js";
import { startEnrichment } from "./enrichment.js";
import { startPollLoop } from "./poll.js";
import { pruneOldActivity, startPruneLoop } from "./pruning.js";
import { retemplateMissingImageTemplates } from "./retemplate.js";
import { RpcSource } from "./rpc-source.js";
import { startStatsLoop } from "./stats.js";
import { startTierLoop } from "./tier.js";
import { startTraitWorker } from "./traits/worker.js";

/**
 * Crawler orchestrator. Seven tasks run inside one Node process:
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
 *   7. Trait index — per-collection trait manifest builder. Heaviest
 *      I/O job in the indexer (one HTTP fetch per token), throttled to
 *      100 concurrent fetches globally / 10 per host. Gated on
 *      RUN_TRAIT_INDEX. Resumable per-collection via the
 *      `collection_traits.lastEnumeratedTokenId` checkpoint.
 *
 * Tasks 2-7 run forever after their respective starts. Each installs a
 * SIGTERM handler so Railway can gracefully recycle the service.
 *
 * All tasks share the same Node event loop. API requests serve fine
 * alongside them because every long-running operation `await`s on
 * either I/O (HTTP, Postgres) or `setTimeout`, yielding to the loop.
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

  // 1. Bootstrap runs in the BACKGROUND. Historically this was awaited
  // before starting other tasks "so there's no overlap window where the
  // cursor jumps confusingly," but in practice a single stuck Monad RPC
  // would park bootstrap for hours, which in turn parked stats, tier,
  // enrichment, AND the trait worker — none of which actually care that
  // bootstrap is still running. Inserts are idempotent (PK on
  // (tx_hash, log_index)) so bootstrap + polling can safely race; they
  // just discover the same rows from different ends and one wins.
  if (env.RUN_BOOTSTRAP) {
    runBootstrap(source)
      .then((result) => {
        console.log(
          `[crawler] bootstrap finished: ${result.totalActivityRows} events, ${result.totalCollectionsTouched} collections, ${(result.elapsedMs / 1000).toFixed(1)}s`,
        );
      })
      .catch((err) => {
        console.error(
          `[crawler] bootstrap aborted: ${err instanceof Error ? err.message : err}`,
        );
      });
  } else {
    console.log("[crawler] bootstrap skipped (RUN_BOOTSTRAP=0)");
  }

  // 2. Retemplate — fast idempotent CPU pass over stored image
  //    templates. Fired in the BACKGROUND so it can't delay the workers.
  //    (Stats + tier are intentionally NOT run here: the periodic tier
  //    loop runs immediately at t=0 and the periodic stats loop at t=45s,
  //    so they already cover the initial pass without an extra blocking
  //    call. History lesson: awaiting stats/tier here repeatedly parked
  //    the entire crawler — including the trait + enrich workers, which
  //    don't read stats/tiers at all — behind a slow query for minutes.)
  void retemplateMissingImageTemplates()
    .then((r) => {
      if (r.filled > 0) {
        console.log(`[retemplate] filled ${r.filled}/${r.scanned} missing image templates in ${r.elapsedMs}ms`);
      }
    })
    .catch((err) => {
      console.error(`[retemplate] failed: ${err instanceof Error ? err.message : err}`);
    });

  // 3-7 run concurrently, starting IMMEDIATELY. Each catches its own
  // errors internally and loops forever; top-level failures here would
  // be unrecoverable bugs.
  const tasks: Array<{ name: string; promise: Promise<void> }> = [
    { name: "poll", promise: startPollLoop(source) },
    { name: "stats", promise: startStatsLoop() },
    { name: "tier", promise: startTierLoop() },
    { name: "prune", promise: startPruneLoop() },
  ];
  if (env.RUN_ENRICHMENT) {
    tasks.push({ name: "enrich", promise: startEnrichment() });
  }
  if (env.RUN_TRAIT_INDEX) {
    tasks.push({ name: "traits", promise: startTraitWorker() });
  }
  for (const task of tasks) {
    task.promise.catch((err) => {
      console.error(`[${task.name}] top-level failure:`, err);
    });
  }
}
