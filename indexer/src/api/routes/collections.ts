import { Hono } from "hono";
import { and, asc, desc, eq, gte, ilike, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, rawSql } from "../../db/client.js";
import { activity, collections, tokens } from "../../db/schema.js";

/**
 * Collection-facing endpoints.
 *
 *   GET /api/collections
 *     ?tier=N          (default 2 — only "explore-eligible"; pass 1 to
 *                       include the long-tail "indexed" tier, 0 to
 *                       include hidden too)
 *     ?sort=trending|holders|newest|name (default trending)
 *     ?limit=N         (default 50, max 200)
 *     ?offset=N        (default 0)
 *     ?q=text          (substring match on name/symbol/address)
 *
 *   GET /api/collections/:address
 *     Single collection details, no extra computation.
 *
 *   GET /api/collections/:address/tokens
 *     ?page=N&pageSize=N
 *     Paginated tokens with owner. Returns empty list until tokens are
 *     populated (happens automatically once polling+ingestion captures
 *     transfers; enrichment is what fills name/image).
 *
 *   GET /api/collections/:address/activity
 *     ?limit=N (default 50, max 200)
 *     Recent activity events for the collection, newest first.
 */
export const collectionsRoutes = new Hono();

const querySchema = z.object({
  tier: z.coerce.number().int().min(0).max(3).optional().default(2),
  sort: z.enum(["trending", "holders", "newest", "name"]).optional().default("trending"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  q: z.string().trim().min(1).max(100).optional(),
});

collectionsRoutes.get("/", async (c) => {
  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", detail: parsed.error.flatten() }, 400);
  }
  const { tier, sort, limit, offset, q } = parsed.data;

  const whereClauses = [gte(collections.tier, tier)];
  if (q) {
    const needle = `%${q}%`;
    whereClauses.push(
      or(
        ilike(collections.name, needle),
        ilike(collections.symbol, needle),
        ilike(collections.address, needle),
      )!,
    );
  }
  const where = and(...whereClauses)!;

  // Composite trending score.
  //
  // Activity terms (additive, log-scaled so an order-of-magnitude
  // bigger collection isn't an order-of-magnitude better):
  //   - secondary_transfers : actual ownership movement (excludes mints)
  //   - unique_senders      : how many distinct wallets are selling
  //   - unique_holders      : breadth of current ownership
  //   - mint_diversity_term : LN(1 + mint_count) * minter_diversity
  //                           where minter_diversity = unique_minters /
  //                           mint_count. 500 mints to 500 wallets gets
  //                           full credit; 500 mints to 1 wallet gets
  //                           near-zero credit.
  //
  // Multiplicative gating factor:
  //   - sender_diversity_factor : LEAST(1, unique_senders / 30). A
  //                               1-sender airdrop ranks at ~3% of its
  //                               otherwise-equivalent score.
  //
  // Mint-heavy penalty (additive, catches drop-and-flip collections
  // where almost no secondary trading occurs):
  //   -5 if >85% of activity is mints, -2 if >65%.
  //
  // (Holder concentration is NOT applied here. The retention-window
  // tokens table understates concentration for older mints. The
  // frontend filters out whale-heavy collections from the trending list
  // using the static snapshot's full-history concentration data.)
  const trendingScoreSql = sql`(
    (LN(1 + GREATEST(0, ${collections.transferCount} - ${collections.mintCount})) * 2.0
      + LN(1 + ${collections.uniqueSenders}) * 2.5
      + LN(1 + ${collections.uniqueHolders}) * 1.0
      + LN(1 + ${collections.mintCount}) * 1.5
        * (${collections.uniqueMinters}::float / GREATEST(${collections.mintCount}, 1)))
    * LEAST(1.0, ${collections.uniqueSenders}::float / 30.0)
    - CASE
        WHEN ${collections.transferCount} > 0
         AND ${collections.mintCount}::float / GREATEST(${collections.transferCount}, 1) > 0.85 THEN 5.0
        WHEN ${collections.transferCount} > 0
         AND ${collections.mintCount}::float / GREATEST(${collections.transferCount}, 1) > 0.65 THEN 2.0
        ELSE 0.0
      END
  )`;

  let orderBy;
  switch (sort) {
    case "holders":
      orderBy = [desc(collections.uniqueHolders), desc(collections.transferCount)];
      break;
    case "newest":
      orderBy = [desc(collections.firstSeenBlock)];
      break;
    case "name":
      orderBy = [asc(collections.name)];
      break;
    case "trending":
    default:
      orderBy = [sql`${trendingScoreSql} DESC`];
      break;
  }

  const rows = await db
    .select()
    .from(collections)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  // Total count for pagination UI. Cheap (indexed scan).
  const countRows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(collections)
    .where(where);
  const count = countRows[0]?.count ?? 0;

  return c.json({
    collections: rows,
    pagination: { limit, offset, total: count },
  });
});

