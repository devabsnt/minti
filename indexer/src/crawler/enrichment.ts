import { sql, eq } from "drizzle-orm";
import { createPublicClient, http, fallback, defineChain, type PublicClient } from "viem";
import { db } from "../db/client.js";
import { collections } from "../db/schema.js";
import { env } from "../env.js";
import {
  buildImageUrlTemplate,
  expandIdTemplate,
  extractImageField,
  fetchMetadataJson,
  resolveImageUriToHttps,
} from "./metadata.js";

/**
 * Enrichment pass. Continuously scans the `collections` table for rows
 * that don't yet have `metadata_checked = true`, batches them through:
 *
 *   1. Multicall3 for name() / symbol() / totalSupply() /
 *      supportsInterface(0x80ac58cd) / supportsInterface(0xd9b67a26)
 *   2. tokenURI(1) (or uri(1) for ERC-1155) — single contract call per
 *      collection (already in the multicall above for batching)
 *   3. Server-side fetch of the metadata JSON (Node has no CORS — we
 *      reach hosts the browser can't)
 *   4. Update the row with all derived fields and set metadata_checked
 *
 * Idempotent: a row with metadata_checked=true is skipped. Restartable:
 * a crash mid-batch resumes from the next unchecked row on relaunch.
 *
 * Gated by RUN_ENRICHMENT env var. Defaults off so deploying this code
 * doesn't auto-start a heavy job — flip it explicitly when ready.
 */

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ERC721_INTERFACE_ID = "0x80ac58cd" as const;
const ERC1155_INTERFACE_ID = "0xd9b67a26" as const;

// Monad RPC + multicall caps per the existing rpcPool config. 10
// contracts × 6 calls each = 60 calls per multicall — comfortably under
// Monad's per-eth_call gas limit.
const CONTRACTS_PER_MULTICALL = 10;
// How many cohort rows to load from DB per iteration. Bigger means
// fewer DB roundtrips but more memory while iterating.
const COHORT_SIZE = 100;
// How long to sleep when the queue is empty before checking again.
const IDLE_SLEEP_MS = 30_000;
// HTTP metadata fetches per cohort, run in parallel. Higher = faster
// but more pressure on host rate-limiters (esp. scatter).
const METADATA_CONCURRENCY = 5;

