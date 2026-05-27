import { z } from "zod";

/**
 * Environment variables, parsed and validated once at startup. Anything
 * missing or malformed throws here rather than blowing up in some random
 * downstream caller weeks later. Import { env } anywhere that needs config.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  MONAD_RPC: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "At least one Monad RPC URL required"),
  PORT: z
    .string()
    .default("8080")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n > 0 && n < 65536, "PORT must be a valid port number"),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.split(",").map((o) => o.trim()).filter(Boolean) : null,
    ),
  RATE_LIMIT_PER_MINUTE: z
    .string()
    .default("120")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n > 0, "RATE_LIMIT_PER_MINUTE must be positive"),
  CRAWLER_POLL_SECONDS: z
    .string()
    .default("10")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n >= 1, "CRAWLER_POLL_SECONDS must be >= 1"),
  RUN_BOOTSTRAP: z
    .string()
    .default("1")
    .transform((s) => s === "1" || s.toLowerCase() === "true"),
  RUN_ENRICHMENT: z
    .string()
    .default("0")
    .transform((s) => s === "1" || s.toLowerCase() === "true"),
  // Gates the trait-index worker. Off by default so deploying this code
  // doesn't auto-start a heavy background backfill — flip explicitly
  // when ready. Worker is implemented in crawler/traits/worker.ts.
  RUN_TRAIT_INDEX: z
    .string()
    .default("0")
    .transform((s) => s === "1" || s.toLowerCase() === "true"),
  // How many days of chain history the indexer maintains in the activity
  // table. Transfers older than this get pruned daily. Mints, burns, and
  // marketplace events (future) are kept regardless. Default 60.
  RETENTION_DAYS: z
    .string()
    .default("60")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n >= 1, "RETENTION_DAYS must be >= 1"),
  // Stats refresh cadence — how often the indexer recomputes
  // transfer_count / unique_holders / etc. per collection. Default 1800s
  // (30 min). The CTE scans the entire activity + tokens tables, so this
  // is the heaviest job we run — don't drop it below a few minutes
  // without an incremental-update story.
  STATS_REFRESH_SECONDS: z
    .string()
    .default("1800")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n >= 30, "STATS_REFRESH_SECONDS must be >= 30"),
  // Tier reclassification cadence. Reads from stats so should run after
  // a stats refresh. Default 600s (10 min).
  TIER_REFRESH_SECONDS: z
    .string()
    .default("600")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n >= 60, "TIER_REFRESH_SECONDS must be >= 60"),
  // Pruning cadence. Daily is sensible — pruning churns Postgres pages.
  // Set to 24 (hours) for normal ops; lower for testing.
  PRUNE_HOURS: z
    .string()
    .default("24")
    .transform((s) => parseInt(s, 10))
    .refine((n) => n >= 1, "PRUNE_HOURS must be >= 1"),
  MARKETPLACE_ADDRESS: z
    .string()
    .optional()
    .transform((s) => (s && s !== "0x0000000000000000000000000000000000000000" ? s.toLowerCase() : null)),
  NODE_ENV: z.enum(["production", "development", "test"]).default("development"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
