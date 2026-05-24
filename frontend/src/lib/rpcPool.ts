/**
 * Smart RPC pool with rate-limit tracking, node health, and Multicall3 batching.
 * Uses raw `eth_call` to Multicall3's `tryAggregate` — one RPC request per batch.
 */

import { mainnet, base, arbitrum, optimism, polygon, sepolia } from "wagmi/chains";
import { monad } from "@/config/chains";
import {
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
} from "viem";

// Debug logging — silent in production
const DEBUG = process.env.NODE_ENV === "development";
const warn = (...args: unknown[]) => { if (DEBUG) console.warn(...args); };

// ═══════════════════════════ RPC ENDPOINTS ═══════════════════════════

// All RPCs must support CORS (Access-Control-Allow-Origin) since all calls
// originate from the browser. llamarpc.com is excluded — it blocks browser requests.
export const RPC_POOLS: Record<number, string[]> = {
  [mainnet.id]: [
    "https://ethereum.publicnode.com",
    "https://rpc.ankr.com/eth",
    "https://1rpc.io/eth",
    "https://eth.drpc.org",
    "https://cloudflare-eth.com",
    "https://eth.merkle.io",
    "https://rpc.flashbots.net",
    "https://eth-mainnet.public.blastapi.io",
  ],
  [monad.id]: [
    "https://rpc3.monad.xyz",
    "https://rpc-mainnet.monadinfra.com",
    "https://rpc4.monad.xyz",
    "https://infra.originstake.com/monad/evm",
    "https://rpc.sentio.xyz/monad-mainnet",
  ],
  [base.id]: [
    "https://mainnet.base.org",
    "https://base.publicnode.com",
    "https://1rpc.io/base",
    "https://base.drpc.org",
    "https://base-mainnet.public.blastapi.io",
    "https://base.merkle.io",
  ],
  [arbitrum.id]: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one.publicnode.com",
    "https://1rpc.io/arb",
    "https://arbitrum.drpc.org",
    "https://arbitrum-one.public.blastapi.io",
    "https://arbitrum.merkle.io",
  ],
  [optimism.id]: [
    "https://mainnet.optimism.io",
    "https://optimism.publicnode.com",
    "https://1rpc.io/op",
    "https://optimism.drpc.org",
    "https://optimism-mainnet.public.blastapi.io",
    "https://optimism.merkle.io",
  ],
  [polygon.id]: [
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
    "https://polygon.drpc.org",
    "https://polygon-mainnet.public.blastapi.io",
    "https://polygon.merkle.io",
  ],
  [sepolia.id]: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://rpc2.sepolia.org",
    "https://sepolia.drpc.org",
    "https://ethereum-sepolia.public.blastapi.io",
  ],
};

// ═══════════════════════════ CHAIN CONFIGS ═══════════════════════════

export const DEFAULT_SCAN_BLOCKS: Record<number, number> = {
  [mainnet.id]: 50_000,
  [monad.id]: 50_000,
  [base.id]: 100_000,
  [arbitrum.id]: 100_000,
  [optimism.id]: 100_000,
  [polygon.id]: 50_000,
  [sepolia.id]: 50_000,
};

export const CHUNK_SIZES: Record<number, number> = {
  [mainnet.id]: 3000,
  [monad.id]: 2000,
  [base.id]: 3000,
  [arbitrum.id]: 3000,
  [optimism.id]: 3000,
  [polygon.id]: 2000,
  [sepolia.id]: 3000,
};

export const DEFAULT_CHUNK_SIZE = 3000;

// ═══════════════════════════ RPC POOL ═══════════════════════════

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const RATE_LIMIT_COOLDOWN_MS = 2000;
const DELAY_BETWEEN_DISPATCHES_MS = 100;
const MULTICALL_BATCH_SIZE = 150;

// Per-chain multicall batch size overrides — some chains have lower eth_call gas limits
const MULTICALL_BATCH_SIZES: Record<number, number> = {
  [monad.id]: 50, // Monad RPCs — 50 ownerOf calls per multicall batch
};

export function getMulticallBatchSize(chainId?: number): number {
  if (chainId && MULTICALL_BATCH_SIZES[chainId]) return MULTICALL_BATCH_SIZES[chainId];
  return MULTICALL_BATCH_SIZE;
}

interface RpcNode {
  url: string;
  available: boolean;
  failCount: number;
  rateLimitedUntil: number;
}

export interface RpcPool {
  nodes: RpcNode[];
  chainId?: number;
}

// Singleton pool cache — preserves node health across calls
const poolCache = new Map<string, { pool: RpcPool; createdAt: number }>();
const POOL_TTL_MS = 60_000; // Reset pool health after 60s

