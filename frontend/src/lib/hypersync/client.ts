/**
 * Envio Hypersync client — fast bulk log queries for the wallet scanner.
 *
 * Hypersync is a free, public, indexer-replacement service that exposes a
 * JSON query endpoint optimised for bulk log retrieval. A single query
 * sweeps any block range and pages with `next_block` until we catch up
 * with `archive_height`.
 *
 * Why this over RPC eth_getLogs on Monad:
 *   - RPC chunks are capped at ~2000 blocks/call with low rate limits.
 *     Scanning 60M+ blocks via RPC takes many minutes and frequently drops
 *     events under rate-limit pressure.
 *   - Hypersync streams the same data in a few seconds with no key.
 *
 * Reference: https://docs.envio.dev/docs/HyperSync/overview
 */

// ── chain → endpoint map ──────────────────────────────────────────
// Extend here when adding other Hypersync-supported chains.
//
// Envio's public Hypersync endpoint doesn't send CORS headers, so browser
// requests need to go through a CORS proxy. Source lives in
// `cloudflare-worker/` in this repo — deploy with `wrangler deploy` to
// publish updates.
export const HYPERSYNC_ENDPOINTS: Record<number, string> = {
  143: "https://monad-hypersync-proxy.devskibb.workers.dev", // Monad mainnet (CORS proxy → monad.hypersync.xyz)
};

function parseRetryAfterSeconds(header: string | null): number {
  if (!header) return 5;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(60, Math.max(1, Math.round(n)));
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(1, Math.min(60, Math.ceil((dateMs - Date.now()) / 1000)));
  }
  return 5;
}

export function hasHypersync(chainId: number): boolean {
  return chainId in HYPERSYNC_ENDPOINTS;
}

// ── event signatures ──────────────────────────────────────────────
// keccak256 of the event signatures:
//   Transfer(address,address,uint256)               — ERC-20/721 (3 topics indexed)
//   TransferSingle(address,address,address,uint256,uint256)
//   TransferBatch(address,address,address,uint256[],uint256[])
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
export const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

