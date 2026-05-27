"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { Abi } from "viem";
import { useQuery } from "@tanstack/react-query";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useRpc } from "@/providers/RpcProvider";

// Debug logging — silent in production
const DEBUG = process.env.NODE_ENV === "development";
const log = (...args: unknown[]) => { if (DEBUG) console.log(...args); };
const warn = (...args: unknown[]) => { if (DEBUG) console.warn(...args); };
import {
  CHUNK_SIZES,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_SCAN_BLOCKS,
  createRpcPool,
  executeBatchedMulticalls,
  executeLogQueries,
  getBlockNumberViaPool,
  rpcCall,
  encodeCall,
  decodeResult,
  sleep,
  type MulticallRequest,
  type LogQueryParams,
  type RpcPool,
} from "@/lib/rpcPool";
import { batchOwnerOfScan } from "./useOwnedNfts";
import { hasHypersync } from "@/lib/hypersync/client";
import { useHypersyncWalletScan } from "./useHypersyncWalletScan";

// ERC-721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ERC-1155 TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)
const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

// ERC-1155 TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)
const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const ERC721_ABI = [
  {
    inputs: [{ type: "address", name: "owner" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "ownerOf",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "owner" },
      { type: "uint256", name: "index" },
    ],
    name: "tokenOfOwnerByIndex",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "bytes4", name: "interfaceId" }],
    name: "supportsInterface",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC721_ENUMERABLE_INTERFACE_ID = "0x780e9d63";
const ERC1155_INTERFACE_ID = "0xd9b67a26";
const MAX_OWNEROF_SCAN = 10_000;

const ERC1155_ABI = [
  {
    inputs: [
      { type: "address", name: "account" },
      { type: "uint256", name: "id" },
    ],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address[]", name: "accounts" },
      { type: "uint256[]", name: "ids" },
    ],
    name: "balanceOfBatch",
    outputs: [{ type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ type: "bytes4", name: "interfaceId" }],
    name: "supportsInterface",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

export interface DiscoveredToken {
  contractAddress: `0x${string}`;
  tokenId: bigint;
  /** True if this token is from an ERC-1155 contract */
  is1155?: boolean;
  /** ERC-1155 balance (how many copies the wallet holds) */
  balance1155?: bigint;
}

export interface TransferScanResult {
  tokens: DiscoveredToken[];
  scannedBlocks: number;
  collectionsFound: number;
  isLoading: boolean;
  isBackScanning: boolean;
  backwardProgress: number;
  /** Seconds until the public Hypersync scanner is expected to free
   *  up. Non-zero only while a 429 backoff is active. UI can surface
   *  a "scanner busy" pill instead of looking stuck. */
  retryAfterSeconds?: number;
}

// ────────────────────── Bidirectional Cache ──────────────────────

interface ScanCache {
  forwardEdge: number;    // latest block we've scanned TO
  backwardEdge: number;   // earliest block we've scanned FROM (kept for progress calc)
  birthBlock: number;     // wallet's first outgoing tx block (0 = unknown/receive-only)
  collections: string[];  // all discovered collection addresses
  pendingRanges?: ActiveRange[];  // active ranges still to scan (survives page reload)
  dormantRanges?: ActiveRange[];  // dormant ranges to scan after active (lower priority)
  totalRanges?: number;          // original total for progress calculation
  // Cached token IDs per collection — allows instant display on revisit
  // Keys are lowercase contract addresses, values are tokenId strings
  tokensByCollection?: Record<string, string[]>;
  // ERC-1155 collections — keys are lowercase contract addresses
  // Values are records of tokenId → balance string
  erc1155Collections?: Record<string, Record<string, string>>;
}

function getCacheKey(chainId: number, address: string): string {
  return `minti_scan_${chainId}_${address.toLowerCase()}`;
}

function loadCache(key: string): ScanCache | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Migrate old format (lastBlock only)
    if ("lastBlock" in parsed && !("forwardEdge" in parsed)) {
      return {
        forwardEdge: parsed.lastBlock,
        backwardEdge: parsed.lastBlock,
        birthBlock: 0,
        collections: parsed.collections || [],
      };
    }
    // Migrate from before birthBlock was added
    if (!("birthBlock" in parsed)) {
      parsed.birthBlock = 0;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(key: string, cache: ScanCache) {
  try {
    localStorage.setItem(key, JSON.stringify(cache));
  } catch {
    // Storage full, ignore
  }
}

// ────────────────────── Helpers ──────────────────────

function padAddress(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

function toHex(n: bigint): `0x${string}` {
  return `0x${n.toString(16)}` as `0x${string}`;
}

/**
 * Decode a uint256[] from ABI-encoded log data at a given slot offset.
 * ABI encoding: data starts with an offset pointer (32 bytes), then at that offset:
 * length (32 bytes) followed by `length` uint256 values.
 */
function decodeUint256Array(data: string, slotIndex: number): bigint[] {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  // Read the offset pointer at the given slot
  const offsetSlot = slotIndex * 64;
  if (hex.length < offsetSlot + 64) return [];
  const offset = parseInt(hex.slice(offsetSlot, offsetSlot + 64), 16) * 2; // byte offset → hex char offset
  if (hex.length < offset + 64) return [];
  const length = parseInt(hex.slice(offset, offset + 64), 16);
  const result: bigint[] = [];
  for (let i = 0; i < length; i++) {
    const start = offset + 64 + i * 64;
    if (hex.length < start + 64) break;
    result.push(BigInt("0x" + hex.slice(start, start + 64)));
  }
  return result;
}

// ────────────────────── Core scan logic ──────────────────────

interface ScanChunk {
  fromBlock: bigint;
  toBlock: bigint;
}

function buildChunks(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: number
): ScanChunk[] {
  const chunks: ScanChunk[] = [];
  const size = BigInt(chunkSize);
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + size - 1n > toBlock ? toBlock : start + size - 1n;
    chunks.push({ fromBlock: start, toBlock: end });
    start = end + 1n;
  }
  return chunks;
}

/**
 * Scan Transfer logs using the RPC pool dispatch pattern.
 * Returns sets of contract+tokenId pairs for received and sent transfers.
 */
async function scanTransferLogs(
  pool: RpcPool,
  ownerAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  chainId: number,
  contractFilter?: `0x${string}`,
  incomingOnly?: boolean
): Promise<{ received: Map<string, Set<string>>; sent: Map<string, Set<string>> }> {
  const chunkSize = CHUNK_SIZES[chainId] || DEFAULT_CHUNK_SIZE;
  const chunks = buildChunks(fromBlock, toBlock, chunkSize);

  if (chunks.length === 0) {
    return { received: new Map(), sent: new Map() };
  }

  const paddedOwner = padAddress(ownerAddress);

  // ── ERC-721 queries: Transfer(from, to, tokenId) — to is topics[2] ──
  const erc721InQueries: LogQueryParams[] = chunks.map((chunk) => ({
    fromBlock: toHex(chunk.fromBlock),
    toBlock: toHex(chunk.toBlock),
    topics: [TRANSFER_TOPIC, null, paddedOwner],
    ...(contractFilter ? { address: contractFilter } : {}),
  }));

  // ── ERC-1155 queries: TransferSingle/TransferBatch(operator, from, to, ...) — to is topics[3] ──
  // Use topic0 array to OR both event signatures in a single query per chunk
  const erc1155InQueries: LogQueryParams[] = chunks.map((chunk) => ({
    fromBlock: toHex(chunk.fromBlock),
    toBlock: toHex(chunk.toBlock),
    topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, null, paddedOwner],
    ...(contractFilter ? { address: contractFilter } : {}),
  }));

  let erc721OutQueries: LogQueryParams[] = [];
  let erc1155OutQueries: LogQueryParams[] = [];
  if (!incomingOnly) {
    erc721OutQueries = chunks.map((chunk) => ({
      fromBlock: toHex(chunk.fromBlock),
      toBlock: toHex(chunk.toBlock),
      topics: [TRANSFER_TOPIC, paddedOwner, null],
      ...(contractFilter ? { address: contractFilter } : {}),
    }));
    erc1155OutQueries = chunks.map((chunk) => ({
      fromBlock: toHex(chunk.fromBlock),
      toBlock: toHex(chunk.toBlock),
      topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, paddedOwner, null],
      ...(contractFilter ? { address: contractFilter } : {}),
    }));
  }

  const allQueries = [...erc721InQueries, ...erc1155InQueries, ...erc721OutQueries, ...erc1155OutQueries];
  const allResults = await executeLogQueries(pool, allQueries);

  // Slice results by query group
  let offset = 0;
  const erc721InResults = allResults.slice(offset, offset += chunks.length);
  const erc1155InResults = allResults.slice(offset, offset += chunks.length);
  const erc721OutResults = incomingOnly ? [] : allResults.slice(offset, offset += chunks.length);
  const erc1155OutResults = incomingOnly ? [] : allResults.slice(offset, offset += chunks.length);

  const received = new Map<string, Set<string>>();
  const addReceived = (contract: string, tokenId: string) => {
    if (!received.has(contract)) received.set(contract, new Set());
    received.get(contract)!.add(tokenId);
  };

  // Process ERC-721 incoming
  for (const logs of erc721InResults) {
    for (const log of logs) {
      if (log.topics.length < 4) continue; // ERC-20 filter
      addReceived(log.address.toLowerCase(), log.topics[3]);
    }
  }

  // Process ERC-1155 incoming
  for (const logs of erc1155InResults) {
    for (const log of logs) {
      const contract = log.address.toLowerCase();
      const topic0 = log.topics[0];
      if (topic0 === TRANSFER_SINGLE_TOPIC) {
        // data = abi.encode(uint256 id, uint256 value)
        // id is the first 32 bytes of data
        if (log.data.length >= 66) { // "0x" + 64 hex chars
          const tokenId = "0x" + log.data.slice(2, 66).replace(/^0+/, "") || "0";
          addReceived(contract, "0x" + tokenId.slice(2).padStart(64, "0"));
        }
      } else if (topic0 === TRANSFER_BATCH_TOPIC) {
        // data = abi.encode(uint256[] ids, uint256[] values)
        // ABI-encoded dynamic arrays: offset_ids(32) + offset_values(32) + length_ids(32) + ids...
        const tokenIds = decodeUint256Array(log.data, 0);
        for (const id of tokenIds) {
          const hex = id.toString(16).padStart(64, "0");
          addReceived(contract, "0x" + hex);
        }
      }
    }
  }

  const sent = new Map<string, Set<string>>();
  const addSent = (contract: string, tokenId: string) => {
    if (!sent.has(contract)) sent.set(contract, new Set());
    sent.get(contract)!.add(tokenId);
  };

  // Process ERC-721 outgoing
  for (const logs of erc721OutResults) {
    for (const log of logs) {
      if (log.topics.length < 4) continue;
      addSent(log.address.toLowerCase(), log.topics[3]);
    }
  }

  // Process ERC-1155 outgoing
  for (const logs of erc1155OutResults) {
    for (const log of logs) {
      const contract = log.address.toLowerCase();
      const topic0 = log.topics[0];
      if (topic0 === TRANSFER_SINGLE_TOPIC) {
        if (log.data.length >= 66) {
          const tokenId = "0x" + log.data.slice(2, 66).replace(/^0+/, "") || "0";
          addSent(contract, "0x" + tokenId.slice(2).padStart(64, "0"));
        }
      } else if (topic0 === TRANSFER_BATCH_TOPIC) {
        const tokenIds = decodeUint256Array(log.data, 0);
        for (const id of tokenIds) {
          const hex = id.toString(16).padStart(64, "0");
          addSent(contract, "0x" + hex);
        }
      }
    }
  }

  return { received, sent };
}