export function createRpcPool(chainId: number, userRpc?: string): RpcPool {
  const cacheKey = `${chainId}:${userRpc || ""}`;
  const cached = poolCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < POOL_TTL_MS) {
    // Reset rate limits that have expired
    const now = Date.now();
    for (const node of cached.pool.nodes) {
      if (node.rateLimitedUntil > 0 && node.rateLimitedUntil <= now) {
        node.rateLimitedUntil = 0;
      }
    }
    return cached.pool;
  }

  const rpcs = [...(RPC_POOLS[chainId] || [])];
  if (userRpc && !rpcs.includes(userRpc)) {
    rpcs.unshift(userRpc);
  }
  const pool: RpcPool = {
    chainId,
    nodes: rpcs.map((url) => ({
      url,
      available: true,
      failCount: 0,
      rateLimitedUntil: 0,
    })),
  };

  poolCache.set(cacheKey, { pool, createdAt: Date.now() });
  return pool;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Round-robin counter for distributing requests evenly across nodes
let rrCounter = 0;

function roundRobinOrder<T>(arr: T[]): T[] {
  if (arr.length <= 1) return arr;
  const start = rrCounter++ % arr.length;
  return [...arr.slice(start), ...arr.slice(0, start)];
}

// ═══════════════════════════ RAW RPC CALL ═══════════════════════════

export async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (response.status === 429 || response.status === 413) {
    const err = new Error(`Rate limited (${response.status})`) as Error & { isRateLimit: boolean };
    err.isRateLimit = true;
    throw err;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || "RPC error");
  }

  return json.result;
}

// ═══════════════════════════ MULTICALL3 BATCHING ═══════════════════════════