collectionsRoutes.get("/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return c.json({ error: "Invalid address" }, 400);
  }
  const rows = await db.select().from(collections).where(eq(collections.address, address));
  const row = rows[0];
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ collection: row });
});

const tokenListSchema = z.object({
  page: z.coerce.number().int().min(0).optional().default(0),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
});

collectionsRoutes.get("/:address/tokens", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return c.json({ error: "Invalid address" }, 400);
  }
  const parsed = tokenListSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", detail: parsed.error.flatten() }, 400);
  }
  const { page, pageSize } = parsed.data;

  const rows = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.contract, address), isNotNull(tokens.owner))!)
    .orderBy(asc(sql`(${tokens.tokenId})::numeric`))
    .limit(pageSize)
    .offset(page * pageSize);

  const countRows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(tokens)
    .where(and(eq(tokens.contract, address), isNotNull(tokens.owner))!);
  const count = countRows[0]?.count ?? 0;

  return c.json({
    tokens: rows,
    pagination: { page, pageSize, total: count },
  });
});

const activityListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

collectionsRoutes.get("/:address/activity", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return c.json({ error: "Invalid address" }, 400);
  }
  const parsed = activityListSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", detail: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  const rows = await db
    .select()
    .from(activity)
    .where(eq(activity.contract, address))
    .orderBy(desc(activity.blockNumber), desc(activity.logIndex))
    .limit(limit);

  return c.json({ activity: rows });
});

const sparklineSchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).optional().default(24),
});

/**
 * Hourly activity buckets for the last N hours. Drives the inline
 * sparkline on the trending podium. Returns one bucket per hour,
 * zero-filled — even hours with no activity get an entry so the front
 * end can render a flat segment without doing date math itself.
 *
 * Counts every event row (transfers, mints, sales) — the goal is "is
 * this collection busy right now," not a specific event-type breakdown.
 */
collectionsRoutes.get("/:address/sparkline", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return c.json({ error: "Invalid address" }, 400);
  }
  const parsed = sparklineSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", detail: parsed.error.flatten() }, 400);
  }
  const { hours } = parsed.data;

  // generate_series produces every hour bucket in the window so empty
  // hours appear as zeros (a LEFT JOIN against the activity aggregation
  // takes care of the actual values). All buckets are aligned to
  // hour boundaries via date_trunc.
  const rows = await rawSql.unsafe<{ ts: Date; count: number }[]>(`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc('hour', NOW()) - (($1::int - 1) * INTERVAL '1 hour'),
        date_trunc('hour', NOW()),
        INTERVAL '1 hour'
      ) AS ts
    ),
    counts AS (
      SELECT
        date_trunc('hour', timestamp) AS ts,
        COUNT(*)::int AS count
      FROM activity
      WHERE contract = $2
        AND timestamp > NOW() - ($1::int * INTERVAL '1 hour')
      GROUP BY ts
    )
    SELECT b.ts AS ts, COALESCE(c.count, 0)::int AS count
      FROM buckets b
 LEFT JOIN counts c USING (ts)
  ORDER BY b.ts ASC
  `, [hours, address]);

  return c.json({
    buckets: rows.map((r) => ({ ts: r.ts.toISOString(), count: r.count })),
  });
});