// ────────────────────── Binary search for wallet birth block ──────────────────────

/**
 * Binary search on eth_getTransactionCount to find the block where the wallet
 * sent its first transaction (nonce goes from 0 → 1). This gives a lower bound
 * for backward scanning — no need to scan blocks before the wallet existed.
 *
 * Returns { birthBlock, nonce }. birthBlock=0 if wallet has never sent a tx.
 * nonce is the current total transaction count (useful for activity density).
 * ~20 RPC calls (log2 of total blocks).
 */
async function probeWalletBirth(
  chainId: number,
  userRpc: string | undefined,
  ownerAddress: `0x${string}`,
  currentBlock: bigint
): Promise<{ birthBlock: number; nonce: number }> {
  const pool = createRpcPool(chainId, userRpc);

  // First check: does the wallet have any outgoing transactions at all?
  let currentNonce: bigint;
  try {
    const result = await rpcCall(pool.nodes[0].url, "eth_getTransactionCount", [
      ownerAddress,
      "latest",
    ]);
    currentNonce = BigInt(result as string);
  } catch {
    warn("[probeWalletBirth] Failed to get current nonce");
    return { birthBlock: 0, nonce: 0 };
  }

  if (currentNonce === 0n) {
    log("[probeWalletBirth] Wallet has never sent a transaction (nonce=0)");
    return { birthBlock: 0, nonce: 0 };
  }

  log(`[probeWalletBirth] Wallet nonce=${currentNonce}, binary searching for birth block...`);

  // Binary search: find earliest block where nonce > 0
  let lo = 0n;
  let hi = currentBlock;

  while (lo < hi) {
    const mid = (lo + hi) / 2n;

    let nonceAtMid: bigint;
    try {
      // Try multiple nodes in case one fails, with rate-limit handling
      let result: unknown = null;
      for (const node of pool.nodes) {
        if (!node.available) continue;
        const waitTime = node.rateLimitedUntil - Date.now();
        if (waitTime > 0) {
          // Try another node first
          const alt = pool.nodes.find(
            (n) => n !== node && n.available && n.rateLimitedUntil <= Date.now()
          );
          if (alt) continue; // skip this node, loop will find the alt
          await sleep(waitTime);
        }
        try {
          result = await rpcCall(node.url, "eth_getTransactionCount", [
            ownerAddress,
            toHex(mid),
          ]);
          break;
        } catch (err) {
          const isRateLimit = (err as Error & { isRateLimit?: boolean }).isRateLimit ||
            (err instanceof Error && err.message.includes("429"));
          if (isRateLimit) {
            node.rateLimitedUntil = Date.now() + 3000;
          } else {
            node.failCount++;
            if (node.failCount >= 10) node.available = false;
          }
        }
      }
      if (result === null) {
        warn("[probeWalletBirth] All nodes failed for nonce query, aborting");
        return { birthBlock: 0, nonce: Number(currentNonce) };
      }
      nonceAtMid = BigInt(result as string);
    } catch {
      return { birthBlock: 0, nonce: Number(currentNonce) };
    }

    if (nonceAtMid === 0n) {
      lo = mid + 1n; // First tx is after this block
    } else {
      hi = mid; // First tx is at or before this block
    }
  }

  const bb = Number(lo);
  log(`[probeWalletBirth] Wallet birth block: ${bb}, nonce: ${currentNonce}`);
  return { birthBlock: bb, nonce: Number(currentNonce) };
}

