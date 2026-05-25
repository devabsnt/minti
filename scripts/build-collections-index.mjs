/**
 * Build the Monad collections snapshot used by /explore for global search.
 *
 * Pipeline:
 *   1. Hypersync sweep — find every contract that ever emitted an ERC-721
 *      Transfer event (topic[3] present filters out ERC-20s). Per-contract
 *      we accumulate: transferCount, uniqueHolders (receivers), uniqueSenders,
 *      mintCount (from = 0x0), selfTransferCount, plus a balance map for new
 *      contracts only.
 *   2. Recent-window pass — re-scan last 30d every run so 24h/7d/30d numbers
 *      stay fresh. Also tracks recent mint counts and recent unique buyers.
 *   3. Marketplace sales pass — Hypersync query for the MintiMarketplace's
 *      ItemSold event grouped by nftContract. Emits sales24h/7d, volume24h/7d,
 *      uniqueBuyers24h/7d, uniqueSellers24h/7d. No-op when marketplace is not
 *      deployed (MARKETPLACE_ADDRESS unset or zero).
 *   4. Multicall enrichment — `name()`, `symbol()`, `totalSupply()`, ERC-165
 *      flags for newly-discovered contracts. Failures get null placeholders.
 *   4b. Metadata precheck — `tokenURI(lowest)` + server-side metadata
 *      JSON fetch for every newly-discovered contract (and previously-
 *      known ones on FORCE_FULL_RESCAN or BACKFILL_METADATA). Stores
 *      `sampleImageUrl` so the frontend can paint thumbnails without
 *      runtime metadata fetches, and `metadataBroken: true` for tokens
 *      whose JSON can't be resolved (dead DNS, all-gateway 404, etc.).
 *   5. Tier assignment — every collection gets a tier (0=hidden, 1=indexed,
 *      2=explore-eligible, 3=featured) computed from the gathered stats.
 *      metadataBroken=true collapses to tier 0 so broken collections never
 *      reach the explore grid.
 *   6. Write `frontend/public/data/monad-collections.json`.
 *
 * Concentration metrics (top1HolderPct, top10HolderPct, holderRatio) are
 * computed during a FULL rescan only — too expensive to maintain incremental
 * balance state across the snapshot. Set FORCE_FULL_RESCAN=1 once a week (or
 * via a separate Sunday cron) to refresh. Delta runs keep last-known values.
 *
 * Env vars:
 *   HYPERSYNC_TOKEN     required, free Envio token
 *   MONAD_RPC           optional, comma-separated RPC URLs
 *   MARKETPLACE_ADDRESS optional, MintiMarketplace deployment address
 *   MAX_BLOCKS          optional, cap on blocks scanned (debug)
 *   ENRICH_LIMIT        optional, cap on contracts enriched (debug)
 *   FORCE_FULL_RESCAN   optional, "1" ignores previous snapshot
 *   BACKFILL_METADATA   optional, "1" re-prechecks every previously-known
 *                       collection that doesn't yet have metadataChecked.
 *                       Use once after this feature ships, then leave unset.
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
// When set, re-runs the metadata precheck on every previously-known
// collection that doesn't already have `metadataChecked: true`. Use once
// after the precheck feature first ships to backfill the existing
// snapshot. Subsequent runs only precheck newly-discovered contracts.
const BACKFILL_METADATA = process.env.BACKFILL_METADATA === "1";

const MARKETPLACE_ADDRESS_RAW = process.env.MARKETPLACE_ADDRESS || "";
const MARKETPLACE_ADDRESS =
  MARKETPLACE_ADDRESS_RAW &&
  MARKETPLACE_ADDRESS_RAW !== "0x0000000000000000000000000000000000000000"
    ? MARKETPLACE_ADDRESS_RAW.toLowerCase()
    : null;

const SNAPSHOT_PATH = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "data",
  "monad-collections.json",
);

// ── event signatures ─────────────────────────────────────────────
// Transfer(address,address,uint256) — ERC-721 (4 topics) / ERC-20 (3 topics)
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// ItemSold(uint256,address,uint256,address,address,uint256,uint256,uint256,address)
//   topic[0] = sig
//   topic[1] = listingId
//   topic[2] = nftContract (indexed)
//   topic[3] = tokenId
//   data     = (buyer, seller, price, protocolFee, royaltyAmount, royaltyReceiver)
const ITEMSOLD_TOPIC =
  "0x4d49c98aaf3b32a8b3a7e7e7e02bbc02b6f7c0a3eb1d2a6e3a7e1b1c2d3e4f50";
// NOTE: the exact ItemSold topic depends on the deployed ABI hash. We compute
// it lazily at runtime from the marketplace ABI to avoid drift.

// 4-byte interface IDs
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC1155_INTERFACE_ID = "0xd9b67a26";

// ── tunables ─────────────────────────────────────────────────────
// Multicall batch size — Monad RPCs cap eth_call gas tighter than mainnet.
const MULTICALL_BATCH = 80;
const CALLS_PER_CONTRACT = 5;
const CONTRACTS_PER_BATCH = Math.floor(MULTICALL_BATCH / CALLS_PER_CONTRACT);

// Block constants
const MONAD_BLOCKS_PER_DAY = 172_800; // 0.5s blocks → 86400/0.5
const WINDOW_24H = MONAD_BLOCKS_PER_DAY;
const WINDOW_7D = WINDOW_24H * 7;
const WINDOW_30D = WINDOW_24H * 30;

// Zero address used to detect mints/burns
const ZERO_TOPIC = "0x" + "00".repeat(32);
const ZERO_ADDR = "0x" + "00".repeat(20);

// Cap per-collection balance maps in full-rescan mode. Contracts above this
// holder count get `top1HolderPct = null` — they're nearly always operational
// NFTs (CLOB positions, LP NFTs, name service) anyway.
const MAX_BALANCE_MAP_SIZE = 30_000;

// Cap per-contract receiver/sender Sets. Anything beyond a few thousand
// distinct holders is operational, not a collectible — we still serialize
// the cap as the count and flag the contract as "approx".
const MAX_SET_SIZE = 5_000;

// Cap recent-window per-contract receiver/sender Sets. 30-day window so
// real collections rarely exceed a few hundred unique participants.
const MAX_RECENT_SET_SIZE = 1_000;

// Threshold for triggering pass 2 balance computation. Below this, the
// contract is almost certainly tier-0 spam and we don't waste cycles
// computing holder concentration.
const PASS2_MIN_HOLDERS = 20;

// How many contracts per pass-2 Hypersync query (address filter limit).
const PASS2_BATCH_SIZE = 50;

// Hypersync polite delay between paged queries
const HYPERSYNC_PAGE_DELAY_MS = 200;

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

const TOKEN_URI_ABI = [
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
];

// ── Hypersync transport ───────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ── snapshot bookkeeping ──────────────────────────────────────────
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
 * Stats bucket accumulated during the main sweep. The Sets are kept in
 * memory only — we serialize their sizes. Once any Set hits MAX_SET_SIZE
 * we stop tracking new entries (further inserts no-op) and flag the
 * bucket as `setsCapped`. The serialized count is the cap rather than
 * the true cardinality — fine because such contracts are operational
 * NFTs that won't rank anyway.
 */
