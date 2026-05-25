import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Singleton Postgres connection. `postgres` (porsager) handles its own
 * pool internally — we keep one instance for the process lifetime.
 *
 * `prepare: false` disables prepared statements which can interact
 * badly with PgBouncer-style transaction poolers. Railway's Postgres
 * doesn't put a pooler in front by default but the cost of disabling
 * prepare is small and the safety is meaningful.
 */
const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 30,
  prepare: false,
});

export const db = drizzle(sql, { schema });
export { sql as rawSql };
export type Db = typeof db;