// ────────────────────── Nonce checkpoint skip-ahead ──────────────────────

interface ActiveRange {
  from: number;
  to: number;
}

interface RangeClassification {
  active: ActiveRange[];  // Nonce changed — wallet was sending txs here
  dormant: ActiveRange[]; // Nonce unchanged — wallet was idle (may still have received NFTs)
}

/**
 * Recursive binary partition using nonce density.
 *
 * Algorithm:
 * 1. Check nonce at fromBlock and toBlock — if same, entire range is dormant
 * 2. Otherwise, check nonce at midpoint
 * 3. For each half: if nonce unchanged → dormant, if changed → recurse deeper
 * 4. Stop subdividing when range is small enough to scan directly
 *
 * BFS-style: at each level, batch all midpoint nonce checks in parallel.
 * This adaptively focuses on active periods and prunes dormant ones early.
 */
async function findActiveRanges(
  chainId: number,
  userRpc: string | undefined,
  ownerAddress: `0x${string}`,
  fromBlock: number,
  toBlock: number,
  _totalNonce: number
): Promise<RangeClassification> {
  const totalRange = toBlock - fromBlock;
  if (totalRange <= 0) return { active: [], dormant: [] };

  // Stop subdividing when range is small enough to scan directly
  const minRange = (CHUNK_SIZES[chainId] || DEFAULT_CHUNK_SIZE) * 5;

  const pool = createRpcPool(chainId, userRpc);
  let nodeIdx = 0;
  const NONCE_RATE_LIMIT_MS = 3000;

  // Round-robin with rate-limit tracking
  const fetchNonce = async (blockNum: number): Promise<bigint | null> => {
    const startIdx = nodeIdx++ % pool.nodes.length;
    for (let attempt = 0; attempt < pool.nodes.length + 1; attempt++) {
      // Find a usable node
      let node = pool.nodes[(startIdx + attempt) % pool.nodes.length];
      if (!node.available) continue;

      // Wait out rate-limit cooldown
      const waitTime = node.rateLimitedUntil - Date.now();
      if (waitTime > 0) {
        // Try a different node first
        const altIdx = pool.nodes.findIndex(
          (n, j) => j !== (startIdx + attempt) % pool.nodes.length && n.available && n.rateLimitedUntil <= Date.now()
        );
        if (altIdx >= 0) {
          node = pool.nodes[altIdx];
        } else {
          await sleep(waitTime);
        }
      }

      try {
        const result = await rpcCall(node.url, "eth_getTransactionCount", [
          ownerAddress,
          toHex(BigInt(blockNum)),
        ]);
        return BigInt(result as string);
      } catch (err) {
        const isRateLimit = (err as Error & { isRateLimit?: boolean }).isRateLimit ||
          (err instanceof Error && err.message.includes("429"));
        if (isRateLimit) {
          node.rateLimitedUntil = Date.now() + NONCE_RATE_LIMIT_MS;
        } else {
          node.failCount++;
          if (node.failCount >= 10) node.available = false;
        }
      }
    }
    return null;
  };

  // Throttled parallel nonce fetches — cap concurrency to node count
  const throttledNonceBatch = async (blockNums: number[]): Promise<(bigint | null)[]> => {
    const concurrency = Math.max(pool.nodes.length, 2);
    const results: (bigint | null)[] = new Array(blockNums.length).fill(null);
    for (let i = 0; i < blockNums.length; i += concurrency) {
      const batch = blockNums.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map((b) => fetchNonce(b)));
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }
    return results;
  };

  // Get nonce at boundaries
  const [nonceFrom, nonceTo] = await Promise.all([
    fetchNonce(fromBlock),
    fetchNonce(toBlock),
  ]);

  if (nonceFrom === null || nonceTo === null) {
    // Can't determine — treat entire range as active
    return { active: [{ from: fromBlock, to: toBlock }], dormant: [] };
  }

  if (nonceFrom === nonceTo) {
    // Entire range is dormant
    log(`[findActiveRanges] Entire range ${fromBlock}→${toBlock} is dormant (nonce=${nonceFrom})`);
    return { active: [], dormant: [{ from: fromBlock, to: toBlock }] };
  }

  log(`[findActiveRanges] Nonce ${nonceFrom}→${nonceTo} (${nonceTo - nonceFrom} txs), recursively partitioning...`);

  interface PendingRange {
    from: number;
    to: number;
    nonceFrom: bigint;
    nonceTo: bigint;
  }

  const active: ActiveRange[] = [];
  const dormant: ActiveRange[] = [];
  let queue: PendingRange[] = [{ from: fromBlock, to: toBlock, nonceFrom, nonceTo }];
  let totalChecks = 2; // already checked boundaries

  while (queue.length > 0) {
    // Separate ranges that need midpoint checks from those already classified
    const needsSplit: PendingRange[] = [];

    for (const r of queue) {
      if (r.nonceFrom === r.nonceTo) {
        dormant.push({ from: r.from, to: r.to });
      } else if (r.to - r.from <= minRange) {
        // Small enough — scan it directly
        active.push({ from: r.from, to: r.to });
      } else {
        needsSplit.push(r);
      }
    }

    if (needsSplit.length === 0) break;

    // Batch fetch all midpoint nonces — throttled to avoid 429s
    const midpoints = needsSplit.map((r) => Math.floor((r.from + r.to) / 2));
    const midNonces = await throttledNonceBatch(midpoints);
    totalChecks += midpoints.length;

    // Build next level of the queue
    const nextQueue: PendingRange[] = [];

    for (let i = 0; i < needsSplit.length; i++) {
      const r = needsSplit[i];
      const mid = midpoints[i];
      const midNonce = midNonces[i];

      if (midNonce === null) {
        // Can't check — treat as active
        active.push({ from: r.from, to: r.to });
        continue;
      }

      // Left half: from → mid
      // Right half: mid → to
      const halves: PendingRange[] = [
        { from: r.from, to: mid, nonceFrom: r.nonceFrom, nonceTo: midNonce },
        { from: mid, to: r.to, nonceFrom: midNonce, nonceTo: r.nonceTo },
      ];

      for (const half of halves) {
        if (half.nonceFrom === half.nonceTo) {
          dormant.push({ from: half.from, to: half.to });
        } else if (half.to - half.from <= minRange) {
          active.push({ from: half.from, to: half.to });
        } else {
          nextQueue.push(half);
        }
      }
    }

    queue = nextQueue;
  }

  const activeBlocks = active.reduce((s, r) => s + (r.to - r.from), 0);
  const dormantBlocks = dormant.reduce((s, r) => s + (r.to - r.from), 0);
  const totalBlocks = activeBlocks + dormantBlocks;
  const dormantPct = totalBlocks > 0 ? Math.round((dormantBlocks / totalBlocks) * 100) : 0;
  log(
    `[findActiveRanges] ${active.length} active + ${dormant.length} dormant ranges ` +
    `(${dormantPct}% dormant, ${totalChecks} nonce checks)`
  );

  return { active, dormant };
}

