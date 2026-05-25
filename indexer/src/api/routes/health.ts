import { Hono } from "hono";
import { rawSql } from "../../db/client.js";

/**
 * Health endpoint. Returns 200 + a small JSON when the service can reach
 * Postgres. Used by Railway for service health checks and by us to
 * validate the deploy.
 */
export const health = new Hono();

health.get("/", async (c) => {
  // Quick connectivity check — `select 1` is the canonical "DB is up"
  // probe. Times out at the connect_timeout we set in db/client.ts.
  try {
    const result = await rawSql`select 1 as ok`;
    return c.json({
      status: "ok",
      db: result[0]?.ok === 1 ? "connected" : "unexpected",
      uptime: process.uptime(),
    });
  } catch (err) {
    return c.json(
      {
        status: "degraded",
        db: "unreachable",
        error: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
});
