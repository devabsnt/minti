import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";
import { db } from "../../db/client.js";
import { collections, collectionTraits } from "../../db/schema.js";
import { env } from "../../env.js";
import {
  expandIdTemplate,
  fetchMetadataJson,
} from "../metadata.js";
import {
  ManifestBuilder,
  normalizeAttributes,
  type SerializedManifest,
} from "./manifest.js";
import { HostThrottle, hostKey } from "./throttle.js";

/**
 * Trait enumeration worker.
 *
 * Builds a `collection_traits.manifest` for every collection in the
 * registry, one collection at a time, with checkpointing per token
 * chunk so Railway restarts resume instead of redoing hours of work.
 *
 * Order of operations per collection:
 *
 *   1. Read totalSupply + tokenUriTemplate from the collections row.
 *      Skip if either is missing (enrichment hasn't finished yet).
 *   2. Hydrate any prior partial manifest from collection_traits.
 *   3. Compute the missing token-ID range
 *      (lastEnumeratedTokenId+1 → totalSupply).
 *   4. Fetch metadata JSON for each missing token through the global
 *      HostThrottle. Indexer-side fetches don't need the CORS proxy —
 *      Node.js fetch has no CORS, and Railway IPs are not on the
 *      anti-scrape blocklists that bit our Cloudflare worker.
 *   5. After every CHECKPOINT_EVERY tokens, persist the updated
 *      manifest + lastEnumeratedTokenId. A crash anywhere loses at
 *      most CHECKPOINT_EVERY tokens of progress.
 *   6. On completion, set status='complete' (or 'all_identical' /
 *      'failed' as appropriate) and clear nextAttemptAt.
 *
 * On failure (host dead, too many fetch errors): bump attemptCount,
 * compute exponential backoff, set status='failed' + nextAttemptAt.
 * The worker will pick the row back up when nextAttemptAt elapses.
 */

// How many tokens to fetch in parallel per collection. Each fetch is
// gated by the global HostThrottle, so going higher here doesn't
// actually exceed our per-host caps — it just lets more pending
// promises sit in the throttle queue.
const FETCH_CONCURRENCY_PER_COLLECTION = 40;
// Persist progress after this many tokens. Lower = more disk writes
// but smaller crash window; higher = fewer writes but larger window.
// 200 chosen so a 3K-supply collection writes ~15 times during enum.
const CHECKPOINT_EVERY = 200;
// Sleep when the queue is empty. Cheap re-check, but no need to spin.
const IDLE_SLEEP_MS = 60_000;
// Per-collection budget. If a single collection produces this many
// consecutive failures, abort and back off — usually means the host
// is down. We mark it failed but keep partial progress.
const PER_COLLECTION_CONSECUTIVE_FAIL_BUDGET = 30;
// Backoff schedule: 5 min, 30 min, 2h, 12h, then cap. attemptCount
// 0-based, so first failure waits ~5 min before retry.
const BACKOFF_MINUTES = [5, 30, 120, 720, 1440];