// ────────────────────── Resolve owned tokens via Multicall3 ──────────────────────

/**
 * For each candidate contract discovered from logs:
 * 1. Check supportsInterface(ERC-721) — filter out non-NFTs
 * 2. Check balanceOf — skip if 0
 * 3. If enumerable: tokenOfOwnerByIndex
 * 4. If not enumerable: parallel batchOwnerOfScan (ownerOf brute-force)
 */
async function resolveOwnedTokens(
  chainId: number,
  userRpc: string | undefined,
  ownerAddress: `0x${string}`,
  candidateContracts: string[],
  /** Token IDs seen in transfer logs — used to skip brute-force ownerOf scan */
  transferHints?: Map<string, Set<string>>
): Promise<DiscoveredToken[]> {
  if (candidateContracts.length === 0) return [];

  const tokens: DiscoveredToken[] = [];

  // Step 1: Batch 5 calls per candidate: isERC721, balanceOf, isEnumerable, totalSupply, isERC1155
  const CALLS_PER_CONTRACT = 5;
  const metaCalls: MulticallRequest[] = [];
  for (const addr of candidateContracts) {
    const a = addr as `0x${string}`;
    metaCalls.push(encodeCall(a, ERC721_ABI, "supportsInterface", [ERC721_INTERFACE_ID]));
    metaCalls.push(encodeCall(a, ERC721_ABI, "balanceOf", [ownerAddress]));
    metaCalls.push(encodeCall(a, ERC721_ABI, "supportsInterface", [ERC721_ENUMERABLE_INTERFACE_ID]));
    metaCalls.push(encodeCall(a, ERC721_ABI, "totalSupply", []));
    metaCalls.push(encodeCall(a, ERC1155_ABI, "supportsInterface", [ERC1155_INTERFACE_ID]));
  }

  const pool = createRpcPool(chainId, userRpc);
  const metaResults = await executeBatchedMulticalls(pool, metaCalls);
  const flatMeta = metaResults.flat();

  log(`[resolveOwnedTokens] ${candidateContracts.length} candidates, ${flatMeta.length} meta results`);

  // Step 2: Filter and enumerate
  for (let i = 0; i < candidateContracts.length; i++) {
    const addr = candidateContracts[i] as `0x${string}`;
    const isERC721Result = flatMeta[i * CALLS_PER_CONTRACT];
    const balanceResult = flatMeta[i * CALLS_PER_CONTRACT + 1];
    const isEnumerableResult = flatMeta[i * CALLS_PER_CONTRACT + 2];
    const totalSupplyResult = flatMeta[i * CALLS_PER_CONTRACT + 3];
    const isERC1155Result = flatMeta[i * CALLS_PER_CONTRACT + 4];

    // Check if it's actually an ERC-721 or ERC-1155
    const isERC721 = isERC721Result
      ? decodeResult<boolean>(ERC721_ABI, "supportsInterface", isERC721Result)
      : false;

    const isERC1155 = isERC1155Result
      ? decodeResult<boolean>(ERC1155_ABI, "supportsInterface", isERC1155Result)
      : false;

    // If supportsInterface failed/returned false but balanceOf succeeded,
    // the contract was found via Transfer events — treat it as ERC-721.
    // Many contracts don't implement ERC-165 properly.
    const balance721 = balanceResult
      ? decodeResult<bigint>(ERC721_ABI, "balanceOf", balanceResult)
      : null;
    const inferredERC721 = !isERC721 && !isERC1155 && balance721 != null && balance721 > 0n;

    if (!isERC721 && !isERC1155 && !inferredERC721) {
      log(`[resolveOwnedTokens] ${addr.slice(0, 10)} is neither ERC-721 nor ERC-1155, skipping`);
      continue;
    }

    const treatAsERC721 = isERC721 || inferredERC721;

    // ── ERC-1155 path ──
    if (isERC1155 && !treatAsERC721) {
      const hintIds = transferHints?.get(addr.toLowerCase());
      if (!hintIds || hintIds.size === 0) {
        log(`[resolveOwnedTokens] ${addr.slice(0, 10)} is ERC-1155 but no transfer hints, skipping`);
        continue;
      }

      // Check balanceOf(account, id) for each known tokenId
      log(`[resolveOwnedTokens] ${addr.slice(0, 10)} ERC-1155, checking ${hintIds.size} token IDs...`);
      const candidateIds = Array.from(hintIds).map((raw) => BigInt(raw));
      const balCalls: MulticallRequest[] = candidateIds.map((id) =>
        encodeCall(addr, ERC1155_ABI, "balanceOf", [ownerAddress, id])
      );

      const balPool = createRpcPool(chainId, userRpc);
      const balResults = await executeBatchedMulticalls(balPool, balCalls);
      const flatBal = balResults.flat();

      for (let j = 0; j < flatBal.length; j++) {
        const entry = flatBal[j];
        if (!entry || !entry.success) continue;
        const bal = decodeResult<bigint>(ERC1155_ABI, "balanceOf", entry);
        if (bal && bal > 0n) {
          tokens.push({
            contractAddress: addr,
            tokenId: candidateIds[j],
            is1155: true,
            balance1155: bal,
          });
        }
      }

      log(`[resolveOwnedTokens] ${addr.slice(0, 10)} ERC-1155 found ${tokens.filter(t => t.contractAddress === addr).length} owned token IDs`);
      continue;
    }

    // ── ERC-721 path ──
    const balance = balance721; // already decoded above

    if (!balance || balance === 0n) {
      log(`[resolveOwnedTokens] ${addr.slice(0, 10)} balance=0, skipping`);
      continue;
    }

    const isEnumerable = isEnumerableResult
      ? decodeResult<boolean>(ERC721_ABI, "supportsInterface", isEnumerableResult)
      : false;

    const totalSupply = totalSupplyResult
      ? decodeResult<bigint>(ERC721_ABI, "totalSupply", totalSupplyResult)
      : null;

    log(`[resolveOwnedTokens] ${addr.slice(0, 10)} ERC-721=true balance=${balance} enumerable=${isEnumerable} totalSupply=${totalSupply?.toString() ?? 'unknown'}`);

    if (isEnumerable) {
      // Enumerate via tokenOfOwnerByIndex
      const count = Math.min(Number(balance), 100);
      const enumCalls: MulticallRequest[] = [];
      for (let idx = 0; idx < count; idx++) {
        enumCalls.push(
          encodeCall(addr, ERC721_ABI, "tokenOfOwnerByIndex", [
            ownerAddress,
            BigInt(idx),
          ])
        );
      }

      const enumPool = createRpcPool(chainId, userRpc);
      const enumResults = await executeBatchedMulticalls(enumPool, enumCalls);

      for (const batch of enumResults) {
        for (const entry of batch) {
          const tokenId = decodeResult<bigint>(ERC721_ABI, "tokenOfOwnerByIndex", entry);
          if (tokenId != null) {
            tokens.push({ contractAddress: addr, tokenId });
          }
        }
      }
    } else {
      // Non-enumerable: check hints first (cheap), then full ownerOf scan
      const hintIds = transferHints?.get(addr.toLowerCase());
      const normalizedOwner = ownerAddress.toLowerCase();
      const foundFromHints = new Set<string>();

      // Verify ownership of known transfer hint IDs — this is all we need.
      // Transfer events already tell us exactly which tokenIds were sent to this wallet.
      // No brute-force scan needed. The backward scan will discover more over time.
      if (hintIds && hintIds.size > 0) {
        log(`[resolveOwnedTokens] ${addr.slice(0, 10)} verifying ${hintIds.size} hint IDs`);
        const candidateIds = Array.from(hintIds).map((raw) => BigInt(raw));
        const ownerOfCalls: MulticallRequest[] = candidateIds.map((id) =>
          encodeCall(addr, ERC721_ABI, "ownerOf", [id])
        );

        const hintPool = createRpcPool(chainId, userRpc);
        const hintResults = await executeBatchedMulticalls(hintPool, ownerOfCalls);
        const flatHints = hintResults.flat();

        for (let j = 0; j < flatHints.length; j++) {
          const entry = flatHints[j];
          if (!entry || !entry.success) continue;
          const owner = decodeResult<string>(ERC721_ABI, "ownerOf", entry);
          if (owner && owner.toLowerCase() === normalizedOwner) {
            tokens.push({ contractAddress: addr, tokenId: candidateIds[j] });
          }
        }

        const found = tokens.filter(t => t.contractAddress.toLowerCase() === addr.toLowerCase()).length;
        log(`[resolveOwnedTokens] ${addr.slice(0, 10)} ${found}/${hintIds.size} still owned (balance=${balance})`);
      } else if (Number(balance) > 0) {
        // No hints yet — backward scan hasn't reached this collection's transfer events.
        // Show sentinel so the UI knows tokens exist but IDs are pending.
        log(`[resolveOwnedTokens] ${addr.slice(0, 10)} no hints yet, balance=${balance} — waiting for backward scan`);
        tokens.push({ contractAddress: addr, tokenId: BigInt(-1) });
      }
    }
  }

  return tokens;
}

