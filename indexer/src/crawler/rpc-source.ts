import type { ChainSource, ChainLog, LogFilter } from "./source.js";

/**
 * Multi-RPC implementation of ChainSource. Round-robins across the
 * configured RPC endpoints with per-node health tracking. When a node
 * 429s we cool it down for COOLDOWN_MS; when it errors we increment a
 * failCount and skip it for the next request. After all nodes have been
 * tried we throw — the caller (bootstrap / poll loop) decides whether
 * to back off + retry.
 *
 * Paginates eth_getLogs internally: callers ask for an arbitrary block
 * range, we split it into MAX_BLOCK_RANGE chunks. If a chunk returns a
 * "too many results" error, we halve and retry recursively so the caller
 * never has to know about provider limits.
 */

const MAX_BLOCK_RANGE = 10_000;
const MIN_BLOCK_RANGE_BEFORE_GIVING_UP = 32;
const COOLDOWN_MS = 2_000;

interface RpcNode {
  url: string;
  rateLimitedUntil: number;
  failCount: number;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
}

export class RpcSource implements ChainSource {
  private readonly nodes: RpcNode[];
  private rrIndex = 0;

  constructor(urls: readonly string[]) {
    if (urls.length === 0) throw new Error("RpcSource requires at least one URL");
    this.nodes = urls.map((url) => ({ url, rateLimitedUntil: 0, failCount: 0 }));
  }

  async getCurrentBlock(): Promise<number> {
    const result = await this.call<string>("eth_blockNumber", []);
    return parseInt(result, 16);
  }

  async getLogs(filter: LogFilter): Promise<ChainLog[]> {
    const out: ChainLog[] = [];
    let cursor = filter.fromBlock;
    while (cursor <= filter.toBlock) {
      const chunkEnd = Math.min(cursor + MAX_BLOCK_RANGE - 1, filter.toBlock);
      const chunk = await this.getLogsChunk({
        ...filter,
        fromBlock: cursor,
        toBlock: chunkEnd,
      });
      out.push(...chunk);
      cursor = chunkEnd + 1;
    }
    return out;
  }

  /**
   * Single-chunk getLogs with adaptive splitting. If the RPC complains
   * "too many results" / "limit exceeded" / similar, we halve the range
   * and recurse. Bottoms out at MIN_BLOCK_RANGE_BEFORE_GIVING_UP.
   */
  private async getLogsChunk(filter: LogFilter): Promise<ChainLog[]> {
    const params = [
      {
        fromBlock: "0x" + filter.fromBlock.toString(16),
        toBlock: "0x" + filter.toBlock.toString(16),
        // topics[0] is OR-array, topics[1..] are wildcard. This is the
        // "any of these event sigs from any contract" shape we want for
        // a chain-wide Transfer sweep.
        topics: [filter.eventSignatures as string[]],
        ...(filter.addresses && filter.addresses.length > 0
          ? { address: filter.addresses as string[] }
          : {}),
      },
    ];

    try {
      const raw = await this.call<RawLog[]>("eth_getLogs", params);
      return raw.map(parseLog);
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err);
      const rangeSize = filter.toBlock - filter.fromBlock + 1;
      const isRangeError =
        msg.includes("too many") ||
        msg.includes("limit") ||
        msg.includes("range") ||
        msg.includes("response size") ||
        msg.includes("result set");
      if (isRangeError && rangeSize > MIN_BLOCK_RANGE_BEFORE_GIVING_UP) {
        const mid = filter.fromBlock + Math.floor(rangeSize / 2);
        const left = await this.getLogsChunk({ ...filter, toBlock: mid - 1 });
        const right = await this.getLogsChunk({ ...filter, fromBlock: mid });
        return [...left, ...right];
      }
      throw err;
    }
  }

  /**
   * Round-robin RPC call with cooldown + retry. Returns the first
   * successful response. Throws an aggregated error if every healthy
   * node fails.
   */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const errors: string[] = [];
    const now = Date.now();
    // Snapshot the ordered node list for this call. lastIdx tracks how
    // far into the cycle we've advanced for round-robin fairness.
    const order: RpcNode[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[(this.rrIndex + i) % this.nodes.length]!;
      order.push(node);
    }
    this.rrIndex = (this.rrIndex + 1) % this.nodes.length;

    for (const node of order) {
      if (node.rateLimitedUntil > now) {
        errors.push(`${hostOf(node.url)}: cooling down`);
        continue;
      }
      try {
        const resp = await jsonRpc<T>(node.url, method, params);
        if (resp.error) {
          // RPC-level error. Don't trip rate-limit cooldown — it's a
          // user-level failure (bad method, bad params) most of the time.
          throw new Error(resp.error.message);
        }
        node.failCount = 0;
        return resp.result as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${hostOf(node.url)}: ${msg}`);
        const lower = msg.toLowerCase();
        if (lower.includes("429") || lower.includes("rate") || lower.includes("too many requests")) {
          node.rateLimitedUntil = Date.now() + COOLDOWN_MS;
        }
        node.failCount += 1;
        // Don't break — let the loop try the next node.
      }
    }
    throw new Error(
      `All RPCs failed for ${method}: ${errors.join("; ")}`,
    );
  }

  /** For debugging / metrics. */
  describe(): string {
    return this.nodes
      .map((n) => `${hostOf(n.url)}(fails=${n.failCount})`)
      .join(", ");
  }
}

// ── helpers ──────────────────────────────────────────────────────

async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<JsonRpcResponse<T>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (resp.status === 429) {
      throw new Error(`HTTP 429 rate limited`);
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return (await resp.json()) as JsonRpcResponse<T>;
  } finally {
    clearTimeout(t);
  }
}

function parseLog(raw: RawLog): ChainLog {
  return {
    blockNumber: parseInt(raw.blockNumber, 16),
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: parseInt(raw.transactionIndex, 16),
    logIndex: parseInt(raw.logIndex, 16),
    address: raw.address.toLowerCase(),
    topics: raw.topics,
    data: raw.data,
    removed: raw.removed,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