// ── address padding ───────────────────────────────────────────────
function padAddress(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

// ── response types ────────────────────────────────────────────────
export interface HypersyncLog {
  address: `0x${string}`;
  topics: (string | null)[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

interface HypersyncRawLog {
  address?: string;
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  data?: string;
  block_number?: number;
  transaction_hash?: string;
  log_index?: number;
}

interface HypersyncBatch {
  logs?: HypersyncRawLog[];
}

interface HypersyncResponse {
  data: HypersyncBatch[];
  next_block: number;
  archive_height: number;
  total_execution_time?: number;
}

function normalizeLog(raw: HypersyncRawLog): HypersyncLog | null {
  if (!raw.address || !raw.topic0 || raw.block_number == null) return null;
  return {
    address: raw.address as `0x${string}`,
    topics: [raw.topic0, raw.topic1 ?? null, raw.topic2 ?? null, raw.topic3 ?? null],
    data: raw.data ?? "0x",
    blockNumber: raw.block_number,
    transactionHash: raw.transaction_hash ?? "0x",
    logIndex: raw.log_index ?? 0,
  };
}

// ── core query ────────────────────────────────────────────────────
/**
 * Stream all incoming NFT-transfer events for a wallet on the given chain.
 *
 * Issues a Hypersync query for:
 *   - ERC-721 Transfer logs where topic[2] (to) === user
 *   - ERC-1155 TransferSingle/Batch logs where topic[3] (to) === user
 *
 * Pages via `next_block` until we reach `archive_height`. Returns the union.
 */
export async function queryIncomingTransfers(
  chainId: number,
  userAddress: `0x${string}`,
  fromBlock: number = 0,
  onProgress?: (block: number, target: number, found: number) => void,
): Promise<{ logs: HypersyncLog[]; lastBlock: number }> {
  const endpoint = HYPERSYNC_ENDPOINTS[chainId];
  if (!endpoint) throw new Error(`Hypersync not configured for chain ${chainId}`);

  const padded = padAddress(userAddress);
  const allLogs: HypersyncLog[] = [];
  let cursor = fromBlock;
  let target = fromBlock; // updated from first response's archive_height

  for (let safety = 0; safety < 200; safety++) {
    const body = {
      from_block: cursor,
      // Two log selectors: one for ERC-721, one for ERC-1155. Each only
      // matches when the relevant `to` topic equals the user — Hypersync
      // filters server-side, dramatically smaller payloads than scanning
      // all Transfer events.
      logs: [
        {
          // ERC-721 Transfer(from, to, tokenId) — to is topic[2]
          topics: [
            [TRANSFER_TOPIC],
            [], // any from
            [padded],
            [], // tokenId
          ],
        },
        {
          // ERC-1155 TransferSingle / TransferBatch — to is topic[3]
          topics: [
            [TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC],
            [], // operator
            [], // from
            [padded],
          ],
        },
      ],
      field_selection: {
        log: [
          "address",
          "topic0",
          "topic1",
          "topic2",
          "topic3",
          "data",
          "block_number",
          "transaction_hash",
          "log_index",
        ],
      },
    };

    const resp = await fetch(`${endpoint}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      const retryAfter = parseRetryAfterSeconds(resp.headers.get("retry-after"));
      const err = new Error(`Hypersync rate-limited (429)`) as Error & {
        isRateLimit: true;
        retryAfterSeconds: number;
      };
      err.isRateLimit = true;
      err.retryAfterSeconds = retryAfter;
      throw err;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Hypersync ${resp.status}: ${text.slice(0, 200)}`);
    }

    const parsed = (await resp.json()) as HypersyncResponse;
    target = parsed.archive_height;

    for (const batch of parsed.data) {
      if (!batch.logs) continue;
      for (const raw of batch.logs) {
        const norm = normalizeLog(raw);
        if (norm) allLogs.push(norm);
      }
    }

    cursor = parsed.next_block;
    onProgress?.(cursor, target, allLogs.length);

    // Hypersync paginates server-side. Done when next_block reaches archive_height.
    if (cursor >= target) break;
  }

  return { logs: allLogs, lastBlock: cursor };
}

// ── derive collections + token IDs from logs ──────────────────────
export interface TransferEvent {
  contract: `0x${string}`;
  tokenId: bigint;
  blockNumber: number;
  is1155: boolean;
}

/**
 * Walk the log payloads and extract (contract, tokenId, kind) tuples. The
 * caller still has to verify current ownership — these tell us what the
 * wallet ever received, not what it currently holds.
 *
 * For ERC-721 the tokenId is topic[3]. For ERC-1155 TransferSingle the
 * tokenId is in `data[0..32]`. For TransferBatch the IDs are in a
 * dynamically-encoded uint256[] at data offset 0.
 */
export function extractTransferEvents(logs: HypersyncLog[]): TransferEvent[] {
  const events: TransferEvent[] = [];

  for (const log of logs) {
    const topic0 = log.topics[0];
    const contract = log.address;
    const blockNumber = log.blockNumber;

    if (topic0 === TRANSFER_TOPIC) {
      // ERC-721 Transfer (must have topic[3] = tokenId). ERC-20 has only 3
      // topics; filter those out by requiring topic[3] to be present.
      const tid = log.topics[3];
      if (!tid) continue;
      events.push({
        contract,
        tokenId: BigInt(tid),
        blockNumber,
        is1155: false,
      });
    } else if (topic0 === TRANSFER_SINGLE_TOPIC) {
      // data = abi.encode(uint256 id, uint256 value) — first 32 bytes = id
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (hex.length >= 64) {
        events.push({
          contract,
          tokenId: BigInt("0x" + hex.slice(0, 64)),
          blockNumber,
          is1155: true,
        });
      }
    } else if (topic0 === TRANSFER_BATCH_TOPIC) {
      // data = abi.encode(uint256[] ids, uint256[] values)
      // dynamic-array layout: [offset_ids][offset_values][len_ids][ids...]
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      // Read offset to ids array (slot 0)
      if (hex.length < 64) continue;
      const offsetIds = parseInt(hex.slice(0, 64), 16) * 2; // byte→hex char
      if (hex.length < offsetIds + 64) continue;
      const lenIds = parseInt(hex.slice(offsetIds, offsetIds + 64), 16);
      for (let i = 0; i < lenIds; i++) {
        const start = offsetIds + 64 + i * 64;
        if (hex.length < start + 64) break;
        events.push({
          contract,
          tokenId: BigInt("0x" + hex.slice(start, start + 64)),
          blockNumber,
          is1155: true,
        });
      }
    }
  }

  return events;
}

// ── current tip helper ────────────────────────────────────────────
/**
 * Lightweight call to discover the indexer's current archive height. Used
 * when we just want to know how fresh the index is without doing a full
 * query (e.g. UI status indicators).
 */
export async function getHypersyncTip(chainId: number): Promise<number> {
  const endpoint = HYPERSYNC_ENDPOINTS[chainId];
  if (!endpoint) throw new Error(`Hypersync not configured for chain ${chainId}`);

  // Smallest-possible query — single block, no log filters — used as a ping.
  const resp = await fetch(`${endpoint}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_block: 0,
      to_block: 1,
      logs: [],
      field_selection: { log: ["block_number"] },
    }),
  });
  if (!resp.ok) throw new Error(`Hypersync tip query ${resp.status}`);
  const parsed = (await resp.json()) as HypersyncResponse;
  return parsed.archive_height;
}
