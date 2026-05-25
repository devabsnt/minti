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
