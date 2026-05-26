import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./client.js";

/**
 * Apply pending Drizzle migrations to the live DB. Runs at startup
 * BEFORE any other code touches the database.
 *
 * Replaces the previous `drizzle-kit push --force` start-script step,
 * which had three problems:
 *   1. It re-derives the diff every deploy against the live schema,
 *      not against migration history — so harmless quirks (e.g. the
 *      composite-PK drop+add quirk on `tokens`) ran on every redeploy.
 *   2. The drop+add rebuilt the PK index on a multi-GB table for no
 *      structural reason. Slow, lock-prone, deploy-blocking.
 *   3. It could race with the OLD container's in-flight queries during
 *      rolling deploys, causing lock contention deadlocks we just had.
 *
 * Proper migrations only run the diff that's been explicitly committed
 * via `drizzle-kit generate`. New deploys with no schema change → no DDL.
 */
export async function runMigrations(): Promise<void> {
  console.log("[migrate] applying pending migrations from ./drizzle ...");
  const start = Date.now();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log(`[migrate] complete in ${Date.now() - start}ms`);
}