function makeStatsBucket() {
  return {
    transferCount: 0,
    mintCount: 0,
    burnCount: 0,
    selfTransferCount: 0,
    receivers: new Set(),
    senders: new Set(),
    setsCapped: false,
    firstBlock: Infinity,
    lowestTokenId: null,
  };
}

/**
 * Apply one Transfer event to a bucket. `from`, `to` are lowercased 0x
 * addresses. No balance tracking here — see pass 2.
 */
function applyTransfer(bucket, from, to, blockNumber, tokenId) {
  bucket.transferCount++;

  const isMint = from === ZERO_ADDR;
  const isBurn = to === ZERO_ADDR;
  if (isMint) bucket.mintCount++;
  if (isBurn) bucket.burnCount++;
  if (!isMint && !isBurn && from === to) bucket.selfTransferCount++;

  if (!isBurn && bucket.receivers.size < MAX_SET_SIZE) {
    bucket.receivers.add(to);
  } else if (!isBurn) {
    bucket.setsCapped = true;
  }
  if (!isMint && bucket.senders.size < MAX_SET_SIZE) {
    bucket.senders.add(from);
  } else if (!isMint) {
    bucket.setsCapped = true;
  }

  if (blockNumber != null && blockNumber < bucket.firstBlock) {
    bucket.firstBlock = blockNumber;
  }
  if (tokenId != null) {
    const tid = BigInt(tokenId);
    if (bucket.lowestTokenId == null || tid < bucket.lowestTokenId) {
      bucket.lowestTokenId = tid;
    }
  }
}

/**
 * From a fresh balance Map (built in pass 2), compute top1/top10 holder
 * concentration. Returns nulls when no balance data is available (e.g.
 * because the contract overflowed MAX_BALANCE_MAP_SIZE during replay).
 */
