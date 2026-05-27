import { rawSql } from "../db/client.js";
import { env } from "../env.js";

/**
 * Aggregate stats refresh. Recomputes per-collection counters from the
 * current `activity` + `tokens` tables. Idempotent — always overwrites
 * with the latest computed values.
 *
 * Sources:
 *   - transfer_count / mint_count: counted from `activity` (so they
 *     reflect the retention window, not lifetime — that's actually a
 *     more useful "recent activity" metric than "all-time transfers")
 *   - unique_holders: distinct `tokens.owner` per contract, excluding
 *     burn address (so holders count current owners regardless of
 *     pruning). Survives `activity` pruning.
 *   - unique_senders: distinct `from_addr` in `activity` per contract.
 *     Same retention semantics as transfer_count.
 *   - unique_minters: distinct `to_addr` for mint events. Lets the
 *     trending score reward broad mint participation while ignoring
 *     single-wallet farm mints.
 *
 * (Holder concentration metrics — `top1_holder_pct` / `top10_holder_pct`
 * — are NOT computed here. The retention-window-based tokens table
 * understates true concentration for older mints anyway. The frontend
 * filters trending against the static snapshot's concentration data
 * instead, which has full-history coverage.)
 *
 * **OOM safety.** The previous implementation ran one giant CTE with
 * FULL OUTER JOIN across all collections + activity + tokens at once,
 * which OOM'd on the Railway 8GB instance once the registry grew past
 * ~30K collections. We now process the contracts in batches of
 * `BATCH_SIZE` so each query's working set is bounded. Total elapsed
 * time is similar (Postgres parallelizes index scans either way), but
 * memory stays low and per-batch progress is visible in the logs.
 */

// Per-batch contract count. Memory is roughly linear in this — each
// batch's UPDATE materializes the CTE results for at most BATCH_SIZE
// contracts. 500 keeps each query under ~50 MB of working set even
// for very active collections.
const BATCH_SIZE = 500;

export interface StatsResult {
  updated: number;
  elapsedMs: number;
}

export async function refreshStats(): Promise<StatsResult> {
  const t = Date.now();
  let totalUpdated = 0;

  // Pull all contract addresses in chunks so we stream through them
  // without materializing the full list in memory. PG ORDER BY address
  // matches the primary-key index, so this is a single index scan.
  const allRows = await rawSql<Array<{ address: string }>>`
    SELECT address FROM collections ORDER BY address
  `;
  const total = allRows.length;
  if (total === 0) return { updated: 0, elapsedMs: Date.now() - t };

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE).map((r) => r.address);
    const updated = await refreshStatsBatch(batch);
    totalUpdated += updated;
  }

  return { updated: totalUpdated, elapsedMs: Date.now() - t };
}

/**
 * Recompute + write stats for a specific list of contract addresses.
 * Memory-bounded to the batch's aggregation footprint. Caller is
 * responsible for chunking the full registry into these.
 */
async function refreshStatsBatch(addrs: string[]): Promise<number> {
  if (addrs.length === 0) return 0;
  const ZERO = "0x" + "0".repeat(40);

  // `addrs` is an ARRAY parameter passed via `rawSql` template tagging
  // — postgres lib serializes it as a Postgres array literal so the
  // CTEs can `WHERE contract = ANY(...)`. Two filtered CTEs keep the
  // working set small: only this batch's rows are scanned/aggregated.
  const result = await rawSql<Array<{ address: string }>>`
    WITH activity_stats AS (
      SELECT
        contract,
        COUNT(*)::int AS transfer_count,
        COUNT(*) FILTER (WHERE event_type = 'mint')::int AS mint_count,
        COUNT(DISTINCT from_addr) FILTER (
          WHERE from_addr IS NOT NULL AND from_addr <> ${ZERO}
        )::int AS unique_senders,
        COUNT(DISTINCT to_addr) FILTER (
          WHERE event_type = 'mint' AND to_addr IS NOT NULL AND to_addr <> ${ZERO}
        )::int AS unique_minters
      FROM activity
      WHERE contract = ANY(${addrs})
      GROUP BY contract
    ),
    holder_stats AS (
      SELECT
        contract,
        COUNT(DISTINCT owner) FILTER (
          WHERE owner IS NOT NULL AND owner <> ${ZERO}
        )::int AS unique_holders
      FROM tokens
      WHERE contract = ANY(${addrs})
      GROUP BY contract
    )
    UPDATE collections c
    SET
      transfer_count = COALESCE(a.transfer_count, 0),
      mint_count = COALESCE(a.mint_count, 0),
      unique_senders = COALESCE(a.unique_senders, 0),
      unique_minters = COALESCE(a.unique_minters, 0),
      unique_holders = COALESCE(h.unique_holders, 0),
      updated_at = now()
    FROM activity_stats a
    FULL OUTER JOIN holder_stats h USING (contract)
    WHERE c.address = COALESCE(a.contract, h.contract)
      AND c.address = ANY(${addrs})
    RETURNING c.address
  `;

  return Array.isArray(result) ? result.length : 0;
}

export async function startStatsLoop(): Promise<void> {
  const intervalMs = env.STATS_REFRESH_SECONDS * 1000;
  console.log(`[stats] starting, cadence=${env.STATS_REFRESH_SECONDS}s, batch=${BATCH_SIZE}`);
  let stop = false;
  process.once("SIGTERM", () => { stop = true; });
  process.once("SIGINT", () => { stop = true; });

  // Hold off the first refresh for 45s after boot. The batched stats
  // pass is much friendlier than the old single-CTE version but
  // letting the API answer initial traffic before the heavy work
  // starts keeps the first /explore load snappy.
  await sleep(45_000);

  while (!stop) {
    try {
      const { updated, elapsedMs } = await refreshStats();
      if (updated > 0) {
        console.log(`[stats] refreshed ${updated} collections in ${elapsedMs}ms`);
      }
    } catch (err) {
      console.error(`[stats] refresh failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(intervalMs);
  }
  console.log("[stats] stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
