/**
 * Build the Monad collections snapshot used by /explore for global search.
 *
 * Pipeline:
 *   1. Hypersync sweep — find every contract that ever emitted an ERC-721
 *      Transfer event (topic[3] present filters out ERC-20s).
 *   2. Multicall enrichment — `name()`, `symbol()`, `totalSupply()`, and
 *      ERC-165 interface flags for each candidate. We batch through
 *      Multicall3's `aggregate3` with `allowFailure: true` so broken
 *      contracts don't poison the batch.
 *   3. Filter — drop contracts where neither name nor symbol resolved
 *      (probably not real NFT collections), and contracts where the
 *      ERC-721 interface flag is false AND the contract isn't ERC-1155.
 *   4. Write `frontend/public/data/monad-collections.json`.
 *
 * Env vars:
 *   HYPERSYNC_TOKEN  required, free Envio token
 *   MONAD_RPC        optional, comma-separated RPC URLs (defaults shipped)
 *   MAX_BLOCKS       optional, cap on how far back to scan (debug only)
 *   ENRICH_LIMIT     optional, cap on how many contracts to enrich (debug)
 *
 * Run:
 *   cd scripts && npm install
 *   HYPERSYNC_TOKEN=… node build-collections-index.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── config ────────────────────────────────────────────────────────
const HYPERSYNC_TOKEN = process.env.HYPERSYNC_TOKEN;
if (!HYPERSYNC_TOKEN) {
  console.error("HYPERSYNC_TOKEN env var is required.");
  console.error("Get one at https://app.envio.dev/api-tokens");
  process.exit(1);
}

const HYPERSYNC_URL = "https://monad.hypersync.xyz";
const CHAIN_ID = 143;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const DEFAULT_RPCS = [
  "https://rpc-mainnet.monadinfra.com",
  "https://rpc3.monad.xyz",
  "https://rpc4.monad.xyz",
];
const RPC_URLS = (process.env.MONAD_RPC || DEFAULT_RPCS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_BLOCKS = process.env.MAX_BLOCKS ? Number(process.env.MAX_BLOCKS) : Infinity;
const ENRICH_LIMIT = process.env.ENRICH_LIMIT ? Number(process.env.ENRICH_LIMIT) : Infinity;
const FORCE_FULL_RESCAN = process.env.FORCE_FULL_RESCAN === "1";

const SNAPSHOT_PATH = path.join(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "frontend",
  "public",
  "data",
  "monad-collections.json",
);

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC1155_INTERFACE_ID = "0xd9b67a26";

// Multicall batch size — Monad RPCs cap eth_call gas tighter than mainnet.
// 80 calls per multicall × 5 calls per contract = 16 contracts per batch.
// Tunable; raise on better RPCs.
const MULTICALL_BATCH = 80;
const CALLS_PER_CONTRACT = 5;
const CONTRACTS_PER_BATCH = Math.floor(MULTICALL_BATCH / CALLS_PER_CONTRACT);

// ── viem client (rotates across RPC pool on failure) ──────────────
let rpcIdx = 0;
function nextClient() {
  const url = RPC_URLS[rpcIdx++ % RPC_URLS.length];
  return createPublicClient({
    chain: defineChain({
      id: CHAIN_ID,
      name: "Monad",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    }),
    transport: http(url, { timeout: 30_000 }),
  });
}

// ── ABIs ──────────────────────────────────────────────────────────
const ABI = [
  { name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  {
    name: "supportsInterface",
    inputs: [{ type: "bytes4", name: "interfaceId" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
];

// ── 1. Hypersync sweep ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to Hypersync with automatic retry on 429 + 5xx. Honors Retry-After
 * header when set; otherwise uses exponential backoff capped at 30s. After
 * MAX_RETRIES exhausted the original error propagates.
 */
const MAX_RETRIES = 8;
async function hypersync(body) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch(`${HYPERSYNC_URL}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HYPERSYNC_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) return resp.json();

    const text = await resp.text().catch(() => "");
    const retriable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
    if (!retriable) {
      throw new Error(`Hypersync ${resp.status}: ${text.slice(0, 200)}`);
    }

    // Backoff: honor Retry-After if present, else exponential
    const retryAfter = resp.headers.get("retry-after");
    const fromHeader = retryAfter ? Number(retryAfter) : NaN;
    const waitSec = Number.isFinite(fromHeader)
      ? Math.max(1, fromHeader)
      : Math.min(30, 2 ** attempt);
    console.log(
      `  Hypersync ${resp.status} — waiting ${waitSec}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(waitSec * 1000);
    lastErr = new Error(`Hypersync ${resp.status}: ${text.slice(0, 200)}`);
  }
  throw lastErr ?? new Error("Hypersync exhausted retries");
}