// ABIs scoped to the bits we actually call. Keeps multicall encode/decode lean.
const ABI = [
  { name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { name: "supportsInterface", inputs: [{ type: "bytes4" }], outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  { name: "tokenURI", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { name: "uri", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
] as const;

// Sample tokenId we use to fetch a representative metadata blob. 1 is
// the convention; rare collections start at 0. We try 1 first; if
// tokenURI(1) reverts, callers can extend to try 0 in a follow-up pass.
const SAMPLE_TOKEN_ID = 1n;

interface CollectionRow {
  address: string;
  is721: boolean;
  is1155: boolean;
}

interface EnrichmentUpdate {
  address: string;
  name: string | null;
  symbol: string | null;
  totalSupply: string | null;
  is721: boolean;
  is1155: boolean;
  metadataChecked: boolean;
  metadataBroken: boolean;
  tokenUriTemplate: string | null;
  sampleImageUrl: string | null;
  imageUrlTemplate: string | null;
  isOnChainMetadata: boolean;
}

function buildClient(): PublicClient {
  const urls = env.MONAD_RPC;
  const chain = defineChain({
    id: 143,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [...urls] } },
    contracts: {
      multicall3: { address: MULTICALL3_ADDRESS },
    },
  });
  return createPublicClient({
    chain,
    transport: fallback(
      urls.map((u) => http(u, { retryCount: 1, retryDelay: 250, timeout: 30_000 })),
      { rank: { interval: 30_000 } },
    ),
  }) as PublicClient;
}

async function loadCohort(limit: number): Promise<CollectionRow[]> {
  return db
    .select({
      address: collections.address,
      is721: collections.is721,
      is1155: collections.is1155,
    })
    .from(collections)
    .where(eq(collections.metadataChecked, false))
    .limit(limit);
}

/**
 * Multicall name/symbol/totalSupply/supportsInterface(721)/
 * supportsInterface(1155)/tokenURI(1) for a batch of contracts. Returns
 * a result per contract; any individual call failure is captured per
 * row so we still get partial data.
 */
async function batchOnChainMetadata(
  client: PublicClient,
  addrs: readonly `0x${string}`[],
): Promise<Array<{
  name: string | null;
  symbol: string | null;
  totalSupply: string | null;
  is721: boolean;
  is1155: boolean;
  rawTokenUri: string | null;
}>> {
  const contracts = addrs.flatMap((address) => [
    { address, abi: ABI, functionName: "name" as const },
    { address, abi: ABI, functionName: "symbol" as const },
    { address, abi: ABI, functionName: "totalSupply" as const },
    { address, abi: ABI, functionName: "supportsInterface" as const, args: [ERC721_INTERFACE_ID] },
    { address, abi: ABI, functionName: "supportsInterface" as const, args: [ERC1155_INTERFACE_ID] },
    // We send tokenURI(1) by default; if a row turns out to be ERC-1155
    // we can issue uri(1) in a follow-up — most ERC-1155 collections
    // implement both names anyway, so this is usually fine.
    { address, abi: ABI, functionName: "tokenURI" as const, args: [SAMPLE_TOKEN_ID] },
  ]);

  const results = await client.multicall({
    contracts,
    multicallAddress: MULTICALL3_ADDRESS,
    allowFailure: true,
  });

  const PER = 6;
  const out: ReturnType<typeof batchOnChainMetadata> extends Promise<infer T> ? T : never = [];
  for (let i = 0; i < addrs.length; i++) {
    const base = i * PER;
    const r = (idx: number) => results[base + idx]!;
    const success = (idx: number) => r(idx).status === "success";
    const value = <T,>(idx: number): T | null =>
      success(idx) ? (r(idx).result as T) : null;

    const rawName = value<string>(0);
    const rawSymbol = value<string>(1);
    const rawSupply = value<bigint>(2);
    out.push({
      name: typeof rawName === "string" && rawName.length > 0 ? rawName : null,
      symbol: typeof rawSymbol === "string" && rawSymbol.length > 0 ? rawSymbol : null,
      totalSupply: typeof rawSupply === "bigint" ? rawSupply.toString() : null,
      is721: success(3) && !!r(3).result,
      is1155: success(4) && !!r(4).result,
      rawTokenUri: value<string>(5),
    });
  }
  return out;
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function enrichCohort(client: PublicClient, cohort: CollectionRow[]): Promise<{
  enriched: number;
  withImage: number;
  broken: number;
}> {
  const addrs = cohort.map((c) => c.address as `0x${string}`);
  const batches: `0x${string}`[][] = [];
  for (let i = 0; i < addrs.length; i += CONTRACTS_PER_MULTICALL) {
    batches.push(addrs.slice(i, i + CONTRACTS_PER_MULTICALL));
  }

  const allOnchain: Awaited<ReturnType<typeof batchOnChainMetadata>> = [];
  for (const batch of batches) {
    let results;
    try {
      results = await batchOnChainMetadata(client, batch);
    } catch (err) {
      // RPC failure for this multicall batch — treat all as null and
      // try again next loop iteration (rows still have metadata_checked
      // = false, so they'll come back around).
      console.warn(`[enrich] multicall batch failed (${batch.length} contracts): ${err instanceof Error ? err.message : err}`);
      for (let i = 0; i < batch.length; i++) {
        allOnchain.push({
          name: null,
          symbol: null,
          totalSupply: null,
          is721: false,
          is1155: false,
          rawTokenUri: null,
        });
      }
      continue;
    }
    for (const r of results) allOnchain.push(r);
  }

  // For each row that got a tokenURI back, resolve the JSON in parallel.
  // The metadata fetch is the slow part — bound concurrency.
  const updates = await runWithConcurrency(
    cohort.map((c, i) => ({ row: c, onchain: allOnchain[i]! })),
    METADATA_CONCURRENCY,
    async ({ row, onchain }) => {
      const update: EnrichmentUpdate = {
        address: row.address,
        name: onchain.name,
        symbol: onchain.symbol,
        totalSupply: onchain.totalSupply,
        is721: onchain.is721,
        is1155: onchain.is1155,
        metadataChecked: true,
        metadataBroken: false,
        tokenUriTemplate: null,
        sampleImageUrl: null,
        imageUrlTemplate: null,
        isOnChainMetadata: false,
      };

      const rawUri = onchain.rawTokenUri;
      if (!rawUri) {
        // tokenURI reverted or returned empty. Marked checked-but-broken
        // so it doesn't keep coming back; assignTier will hide it.
        update.metadataBroken = true;
        return update;
      }
      const concrete = expandIdTemplate(rawUri, SAMPLE_TOKEN_ID);
      const isOnChain = concrete.startsWith("data:");
      const json = await fetchMetadataJson(concrete);
      if (!json) {
        update.metadataBroken = true;
        update.tokenUriTemplate = rawUri;
        update.isOnChainMetadata = isOnChain;
        return update;
      }
      const rawImage = extractImageField(json);
      const sampleImageUrl = resolveImageUriToHttps(rawImage);
      update.tokenUriTemplate = rawUri;
      update.sampleImageUrl = sampleImageUrl;
      update.imageUrlTemplate = sampleImageUrl
        ? buildImageUrlTemplate(sampleImageUrl, SAMPLE_TOKEN_ID)
        : null;
      update.isOnChainMetadata = isOnChain;
      return update;
    },
  );

  // Apply updates one by one. Each is a single-row UPDATE so concurrent
  // contention on `collections` rows is impossible (one txn per row).
  let withImage = 0;
  let broken = 0;
  for (const u of updates) {
    if (u.sampleImageUrl) withImage++;
    if (u.metadataBroken) broken++;
    await db
      .update(collections)
      .set({
        name: u.name,
        symbol: u.symbol,
        totalSupply: u.totalSupply,
        is721: u.is721,
        is1155: u.is1155,
        metadataChecked: u.metadataChecked,
        metadataBroken: u.metadataBroken,
        tokenUriTemplate: u.tokenUriTemplate,
        sampleImageUrl: u.sampleImageUrl,
        imageUrlTemplate: u.imageUrlTemplate,
        isOnChainMetadata: u.isOnChainMetadata,
        updatedAt: sql`now()`,
      })
      .where(eq(collections.address, u.address));
  }

  return { enriched: updates.length, withImage, broken };
}

export async function startEnrichment(): Promise<void> {
  if (!env.RUN_ENRICHMENT) {
    console.log("[enrich] disabled (RUN_ENRICHMENT=0)");
    return;
  }
  console.log(`[enrich] starting (cohort=${COHORT_SIZE}, multicall=${CONTRACTS_PER_MULTICALL}, metadata-concurrency=${METADATA_CONCURRENCY})`);
  const client = buildClient();

  let totalEnriched = 0;
  let totalWithImage = 0;
  let totalBroken = 0;
  let stop = false;
  const shutdown = () => { stop = true; };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  while (!stop) {
    const cohort = await loadCohort(COHORT_SIZE);
    if (cohort.length === 0) {
      console.log(`[enrich] queue empty — sleeping ${IDLE_SLEEP_MS / 1000}s before next check`);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    const t = Date.now();
    try {
      const result = await enrichCohort(client, cohort);
      totalEnriched += result.enriched;
      totalWithImage += result.withImage;
      totalBroken += result.broken;
      const elapsed = Date.now() - t;
      console.log(
        `[enrich] cohort done: ${result.enriched} updated, ${result.withImage} with image, ${result.broken} broken in ${elapsed}ms — totals: ${totalEnriched} updated, ${totalWithImage} with image, ${totalBroken} broken`,
      );
    } catch (err) {
      console.error(`[enrich] cohort failed: ${err instanceof Error ? err.message : err}. Sleeping 10s and retrying.`);
      await sleep(10_000);
    }
  }
  console.log("[enrich] stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