// Throttle is shared across all in-flight collection enumerations so
// per-host caps actually mean something (otherwise 5 collections all
// running concurrently against scatter would each get their own
// 10-slot cap = 50 in-flight to scatter).
const throttle = new HostThrottle({ global: 100, perHost: 10 });

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const ABI = [
  {
    name: "tokenURI",
    inputs: [{ type: "uint256", name: "tokenId" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    name: "uri",
    inputs: [{ type: "uint256", name: "id" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function buildClient(): PublicClient {
  const urls = env.MONAD_RPC;
  const chain = defineChain({
    id: 143,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [...urls] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });
  return createPublicClient({
    chain,
    transport: fallback(
      urls.map((u) =>
        http(u, { retryCount: 1, retryDelay: 250, timeout: 30_000 }),
      ),
      { rank: { interval: 30_000 } },
    ),
  }) as PublicClient;
}

interface CandidateRow {
  contract: string;
  totalSupply: string | null;
  tokenUriTemplate: string | null;
  is1155: boolean;
  // From collection_traits (joined). Null when we've never enumerated.
  status: string | null;
  lastEnumeratedTokenId: string | null;
  storedManifest: SerializedManifest | null;
  storedTotalSupply: string | null;
  attemptCount: number | null;
}

/**
 * Pick the next collection to enumerate. Priority order:
 *
 *   1. Existing partial rows whose nextAttemptAt is null or past — these
 *      are mid-enumeration or in a backoff window that has elapsed.
 *   2. Collections that have never been enumerated (collection_traits row
 *      doesn't exist) and are enriched (have tokenUriTemplate +
 *      totalSupply) and aren't broken.
 *
 * Returns null when there's nothing to do; caller sleeps and retries.
 */
async function pickNext(): Promise<CandidateRow | null> {
  const now = new Date();
  // Resumable / retry-eligible rows first.
  const partials = await db
    .select({
      contract: collectionTraits.contract,
      status: collectionTraits.status,
      lastEnumeratedTokenId: collectionTraits.lastEnumeratedTokenId,
      manifest: collectionTraits.manifest,
      storedTotalSupply: collectionTraits.totalSupply,
      attemptCount: collectionTraits.attemptCount,
      collectionTotalSupply: collections.totalSupply,
      tokenUriTemplate: collections.tokenUriTemplate,
      is1155: collections.is1155,
    })
    .from(collectionTraits)
    .innerJoin(collections, eq(collections.address, collectionTraits.contract))
    .where(
      and(
        // Anything except a happily-finished row is eligible to be picked
        // up again — partial resumes, pending kicks off, failed retries
        // when its backoff window elapses.
        or(
          eq(collectionTraits.status, "pending"),
          eq(collectionTraits.status, "partial"),
          eq(collectionTraits.status, "failed"),
        )!,
        or(
          isNull(collectionTraits.nextAttemptAt),
          lte(collectionTraits.nextAttemptAt, now),
        )!,
        eq(collections.metadataBroken, false),
      )!,
    )
    .orderBy(asc(collectionTraits.updatedAt))
    .limit(1);

  if (partials.length > 0) {
    const r = partials[0]!;
    return {
      contract: r.contract,
      totalSupply: r.collectionTotalSupply,
      tokenUriTemplate: r.tokenUriTemplate,
      is1155: r.is1155,
      status: r.status,
      lastEnumeratedTokenId: r.lastEnumeratedTokenId,
      storedManifest: r.manifest as SerializedManifest | null,
      storedTotalSupply: r.storedTotalSupply,
      attemptCount: r.attemptCount,
    };
  }

  // Fresh row — collection has been enriched but no collection_traits
  // entry yet.
  const fresh = await db
    .select({
      contract: collections.address,
      totalSupply: collections.totalSupply,
      tokenUriTemplate: collections.tokenUriTemplate,
      is1155: collections.is1155,
    })
    .from(collections)
    .leftJoin(collectionTraits, eq(collectionTraits.contract, collections.address))
    .where(
      and(
        isNull(collectionTraits.contract),
        eq(collections.metadataChecked, true),
        eq(collections.metadataBroken, false),
        // Only enumerate collections eligible for browsing
        gt(collections.tier, 0),
      )!,
    )
    .limit(1);

  if (fresh.length === 0) return null;
  const r = fresh[0]!;
  return {
    contract: r.contract,
    totalSupply: r.totalSupply,
    tokenUriTemplate: r.tokenUriTemplate,
    is1155: r.is1155,
    status: null,
    lastEnumeratedTokenId: null,
    storedManifest: null,
    storedTotalSupply: null,
    attemptCount: 0,
  };
}

/**
 * Resolve a token's metadata URI. For collections whose
 * `tokenUriTemplate` has `{id}` (or is templatizable from "1"), we
 * expand client-side. Otherwise we fall through to a per-token
 * multicall — but that path is rare in practice and the worker handles
 * it one collection at a time, so a few extra multicalls aren't going
 * to break the RPC pool.
 */
function expandTemplateOrNull(template: string, tokenId: bigint): string | null {
  if (template.includes("{id}")) return expandIdTemplate(template, tokenId);
  // Try to derive a template from a "1"-based reference URI.
  const built = buildTemplateFromReference(template, 1n);
  if (!built) return null;
  return expandIdTemplate(built, tokenId);
}

/**
 * Same boundary-safe substitution as the frontend `buildUriTemplate`.
 * Walks the URI from right to left for an occurrence of the reference
 * tokenId where both surrounding characters are non-alphanumeric (so
 * we don't rewrite a "1" inside a CID or timestamp).
 */
function buildTemplateFromReference(uri: string, refId: bigint): string | null {
  if (!uri) return null;
  const refDec = refId.toString();
  const refHex = refId.toString(16);
  const refHexPad = refHex.padStart(64, "0");
  const candidates = [refHexPad, refDec, ...(refHex !== refDec ? [refHex] : [])];
  const isBoundary = (ch: string | undefined) =>
    ch == null || !/[A-Za-z0-9]/.test(ch);
  for (const refStr of candidates) {
    let searchFrom = uri.length;
    while (true) {
      const idx = uri.lastIndexOf(refStr, searchFrom - 1);
      if (idx === -1) break;
      const before = uri[idx - 1];
      const after = uri[idx + refStr.length];
      if (isBoundary(before) && isBoundary(after)) {
        return uri.slice(0, idx) + "{id}" + uri.slice(idx + refStr.length);
      }
      searchFrom = idx;
    }
  }
  return null;
}

/**
 * Fetch metadata for a single tokenId and return its attributes. Null
 * on failure (404, host down, JSON parse error). The throttle gates
 * the actual network call so caller can launch as many in-flight
 * promises as it likes.
 */
async function fetchTokenAttributes(
  tokenUri: string,
  tokenId: bigint,
): Promise<{ ok: true; attributes: ReturnType<typeof normalizeAttributes> } | { ok: false }> {
  const concrete = expandIdTemplate(tokenUri, tokenId);
  if (!concrete) return { ok: false };
  const host = hostKey(concrete);
  return throttle.run(host, async () => {
    const json = await fetchMetadataJson(concrete);
    if (!json || typeof json !== "object") return { ok: false } as const;
    const j = json as { attributes?: unknown };
    return { ok: true, attributes: normalizeAttributes(j.attributes) } as const;
  });
}

/**
 * Multicall `tokenURI(id)` (or `uri(id)` for ERC-1155) for a batch of
 * tokenIds. Used as the fallback when no `{id}`-templatable URI can be
 * derived from the indexer's stored sample — covers:
 *
 *   - On-chain `data:application/json` URIs that bake unique attributes
 *     per token (Monad Mogs, NFTs2Me, etc.)
 *   - Per-token content-addressed CIDs (each token has its own pin)
 *   - Off-chain APIs that don't follow a numeric `/N.json` pattern
 *
 * Returns a Map with `null` for tokens whose tokenURI call reverted. We
 * tolerate per-token failures so a single missing token doesn't kill
 * the batch.
 */
async function multicallTokenURIs(
  client: PublicClient,
  contract: string,
  is1155: boolean,
  tokenIds: bigint[],
): Promise<Map<string, string | null>> {
  const fnName = is1155 ? ("uri" as const) : ("tokenURI" as const);
  const out = new Map<string, string | null>();
  // 50 calls per multicall batch — matches Monad's per-eth_call gas
  // budget per the existing rpcPool config. Larger batches occasionally
  // hit the cap.
  const BATCH = 50;
  for (let i = 0; i < tokenIds.length; i += BATCH) {
    const batch = tokenIds.slice(i, i + BATCH);
    const contracts = batch.map((id) => ({
      address: contract as `0x${string}`,
      abi: ABI,
      functionName: fnName,
      args: [id] as const,
    }));
    try {
      const results = await client.multicall({
        contracts,
        multicallAddress: MULTICALL3_ADDRESS,
        allowFailure: true,
      });
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        const idStr = batch[j]!.toString();
        if (r?.status === "success" && typeof r.result === "string" && r.result.length > 0) {
          out.set(idStr, r.result);
        } else {
          out.set(idStr, null);
        }
      }
    } catch {
      // Entire batch failed — record nulls and move on. The per-token
      // failure budget in the outer enumeration will bail us cleanly
      // if everything in this batch comes back null.
      for (const id of batch) out.set(id.toString(), null);
    }
  }
  return out;
}

/** Per-collection terminal outcome — used by the worker loop to log
 *  meaningfully instead of always saying "done". `retryMinutes` is set
 *  on failed / partial outcomes to surface backoff timing in the log. */
type EnumerationOutcome =
  | { status: "complete"; tokens: number }
  | { status: "all_identical"; tokens: number }
  | { status: "failed"; reason: string; retryMinutes?: number }
  | { status: "partial"; tokens: number; reason: string; retryMinutes?: number };

async function enumerateCollection(
  client: PublicClient,
  row: CandidateRow,
): Promise<EnumerationOutcome> {
  const contract = row.contract;
  // Hard pre-conditions.
  const supplyNum = row.totalSupply ? Number(row.totalSupply) : 0;
  if (!supplyNum || supplyNum <= 0 || supplyNum > 1_000_000) {
    const reason = `invalid totalSupply: ${row.totalSupply}`;
    const retryMinutes = await markFailed(contract, row, reason);
    return { status: "failed", reason, retryMinutes };
  }
  if (!row.tokenUriTemplate) {
    const reason = "no tokenUriTemplate";
    const retryMinutes = await markFailed(contract, row, reason);
    return { status: "failed", reason, retryMinutes };
  }

  // Two URI-resolution modes:
  //   (A) Template path — derive a `{id}`-substitutable string from the
  //       stored sample URI and expand client-side. Free, no chain reads.
  //   (B) Multicall path — call tokenURI(id) for every token. Necessary
  //       for on-chain data: URIs (each token has unique embedded JSON),
  //       per-token content-addressed CIDs, and off-chain APIs that
  //       don't follow a numeric `/N.json` shape.
  //
  // We don't try to detect (B) heuristically; if (A) doesn't yield a
  // template, we just fall through to (B). The multicall path is slower
  // (~1 round-trip per 50 tokens) but covers the long tail.
  const template = row.tokenUriTemplate.includes("{id}")
    ? row.tokenUriTemplate
    : buildTemplateFromReference(row.tokenUriTemplate, 1n);

  const builder = ManifestBuilder.fromJson(row.storedManifest);
  // Resume point. tokenIdStart defaults to 1 unless the contract is
  // 0-indexed; we don't have a per-collection setting for that yet, so
  // try tokenId 0 ALSO when we're starting fresh and the first ID
  // succeeds. Cheap optimization vs. silently skipping a token.
  const startedFrom = row.lastEnumeratedTokenId
    ? BigInt(row.lastEnumeratedTokenId) + 1n
    : 1n;
  const end = BigInt(supplyNum); // exclusive upper bound when start is 1
  // Special-case: if we're starting fresh, also try id 0 alongside the
  // 1..N range so 0-indexed collections aren't off by one.
  const ids: bigint[] = [];
  if (startedFrom === 1n) ids.push(0n);
  for (let id = startedFrom; id <= end; id++) ids.push(id);

  // Filter out tokens already in the manifest (survived a prior run's
  // partial persist + crash before the checkpoint).
  const todo = ids.filter((id) => !builder.has(id.toString()));
  if (todo.length === 0) {
    await markComplete(contract, row, builder, supplyNum);
    return {
      status: builder.isMostlyIdentical() ? "all_identical" : "complete",
      tokens: builder.size(),
    };
  }

  // Resolve URIs for every todo token up front. For the template path
  // this is just string substitution. For the multicall path we batch
  // chain reads in chunks of 50 — slower but works for any contract.
  let uriByTokenId: Map<string, string | null>;
  if (template) {
    uriByTokenId = new Map();
    for (const id of todo) {
      uriByTokenId.set(id.toString(), expandIdTemplate(template, id));
    }
  } else {
    console.log(`[traits] ${contract}: no URI template — multicalling tokenURI for ${todo.length} tokens`);
    uriByTokenId = await multicallTokenURIs(client, contract, row.is1155, todo);
  }

  let consecutiveFailures = 0;
  let lastChunkCheckpointId: bigint | null = row.lastEnumeratedTokenId
    ? BigInt(row.lastEnumeratedTokenId)
    : null;

  // Worker pool. Each worker pulls the next tokenId, fetches, merges.
  let cursor = 0;
  const failed = new Set<string>();
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const id = todo[i]!;
      const url = uriByTokenId.get(id.toString());
      if (!url) {
        // tokenURI reverted OR template expansion failed for this id.
        failed.add(id.toString());
        consecutiveFailures++;
        if (consecutiveFailures >= PER_COLLECTION_CONSECUTIVE_FAIL_BUDGET) {
          cursor = todo.length;
          return;
        }
        continue;
      }
      const result = await fetchTokenAttributes(url, id);
      if (result.ok) {
        builder.addToken(id.toString(), result.attributes);
        consecutiveFailures = 0;
      } else {
        failed.add(id.toString());
        consecutiveFailures++;
        if (consecutiveFailures >= PER_COLLECTION_CONSECUTIVE_FAIL_BUDGET) {
          cursor = todo.length;
          return;
        }
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(FETCH_CONCURRENCY_PER_COLLECTION, todo.length) },
    () => worker(),
  );

  // Periodic checkpointer. Runs alongside the workers and persists the
  // current builder state every CHECKPOINT_EVERY tokens (measured by
  // builder.size() growth).
  const startSize = builder.size();
  const checkpointer = (async () => {
    let lastSize = startSize;
    while (cursor < todo.length) {
      await sleep(2_000);
      const size = builder.size();
      if (size - lastSize >= CHECKPOINT_EVERY) {
        lastChunkCheckpointId = highestIdInBuilder(builder, lastChunkCheckpointId);
        await persistPartial(contract, row, builder, supplyNum, lastChunkCheckpointId);
        lastSize = size;
      }
    }
  })();

  await Promise.all(workers);
  await checkpointer.catch(() => {});

  // Final persist.
  if (consecutiveFailures >= PER_COLLECTION_CONSECUTIVE_FAIL_BUDGET) {
    lastChunkCheckpointId = highestIdInBuilder(builder, lastChunkCheckpointId);
    const retryMinutes = await markFailedWithProgress(
      contract,
      row,
      builder,
      supplyNum,
      lastChunkCheckpointId,
    );
    return {
      status: "partial",
      tokens: builder.size(),
      reason: `host failures (${failed.size}/${todo.length})`,
      retryMinutes,
    };
  }

  // Decide terminal state.
  if (builder.size() === 0) {
    const reason = "no tokens fetched successfully";
    const retryMinutes = await markFailed(contract, row, reason);
    return { status: "failed", reason, retryMinutes };
  }
  await markComplete(contract, row, builder, supplyNum);
  return {
    status: builder.isMostlyIdentical() ? "all_identical" : "complete",
    tokens: builder.size(),
  };
}

function highestIdInBuilder(
  builder: ManifestBuilder,
  prior: bigint | null,
): bigint {
  let max = prior ?? 0n;
  // Slightly expensive (iterates all tokens) but called only on
  // checkpoint, not per token. For 10K tokens this is microseconds.
  // We use the serialized form to avoid leaking builder internals.
  const snapshot = builder.toJson();
  for (const t of snapshot.traits) {
    let n: bigint;
    try {
      n = BigInt(t.id);
    } catch {
      continue;
    }
    if (n > max) max = n;
  }
  return max;
}

async function persistPartial(
  contract: string,
  row: CandidateRow,
  builder: ManifestBuilder,
  supply: number,
  lastEnumeratedTokenId: bigint,
): Promise<void> {
  const snapshot = builder.toJson();
  await upsertTraits({
    contract,
    status: "partial",
    totalSupply: supply.toString(),
    tokenCount: builder.size(),
    manifest: snapshot,
    sampledTokenURIs:
      // Keep prior samples if present; we'll populate proper samples
      // when the collection reaches complete state.
      row.storedManifest
        ? null
        : sampledFromManifest(snapshot, contract, row.tokenUriTemplate ?? ""),
    lastEnumeratedTokenId: lastEnumeratedTokenId.toString(),
    attemptCount: 0,
    nextAttemptAt: null,
    enumeratedAt: null,
  });
}

function sampledFromManifest(
  snapshot: { traits: Array<{ id: string }> },
  _contract: string,
  template: string,
): Array<{ tokenId: string; uri: string }> | null {
  if (!template) return null;
  const take = snapshot.traits.slice(0, 5);
  return take.map((t) => {
    let bn: bigint;
    try {
      bn = BigInt(t.id);
    } catch {
      bn = 1n;
    }
    return { tokenId: t.id, uri: expandIdTemplate(template, bn) };
  });
}

async function markComplete(
  contract: string,
  row: CandidateRow,
  builder: ManifestBuilder,
  supply: number,
): Promise<void> {
  const snapshot = builder.toJson();
  const status = builder.isMostlyIdentical() ? "all_identical" : "complete";
  await upsertTraits({
    contract,
    status,
    totalSupply: supply.toString(),
    tokenCount: builder.size(),
    manifest: snapshot,
    sampledTokenURIs: sampledFromManifest(snapshot, contract, row.tokenUriTemplate ?? ""),
    lastEnumeratedTokenId: supply.toString(),
    attemptCount: 0,
    nextAttemptAt: null,
    enumeratedAt: new Date(),
  });
}

async function markFailed(
  contract: string,
  row: CandidateRow,
  _reason: string,
): Promise<number> {
  const attempts = (row.attemptCount ?? 0) + 1;
  const wait = backoffMs(attempts);
  await upsertTraits({
    contract,
    status: "failed",
    totalSupply: row.totalSupply,
    tokenCount: 0,
    manifest: row.storedManifest,
    sampledTokenURIs: null,
    lastEnumeratedTokenId: row.lastEnumeratedTokenId,
    attemptCount: attempts,
    nextAttemptAt: new Date(Date.now() + wait),
    enumeratedAt: null,
  });
  return Math.round(wait / 60_000);
}

async function markFailedWithProgress(
  contract: string,
  row: CandidateRow,
  builder: ManifestBuilder,
  supply: number,
  lastEnumeratedTokenId: bigint,
): Promise<number> {
  const attempts = (row.attemptCount ?? 0) + 1;
  const wait = backoffMs(attempts);
  const snapshot = builder.toJson();
  await upsertTraits({
    contract,
    status: "failed",
    totalSupply: supply.toString(),
    tokenCount: builder.size(),
    manifest: snapshot,
    sampledTokenURIs: sampledFromManifest(snapshot, contract, row.tokenUriTemplate ?? ""),
    lastEnumeratedTokenId: lastEnumeratedTokenId.toString(),
    attemptCount: attempts,
    nextAttemptAt: new Date(Date.now() + wait),
    enumeratedAt: null,
  });
  return Math.round(wait / 60_000);
}

interface UpsertArgs {
  contract: string;
  status: string;
  totalSupply: string | null;
  tokenCount: number;
  manifest: SerializedManifest | null;
  sampledTokenURIs: Array<{ tokenId: string; uri: string }> | null;
  lastEnumeratedTokenId: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  enumeratedAt: Date | null;
}

async function upsertTraits(args: UpsertArgs): Promise<void> {
  await db
    .insert(collectionTraits)
    .values({
      contract: args.contract,
      status: args.status,
      totalSupply: args.totalSupply,
      tokenCount: args.tokenCount,
      manifest: args.manifest,
      sampledTokenURIs: args.sampledTokenURIs,
      lastEnumeratedTokenId: args.lastEnumeratedTokenId,
      attemptCount: args.attemptCount,
      nextAttemptAt: args.nextAttemptAt,
      enumeratedAt: args.enumeratedAt,
    })
    .onConflictDoUpdate({
      target: collectionTraits.contract,
      set: {
        status: args.status,
        totalSupply: args.totalSupply,
        tokenCount: args.tokenCount,
        manifest: args.manifest,
        sampledTokenURIs: args.sampledTokenURIs,
        lastEnumeratedTokenId: args.lastEnumeratedTokenId,
        attemptCount: args.attemptCount,
        nextAttemptAt: args.nextAttemptAt,
        enumeratedAt: args.enumeratedAt,
        updatedAt: sql`now()`,
      },
    });
}

function backoffMs(attempt: number): number {
  const idx = Math.min(attempt - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[Math.max(0, idx)]! * 60_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startTraitWorker(): Promise<void> {
  console.log(
    `[traits] starting (global=${100}, per-host=${10}, fetch-concurrency-per-coll=${FETCH_CONCURRENCY_PER_COLLECTION}, checkpoint-every=${CHECKPOINT_EVERY})`,
  );
  const client = buildClient();

  let stop = false;
  const shutdown = () => {
    stop = true;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  let processed = 0;
  while (!stop) {
    let row: CandidateRow | null;
    try {
      row = await pickNext();
    } catch (err) {
      console.error(`[traits] pickNext failed: ${err instanceof Error ? err.message : err}`);
      await sleep(10_000);
      continue;
    }
    if (!row) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    const t0 = Date.now();
    try {
      // Ensure a row exists in collection_traits so the worker can be
      // observed mid-run (status='pending' is set immediately).
      if (row.status === null) {
        await upsertTraits({
          contract: row.contract,
          status: "pending",
          totalSupply: row.totalSupply,
          tokenCount: 0,
          manifest: null,
          sampledTokenURIs: null,
          lastEnumeratedTokenId: null,
          attemptCount: 0,
          nextAttemptAt: null,
          enumeratedAt: null,
        });
      }
      const outcome = await enumerateCollection(client, row);
      processed++;
      const elapsed = Date.now() - t0;
      const elapsedS = (elapsed / 1000).toFixed(1);
      switch (outcome.status) {
        case "complete":
          console.log(
            `[traits] ${row.contract}: complete (${outcome.tokens} tokens, ${elapsedS}s, processed ${processed} total)`,
          );
          break;
        case "all_identical":
          console.log(
            `[traits] ${row.contract}: all_identical (${outcome.tokens} tokens, ${elapsedS}s, processed ${processed} total)`,
          );
          break;
        case "partial": {
          const retry = outcome.retryMinutes != null ? `, retry in ${outcome.retryMinutes}min` : "";
          console.log(
            `[traits] ${row.contract}: partial (${outcome.tokens} tokens, ${outcome.reason}${retry}, ${elapsedS}s, processed ${processed} total)`,
          );
          break;
        }
        case "failed": {
          const retry = outcome.retryMinutes != null ? `, retry in ${outcome.retryMinutes}min` : "";
          console.log(
            `[traits] ${row.contract}: failed (${outcome.reason}${retry}, ${elapsedS}s, processed ${processed} total)`,
          );
          break;
        }
      }
    } catch (err) {
      console.error(
        `[traits] ${row.contract}: unexpected error: ${err instanceof Error ? err.message : err}`,
      );
      try {
        await markFailed(row.contract, row, `unexpected: ${err instanceof Error ? err.message : err}`);
      } catch {
        // swallow — next loop iteration will try again
      }
    }
  }
  console.log("[traits] stopped");
}
