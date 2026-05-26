import { sql } from "drizzle-orm";
import { rawSql } from "../db/client.js";
import { env } from "../env.js";

/**
 * Aggregate stats refresh. Recomputes per-collection counters from the
 * current `activity` + `tokens` tables in one SQL pass. Idempotent —
 * always overwrites with the latest computed values.
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
 *   - top1_holder_pct: share of supply held by the single largest
 *     wallet. Computed by grouping tokens by owner and taking
 *     MAX(balance) / SUM(balance) per contract — cheap aggregate, no
 *     window function. (We tried `top10_holder_pct` via ROW_NUMBER
 *     window function but it never finished on the basic Railway tier.
 *     The single-wallet signal alone catches the gaming patterns we
 *     care about.)
 *
 * Cost: a few CTEs + UPDATE. Postgres handles it well with the existing
 * indexes on activity(contract, block_number) and tokens(contract).
 * For 30k collections + millions of rows, expect a few seconds.
 */
export async function refreshStats(): Promise<{ updated: number; elapsedMs: number }> {
  const t = Date.now();

  // Note: zero address handled in two forms (40 zeros + the canonical
  // string). All on-chain addresses we store are lowercased.
  const ZERO = "0x" + "0".repeat(40);

  const result = await rawSql.unsafe(`
    WITH activity_stats AS (
      SELECT
        contract,
        COUNT(*)::int AS transfer_count,
        COUNT(*) FILTER (WHERE event_type = 'mint')::int AS mint_count,
        COUNT(DISTINCT from_addr) FILTER (WHERE from_addr IS NOT NULL AND from_addr <> '${ZERO}')::int AS unique_senders,
        COUNT(DISTINCT to_addr) FILTER (WHERE event_type = 'mint' AND to_addr IS NOT NULL AND to_addr <> '${ZERO}')::int AS unique_minters
      FROM activity
      GROUP BY contract
    ),
    balances AS (
      SELECT contract, owner, COUNT(*)::bigint AS balance
      FROM tokens
      WHERE owner IS NOT NULL AND owner <> '${ZERO}'
      GROUP BY contract, owner
    ),
    holder_stats AS (
      SELECT
        contract,
        COUNT(*)::int AS unique_holders,
        SUM(balance)::bigint AS total_held,
        MAX(balance)::bigint AS top1_balance
      FROM balances
      GROUP BY contract
    )
    UPDATE collections c
    SET
      transfer_count = COALESCE(a.transfer_count, 0),
      mint_count = COALESCE(a.mint_count, 0),
      unique_senders = COALESCE(a.unique_senders, 0),
      unique_minters = COALESCE(a.unique_minters, 0),
      unique_holders = COALESCE(h.unique_holders, 0),
      top1_holder_pct = CASE
        WHEN h.total_held > 0 THEN (h.top1_balance::float / h.total_held)::real
        ELSE 0
      END,
      top10_holder_pct = 0,
      updated_at = now()
    FROM activity_stats a
    FULL OUTER JOIN holder_stats h USING (contract)
    WHERE c.address = COALESCE(a.contract, h.contract)
    RETURNING c.address
  `);

  const elapsed = Date.now() - t;
  // postgres lib returns array of rows for RETURNING; length is rows updated
  const updated = Array.isArray(result) ? result.length : 0;
  return { updated, elapsedMs: elapsed };
}

export async function startStatsLoop(): Promise<void> {
  const intervalMs = env.STATS_REFRESH_SECONDS * 1000;
  console.log(`[stats] starting, cadence=${env.STATS_REFRESH_SECONDS}s`);
  let stop = false;
  process.once("SIGTERM", () => { stop = true; });
  process.once("SIGINT", () => { stop = true; });

  // Hold off the first refresh for 45s after boot. The CTE scans all of
  // activity + tokens and saturates Postgres IO/CPU on the basic Railway
  // tier; concurrent API requests get queued behind it and the first
  // /explore load can take 50s+. Letting the API serve initial traffic
  // first means users see the page snappily, then stats catch up in the
  // background. Newly-discovered collections still get stats within
  // 45s + STATS_REFRESH_SECONDS, which is fine.
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
