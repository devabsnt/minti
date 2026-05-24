/**
 * Fetch raw bytes for an EVMFS-stored blob given its (chainId, block, hash).
 *
 * The Store event topic is identical on V1 and V2. Since `eth_getLogs` allows
 * filtering by either a single address or *omitting* the address filter, we
 * default to omitting it (cheaper to write, and returns the same single log
 * regardless of which contract emitted it). If a caller knows the source
 * contract — e.g. the registry told them — they can pass it via
 * `evmfsContract` for a slightly tighter query.
 */

import { decodeAbiParameters, keccak256 } from "viem";

import { createRpcPool, executeLogQueries } from "@/lib/rpcPool";
import {
  EVMFS_STORE_TOPIC,
  EVMFS_ADDRESSES_LOWER,
  type EvmfsContract,
} from "./addresses";
import { gunzip } from "./gzip";
import { cacheGet, cachePut } from "./cache";

export interface EvmfsFetchInput {
  chainId: number;
  block: number;
  hash: `0x${string}`;
  /**
   * Optional: restrict the log search to a specific EVMFS contract (V1 or V2).
   * When omitted, both contracts are accepted — useful since the Store event
   * topic is identical on both and hashes are content-addressed anyway.
   */
  evmfsContract?: EvmfsContract;
}

export class EvmfsFetchError extends Error {
  constructor(message: string, readonly input: EvmfsFetchInput) {
    super(message);
    this.name = "EvmfsFetchError";
  }
}

export async function fetchEvmfsBlob(input: EvmfsFetchInput): Promise<Uint8Array> {
  const cached = await cacheGet(input.chainId, input.hash);
  if (cached) return cached;

  const pool = createRpcPool(input.chainId);
  const blockHex = `0x${input.block.toString(16)}` as `0x${string}`;
  const [logs] = await executeLogQueries(pool, [
    {
      fromBlock: blockHex,
      toBlock: blockHex,
      // Address filter: when caller supplied a specific V1/V2 address use it,
      // otherwise omit and let the hash-as-topic constrain the result.
      ...(input.evmfsContract ? { address: input.evmfsContract } : {}),
      topics: [EVMFS_STORE_TOPIC, input.hash],
    },
  ]);

  const filtered = (logs ?? []).filter((l) =>
    EVMFS_ADDRESSES_LOWER.includes(l.address.toLowerCase())
  );
  if (filtered.length === 0) {
    throw new EvmfsFetchError(`no Store log found for hash at block ${input.block}`, input);
  }

  const log = filtered[0];
  const [encoded] = decodeAbiParameters([{ type: "bytes" }], log.data as `0x${string}`);
  const gzipped = hexToBytes(encoded);

  const observed = keccak256(`0x${bytesToHex(gzipped)}` as `0x${string}`).toLowerCase();
  if (observed !== input.hash.toLowerCase()) {
    throw new EvmfsFetchError(`hash mismatch: expected ${input.hash}, got ${observed}`, input);
  }

  const bytes = await gunzip(gzipped);
  await cachePut(input.chainId, input.hash, bytes);
  return bytes;
}

export async function fetchEvmfsText(input: EvmfsFetchInput): Promise<string> {
  const bytes = await fetchEvmfsBlob(input);
  return new TextDecoder().decode(bytes);
}

export async function fetchEvmfsJson<T = unknown>(input: EvmfsFetchInput): Promise<T> {
  const text = await fetchEvmfsText(input);
  return JSON.parse(text) as T;
}

// ─── helpers ──────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  let s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) s = `0${s}`;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