function loadPreviousSnapshot() {
  if (FORCE_FULL_RESCAN) {
    console.log("FORCE_FULL_RESCAN set — ignoring previous snapshot");
    return null;
  }
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    if (typeof parsed.lastBlock !== "number" || !Array.isArray(parsed.collections)) {
      console.warn("Previous snapshot is malformed; ignoring");
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`Could not parse previous snapshot: ${err.message}`);
    return null;
  }
}

/**
 * Aggregated per-contract stats accumulated during the Hypersync sweep.
 * These are essentially free to compute — we already iterate every log.
 */
function makeStatsBucket() {
  return {
    transferCount: 0,
    holders: new Set(), // distinct lowercased `to` addresses
    firstBlock: Infinity,
    lowestTokenId: null, // first tokenId we see for this contract
  };
}

async function discoverErc721Contracts(startBlock = 0, knownAddresses = new Set()) {
  console.log(
    `Hypersync: scanning Transfer events from block ${startBlock}` +
      (knownAddresses.size > 0
        ? ` (${knownAddresses.size} contracts already known)`
        : ""),
  );
  // Per-contract running stats, keyed by lowercased address.
  const stats = new Map();
  let cursor = startBlock;
  let target = 0;
  let queries = 0;
  const startTime = Date.now();

  while (true) {
    const result = await hypersync({
      from_block: cursor,
      // ERC-721 Transfer has 4 indexed topics (signature, from, to, tokenId).
      // ERC-20 Transfer has only 3. By requiring topic[3] we filter to ERC-721.
      logs: [
        {
          topics: [
            [TRANSFER_TOPIC],
            [],
            [],
            [],
          ],
        },
      ],
      field_selection: { log: ["address", "topic2", "topic3", "block_number"] },
    });

    target = result.archive_height;
    for (const batch of result.data || []) {
      for (const log of batch.logs || []) {
        // topic3 presence confirms ERC-721 (not ERC-20)
        if (!log.topic3 || !log.address) continue;
        const addr = log.address.toLowerCase();
        // Skip ones we already enriched in a prior run — we still tally
        // delta stats for known contracts so their numbers stay fresh.
        let bucket = stats.get(addr);
        if (!bucket) {
          bucket = makeStatsBucket();
          stats.set(addr, bucket);
        }
        bucket.transferCount++;
        // topic2 = `to` (indexed). Padded hex string.
        if (log.topic2) bucket.holders.add(log.topic2.toLowerCase());
        // topic3 = tokenId. Track the lowest we've seen.
        const tid = BigInt(log.topic3);
        if (bucket.lowestTokenId == null || tid < bucket.lowestTokenId) {
          bucket.lowestTokenId = tid;
        }
        if (log.block_number != null && log.block_number < bucket.firstBlock) {
          bucket.firstBlock = log.block_number;
        }
      }
    }

    cursor = result.next_block;
    queries++;

    if (queries % 5 === 0 || cursor >= target) {
      const pct = target > 0 ? Math.round((cursor / target) * 100) : 0;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `  ${cursor}/${target} blocks (${pct}%), ${stats.size} contracts, ${elapsed}s elapsed`,
      );
    }

    if (cursor >= target) break;
    if (cursor >= MAX_BLOCKS) {
      console.log(`  Stopping early at MAX_BLOCKS=${MAX_BLOCKS}`);
      break;
    }

    // Stay polite under Envio's per-token rate limit — at ~5 req/s we never
    // hit a 429 in practice. Retry logic above covers bursts anyway.
    await sleep(200);
  }

  // Materialise stats into plain objects keyed by address. Holders Set is
  // dropped — we only care about its size.
  const statsByAddress = {};
  for (const [addr, bucket] of stats.entries()) {
    statsByAddress[addr] = {
      transferCount: bucket.transferCount,
      uniqueHolders: bucket.holders.size,
      firstTransferBlock: bucket.firstBlock === Infinity ? 0 : bucket.firstBlock,
      lowestTokenId: bucket.lowestTokenId != null ? bucket.lowestTokenId.toString() : null,
    };
  }

  // The list of *newly seen* contracts (for enrichment) is everything we
  // saw that wasn't in the known set.
  const newContracts = [];
  for (const addr of stats.keys()) {
    if (!knownAddresses.has(addr)) newContracts.push(addr);
  }

  console.log(
    `Hypersync done: ${stats.size} contracts total (${newContracts.length} new), ${queries} queries`,
  );
  return { contracts: newContracts, statsByAddress, lastBlock: cursor };
}

