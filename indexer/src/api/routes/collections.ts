import { Hono } from "hono";
import { and, asc, desc, eq, gte, ilike, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
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

  // Composite trending score:
  //   - log-scaled secondary transfers (non-mint movement) — actual market activity
  //   - log-scaled unique_senders weighted highest — diversity of sellers is
  //     the strongest "real market" signal. An airdrop has 1 sender; a
  //     traded collection has hundreds.
  //   - log-scaled unique_holders for breadth
  //   - penalty when mint_count/transfer_count ratio is very high (airdrop
  //     signature: lots of transfers but they're all mint events)
  //
  // Logs prevent any single huge number from dominating. Weights tuned
  // so unique_senders carries more than raw transfer count.
  const trendingScoreSql = sql`(
    LN(1 + GREATEST(0, ${collections.transferCount} - ${collections.mintCount})) * 2.0
    + LN(1 + ${collections.uniqueSenders}) * 2.5
    + LN(1 + ${collections.uniqueHolders}) * 1.0
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
