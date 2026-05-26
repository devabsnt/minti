import { eq, isNotNull, isNull, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { collections } from "../db/schema.js";
import { buildImageUrlTemplate } from "./metadata.js";

/**
 * One-shot retemplate pass. Re-runs `buildImageUrlTemplate` on every
 * collection that has a `sample_image_url` but no `image_url_template`.
 * Pure CPU — no HTTP, no RPC, no metadata refetch. Picks up template
 * extractions the old (lastIndexOf-only) algorithm missed.
 *
 * Always runs at startup. Idempotent — if nothing changed, no UPDATEs.
 */

const SAMPLE_TOKEN_ID = 1n;
const UPDATE_BATCH = 50;

export async function retemplateMissingImageTemplates(): Promise<{
  scanned: number;
  filled: number;
  elapsedMs: number;
}> {
  const t = Date.now();
  // Pull every row that has an image but no template. For an indexer
  // around 30k collections that's a small in-memory set (~couple MB).
  const rows = await db
    .select({
      address: collections.address,
      sampleImageUrl: collections.sampleImageUrl,
    })
    .from(collections)
    .where(
      and(
        isNotNull(collections.sampleImageUrl),
        isNull(collections.imageUrlTemplate),
      )!,
    );

  const filled: Array<{ address: string; template: string }> = [];
  for (const r of rows) {
    if (!r.sampleImageUrl) continue;
    const tpl = buildImageUrlTemplate(r.sampleImageUrl, SAMPLE_TOKEN_ID);
    if (tpl) filled.push({ address: r.address, template: tpl });
  }

  // Batch the UPDATEs. Single-row UPDATEs would work but waste roundtrips.
  for (let i = 0; i < filled.length; i += UPDATE_BATCH) {
    const slice = filled.slice(i, i + UPDATE_BATCH);
    await Promise.all(
      slice.map((u) =>
        db
          .update(collections)
          .set({ imageUrlTemplate: u.template, updatedAt: sql`now()` })
          .where(eq(collections.address, u.address)),
      ),
    );
  }

  return { scanned: rows.length, filled: filled.length, elapsedMs: Date.now() - t };
}