// ────────────────────── Token cache helpers ──────────────────────

/** Build DiscoveredToken[] from the cached tokensByCollection map */
function hydrateTokensFromCache(cache: ScanCache): DiscoveredToken[] {
  const tokens: DiscoveredToken[] = [];
  const byCol = cache.tokensByCollection;
  if (byCol) {
    for (const [col, ids] of Object.entries(byCol)) {
      for (const id of ids) {
        tokens.push({
          contractAddress: col as `0x${string}`,
          tokenId: BigInt(id),
        });
      }
    }
  }

  // Hydrate ERC-1155 tokens
  const erc1155 = cache.erc1155Collections;
  if (erc1155) {
    for (const [col, idBalances] of Object.entries(erc1155)) {
      for (const [id, bal] of Object.entries(idBalances)) {
        tokens.push({
          contractAddress: col as `0x${string}`,
          tokenId: BigInt(id),
          is1155: true,
          balance1155: BigInt(bal),
        });
      }
    }
  }

  return tokens;
}

/** Save resolved tokens into the cache's tokensByCollection map */
function cacheTokens(cache: ScanCache, tokens: DiscoveredToken[]): ScanCache {
  const byCol: Record<string, string[]> = {};
  const erc1155: Record<string, Record<string, string>> = {};

  for (const t of tokens) {
    const col = t.contractAddress.toLowerCase();
    if (t.tokenId === BigInt(-1)) continue; // don't cache sentinels

    if (t.is1155) {
      if (!erc1155[col]) erc1155[col] = {};
      erc1155[col][t.tokenId.toString()] = (t.balance1155 ?? 1n).toString();
    } else {
      if (!byCol[col]) byCol[col] = [];
      byCol[col].push(t.tokenId.toString());
    }
  }

  return {
    ...cache,
    tokensByCollection: byCol,
    erc1155Collections: Object.keys(erc1155).length > 0 ? erc1155 : undefined,
  };
}

/**
 * Quick ownership verification — check if the wallet still owns each cached token.
 * Uses ownerOf for ERC-721, balanceOf(account, id) for ERC-1155.
 * Much cheaper than a full scan: one multicall batch per ~100 tokens.
 */
async function verifyOwnership(
  chainId: number,
  userRpc: string | undefined,
  ownerAddress: `0x${string}`,
  cachedTokens: DiscoveredToken[]
): Promise<DiscoveredToken[]> {
  if (cachedTokens.length === 0) return [];

  const pool = createRpcPool(chainId, userRpc);
  const calls: MulticallRequest[] = cachedTokens.map((t) =>
    t.is1155
      ? encodeCall(t.contractAddress, ERC1155_ABI, "balanceOf", [ownerAddress, t.tokenId])
      : encodeCall(t.contractAddress, ERC721_ABI, "ownerOf", [t.tokenId])
  );

  const results = await executeBatchedMulticalls(pool, calls);
  const flat = results.flat();

  const normalizedOwner = ownerAddress.toLowerCase();
  const verified: DiscoveredToken[] = [];

  for (let i = 0; i < cachedTokens.length; i++) {
    const result = flat[i];
    if (!result) continue;
    const token = cachedTokens[i];

    if (token.is1155) {
      const bal = decodeResult<bigint>(ERC1155_ABI, "balanceOf", result);
      if (bal && bal > 0n) {
        verified.push({ ...token, balance1155: bal });
      }
    } else {
      const owner = decodeResult<string>(ERC721_ABI, "ownerOf", result);
      if (owner && owner.toLowerCase() === normalizedOwner) {
        verified.push(token);
      }
    }
  }

  return verified;
}

// ────────────────────── Wallet Transfer Scan Hook ──────────────────────

/**
 * Bidirectional Transfer log scanner.
 * - Forward: scans from last cached block to tip (catches new transfers)
 * - Backward: continuously scans older blocks while page is open (discovers history)
 * - Cache: persists forward/backward edges + discovered collections per chain+address
 * - Token cache: stores discovered token IDs for instant display on revisit
 */
