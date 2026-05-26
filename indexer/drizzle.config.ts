import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` (offline migration generation) doesn't need a
// DB connection — it just diffs schema.ts against the migrations folder.
// Only `push` and `studio` need DATABASE_URL. Default to a placeholder
// so `generate` works locally without a real DB; the runtime migrator
// reads DATABASE_URL itself.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder",
  },
  verbose: true,
  strict: true,
});
