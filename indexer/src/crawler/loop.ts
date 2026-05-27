import { env } from "../env.js";
import { runBootstrap } from "./bootstrap.js";
import { startEnrichment } from "./enrichment.js";
import { startPollLoop } from "./poll.js";
import { pruneOldActivity, startPruneLoop } from "./pruning.js";
import { retemplateMissingImageTemplates } from "./retemplate.js";
import { RpcSource } from "./rpc-source.js";
import { refreshStats, startStatsLoop } from "./stats.js";
import { refreshTiers, startTierLoop } from "./tier.js";
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

  // 2. One-shot stats refresh + tier classification, sequential, BEFORE
  //    the periodic loops start. Guarantees the API serves fresh tier
  //    distribution to the first request after deploy. Without this the
  //    initial periodic stats/tier race could leave tiers stale until
  //    the second tier interval fired (~10 min later).
  // Retemplate first — fixes up `image_url_template` for collections
  // where the old (lastIndexOf-only) algorithm missed the match (e.g.
  // scatter URLs with `tokenId=X&v=<timestamp>`). Pure CPU pass over
  // stored sample_image_url values. Idempotent: re-runs do nothing
  // once everything is filled in.
  try {
    const r = await retemplateMissingImageTemplates();
    if (r.filled > 0) {
      console.log(`[retemplate] filled ${r.filled}/${r.scanned} missing image templates in ${r.elapsedMs}ms`);
    }
  } catch (err) {
    console.error(`[retemplate] failed: ${err instanceof Error ? err.message : err}`);
  }

  // Initial stats + tier passes — bounded by a hard timeout so a stuck
  // query (Postgres lock, network hang) doesn't park the entire crawler
  // before periodic tasks start. If we time out here, the periodic
  // stats / tier loops below will run it on their normal cadence; the
  // first request after deploy might serve slightly-stale tier data,
  // but that's far better than the trait/enrich workers never starting.
  try {
    console.log("[crawler] initial stats refresh...");
    const s = await withTimeout(refreshStats(), 120_000, "initial stats");
    console.log(`[crawler] initial stats: ${s.updated} collections updated in ${s.elapsedMs}ms`);
  } catch (err) {
    console.error(`[crawler] initial stats failed: ${err instanceof Error ? err.message : err} — moving on`);
  }
  try {
    console.log("[crawler] initial tier classification...");
    const t = await withTimeout(refreshTiers(), 60_000, "initial tier");
    console.log(`[crawler] initial tier: T0=${t.tier0} T1=${t.tier1} T2=${t.tier2} (${t.updated} changed) in ${t.elapsedMs}ms`);
  } catch (err) {
    console.error(`[crawler] initial tier failed: ${err instanceof Error ? err.message : err}`);
  }

  // 3-7 run concurrently. Each catches its own errors internally and
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
  if (env.RUN_TRAIT_INDEX) {
    tasks.push({ name: "traits", promise: startTraitWorker() });
  }
  for (const task of tasks) {
    task.promise.catch((err) => {
      console.error(`[${task.name}] top-level failure:`, err);
    });
  }
}

/**
 * Race `promise` against a timeout. Throws `Timed out` if the promise
 * doesn't settle in `ms` milliseconds. Caller decides whether to recover
 * (e.g. log and skip) or rethrow.
 *
 * Used to bound the blocking initial passes (stats, tier) so a stuck
 * Postgres query can't keep the periodic crawler tasks from ever
 * starting. The periodic loops will recover the missed work on their
 * normal cadence.
 *
 * NOTE: this is best-effort cancellation — the underlying Postgres
 * query keeps running on the server until it finishes or the
 * connection drops. The timeout just lets us stop awaiting it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
