import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  // drizzle-kit reads this config at CLI time. Fail loud rather than
  // silently use undefined.
  throw new Error("DATABASE_URL is required for drizzle-kit operations");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Verbose output is helpful when iterating on the schema.
  verbose: true,
  strict: true,
});
