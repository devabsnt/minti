import { rateLimiter } from "hono-rate-limiter";
import { env } from "../../env.js";

/**
 * Per-IP rate limiter. Defaults to RATE_LIMIT_PER_MINUTE requests per
 * minute per source IP. In-memory storage — good for a single Railway
 * instance. When/if the service horizontally scales, swap to a Redis-
 * backed store (hono-rate-limiter supports it via the `store` option).
 *
 * Why this matters: the indexer's API is reading from our own DB, which
 * is fine, but the DB and Postgres connection are finite. Without a
 * limiter a single client (or scraper) can pin the pool. Cheaper to
 * 429 obvious abusers than to scale Postgres for free abuse.
 *
 * The limit is the same for all callers regardless of origin. Tight CORS
 * (CORS_ORIGINS env) is the OTHER lever — only trusted browser origins
 * are allowed to make CORS requests, so the limiter is primarily a
 * defense against direct API hammering.
 */
export const apiRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: env.RATE_LIMIT_PER_MINUTE,
  standardHeaders: "draft-6",
  keyGenerator: (c) => {
    // Use X-Forwarded-For when Railway's proxy sets it; fall back to
    // the connection's remote address. Railway terminates TLS at its
    // edge and forwards the original client IP.
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]?.trim() ?? "unknown";
    return c.req.header("x-real-ip") ?? "unknown";
  },
});