// ── 2. Multicall enrichment ───────────────────────────────────────
/**
 * For each contract: name, symbol, totalSupply, supportsInterface(ERC-721),
 * supportsInterface(ERC-1155). Failures don't stop the batch — broken
 * contracts just get null fields.
 */
async function enrichBatch(client, addresses) {
  const calls = [];
  for (const addr of addresses) {
    calls.push(
      { address: addr, abi: ABI, functionName: "name" },
      { address: addr, abi: ABI, functionName: "symbol" },
      { address: addr, abi: ABI, functionName: "totalSupply" },
      {
        address: addr,
        abi: ABI,
        functionName: "supportsInterface",
        args: [ERC721_INTERFACE_ID],
      },
      {
        address: addr,
        abi: ABI,
        functionName: "supportsInterface",
        args: [ERC1155_INTERFACE_ID],
      },
    );
  }

  const results = await client.multicall({
    contracts: calls,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  });

  const enriched = [];
  for (let i = 0; i < addresses.length; i++) {
    const base = i * CALLS_PER_CONTRACT;
    const nameRes = results[base];
    const symbolRes = results[base + 1];
    const tsRes = results[base + 2];
    const is721Res = results[base + 3];
    const is1155Res = results[base + 4];

    const name = nameRes.status === "success" ? String(nameRes.result || "") : null;
    const symbol = symbolRes.status === "success" ? String(symbolRes.result || "") : null;
    const totalSupply =
      tsRes.status === "success" && typeof tsRes.result === "bigint"
        ? tsRes.result.toString()
        : null;
    const is721 = is721Res.status === "success" ? !!is721Res.result : false;
    const is1155 = is1155Res.status === "success" ? !!is1155Res.result : false;

    enriched.push({
      address: addresses[i],
      name,
      symbol,
      totalSupply,
      is721,
      is1155,
    });
  }
  return enriched;
}