const MULTICALL3_ABI = [
  {
    inputs: [
      { name: "requireSuccess", type: "bool" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    name: "tryAggregate",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface MulticallRequest {
  target: `0x${string}`;
  callData: `0x${string}`;
}

export interface MulticallResult {
  success: boolean;
  returnData: `0x${string}`;
}

/**
 * Encode a contract call into target + callData for Multicall3.
 */
export function encodeCall(
  target: `0x${string}`,
  abi: Abi,
  functionName: string,
  args: unknown[]
): MulticallRequest {
  const callData = encodeFunctionData({
    abi,
    functionName,
    args,
  });
  return { target, callData };
}

/**
 * Decode a Multicall3 result for a specific function.
 */
export function decodeResult<T>(
  abi: Abi,
  functionName: string,
  result: MulticallResult
): T | null {
  if (!result.success || result.returnData === "0x") return null;
  try {
    return decodeFunctionResult({
      abi,
      functionName,
      data: result.returnData,
    }) as T;
  } catch {
    return null;
  }
}

/**
 * Execute batched Multicall3 calls across the RPC pool with rate-limit handling.
 * Each batch = 1 RPC request to tryAggregate. Failed batches get retried on other nodes.
 */
const MAX_BATCH_RETRIES = 5;
const MULTICALL_TIMEOUT_MS = 30_000;
const LOG_QUERY_TIMEOUT_MS = 45_000;

export async function executeBatchedMulticalls(
  pool: RpcPool,
  calls: MulticallRequest[],
  batchSize?: number
): Promise<MulticallResult[][]> {
  const effectiveBatchSize = batchSize ?? getMulticallBatchSize(pool.chainId);
  // Split calls into batches
  const batches: MulticallRequest[][] = [];
  for (let i = 0; i < calls.length; i += effectiveBatchSize) {
    batches.push(calls.slice(i, i + effectiveBatchSize));
  }

  const results: (MulticallResult[] | null)[] = new Array(batches.length).fill(null);
  const pendingIndices: number[] = batches.map((_, i) => i);
  const retryCount = new Map<number, number>();
  const activeFetches = new Map<string, Promise<void>>();
  const startTime = Date.now();

  while (pendingIndices.length > 0 || activeFetches.size > 0) {
    // Circuit breaker: return whatever we have after timeout
    if (Date.now() - startTime > MULTICALL_TIMEOUT_MS) {
      if (activeFetches.size > 0) {
        await Promise.allSettled([...activeFetches.values()]);
      }
      break;
    }

    // Check if all nodes are permanently failed (not just rate-limited)
    const now = Date.now();
    const hasUsableNodes = pool.nodes.some(
      (n) => n.available || n.rateLimitedUntil > now
    );
    if (!hasUsableNodes && pendingIndices.length > 0 && activeFetches.size === 0) {
      break;
    }

    let dispatched = 0;

    for (const node of roundRobinOrder(pool.nodes)) {
      if (activeFetches.has(node.url)) continue;
      if (!node.available) continue;
      if (node.rateLimitedUntil > now) continue;
      if (pendingIndices.length === 0) break;

      const batchIdx = pendingIndices.shift()!;
      const batch = batches[batchIdx];
      dispatched++;

      activeFetches.set(
        node.url,
        (async () => {
          try {
            // Encode tryAggregate call
            const calldata = encodeFunctionData({
              abi: MULTICALL3_ABI,
              functionName: "tryAggregate",
              args: [
                false,
                batch.map((c) => ({ target: c.target, callData: c.callData })),
              ],
            });

            const rawResult = (await rpcCall(node.url, "eth_call", [
              { to: MULTICALL3_ADDRESS, data: calldata },
              "latest",
            ])) as `0x${string}`;

            // Decode tryAggregate response
            // viem returns single-output functions unwrapped, but may vary by version
            const raw = decodeFunctionResult({
              abi: MULTICALL3_ABI,
              functionName: "tryAggregate",
              data: rawResult,
            });
            // Handle both wrapped [Array<tuple>] and unwrapped Array<tuple> forms
            const entries = (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]))
              ? raw[0] as Array<{ success: boolean; returnData: `0x${string}` }>
              : raw as unknown as Array<{ success: boolean; returnData: `0x${string}` }>;

            results[batchIdx] = entries.map((entry) => ({
              success: entry.success,
              returnData: entry.returnData,
            }));

            node.failCount = 0;
          } catch (err: unknown) {
            warn(`[executeBatchedMulticalls] Batch ${batchIdx} failed on ${node.url}:`, (err as Error).message || err);

            const errMsg = (err as Error).message || "";
            const isRateLimit =
              (err as Error & { isRateLimit?: boolean }).isRateLimit ||
              errMsg.includes("429");
            const isGasLimit = errMsg.includes("gas exceeds") || errMsg.includes("gas limit");

            if (isRateLimit) {
              node.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            } else if (isGasLimit) {
              // Permanently mark this node — it can't handle multicalls at this batch size
              node.available = false;
              warn(`[executeBatchedMulticalls] Node ${node.url} marked dead — gas limit too low for multicalls`);
            } else {
              node.failCount++;
              if (node.failCount >= 10) {
                node.available = false;
                warn(`[executeBatchedMulticalls] Node ${node.url} marked dead after ${node.failCount} failures`);
              }
            }
            // Rate-limit retries don't count — they'll succeed after cooldown
            if (isRateLimit) {
              pendingIndices.unshift(batchIdx);
            } else {
              const attempts = (retryCount.get(batchIdx) || 0) + 1;
              retryCount.set(batchIdx, attempts);
              if (attempts < MAX_BATCH_RETRIES) {
                pendingIndices.push(batchIdx);
              } else {
                warn(`[executeBatchedMulticalls] Batch ${batchIdx} ABANDONED after ${attempts} retries`);
              }
            }
          } finally {
            activeFetches.delete(node.url);
          }
        })()
      );
    }

    if (dispatched > 0) {
      await sleep(DELAY_BETWEEN_DISPATCHES_MS);
    }

    if (activeFetches.size > 0) {
      await Promise.race([...activeFetches.values(), sleep(100)]);
    } else if (pendingIndices.length > 0) {
      // All nodes rate-limited or busy — wait for earliest cooldown
      const now2 = Date.now();
      const rateLimitedNodes = pool.nodes.filter(
        (n) => n.available && n.rateLimitedUntil > now2
      );
      if (rateLimitedNodes.length > 0) {
        const earliestExpiry = Math.min(...rateLimitedNodes.map((n) => n.rateLimitedUntil));
        await sleep(Math.max(earliestExpiry - now2, 50));
      } else {
        warn("[executeBatchedMulticalls] All nodes permanently dead, aborting", pendingIndices.length, "remaining batches");
        break;
      }
    }
  }

  const succeeded = results.filter(r => r !== null).length;
  const failed = results.filter(r => r === null).length;
  if (failed > 0) {
    warn(`[executeBatchedMulticalls] Done: ${succeeded}/${batches.length} batches succeeded, ${failed} failed`);
  }

  return results.map((r) => r || []);
}

// ═══════════════════════════ LOG QUERY DISPATCH ═══════════════════════════

export interface LogQueryParams {
  fromBlock: `0x${string}`;
  toBlock: `0x${string}`;
  topics: (string | string[] | null)[];
  address?: string;
}

export interface RawLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/**
 * Dispatch eth_getLogs queries across the RPC pool with rate-limit handling.
 * Same Promise.race dispatch pattern as executeBatchedMulticalls but for log queries.
 */
export async function executeLogQueries(
  pool: RpcPool,
  queries: LogQueryParams[]
): Promise<RawLogEntry[][]> {
  if (queries.length === 0) return [];

  const MAX_CONCURRENT_PER_NODE = 2;

  const results: (RawLogEntry[] | null)[] = new Array(queries.length).fill(null);
  const pendingIndices: number[] = queries.map((_, i) => i);
  const retryCount = new Map<number, number>();
  const activeFetches = new Map<string, Promise<void>>();
  const nodeActiveCount = new Map<string, number>();
  const startTime = Date.now();

  while (pendingIndices.length > 0 || activeFetches.size > 0) {
    // Circuit breaker: return whatever we have after timeout
    if (Date.now() - startTime > LOG_QUERY_TIMEOUT_MS) {
      if (activeFetches.size > 0) {
        await Promise.allSettled([...activeFetches.values()]);
      }
      break;
    }

    const now = Date.now();
    const hasUsableNodes = pool.nodes.some(
      (n) => n.available || n.rateLimitedUntil > now
    );
    if (!hasUsableNodes && pendingIndices.length > 0 && activeFetches.size === 0) {
      break;
    }

    let dispatched = 0;

    for (const node of roundRobinOrder(pool.nodes)) {
      const activeCount = nodeActiveCount.get(node.url) || 0;
      if (activeCount >= MAX_CONCURRENT_PER_NODE) continue;
      if (!node.available) continue;
      if (node.rateLimitedUntil > now) continue;
      if (pendingIndices.length === 0) break;

      const queryIdx = pendingIndices.shift()!;
      const query = queries[queryIdx];
      dispatched++;

      const fetchId = `${node.url}:${queryIdx}`;
      nodeActiveCount.set(node.url, activeCount + 1);

      activeFetches.set(
        fetchId,
        (async () => {
          try {
            const params: Record<string, unknown> = {
              fromBlock: query.fromBlock,
              toBlock: query.toBlock,
              topics: query.topics,
            };
            if (query.address) params.address = query.address;

            const rawResult = await rpcCall(node.url, "eth_getLogs", [params]);
            results[queryIdx] = (rawResult as RawLogEntry[]) || [];
            node.failCount = 0;
          } catch (err: unknown) {
            const isRateLimit =
              (err as Error & { isRateLimit?: boolean }).isRateLimit ||
              (err instanceof Error && err.message.includes("429"));

            if (isRateLimit) {
              node.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            } else {
              node.failCount++;
              if (node.failCount >= 10) {
                node.available = false;
              }
            }

            // Rate-limit retries don't count — they'll succeed after cooldown
            if (isRateLimit) {
              pendingIndices.unshift(queryIdx);
            } else {
              const attempts = (retryCount.get(queryIdx) || 0) + 1;
              retryCount.set(queryIdx, attempts);
              if (attempts < MAX_BATCH_RETRIES) {
                pendingIndices.push(queryIdx);
              }
            }
          } finally {
            activeFetches.delete(fetchId);
            const count = nodeActiveCount.get(node.url) || 1;
            nodeActiveCount.set(node.url, count - 1);
          }
        })()
      );
    }

    if (dispatched > 0) {
      await sleep(DELAY_BETWEEN_DISPATCHES_MS);
    }

    if (activeFetches.size > 0) {
      await Promise.race([...activeFetches.values(), sleep(100)]);
    } else if (pendingIndices.length > 0) {
      // All nodes rate-limited or busy — wait for earliest cooldown
      const now2 = Date.now();
      const rateLimitedNodes = pool.nodes.filter(
        (n) => n.available && n.rateLimitedUntil > now2
      );
      if (rateLimitedNodes.length > 0) {
        const earliestExpiry = Math.min(...rateLimitedNodes.map((n) => n.rateLimitedUntil));
        await sleep(Math.max(earliestExpiry - now2, 50));
      } else {
        // All nodes permanently dead
        break;
      }
    }
  }

  return results.map((r) => r || []);
}

/**
 * Get current block number from the first available node in the pool.
 */
export async function getBlockNumberViaPool(pool: RpcPool): Promise<bigint> {
  for (const node of pool.nodes) {
    if (!node.available) continue;
    try {
      const result = await rpcCall(node.url, "eth_blockNumber", []);
      return BigInt(result as string);
    } catch {
      node.failCount++;
      if (node.failCount >= 10) node.available = false;
    }
  }
  throw new Error("All RPC nodes failed for eth_blockNumber");
}
