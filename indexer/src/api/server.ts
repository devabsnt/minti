import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "../env.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import { collectionsRoutes } from "./routes/collections.js";
import { health } from "./routes/health.js";

/**
 * HTTP API for the indexer. Hono runs on Node via @hono/node-server
 * (see index.ts).
 *
 * Middleware order matters:
 *   1. logger        — captures every request, ALSO captures the
 *                      429 responses from rate-limit so we can see abuse
 *   2. CORS          — must run before route handlers but doesn't gate
 *                      same-origin or curl traffic
 *   3. rate-limit    — last gate before route handlers; returns 429 with
 *                      RateLimit-* headers per draft-6 spec
 *   4. routes        — actual endpoints
 */
export function buildServer() {
  const app = new Hono();

  app.use("*", logger());

  app.use(
    "*",
    cors({
      // null env means "no allowlist set — allow all" (dev mode).
      // Production should SET CORS_ORIGINS so we're not an open API.
      origin: env.CORS_ORIGINS ?? "*",
      allowMethods: ["GET", "OPTIONS"],
      maxAge: 86400,
    }),
  );

  app.use("/api/*", apiRateLimit);
  // /health is intentionally outside the rate limit so Railway's
  // health checker can hit it as often as it wants without consuming
  // a user's quota.
  app.route("/health", health);
  app.route("/api/collections", collectionsRoutes);

  // Root just returns metadata so curl-ing the bare URL is not a 404.
  app.get("/", (c) =>
    c.json({
      service: "minti-indexer",
      version: process.env.npm_package_version ?? "0.1.0",
      env: env.NODE_ENV,
    }),
  );

  return app;
}