async function enrichAll(addresses) {
  const limited = addresses.slice(0, ENRICH_LIMIT);
  console.log(`Enriching ${limited.length} contracts (multicall, ${CONTRACTS_PER_BATCH}/batch)...`);
  const enriched = [];
  const startTime = Date.now();

  for (let i = 0; i < limited.length; i += CONTRACTS_PER_BATCH) {
    const batch = limited.slice(i, i + CONTRACTS_PER_BATCH);
    let lastErr = null;
    for (let attempt = 0; attempt < RPC_URLS.length; attempt++) {
      const client = nextClient();
      try {
        const result = await enrichBatch(client, batch);
        enriched.push(...result);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // try next RPC
      }
    }
    if (lastErr) {
      console.warn(`  batch ${i}..${i + batch.length} failed: ${lastErr.message}`);
      // Push placeholder rows so the address still exists in the snapshot.
      for (const addr of batch) {
        enriched.push({ address: addr, name: null, symbol: null, totalSupply: null, is721: false, is1155: false });
      }
    }

    if (((i / CONTRACTS_PER_BATCH) | 0) % 25 === 0 || i + CONTRACTS_PER_BATCH >= limited.length) {
      const pct = Math.round((Math.min(i + CONTRACTS_PER_BATCH, limited.length) / limited.length) * 100);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  ${enriched.length}/${limited.length} (${pct}%), ${elapsed}s elapsed`);
    }
  }

  return enriched;
}

// ── 3. Filter ─────────────────────────────────────────────────────
function filterRealCollections(enriched) {
  // Drop:
  //   - contracts with neither name nor symbol (probably broken/proxy garbage)
  //   - contracts where both interface flags are false AND no name (high
  //     confidence not an NFT collection)
  const filtered = enriched.filter((c) => {
    const hasName = c.name && c.name.length > 0;
    const hasSymbol = c.symbol && c.symbol.length > 0;
    const looksLikeNft = c.is721 || c.is1155 || hasName;
    return looksLikeNft && (hasName || hasSymbol);
  });
  console.log(`Filter: ${filtered.length}/${enriched.length} look like real NFT collections`);
  return filtered;
}

// ── 4. Write JSON ─────────────────────────────────────────────────
async function main() {
  console.log(`Building Monad collections snapshot (chainId=${CHAIN_ID})...`);
  console.log(`  Hypersync: ${HYPERSYNC_URL}`);
  console.log(`  RPCs: ${RPC_URLS.length} (${RPC_URLS[0]}, …)`);

  // ── Checkpoint: resume from previous snapshot if present ─────────
  // Transfer events are immutable on-chain, so any block we've already
  // scanned never needs to be re-scanned. We carry forward the previous
  // snapshot's enriched collections and only enrich newly-discovered
  // contracts in the delta range.
  const previous = loadPreviousSnapshot();
  const startBlock = previous ? previous.lastBlock + 1 : 0;
  const previousCollections = previous?.collections ?? [];
  const knownAddresses = new Set(previousCollections.map((c) => c.address.toLowerCase()));

  if (previous) {
    console.log(
      `Resuming from block ${startBlock} (previous snapshot: ${previousCollections.length} collections, built ${new Date(previous.builtAt).toISOString()})`,
    );
  }

  const { contracts, statsByAddress, lastBlock } = await discoverErc721Contracts(
    startBlock,
    knownAddresses,
  );

  // Skip enrichment entirely if no new contracts found.
  let newEnriched = [];
  let newFiltered = [];
  if (contracts.length > 0) {
    newEnriched = await enrichAll(contracts);
    newFiltered = filterRealCollections(newEnriched);
  } else {
    console.log("No new contracts to enrich — only the block cursor advanced.");
  }

  // Attach stats to every collection (both previously-known and newly-found).
  // Stats from a delta scan are *additive* — they only cover the new block
  // range. Previous-snapshot stats get summed with the delta's contribution
  // so the cumulative numbers stay accurate.
  const mergeStats = (existing, delta) => {
    if (!delta) return existing;
    return {
      transferCount: (existing?.transferCount ?? 0) + delta.transferCount,
      uniqueHolders: Math.max(existing?.uniqueHolders ?? 0, delta.uniqueHolders),
      firstTransferBlock:
        existing?.firstTransferBlock && existing.firstTransferBlock > 0
          ? Math.min(existing.firstTransferBlock, delta.firstTransferBlock || existing.firstTransferBlock)
          : delta.firstTransferBlock,
      lowestTokenId:
        existing?.lowestTokenId != null && delta.lowestTokenId != null
          ? BigInt(existing.lowestTokenId) < BigInt(delta.lowestTokenId)
            ? existing.lowestTokenId
            : delta.lowestTokenId
          : existing?.lowestTokenId ?? delta.lowestTokenId,
    };
  };

  // Apply stats to both tiers.
  const attachStats = (col) => {
    const delta = statsByAddress[col.address.toLowerCase()];
    const existing = {
      transferCount: col.transferCount,
      uniqueHolders: col.uniqueHolders,
      firstTransferBlock: col.firstTransferBlock,
      lowestTokenId: col.lowestTokenId,
    };
    return { ...col, ...mergeStats(existing, delta) };
  };

  const previousWithStats = previousCollections.map(attachStats);
  const newWithStats = newFiltered.map((col) => ({
    ...col,
    ...(statsByAddress[col.address.toLowerCase()] ?? {
      transferCount: 0,
      uniqueHolders: 0,
      firstTransferBlock: 0,
      lowestTokenId: null,
    }),
  }));

  const merged = [...previousWithStats, ...newWithStats];

  const snapshot = {
    chainId: CHAIN_ID,
    lastBlock,
    builtAt: Date.now(),
    schemaVersion: 2,
    collections: merged,
  };

  mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));
  const sizeKb = (JSON.stringify(snapshot).length / 1024).toFixed(0);
  console.log(
    `Wrote ${SNAPSHOT_PATH} (${sizeKb} KB, ${merged.length} total collections, +${newFiltered.length} new this run)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
