import { rawSql } from "../db/client.js";
import { env } from "../env.js";

/**
 * Activity pruning. Daily job that deletes `activity` rows older than
 * RETENTION_DAYS. Targeted at transfer events (high volume, low long-
 * term value once `tokens.owner` carries current state). Mints, burns,
 * and future marketplace events (sale/listing/bid) are kept regardless.
 *
 * Why this is safe:
 *   - `tokens.owner` is maintained on every ingestion. Pruning a
 *     transfer event doesn't affect ownership knowledge.
 *   - `collections.first_seen_block` carries earliest-seen state.
 *   - We only prune `event_type = 'transfer'` — mints/burns stay.
 *   - Postgres `autovacuum` reclaims the freed pages.
 *
 * Implementation: parameterized retention via `RETENTION_DAYS`.
 * Computes cutoff as `now() - retention_days::interval` rather than by
 * block number — robust against block-time variations.
 */

export async function pruneOldActivity(): Promise<{ deleted: number; elapsedMs: number }> {
  const t = Date.now();
  // We DELETE by timestamp because:
  //   1. activity.timestamp is reliable (set on ingest)
  //   2. activity.block_number is also fine but requires us to know
  //      current tip first; one less indirection.
  // Targeted only at 'transfer' rows. Mints/burns kept forever.
  const result = await rawSql.unsafe(`
    DELETE FROM activity
    WHERE event_type = 'transfer'
      AND timestamp < now() - interval '${env.RETENTION_DAYS} days'
  `);
  // postgres-js returns a query result with count
  const deleted = (result as unknown as { count?: number }).count ?? 0;
  return { deleted, elapsedMs: Date.now() - t };
}

export async function startPruneLoop(): Promise<void> {
  const intervalMs = env.PRUNE_HOURS * 60 * 60 * 1000;
  console.log(`[prune] starting, cadence=${env.PRUNE_HOURS}h, retention=${env.RETENTION_DAYS}d`);
  let stop = false;
  process.once("SIGTERM", () => { stop = true; });
  process.once("SIGINT", () => { stop = true; });

  // Wait one full interval before the first prune — gives the indexer
  // a chance to settle on first boot, avoids hammering Postgres while
  // bootstrap might still be running.
  await sleep(intervalMs);

  while (!stop) {
    try {
      const { deleted, elapsedMs } = await pruneOldActivity();
      console.log(`[prune] deleted ${deleted} transfer rows older than ${env.RETENTION_DAYS}d in ${elapsedMs}ms`);
    } catch (err) {
      console.error(`[prune] failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(intervalMs);
  }
  console.log("[prune] stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