function materializeConcentration(balanceMap) {
  if (!balanceMap) return { top1HolderPct: null, top10HolderPct: null };
  const balances = [];
  for (const v of balanceMap.values()) if (v > 0) balances.push(v);
  if (balances.length === 0) return { top1HolderPct: 0, top10HolderPct: 0 };
  balances.sort((a, b) => b - a);
  let total = 0;
  for (const v of balances) total += v;
  if (total === 0) return { top1HolderPct: 0, top10HolderPct: 0 };
  const top1 = balances[0] / total;
  const top10Slice = balances.slice(0, 10);
  let top10Sum = 0;
  for (const v of top10Slice) top10Sum += v;
  return {
    top1HolderPct: round4(top1),
    top10HolderPct: round4(top10Sum / total),
  };
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

// ── 1. Hypersync all-time sweep ───────────────────────────────────
async function discoverErc721Contracts(startBlock, knownAddresses, isFullRescan) {
  console.log(
    `Hypersync: scanning Transfer events from block ${startBlock}` +
      (knownAddresses.size > 0
        ? ` (${knownAddresses.size} contracts already known)`
        : ""),
  );
  const stats = new Map();
  let cursor = startBlock;
  let target = 0;
  let queries = 0;
  const startTime = Date.now();

  while (true) {
    const result = await hypersync({
      from_block: cursor,
      logs: [{ topics: [[TRANSFER_TOPIC], [], [], []] }],
      // topic1 = from, topic2 = to, topic3 = tokenId
      field_selection: { log: ["address", "topic1", "topic2", "topic3", "block_number"] },
    });

    target = result.archive_height;
    for (const batch of result.data || []) {
      for (const log of batch.logs || []) {
        if (!log.topic3 || !log.address) continue;
        const addr = log.address.toLowerCase();

        let bucket = stats.get(addr);
        if (!bucket) {
          bucket = makeStatsBucket();
          stats.set(addr, bucket);
        }

        const from = topicToAddr(log.topic1);
        const to = topicToAddr(log.topic2);
        applyTransfer(bucket, from, to, log.block_number, log.topic3);
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

    await sleep(HYPERSYNC_PAGE_DELAY_MS);
  }

  // Materialize per-address stats objects. Drop the Sets immediately
  // after reading their sizes so the GC can reclaim before we start the
  // memory-heavy recent-window + concentration passes.
  const statsByAddress = {};
  const newContracts = [];
  for (const [addr, bucket] of stats.entries()) {
    statsByAddress[addr] = {
      transferCount: bucket.transferCount,
      mintCount: bucket.mintCount,
      burnCount: bucket.burnCount,
      selfTransferCount: bucket.selfTransferCount,
      uniqueHolders: bucket.receivers.size,
      uniqueSenders: bucket.senders.size,
      setsCapped: bucket.setsCapped,
      firstTransferBlock: bucket.firstBlock === Infinity ? 0 : bucket.firstBlock,
      lowestTokenId: bucket.lowestTokenId != null ? bucket.lowestTokenId.toString() : null,
      top1HolderPct: null,
      top10HolderPct: null,
    };
    if (!knownAddresses.has(addr)) newContracts.push(addr);
  }
  // Explicitly free the bucket map + per-contract Sets.
  stats.clear();
  if (typeof globalThis.gc === "function") globalThis.gc();

  console.log(
    `Hypersync sweep done: ${Object.keys(statsByAddress).length} contracts total (${newContracts.length} new), ${queries} queries`,
  );

  // Recent-window pass (always fresh)
  const recentStats = await scanRecentWindow(cursor);
  for (const [addr, recent] of Object.entries(recentStats)) {
    if (!statsByAddress[addr]) statsByAddress[addr] = {};
    Object.assign(statsByAddress[addr], recent);
  }

  // Free recent-stats source object now that we've copied it.
  for (const key of Object.keys(recentStats)) delete recentStats[key];

  // Pass 2 — concentration. Only for full rescan, and only for contracts
  // that crossed the holder threshold (skip the long tail of garbage).
  if (isFullRescan) {
    const candidates = [];
    for (const [addr, s] of Object.entries(statsByAddress)) {
      if ((s.uniqueHolders ?? 0) >= PASS2_MIN_HOLDERS) candidates.push(addr);
    }
    console.log(
      `Pass 2 (concentration): ${candidates.length}/${Object.keys(statsByAddress).length} candidates`,
    );
    const concByAddress = await computeConcentrationBatch(candidates, cursor);
    for (const [addr, conc] of Object.entries(concByAddress)) {
      if (statsByAddress[addr]) Object.assign(statsByAddress[addr], conc);
    }
  }

  return { contracts: newContracts, statsByAddress, lastBlock: cursor };
}

// ── 1c. Pass 2: focused balance replay for concentration ──────────
/**
 * Query Hypersync filtered by a list of contract addresses (cap
 * PASS2_BATCH_SIZE per query for filter shape sanity). Replay each
 * contract's Transfers into a balance Map, compute top1/top10 holder
 * percent, free the map, move on. Memory peaks at ~PASS2_BATCH_SIZE
 * contracts simultaneously.
 */
async function computeConcentrationBatch(addresses, currentBlock) {
  const out = {};
  if (addresses.length === 0) return out;

  const startTime = Date.now();
  let totalQueries = 0;

  for (let i = 0; i < addresses.length; i += PASS2_BATCH_SIZE) {
    const slice = addresses.slice(i, i + PASS2_BATCH_SIZE);
    const balances = new Map(); // addr → Map<holder, balance>
    const overflowed = new Set(); // addresses that blew MAX_BALANCE_MAP_SIZE
    for (const a of slice) balances.set(a, new Map());

    let cursor = 0;
    while (true) {
      const result = await hypersync({
        from_block: cursor,
        to_block: currentBlock,
        logs: [
          {
            address: slice,
            topics: [[TRANSFER_TOPIC], [], [], []],
          },
        ],
        field_selection: { log: ["address", "topic1", "topic2", "topic3"] },
      });
      for (const batch of result.data || []) {
        for (const log of batch.logs || []) {
          if (!log.topic3 || !log.address) continue;
          const addr = log.address.toLowerCase();
          if (overflowed.has(addr)) continue;
          const m = balances.get(addr);
          if (!m) continue;
          const from = topicToAddr(log.topic1);
          const to = topicToAddr(log.topic2);
          const isMint = from === ZERO_ADDR;
          const isBurn = to === ZERO_ADDR;
          if (!isMint) {
            const b = (m.get(from) ?? 0) - 1;
            if (b === 0) m.delete(from);
            else m.set(from, b);
          }
          if (!isBurn) {
            const b = (m.get(to) ?? 0) + 1;
            m.set(to, b);
            if (m.size > MAX_BALANCE_MAP_SIZE) {
              overflowed.add(addr);
              balances.set(addr, null); // free the map
            }
          }
        }
      }
      cursor = result.next_block;
      totalQueries++;
      if (cursor >= currentBlock || cursor >= result.archive_height) break;
      await sleep(HYPERSYNC_PAGE_DELAY_MS);
    }

    for (const addr of slice) {
      const m = balances.get(addr);
      out[addr] = materializeConcentration(m);
    }
    balances.clear();
    if (typeof globalThis.gc === "function") globalThis.gc();

    if (i % (PASS2_BATCH_SIZE * 10) === 0 || i + PASS2_BATCH_SIZE >= addresses.length) {
      const pct = Math.round((Math.min(i + PASS2_BATCH_SIZE, addresses.length) / addresses.length) * 100);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  pass 2: ${i + slice.length}/${addresses.length} (${pct}%), ${totalQueries} queries, ${elapsed}s`);
    }
  }

  return out;
}

/**
 * 32-byte topic → 20-byte 0x address (lowercased).
 */
function topicToAddr(topic) {
  if (!topic) return null;
  // topics are 32-byte left-padded. Last 40 hex chars = address.
  return "0x" + topic.slice(-40).toLowerCase();
}

// ── 1b. Recent-window scan (24h / 7d / 30d activity) ──────────────
async function scanRecentWindow(currentBlock) {
  const startBlock = Math.max(0, currentBlock - WINDOW_30D);
  console.log(
    `Hypersync recent-window: scanning blocks ${startBlock} → ${currentBlock} for 24h/7d/30d stats`,
  );

  /** @type {Record<string, any>} */
  const acc = {};
  let cursor = startBlock;
  let target = 0;
  let queries = 0;
  const startTime = Date.now();

  while (true) {
    const result = await hypersync({
      from_block: cursor,
      logs: [{ topics: [[TRANSFER_TOPIC], [], [], []] }],
      field_selection: { log: ["address", "topic1", "topic2", "topic3", "block_number"] },
    });
    target = result.archive_height;

    for (const batch of result.data || []) {
      for (const log of batch.logs || []) {
        if (!log.topic3 || !log.address || log.block_number == null) continue;
        const age = currentBlock - log.block_number;
        if (age > WINDOW_30D) continue;
        const addr = log.address.toLowerCase();
        const from = topicToAddr(log.topic1);
        const to = topicToAddr(log.topic2);
        const isMint = from === ZERO_ADDR;
        const isBurn = to === ZERO_ADDR;

        let row = acc[addr];
        if (!row) {
          row = {
            recent24h: 0,
            recent7d: 0,
            recent30d: 0,
            recentMints24h: 0,
            recentMints7d: 0,
            recentReceivers24h: new Set(),
            recentReceivers7d: new Set(),
            recentSenders24h: new Set(),
            recentSenders7d: new Set(),
          };
          acc[addr] = row;
        }

        row.recent30d++;
        if (age <= WINDOW_7D) {
          row.recent7d++;
          if (isMint) row.recentMints7d++;
          if (!isBurn && row.recentReceivers7d.size < MAX_RECENT_SET_SIZE) row.recentReceivers7d.add(to);
          if (!isMint && row.recentSenders7d.size < MAX_RECENT_SET_SIZE) row.recentSenders7d.add(from);
        }
        if (age <= WINDOW_24H) {
          row.recent24h++;
          if (isMint) row.recentMints24h++;
          if (!isBurn && row.recentReceivers24h.size < MAX_RECENT_SET_SIZE) row.recentReceivers24h.add(to);
          if (!isMint && row.recentSenders24h.size < MAX_RECENT_SET_SIZE) row.recentSenders24h.add(from);
        }
      }
    }

    cursor = result.next_block;
    queries++;
    if (cursor >= target || cursor >= currentBlock) break;
    await sleep(HYPERSYNC_PAGE_DELAY_MS);
  }

  // Materialise sets
  const out = {};
  for (const [addr, row] of Object.entries(acc)) {
    out[addr] = {
      recent24h: row.recent24h,
      recent7d: row.recent7d,
      recent30d: row.recent30d,
      recentMints24h: row.recentMints24h,
      recentMints7d: row.recentMints7d,
      recentReceivers24h: row.recentReceivers24h.size,
      recentReceivers7d: row.recentReceivers7d.size,
      recentSenders24h: row.recentSenders24h.size,
      recentSenders7d: row.recentSenders7d.size,
    };
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `  recent-window done: ${Object.keys(out).length} contracts in ${queries} queries, ${elapsed}s`,
  );
  return out;
}

// ── 2. Marketplace sales pass ─────────────────────────────────────
/**
 * Query Hypersync for the marketplace's ItemSold events in the last 7d.
 * Computes per-collection: sales24h/7d, volume24h/7d, uniqueBuyers24h/7d,
 * uniqueSellers24h/7d. No-op when MARKETPLACE_ADDRESS is not configured.
 *
 * ItemSold event layout (from MintiMarketplace.json):
 *   topic[0] = signature
 *   topic[1] = listingId (indexed uint256)
 *   topic[2] = nftContract (indexed address)
 *   topic[3] = tokenId (indexed uint256)
 *   data     = (buyer, seller, price, protocolFee, royaltyAmount, royaltyReceiver)
 *              = 6 * 32 bytes
 */
async function scanMarketplaceSales(currentBlock, itemSoldTopic) {
  if (!MARKETPLACE_ADDRESS || !itemSoldTopic) {
    console.log("Marketplace not configured — skipping sales pass");
    return {};
  }

  const startBlock = Math.max(0, currentBlock - WINDOW_7D);
  console.log(
    `Hypersync marketplace sales: ${startBlock} → ${currentBlock} (last 7d)`,
  );

  const acc = {};
  let cursor = startBlock;
  let target = 0;
  let queries = 0;

  while (true) {
    const result = await hypersync({
      from_block: cursor,
      logs: [
        {
          address: [MARKETPLACE_ADDRESS],
          topics: [[itemSoldTopic], [], [], []],
        },
      ],
      field_selection: {
        log: ["topic2", "data", "block_number"],
      },
    });
    target = result.archive_height;

    for (const batch of result.data || []) {
      for (const log of batch.logs || []) {
        const nftContract = topicToAddr(log.topic2);
        if (!nftContract || log.block_number == null) continue;

        const age = currentBlock - log.block_number;
        if (age > WINDOW_7D) continue;

        // Parse data
        const data = (log.data || "").startsWith("0x") ? log.data.slice(2) : log.data;
        if (!data || data.length < 64 * 6) continue;
        const buyer = "0x" + data.slice(24, 64).toLowerCase();
        const seller = "0x" + data.slice(64 + 24, 64 + 64).toLowerCase();
        const priceHex = data.slice(64 * 2, 64 * 3);
        const price = BigInt("0x" + priceHex);

        let row = acc[nftContract];
        if (!row) {
          row = {
            sales24h: 0,
            sales7d: 0,
            volume24h: 0n,
            volume7d: 0n,
            buyers24h: new Set(),
            buyers7d: new Set(),
            sellers24h: new Set(),
            sellers7d: new Set(),
          };
          acc[nftContract] = row;
        }

        row.sales7d++;
        row.volume7d += price;
        row.buyers7d.add(buyer);
        row.sellers7d.add(seller);
        if (age <= WINDOW_24H) {
          row.sales24h++;
          row.volume24h += price;
          row.buyers24h.add(buyer);
          row.sellers24h.add(seller);
        }
      }
    }

    cursor = result.next_block;
    queries++;
    if (cursor >= target || cursor >= currentBlock) break;
    await sleep(HYPERSYNC_PAGE_DELAY_MS);
  }

  const out = {};
  for (const [addr, row] of Object.entries(acc)) {
    out[addr] = {
      sales24h: row.sales24h,
      sales7d: row.sales7d,
      volume24h: row.volume24h.toString(),
      volume7d: row.volume7d.toString(),
      uniqueBuyers24h: row.buyers24h.size,
      uniqueBuyers7d: row.buyers7d.size,
      uniqueSellers24h: row.sellers24h.size,
      uniqueSellers7d: row.sellers7d.size,
    };
  }
  console.log(
    `  marketplace sales done: ${Object.keys(out).length} collections traded in ${queries} queries`,
  );
  return out;
}

// ── 3a. Metadata precheck ────────────────────────────────────────
//
// For each collection, fetch tokenURI(lowestTokenId || 1) and try to
// resolve the metadata JSON server-side. We then bake the discovered
// image URL into the snapshot so the frontend can paint thumbnails on
// the explore grid with ZERO runtime metadata fetches. Collections whose
// metadata can't be resolved at all are flagged so assignTier can hide
// them — that's how codepunks-style permanently-dead collections stop
// spamming the user's console.
//
// Server-side has no CORS, so this also captures collections that the
// browser can't reach directly (scatter.art, R2 buckets without CORS,
// etc.). The frontend gets the resolved image URL even though it could
// never have produced it itself.

// Public IPFS gateways — racing these gives us best-of-N latency on
// cold reads. Same set we use client-side, minus dweb.link (chronic 504).
const PRECHECK_IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

const PRECHECK_FETCH_TIMEOUT_MS = 8_000;

// CIDv1 (base32 sha256, 59 chars) OR CIDv0 (Qm-prefix base58, 46 chars).
const CID_RE = /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{52,})/i;

function looksLikeCid(s) {
  return !!s && CID_RE.test(s) && new RegExp(`^${CID_RE.source}$`, "i").test(s);
}

function parseIpfsLike(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const rest = uri.slice("ipfs://".length);
    const slash = rest.indexOf("/");
    const cid = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash) : "";
    if (looksLikeCid(cid)) return { cid, path };
  }
  const sub = uri.match(/^https?:\/\/([^./]+)\.ipfs\.[^/]+(\/.*)?$/);
  if (sub && looksLikeCid(sub[1])) return { cid: sub[1], path: sub[2] || "" };
  const pth = uri.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/);
  if (pth && looksLikeCid(pth[1])) {
    return { cid: pth[1], path: (pth[2] || "") + (pth[3] || "") };
  }
  return null;
}

function resolveImageUriToHttps(image) {
  if (!image || typeof image !== "string") return null;
  if (image.startsWith("data:")) return image;
  if (image.startsWith("ar://")) {
    return "https://arweave.net/" + image.slice("ar://".length);
  }
  const ipfs = parseIpfsLike(image);
  if (ipfs) return `${PRECHECK_IPFS_GATEWAYS[0]}${ipfs.cid}${ipfs.path}`;
  if (image.startsWith("http://") || image.startsWith("https://")) return image;
  return null;
}

function decodeDataUriJson(uri) {
  if (uri.startsWith("data:application/json;base64,")) {
    return Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8");
  }
  if (uri.startsWith("data:application/json,")) {
    return decodeURIComponent(uri.slice("data:application/json,".length));
  }
  if (uri.startsWith("data:application/json;utf8,")) {
    return uri.slice("data:application/json;utf8,".length);
  }
  return null;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadataJson(uri) {
  if (!uri) return null;
  if (uri.startsWith("data:")) {
    const decoded = decodeDataUriJson(uri);
    if (!decoded) return null;
    try { return JSON.parse(decoded); } catch { return null; }
  }
  // IPFS-shaped: race public gateways. Any 200 wins.
  const ipfs = parseIpfsLike(uri);
  if (ipfs) {
    const ctrls = PRECHECK_IPFS_GATEWAYS.map(() => new AbortController());
    const attempts = PRECHECK_IPFS_GATEWAYS.map(async (gw, i) => {
      const t = setTimeout(() => ctrls[i].abort(), PRECHECK_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(`${gw}${ipfs.cid}${ipfs.path}`, { signal: ctrls[i].signal });
        if (!resp.ok) throw new Error(`${resp.status}`);
        return await resp.text();
      } finally {
        clearTimeout(t);
      }
    });
    try {
      const text = await Promise.any(attempts);
      ctrls.forEach((c) => c.abort());
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }
  // Centralized URL. Node has no CORS, so a direct fetch reaches scatter
  // and friends even if the browser can't.
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    try {
      const text = await fetchWithTimeout(uri, PRECHECK_FETCH_TIMEOUT_MS);
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Multicall tokenURI/uri for a batch of contracts. Pads token id variants
 * for {id}-template URIs (ERC-1155 spec) and substitutes them so the
 * returned string is a concrete URL ready to fetch.
 */
async function tokenUriBatch(client, contracts) {
  const calls = contracts.map((c) => ({
    address: c.address,
    abi: TOKEN_URI_ABI,
    functionName: c.is1155 && !c.is721 ? "uri" : "tokenURI",
    args: [BigInt(c.sampleTokenId)],
  }));
  const results = await client.multicall({
    contracts: calls,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  });
  return results.map((r) =>
    r.status === "success" && typeof r.result === "string" && r.result.length > 0
      ? r.result
      : null,
  );
}

function expandIdTemplate(uri, tokenId) {
  if (!uri || !uri.includes("{id}")) return uri;
  const dec = tokenId.toString();
  const hex64 = tokenId.toString(16).padStart(64, "0");
  // ERC-1155 spec wants the 64-char padded hex; some collections shipped
  // decimal anyway. Try padded first since that's what the spec mandates.
  return uri.replace(/\{id\}/g, hex64).replace(/\{decimalId\}/g, dec);
}

/**
 * Run precheck on a list of {address, sampleTokenId, is721, is1155}
 * entries. Returns a Map<address-lowercase, precheck-result>.
 *
 * Result fields:
 *   metadataBroken      — true if tokenURI reverted, returned empty, or
 *                         the JSON couldn't be resolved at all.
 *   tokenUriTemplate    — raw string returned by tokenURI/uri, useful
 *                         for client-side extrapolation to other tokens.
 *   sampleImageUrl      — the image field of the resolved JSON, mapped
 *                         to an https/data URL the browser can use as
 *                         `<img src>`. null on broken metadata.
 *   isOnChainMetadata   — tokenURI was a data: URI.
 */
async function precheckMetadataBatch(client, batch) {
  const results = new Map();
  let uris;
  try {
    uris = await tokenUriBatch(client, batch);
  } catch (err) {
    // RPC-level failure — mark whole batch as un-prechecked, don't poison
    // them as broken just because the RPC hiccuped.
    for (const c of batch) {
      results.set(c.address.toLowerCase(), { metadataChecked: false });
    }
    return results;
  }

  await Promise.all(
    batch.map(async (c, i) => {
      const addr = c.address.toLowerCase();
      const rawUri = uris[i];
      if (!rawUri) {
        results.set(addr, {
          metadataChecked: true,
          metadataBroken: true,
          tokenUriTemplate: null,
          sampleImageUrl: null,
          isOnChainMetadata: false,
        });
        return;
      }
      const concrete = expandIdTemplate(rawUri, BigInt(c.sampleTokenId));
      const isOnChain = concrete.startsWith("data:");
      const json = await fetchMetadataJson(concrete);
      if (!json) {
        results.set(addr, {
          metadataChecked: true,
          metadataBroken: true,
          tokenUriTemplate: rawUri,
          sampleImageUrl: null,
          isOnChainMetadata: isOnChain,
        });
        return;
      }
      const rawImage =
        (typeof json.image === "string" && json.image) ||
        (typeof json.image_url === "string" && json.image_url) ||
        null;
      const sampleImageUrl = rawImage ? resolveImageUriToHttps(rawImage) : null;
      results.set(addr, {
        metadataChecked: true,
        metadataBroken: false,
        tokenUriTemplate: rawUri,
        sampleImageUrl,
        isOnChainMetadata: isOnChain,
      });
    }),
  );
  return results;
}

const PRECHECK_BATCH_SIZE = 20; // smaller than enrichBatch — each entry triggers an HTTP fetch
const PRECHECK_CONCURRENCY = 1; // sequential batches; HTTP gateways throttle aggressively

async function precheckAll(collections) {
  if (collections.length === 0) return new Map();
  console.log(`Prechecking metadata for ${collections.length} collections...`);
  const startTime = Date.now();
  const out = new Map();

  for (let i = 0; i < collections.length; i += PRECHECK_BATCH_SIZE) {
    const batch = collections.slice(i, i + PRECHECK_BATCH_SIZE);
    let lastErr = null;
    let batchResults = null;
    for (let attempt = 0; attempt < RPC_URLS.length; attempt++) {
      const client = nextClient();
      try {
        batchResults = await precheckMetadataBatch(client, batch);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (batchResults) {
      for (const [addr, res] of batchResults) out.set(addr, res);
    } else {
      console.warn(`  precheck batch ${i} failed: ${lastErr?.message}`);
      for (const c of batch) {
        out.set(c.address.toLowerCase(), { metadataChecked: false });
      }
    }

    if (((i / PRECHECK_BATCH_SIZE) | 0) % 10 === 0 || i + PRECHECK_BATCH_SIZE >= collections.length) {
      const pct = Math.round((Math.min(i + PRECHECK_BATCH_SIZE, collections.length) / collections.length) * 100);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  ${Math.min(i + PRECHECK_BATCH_SIZE, collections.length)}/${collections.length} (${pct}%), ${elapsed}s elapsed`);
    }
  }

  let broken = 0;
  let withImage = 0;
  for (const r of out.values()) {
    if (r.metadataBroken) broken++;
    if (r.sampleImageUrl) withImage++;
  }
  console.log(`Precheck done: ${broken} broken, ${withImage} have sample images`);
  return out;
}

// ── 3. Multicall enrichment ───────────────────────────────────────
async function enrichBatch(client, addresses) {
  const calls = [];
  for (const addr of addresses) {
    calls.push(
      { address: addr, abi: ABI, functionName: "name" },
      { address: addr, abi: ABI, functionName: "symbol" },
      { address: addr, abi: ABI, functionName: "totalSupply" },
      { address: addr, abi: ABI, functionName: "supportsInterface", args: [ERC721_INTERFACE_ID] },
      { address: addr, abi: ABI, functionName: "supportsInterface", args: [ERC1155_INTERFACE_ID] },
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

    enriched.push({ address: addresses[i], name, symbol, totalSupply, is721, is1155 });
  }
  return enriched;
}

async function enrichAll(addresses) {
  const limited = addresses.slice(0, ENRICH_LIMIT);
  console.log(
    `Enriching ${limited.length} contracts (multicall, ${CONTRACTS_PER_BATCH}/batch)...`,
  );
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
      }
    }
    if (lastErr) {
      console.warn(`  batch ${i}..${i + batch.length} failed: ${lastErr.message}`);
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

// ── 4. Filter ─────────────────────────────────────────────────────
function filterRealCollections(enriched) {
  const filtered = enriched.filter((c) => {
    const hasName = c.name && c.name.length > 0;
    const hasSymbol = c.symbol && c.symbol.length > 0;
    const looksLikeNft = c.is721 || c.is1155 || hasName;
    return looksLikeNft && (hasName || hasSymbol);
  });
  console.log(`Filter: ${filtered.length}/${enriched.length} look like real NFT collections`);
  return filtered;
}

// ── 5. Tier assignment ────────────────────────────────────────────
/**
 * Patterns associated with scam / airdrop-promo collection names. Kept here
 * (mirrors the client-side list) so the snapshot can pre-tag tier 0 entries.
 */
const SPAM_NAME_RE =
  /\$|🚀|💎|🎁|💰|⭐|free|claim|airdrop|reward|bonus|www\.|https?:|\.com|\.io|\.xyz\b|\.eth\b|t\.me\/|telegram|discord\.gg/i;

/**
 * Tier 0 — hidden by default. Tier 1 — indexed but unranked. Tier 2 — explore-
 * eligible (real activity). Tier 3 — reserved for curated registry collections
 * (assigned client-side from registry membership; never set by this script).
 */
function assignTier(c) {
  const name = c.name || "";
  const symbol = c.symbol || "";
  const holders = c.uniqueHolders ?? 0;
  const senders = c.uniqueSenders ?? 0;
  const transfers = c.transferCount ?? 0;
  const mints = c.mintCount ?? 0;
  const secondary = Math.max(0, transfers - mints);

  // ── Tier 0 hard hides ──
  if (!c.name && !c.symbol) return 0;
  if (SPAM_NAME_RE.test(name) || SPAM_NAME_RE.test(symbol)) return 0;
  if (holders < 5) return 0;
  if (transfers < 5) return 0;
  if (!c.is721 && !c.is1155 && !c.name) return 0;
  if (mints > 0 && transfers === mints && holders < 50) return 0; // mint-and-dead microdust
  // Server-side metadata precheck failed — token doesn't resolve from
  // anywhere. Hide so the user's console isn't spammed at runtime trying
  // to refetch it.
  if (c.metadataBroken === true) return 0;

  // Concentration hide (only when we have a value)
  if (typeof c.top10HolderPct === "number" && c.top10HolderPct > 0.95) return 0;

  // ── Tier 2 — explore eligible ──
  const wideDistribution =
    holders >= 25 &&
    senders >= 3 && // someone other than mints has sent
    secondary >= 10;
  const passConcentration =
    c.top10HolderPct == null || c.top10HolderPct <= 0.80;
  if (wideDistribution && passConcentration) return 2;

  // ── Tier 1 — indexed, hidden behind "show all" ──
  return 1;
}

// ── 6. Write JSON ─────────────────────────────────────────────────
/**
 * Compute the ItemSold topic hash at runtime by reading the deployed ABI
 * file (no need to hardcode keccak256 outputs). We use viem's hashing.
 */
async function getItemSoldTopic() {
  try {
    const { keccak256, toBytes } = await import("viem");
    const sig = "ItemSold(uint256,address,uint256,address,address,uint256,uint256,uint256,address)";
    return keccak256(toBytes(sig));
  } catch (err) {
    console.warn(`Could not compute ItemSold topic: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`Building Monad collections snapshot (chainId=${CHAIN_ID})...`);
  console.log(`  Hypersync: ${HYPERSYNC_URL}`);
  console.log(`  RPCs: ${RPC_URLS.length} (${RPC_URLS[0]}, …)`);
  console.log(`  Marketplace: ${MARKETPLACE_ADDRESS || "(not deployed — skip sales)"}`);
  console.log(`  Full rescan: ${FORCE_FULL_RESCAN ? "yes" : "no (delta)"}`);

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
    FORCE_FULL_RESCAN || startBlock === 0,
  );

  // Marketplace sales pass (last 7d, regardless of mode)
  const itemSoldTopic = await getItemSoldTopic();
  const salesByAddress = await scanMarketplaceSales(lastBlock, itemSoldTopic);

  // Enrich newly-found contracts
  let newEnriched = [];
  let newFiltered = [];
  if (contracts.length > 0) {
    newEnriched = await enrichAll(contracts);
    newFiltered = filterRealCollections(newEnriched);
  } else {
    console.log("No new contracts to enrich — only the block cursor advanced.");
  }

  // ── Metadata precheck ──────────────────────────────────────────
  // Run for: all newly-discovered contracts (small) + on FORCE_FULL_RESCAN
  // or BACKFILL_METADATA, every previously-known collection that isn't
  // already marked as checked. Skips collections we know to be tier-0
  // spam from name/symbol patterns to avoid wasting fetches on garbage.
  const previousNeedingPrecheck =
    (FORCE_FULL_RESCAN || BACKFILL_METADATA)
      ? previousCollections.filter(
          (c) =>
            !c.metadataChecked &&
            (c.name || c.symbol) &&
            !SPAM_NAME_RE.test(c.name || "") &&
            !SPAM_NAME_RE.test(c.symbol || ""),
        )
      : [];
  const precheckTargets = [
    ...newFiltered.map((c) => ({
      address: c.address,
      is721: c.is721,
      is1155: c.is1155,
      sampleTokenId: (statsByAddress[c.address.toLowerCase()]?.lowestTokenId) ?? "1",
    })),
    ...previousNeedingPrecheck.map((c) => ({
      address: c.address,
      is721: c.is721,
      is1155: c.is1155,
      sampleTokenId: c.lowestTokenId ?? "1",
    })),
  ];
  const precheckResults = await precheckAll(precheckTargets);

  // ── Merge with previous snapshot ────────────────────────────────
  /**
   * Delta-merging strategy:
   *   - cumulative counts (transferCount, mintCount, ...): ADD delta to previous
   *   - cardinality counts (uniqueHolders, uniqueSenders): MAX(old, delta) since
   *     we don't carry forward the set. Approximation, fine in practice
   *   - first-block: MIN
   *   - lowest-tokenId: MIN
   *   - recent windows (recent24h/7d/30d, recentMints*, recentReceivers*):
   *     OVERWRITE — these are fresh from the recent-window scan each run
   *   - concentration (top1/top10HolderPct, holderRatio): OVERWRITE iff
   *     full-rescan computed them, otherwise CARRY FORWARD previous value
   *   - marketplace sales: OVERWRITE (fresh each run)
   */
  const mergeStats = (existing, delta, isFullRescan) => {
    if (!delta) return existing;
    return {
      transferCount: (existing?.transferCount ?? 0) + (delta.transferCount ?? 0),
      mintCount: (existing?.mintCount ?? 0) + (delta.mintCount ?? 0),
      burnCount: (existing?.burnCount ?? 0) + (delta.burnCount ?? 0),
      selfTransferCount:
        (existing?.selfTransferCount ?? 0) + (delta.selfTransferCount ?? 0),
      uniqueHolders: Math.max(existing?.uniqueHolders ?? 0, delta.uniqueHolders ?? 0),
      uniqueSenders: Math.max(existing?.uniqueSenders ?? 0, delta.uniqueSenders ?? 0),
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
      top1HolderPct: isFullRescan
        ? delta.top1HolderPct ?? null
        : existing?.top1HolderPct ?? null,
      top10HolderPct: isFullRescan
        ? delta.top10HolderPct ?? null
        : existing?.top10HolderPct ?? null,
    };
  };

  const attachStats = (col) => {
    const addr = col.address.toLowerCase();
    const delta = statsByAddress[addr];
    const sale = salesByAddress[addr];
    const existing = {
      transferCount: col.transferCount,
      mintCount: col.mintCount,
      burnCount: col.burnCount,
      selfTransferCount: col.selfTransferCount,
      uniqueHolders: col.uniqueHolders,
      uniqueSenders: col.uniqueSenders,
      firstTransferBlock: col.firstTransferBlock,
      lowestTokenId: col.lowestTokenId,
      top1HolderPct: col.top1HolderPct,
      top10HolderPct: col.top10HolderPct,
    };
    const merged = {
      ...col,
      ...mergeStats(existing, delta, FORCE_FULL_RESCAN),
      // Recent windows always overwrite from the delta scan
      recent24h: delta?.recent24h ?? 0,
      recent7d: delta?.recent7d ?? 0,
      recent30d: delta?.recent30d ?? 0,
      recentMints24h: delta?.recentMints24h ?? 0,
      recentMints7d: delta?.recentMints7d ?? 0,
      recentReceivers24h: delta?.recentReceivers24h ?? 0,
      recentReceivers7d: delta?.recentReceivers7d ?? 0,
      recentSenders24h: delta?.recentSenders24h ?? 0,
      recentSenders7d: delta?.recentSenders7d ?? 0,
      // Sales always overwrite
      sales24h: sale?.sales24h ?? 0,
      sales7d: sale?.sales7d ?? 0,
      volume24h: sale?.volume24h ?? "0",
      volume7d: sale?.volume7d ?? "0",
      uniqueBuyers24h: sale?.uniqueBuyers24h ?? 0,
      uniqueBuyers7d: sale?.uniqueBuyers7d ?? 0,
      uniqueSellers24h: sale?.uniqueSellers24h ?? 0,
      uniqueSellers7d: sale?.uniqueSellers7d ?? 0,
    };
    // Apply this run's precheck result if we re-checked this collection;
    // otherwise carry forward the previous flags so they don't get lost
    // on delta runs.
    const fresh = precheckResults.get(merged.address.toLowerCase());
    if (fresh && fresh.metadataChecked) {
      merged.metadataChecked = true;
      merged.metadataBroken = !!fresh.metadataBroken;
      merged.tokenUriTemplate = fresh.tokenUriTemplate ?? null;
      merged.sampleImageUrl = fresh.sampleImageUrl ?? null;
      merged.isOnChainMetadata = !!fresh.isOnChainMetadata;
    } else {
      // Preserve previous values (col already has them via ...col)
      merged.metadataChecked = col.metadataChecked ?? false;
      merged.metadataBroken = col.metadataBroken ?? false;
      merged.tokenUriTemplate = col.tokenUriTemplate ?? null;
      merged.sampleImageUrl = col.sampleImageUrl ?? null;
      merged.isOnChainMetadata = col.isOnChainMetadata ?? false;
    }
    // Compute holderRatio for storage convenience (handles totalSupply parsing once)
    if (merged.totalSupply) {
      const supply = Number(merged.totalSupply);
      if (supply > 0) {
        merged.holderRatio = round4(
          Math.min((merged.uniqueHolders ?? 0) / supply, 1),
        );
      }
    }
    merged.tier = assignTier(merged);
    return merged;
  };

  const previousWithStats = previousCollections.map(attachStats);

  // For new contracts, the delta stats ARE the all-time stats
  const newWithStats = newFiltered.map((col) => {
    const addr = col.address.toLowerCase();
    const delta = statsByAddress[addr] ?? {};
    const sale = salesByAddress[addr];
    const merged = {
      ...col,
      transferCount: delta.transferCount ?? 0,
      mintCount: delta.mintCount ?? 0,
      burnCount: delta.burnCount ?? 0,
      selfTransferCount: delta.selfTransferCount ?? 0,
      uniqueHolders: delta.uniqueHolders ?? 0,
      uniqueSenders: delta.uniqueSenders ?? 0,
      firstTransferBlock: delta.firstTransferBlock ?? 0,
      lowestTokenId: delta.lowestTokenId ?? null,
      top1HolderPct: delta.top1HolderPct ?? null,
      top10HolderPct: delta.top10HolderPct ?? null,
      recent24h: delta.recent24h ?? 0,
      recent7d: delta.recent7d ?? 0,
      recent30d: delta.recent30d ?? 0,
      recentMints24h: delta.recentMints24h ?? 0,
      recentMints7d: delta.recentMints7d ?? 0,
      recentReceivers24h: delta.recentReceivers24h ?? 0,
      recentReceivers7d: delta.recentReceivers7d ?? 0,
      recentSenders24h: delta.recentSenders24h ?? 0,
      recentSenders7d: delta.recentSenders7d ?? 0,
      sales24h: sale?.sales24h ?? 0,
      sales7d: sale?.sales7d ?? 0,
      volume24h: sale?.volume24h ?? "0",
      volume7d: sale?.volume7d ?? "0",
      uniqueBuyers24h: sale?.uniqueBuyers24h ?? 0,
      uniqueBuyers7d: sale?.uniqueBuyers7d ?? 0,
      uniqueSellers24h: sale?.uniqueSellers24h ?? 0,
      uniqueSellers7d: sale?.uniqueSellers7d ?? 0,
    };
    const fresh = precheckResults.get(merged.address.toLowerCase());
    if (fresh) {
      merged.metadataChecked = !!fresh.metadataChecked;
      merged.metadataBroken = !!fresh.metadataBroken;
      merged.tokenUriTemplate = fresh.tokenUriTemplate ?? null;
      merged.sampleImageUrl = fresh.sampleImageUrl ?? null;
      merged.isOnChainMetadata = !!fresh.isOnChainMetadata;
    } else {
      merged.metadataChecked = false;
      merged.metadataBroken = false;
      merged.tokenUriTemplate = null;
      merged.sampleImageUrl = null;
      merged.isOnChainMetadata = false;
    }
    if (merged.totalSupply) {
      const supply = Number(merged.totalSupply);
      if (supply > 0) {
        merged.holderRatio = round4(
          Math.min((merged.uniqueHolders ?? 0) / supply, 1),
        );
      }
    }
    merged.tier = assignTier(merged);
    return merged;
  });

  const merged = [...previousWithStats, ...newWithStats];

  const snapshot = {
    chainId: CHAIN_ID,
    lastBlock,
    builtAt: Date.now(),
    schemaVersion: 5,
    marketplaceAddress: MARKETPLACE_ADDRESS,
    fullRescan: FORCE_FULL_RESCAN,
    collections: merged,
  };

  mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));
  const sizeKb = (JSON.stringify(snapshot).length / 1024).toFixed(0);
  // Tier + metadata histogram
  const tierCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let mdChecked = 0, mdBroken = 0, mdWithImage = 0, mdOnChain = 0;
  for (const c of merged) {
    tierCounts[c.tier ?? 0]++;
    if (c.metadataChecked) mdChecked++;
    if (c.metadataBroken) mdBroken++;
    if (c.sampleImageUrl) mdWithImage++;
    if (c.isOnChainMetadata) mdOnChain++;
  }
  console.log(
    `Wrote ${SNAPSHOT_PATH} (${sizeKb} KB, ${merged.length} total, +${newFiltered.length} new this run)`,
  );
  console.log(
    `Tiers: T0=${tierCounts[0]} hidden, T1=${tierCounts[1]} indexed, T2=${tierCounts[2]} explore, T3=${tierCounts[3]} curated`,
  );
  console.log(
    `Metadata: ${mdChecked}/${merged.length} checked, ${mdBroken} broken, ${mdWithImage} with sample image, ${mdOnChain} on-chain`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