export function useWalletTransferScan(ownerAddress: `0x${string}` | undefined) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  // Chains with a free indexer (Envio Hypersync) use it instead of the
  // RPC-based fallback below. ~100× faster on Monad and free.
  const hypersyncResult = useHypersyncWalletScan(
    hasHypersync(browseChainId) ? ownerAddress : undefined,
  );

  const [result, setResult] = useState<TransferScanResult>({
    tokens: [],
    scannedBlocks: 0,
    collectionsFound: 0,
    isLoading: false,
    isBackScanning: false,
    backwardProgress: 0,
  });

  const abortRef = useRef(false);
  const runningRef = useRef(false);

  const scan = useCallback(async () => {
    if (!ownerAddress || runningRef.current) return;
    // Hypersync-supported chains are handled by useHypersyncWalletScan; don't
    // also run the RPC scan there.
    if (hasHypersync(browseChainId)) return;
    runningRef.current = true;
    abortRef.current = false;

    const userRpc = getEffectiveRpc(browseChainId);
    const cacheKey = getCacheKey(browseChainId, ownerAddress);
    let cache = loadCache(cacheKey);

    // ────── Instant hydration from cached tokens ──────
    const cachedTokens = cache ? hydrateTokensFromCache(cache) : [];
    let verifiedTokens: DiscoveredToken[] = [];

    if (cachedTokens.length > 0) {
      const cachedCollections = new Set(cachedTokens.map((t) => t.contractAddress.toLowerCase()));
      log(`[transferScan] Hydrated ${cachedTokens.length} tokens from ${cachedCollections.size} cached collections — verifying ownership...`);
      setResult({
        tokens: cachedTokens,
        scannedBlocks: cache ? cache.forwardEdge - (cache.backwardEdge ?? cache.forwardEdge) : 0,
        collectionsFound: cachedCollections.size,
        isLoading: true,
        isBackScanning: false,
        backwardProgress: cache?.pendingRanges ? Math.round(((cache.totalRanges ?? 0) - cache.pendingRanges.length) / (cache.totalRanges ?? 1) * 100) : (cache && cache.backwardEdge <= (cache.birthBlock || 0) ? 100 : 0),
      });

      // Quick ownerOf check — remove tokens the wallet no longer holds
      try {
        const verified = await verifyOwnership(browseChainId, userRpc, ownerAddress, cachedTokens);
        verifiedTokens = verified;
        const removed = cachedTokens.length - verified.length;
        if (removed > 0) {
          log(`[transferScan] Ownership check: ${removed} tokens no longer owned, ${verified.length} confirmed`);
          cache = cacheTokens(cache!, verified);
          saveCache(cacheKey, cache);
        }
        const verifiedCollections = new Set(verified.map((t) => t.contractAddress.toLowerCase()));
        setResult((prev) => ({
          ...prev,
          tokens: verified,
          collectionsFound: verifiedCollections.size,
        }));
      } catch (e) {
        warn("[transferScan] Ownership verification failed, keeping cached tokens:", e);
        verifiedTokens = cachedTokens; // keep them if verification itself failed
      }
    } else {
      setResult((prev) => ({ ...prev, isLoading: true }));
    }

    const pool = createRpcPool(browseChainId, userRpc);

    if (pool.nodes.length === 0) {
      setResult((prev) => ({ ...prev, isLoading: false }));
      runningRef.current = false;
      return;
    }

    let currentBlock: bigint;
    try {
      currentBlock = await getBlockNumberViaPool(pool);
    } catch {
      warn("[useWalletTransferScan] Failed to get block number");
      setResult((prev) => ({ ...prev, isLoading: false }));
      runningRef.current = false;
      return;
    }

    const currentBlockNum = Number(currentBlock);
    const allCollections = new Set<string>(cache?.collections || []);
    // Accumulate transfer log tokenIds per contract for targeted ownerOf checks
    const allTransferHints = new Map<string, Set<string>>();

    // Seed hints from cached token IDs — on refresh, the forward scan covers
    // only a few hundred blocks and won't have Transfer events for old tokens.
    // Without this, resolveOwnedTokens falls through to brute-force ownerOf scans.
    if (cache?.tokensByCollection) {
      for (const [col, ids] of Object.entries(cache.tokensByCollection)) {
        const hintSet = new Set<string>();
        for (const id of ids) {
          // Convert tokenId string to padded hex to match transfer log format
          const hex = BigInt(id).toString(16).padStart(64, "0");
          hintSet.add("0x" + hex);
        }
        if (hintSet.size > 0) allTransferHints.set(col, hintSet);
      }
    }
    if (cache?.erc1155Collections) {
      for (const [col, idBalances] of Object.entries(cache.erc1155Collections)) {
        const existing = allTransferHints.get(col) || new Set<string>();
        for (const id of Object.keys(idBalances)) {
          const hex = BigInt(id).toString(16).padStart(64, "0");
          existing.add("0x" + hex);
        }
        if (existing.size > 0) allTransferHints.set(col, existing);
      }
    }

    // ────── Probe wallet birth (first visit or if not yet known) ──────
    let birthBlock = cache?.birthBlock ?? 0;
    let walletNonce = 0;
    if (!birthBlock) {
      log("[transferScan] Probing for wallet birth block...");
      const probe = await probeWalletBirth(browseChainId, userRpc, ownerAddress, currentBlock);
      birthBlock = probe.birthBlock;
      walletNonce = probe.nonce;
      log(`[transferScan] Wallet birth block: ${birthBlock || "unknown (receive-only)"}, nonce: ${walletNonce}`);
    } else {
      // Cached birth — still fetch current nonce for skip-ahead
      try {
        const noncePool = createRpcPool(browseChainId, userRpc);
        const result = await rpcCall(noncePool.nodes[0].url, "eth_getTransactionCount", [ownerAddress, "latest"]);
        walletNonce = Number(BigInt(result as string));
      } catch { /* nonce=0 means no skip-ahead optimization */ }
    }

    // ────── FORWARD SCAN: cache.forwardEdge+1 → tip ──────
    let forwardFrom: number;
    if (cache) {
      forwardFrom = cache.forwardEdge + 1;
    } else {
      // First visit: do a quick scan of recent blocks to show results fast,
      // then backward scan fills in the rest of history
      const quickScanBlocks = DEFAULT_SCAN_BLOCKS[browseChainId] || 50_000;
      forwardFrom = Math.max(0, currentBlockNum - quickScanBlocks);
      log(`[transferScan] First visit — quick scan of last ${quickScanBlocks} blocks`);
    }

    if (forwardFrom <= currentBlockNum) {
      log(`[transferScan] Forward scan: blocks ${forwardFrom} → ${currentBlockNum}`);

      try {
        const fwdPool = createRpcPool(browseChainId, userRpc);
        const { received } = await scanTransferLogs(
          fwdPool,
          ownerAddress,
          BigInt(forwardFrom),
          currentBlock,
          browseChainId,
          undefined,
          true // incoming only — we only need contract discovery
        );

        for (const [contract, tokenIds] of received.entries()) {
          allCollections.add(contract);
          if (!allTransferHints.has(contract)) allTransferHints.set(contract, new Set());
          for (const id of tokenIds) allTransferHints.get(contract)!.add(id);
        }
      } catch (e) {
        warn("[transferScan] Forward scan error:", e);
      }
    }

    // Save forward edge (preserve existing tokensByCollection)
    cache = {
      forwardEdge: currentBlockNum,
      backwardEdge: cache?.backwardEdge ?? currentBlockNum,
      birthBlock,
      collections: Array.from(allCollections),
      tokensByCollection: cache?.tokensByCollection,
      erc1155Collections: cache?.erc1155Collections,
      pendingRanges: cache?.pendingRanges,
      totalRanges: cache?.totalRanges,
    };
    saveCache(cacheKey, cache);

    // Only resolve collections that are NEW (not already verified from cache).
    // Cached tokens were already ownership-verified above — don't re-resolve them
    // or we'll overwrite good data with sentinels.
    const cachedCollectionKeys = new Set(
      Object.keys(cache?.tokensByCollection || {})
    );
    const newCollections = Array.from(allCollections).filter(
      (c) => !cachedCollectionKeys.has(c)
    );

    // Start with verified cached tokens (already ownership-checked above)
    let allTokens: DiscoveredToken[] = [...verifiedTokens.filter(t => t.tokenId !== BigInt(-1))];

    if (newCollections.length > 0) {
      try {
        log(`[transferScan] Resolving ${newCollections.length} new collections`);
        const newTokens = await resolveOwnedTokens(
          browseChainId,
          userRpc,
          ownerAddress,
          newCollections,
          allTransferHints
        );

        // Merge new tokens with existing verified ones
        for (const t of newTokens) {
          if (t.tokenId !== BigInt(-1)) {
            allTokens.push(t);
          }
        }

        // Update cache with all real tokens
        cache = cacheTokens(cache, allTokens);
        saveCache(cacheKey, cache);
      } catch (e) {
        warn("[transferScan] resolveOwnedTokens error:", e);
      }
    }

    const activeCount = new Set(allTokens.map((t) => t.contractAddress.toLowerCase())).size;
    setResult({
      tokens: allTokens,
      scannedBlocks: currentBlockNum - (cache.backwardEdge ?? currentBlockNum),
      collectionsFound: activeCount,
      isLoading: false,
      isBackScanning: true,
      backwardProgress: cache.backwardEdge <= birthBlock ? 100 : (() => {
        const range = currentBlockNum - birthBlock;
        return range > 0 ? Math.round(((currentBlockNum - cache.backwardEdge) / range) * 100) : 100;
      })(),
    });

    // ────── BACKWARD SCAN: resumable, nonce-guided ──────
    // For receive-only wallets (nonce=0, no outgoing txs), cap backward lookback
    // to avoid scanning entire chain history (e.g., 62M blocks on Monad).
    const MAX_RECEIVE_ONLY_LOOKBACK = 500_000;
    const scanFloor = birthBlock > 0
      ? birthBlock
      : Math.max(0, currentBlockNum - MAX_RECEIVE_ONLY_LOOKBACK);

    // Resume from cached pending/dormant ranges, or classify fresh
    let pendingRanges: ActiveRange[] | undefined = cache.pendingRanges;
    let dormantRanges: ActiveRange[] | undefined = cache.dormantRanges;
    let totalRanges = cache.totalRanges ?? 0;

    const needsClassification = !pendingRanges && !dormantRanges && cache.backwardEdge > scanFloor;

    if (needsClassification && !abortRef.current) {
      const backEdgeStart = cache.backwardEdge;
      const chunkSize = CHUNK_SIZES[browseChainId] || DEFAULT_CHUNK_SIZE;

      if (walletNonce > 0 && birthBlock > 0) {
        log(`[transferScan] Classifying ranges via nonce checkpoints (birth=${birthBlock}, nonce=${walletNonce})...`);
        const classification = await findActiveRanges(
          browseChainId, userRpc, ownerAddress,
          scanFloor, backEdgeStart, walletNonce
        );
        pendingRanges = classification.active.filter((r) => r.from < backEdgeStart);

        // Split large dormant ranges into manageable pieces.
        // Active ranges are already small (≤ minRange from BFS), but dormant
        // ranges can span millions of blocks. Large ranges overwhelm
        // executeLogQueries' 45s timeout, causing queries to be silently dropped.
        const maxRangeSize = chunkSize * 20; // ~10k blocks on Monad
        const rawDormant = classification.dormant.filter((r) => r.from < backEdgeStart);
        dormantRanges = [];
        for (const r of rawDormant) {
          const size = r.to - r.from;
          if (size <= maxRangeSize) {
            dormantRanges.push(r);
          } else {
            for (let b = r.from; b < r.to; b += maxRangeSize) {
              dormantRanges.push({ from: b, to: Math.min(b + maxRangeSize, r.to) });
            }
          }
        }
        log(`[transferScan] ${pendingRanges.length} active + ${dormantRanges.length} dormant ranges to scan (${rawDormant.length} dormant pre-split)`);
      } else {
        const blocksPer = chunkSize * 5;
        pendingRanges = [];
        for (let b = backEdgeStart; b > scanFloor; b -= blocksPer) {
          const from = Math.max(b - blocksPer, scanFloor);
          pendingRanges.push({ from, to: b });
        }
        dormantRanges = [];
      }

      totalRanges = pendingRanges.length + dormantRanges.length;

      // Persist both lists so they survive page reload
      cache = { ...cache!, pendingRanges, dormantRanges, totalRanges };
      saveCache(cacheKey, cache);
    } else if ((pendingRanges && pendingRanges.length > 0) || (dormantRanges && dormantRanges.length > 0)) {
      const activeCount = pendingRanges?.length ?? 0;
      const dormantCount = dormantRanges?.length ?? 0;
      log(`[transferScan] Resuming backward scan — ${activeCount} active + ${dormantCount} dormant ranges remaining (of ${totalRanges} total)`);
    }

    // ── Scan helper: processes a list of ranges in waves ──
    const SCAN_TIMEOUT_MS = 120_000; // 2 minute max per scan session
    const scanStartTime = Date.now();

    const scanRangeList = async (
      ranges: ActiveRange[],
      label: string,
      startCompleted: number
    ): Promise<{ completed: number; remaining: ActiveRange[] }> => {
      let rangesCompleted = startCompleted;
      const WAVE_SIZE = 4;

      for (let waveStart = 0; waveStart < ranges.length; waveStart += WAVE_SIZE) {
        if (abortRef.current || Date.now() - scanStartTime > SCAN_TIMEOUT_MS) {
          return { completed: rangesCompleted, remaining: ranges.slice(waveStart) };
        }

        const wave = ranges.slice(waveStart, waveStart + WAVE_SIZE);
        log(`[transferScan] Scanning ${label} wave: ${wave.length} ranges (${rangesCompleted + 1}–${rangesCompleted + wave.length}/${totalRanges})`);

        // Dispatch all ranges in this wave concurrently
        const waveResults = await Promise.all(
          wave.map(async (range) => {
            try {
              const backPool = createRpcPool(browseChainId, userRpc);
              return await scanTransferLogs(
                backPool, ownerAddress,
                BigInt(range.from), BigInt(range.to),
                browseChainId, undefined, true
              );
            } catch (e) {
              warn(`[transferScan] Range ${range.from}→${range.to} error:`, e);
              return { received: new Map<string, Set<string>>(), sent: new Map<string, Set<string>>() };
            }
          })
        );

        // Process all results from this wave
        let foundNew = false;
        for (const { received } of waveResults) {
          for (const [contract, tokenIds] of received.entries()) {
            if (!allCollections.has(contract)) {
              allCollections.add(contract);
              foundNew = true;
            }
            if (!allTransferHints.has(contract)) allTransferHints.set(contract, new Set());
            for (const id of tokenIds) allTransferHints.get(contract)!.add(id);
          }
        }

        rangesCompleted += wave.length;
        const progress = totalRanges > 0 ? Math.round((rangesCompleted / totalRanges) * 100) : 100;
        const activeRemaining = label === "active" ? ranges.slice(waveStart + WAVE_SIZE) : (pendingRanges ?? []);
        const dormantRemaining = label === "dormant" ? ranges.slice(waveStart + WAVE_SIZE) : (dormantRanges ?? []);
        const lowestScanned = Math.min(
          ...wave.map((r) => r.from),
          cache!.backwardEdge
        );

        // Save progress once per wave — both lists persist for resumption
        cache = {
          forwardEdge: cache!.forwardEdge,
          backwardEdge: lowestScanned,
          birthBlock,
          collections: Array.from(allCollections),
          pendingRanges: activeRemaining.length > 0 ? activeRemaining : undefined,
          dormantRanges: dormantRemaining.length > 0 ? dormantRemaining : undefined,
          totalRanges: (activeRemaining.length + dormantRemaining.length) > 0 ? totalRanges : undefined,
          tokensByCollection: cache!.tokensByCollection,
          erc1155Collections: cache!.erc1155Collections,
        };
        saveCache(cacheKey, cache);

        if (foundNew) {
          log(`[transferScan] Found new collections in ${label} wave, re-resolving...`);
          try {
            const tokens = await resolveOwnedTokens(
              browseChainId, userRpc, ownerAddress,
              Array.from(allCollections),
              allTransferHints
            );

            cache = cacheTokens(cache!, tokens);
            saveCache(cacheKey, cache);

            const activeCount = new Set(tokens.map((t) => t.contractAddress.toLowerCase())).size;

            setResult({
              tokens,
              scannedBlocks: currentBlockNum - lowestScanned,
              collectionsFound: activeCount,
              isLoading: false,
              isBackScanning: true,
              backwardProgress: progress,
            });
          } catch (e) {
            warn("[transferScan] Re-resolve error:", e);
          }
        } else {
          setResult((prev) => ({
            ...prev,
            scannedBlocks: currentBlockNum - lowestScanned,
            isBackScanning: true,
            backwardProgress: progress,
          }));
        }
      }

      return { completed: rangesCompleted, remaining: [] };
    };

    // ── Phase 1: Scan ACTIVE ranges first (high priority — wallet was transacting) ──
    let rangesCompleted = totalRanges - (pendingRanges?.length ?? 0) - (dormantRanges?.length ?? 0);

    if (pendingRanges && pendingRanges.length > 0 && !abortRef.current) {
      log(`[transferScan] Phase 1: Scanning ${pendingRanges.length} active ranges...`);
      const result = await scanRangeList(pendingRanges, "active", rangesCompleted);
      rangesCompleted = result.completed;
      pendingRanges = result.remaining.length > 0 ? result.remaining : undefined;
    }

    // ── Phase 2: Scan DORMANT ranges (low priority — wallet was idle, but could have received NFTs) ──
    if (dormantRanges && dormantRanges.length > 0 && !abortRef.current) {
      log(`[transferScan] Phase 2: Scanning ${dormantRanges.length} dormant ranges...`);
      const result = await scanRangeList(dormantRanges, "dormant", rangesCompleted);
      rangesCompleted = result.completed;
      dormantRanges = result.remaining.length > 0 ? result.remaining : undefined;
    }

    // Mark backward scan as complete
    if (!abortRef.current && !pendingRanges?.length && !dormantRanges?.length) {
      cache = { ...cache!, backwardEdge: scanFloor, pendingRanges: undefined, dormantRanges: undefined, totalRanges: undefined };
      saveCache(cacheKey, cache);
      log(`[transferScan] Backward scan complete — ${rangesCompleted}/${totalRanges} ranges scanned`);
    }

    setResult((prev) => ({ ...prev, isBackScanning: false, backwardProgress: 100 }));
    runningRef.current = false;
  }, [ownerAddress, browseChainId, getEffectiveRpc]);

  useEffect(() => {
    abortRef.current = true; // abort any previous scan
    runningRef.current = false;

    // Small delay to let abort propagate
    const timer = setTimeout(() => {
      scan();
    }, 100);

    return () => {
      abortRef.current = true;
      clearTimeout(timer);
    };
  }, [scan]);

  // On Hypersync-supported chains, return that hook's result instead of the
  // RPC scan's. Both hooks have run — rules of hooks — but the RPC scan
  // bailed early at the top of scan().
  return hasHypersync(browseChainId) ? hypersyncResult : result;
}

