import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { buildServer } from "./api/server.js";
import { startCrawler } from "./crawler/loop.js";
import { runMigrations } from "./db/migrate.js";

/**
 * Entry point. Boots the HTTP API and the crawler loop in the same
 * Node process. Two concurrent tasks: API serves requests, crawler
 * polls and writes to DB. They share the Postgres connection pool.
 *
 * If either crashes catastrophically the process exits and Railway
 * restarts us. The restart resumes from `crawler_state` so no work
 * is lost (will be true once bootstrap/poll are implemented).
 */

// Log unhandled rejections so we see them in Railway's logs instead of
// silently failing. Process will exit on uncaught exceptions by default.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
});

async function main() {
  // Migrations FIRST. Refuses to boot the API or crawler until the
  // schema matches expectations. If there's nothing to apply (the
  // common case after the baseline), this is a few ms of metadata read.
  await runMigrations();

  const app = buildServer();
  serve(
    {
      fetch: app.fetch,
      port: env.PORT,
    },
    (info) => {
      console.log(`[api] listening on http://0.0.0.0:${info.port}`);
      console.log(`[api] env=${env.NODE_ENV}, cors=${env.CORS_ORIGINS ? env.CORS_ORIGINS.join(",") : "*"}, rate-limit=${env.RATE_LIMIT_PER_MINUTE}/min`);
    },
  );

  // Fire and forget — bootstrap can run for a while and we don't want
  // to block the API server's `serve()` callback from logging. Any
  // unhandled rejection in the crawler propagates to the listener above.
  startCrawler().catch((err) => {
    console.error("[crawler] top-level failure:", err);
  });
}

main().catch((err) => {
  console.error("[fatal] startup failed:", err);
  process.exit(1);
});