// ────────────────────── Collection Transfer Scan Hook ──────────────────────

/**
 * Scan Transfer logs for a SINGLE collection to discover token IDs owned by the user.
 * More targeted than useWalletTransferScan — fewer log queries, less rate-limiting risk.
 * Verifies ownership via ownerOf multicall after log discovery.
 */
export function useCollectionTransferScan(
  ownerAddress: `0x${string}` | undefined,
  collectionAddress: `0x${string}` | undefined
) {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  return useQuery({
    queryKey: ["transfer-scan-collection", browseChainId, ownerAddress, collectionAddress],
    queryFn: async (): Promise<DiscoveredToken[]> => {
      if (!ownerAddress || !collectionAddress) return [];

      const userRpc = getEffectiveRpc(browseChainId);
      const pool = createRpcPool(browseChainId, userRpc);

      if (pool.nodes.length === 0) return [];

      const currentBlock = await getBlockNumberViaPool(pool);
      const chunkSize = CHUNK_SIZES[browseChainId] || DEFAULT_CHUNK_SIZE;
      const scanDepth = BigInt(chunkSize * 20); // scan a reasonable window
      const fromBlock = currentBlock - scanDepth > 0n ? currentBlock - scanDepth : 0n;

      const { received, sent } = await scanTransferLogs(
        pool,
        ownerAddress,
        fromBlock,
        currentBlock,
        browseChainId,
        collectionAddress
      );

      const colKey = collectionAddress.toLowerCase();
      const receivedIds = received.get(colKey) || new Set<string>();
      const sentIds = sent.get(colKey) || new Set<string>();

      const candidateIds: bigint[] = [];
      for (const rawId of receivedIds) {
        if (!sentIds.has(rawId)) {
          candidateIds.push(BigInt(rawId));
        }
      }

      if (candidateIds.length === 0) return [];

      // Check if the contract is ERC-1155 or ERC-721
      const typePool = createRpcPool(browseChainId, userRpc);
      const typeCalls: MulticallRequest[] = [
        encodeCall(collectionAddress, ERC1155_ABI, "supportsInterface", [ERC1155_INTERFACE_ID]),
      ];
      const typeResults = await executeBatchedMulticalls(typePool, typeCalls);
      const is1155 = typeResults.flat()[0]
        ? decodeResult<boolean>(ERC1155_ABI, "supportsInterface", typeResults.flat()[0])
        : false;

      const verifyPool = createRpcPool(browseChainId, userRpc);
      const normalizedOwner = ownerAddress.toLowerCase();
      const verifiedTokens: DiscoveredToken[] = [];

      if (is1155) {
        // ERC-1155: check balanceOf(account, id) for each candidate
        const balCalls: MulticallRequest[] = candidateIds.map((id) =>
          encodeCall(collectionAddress, ERC1155_ABI, "balanceOf", [ownerAddress, id])
        );
        const balResults = await executeBatchedMulticalls(verifyPool, balCalls);
        const flatBal = balResults.flat();
        for (let j = 0; j < flatBal.length; j++) {
          const entry = flatBal[j];
          if (!entry || !entry.success) continue;
          const bal = decodeResult<bigint>(ERC1155_ABI, "balanceOf", entry);
          if (bal && bal > 0n) {
            verifiedTokens.push({
              contractAddress: collectionAddress,
              tokenId: candidateIds[j],
              is1155: true,
              balance1155: bal,
            });
          }
        }
      } else {
        // ERC-721: check ownerOf for each candidate
        const ownerOfCalls: MulticallRequest[] = candidateIds.map((id) =>
          encodeCall(collectionAddress, ERC721_ABI, "ownerOf", [id])
        );
        const ownerResults = await executeBatchedMulticalls(verifyPool, ownerOfCalls);
        let idx = 0;
        for (const batch of ownerResults) {
          for (const entry of batch) {
            const owner = decodeResult<string>(ERC721_ABI, "ownerOf", entry);
            if (owner && owner.toLowerCase() === normalizedOwner) {
              verifiedTokens.push({
                contractAddress: collectionAddress,
                tokenId: candidateIds[idx],
              });
            }
            idx++;
          }
        }
      }

      return verifiedTokens;
    },
    enabled: !!ownerAddress && !!collectionAddress,
    staleTime: 120_000,
    gcTime: 300_000,
  });
}
