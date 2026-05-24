/**
 * Browser-side EVMFS uploader. Defaults to V2 (records uploader + block in
 * `manifests` mapping, making downstream hash-only lookups cheap). Callers
 * may explicitly target V1 for legacy interop.
 */

import { type WalletClient, type PublicClient } from "viem";

import {
  EVMFS_DEFAULT,
  EVMFS_STORE_TOPIC,
  type EvmfsContract,
} from "./addresses";
import { gzip } from "./gzip";

const EVMFS_WRITE_ABI = [
  {
    type: "function",
    name: "store",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "storeBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "storeManifest",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export interface StoredBlob {
  hash: `0x${string}`;
  block: number;
  txHash: `0x${string}`;
  /** Contract this blob was stored to. */
  contract: EvmfsContract;
}

export interface WriterClients {
  wallet: WalletClient;
  publicClient: PublicClient;
  account: `0x${string}`;
  /** Optional override; defaults to {@link EVMFS_DEFAULT} (V2). */
  evmfsContract?: EvmfsContract;
}

function resolveContract(clients: WriterClients): EvmfsContract {
  return clients.evmfsContract ?? EVMFS_DEFAULT;
}

export async function uploadBlob(
  clients: WriterClients,
  bytes: Uint8Array | string
): Promise<StoredBlob> {
  const address = resolveContract(clients);
  const compressed = await gzip(bytes);
  const txHash = await clients.wallet.writeContract({
    address,
    abi: EVMFS_WRITE_ABI,
    functionName: "store",
    args: [bytesToHex(compressed)],
    account: clients.account,
    chain: clients.wallet.chain,
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === EVMFS_STORE_TOPIC
  );
  if (!log || !log.topics[1]) throw new Error("Store log not found in receipt");
  return {
    hash: log.topics[1] as `0x${string}`,
    block: Number(receipt.blockNumber),
    txHash,
    contract: address,
  };
}

export async function uploadBlobBatch(
  clients: WriterClients,
  items: Array<Uint8Array | string>
): Promise<{
  entries: Array<{ hash: `0x${string}` }>;
  block: number;
  txHash: `0x${string}`;
  contract: EvmfsContract;
}> {
  const address = resolveContract(clients);
  const compressed = await Promise.all(items.map((b) => gzip(b)));
  const hexItems = compressed.map(bytesToHex);
  const txHash = await clients.wallet.writeContract({
    address,
    abi: EVMFS_WRITE_ABI,
    functionName: "storeBatch",
    args: [hexItems],
    account: clients.account,
    chain: clients.wallet.chain,
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  const logs = receipt.logs.filter(
    (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === EVMFS_STORE_TOPIC
  );
  if (logs.length !== items.length) {
    throw new Error(`expected ${items.length} Store logs, got ${logs.length}`);
  }
  return {
    entries: logs.map((l) => ({ hash: l.topics[1] as `0x${string}` })),
    block: Number(receipt.blockNumber),
    txHash,
    contract: address,
  };
}

export async function uploadManifest(
  clients: WriterClients,
  bytes: Uint8Array | string
): Promise<StoredBlob> {
  const address = resolveContract(clients);
  const compressed = await gzip(bytes);
  const txHash = await clients.wallet.writeContract({
    address,
    abi: EVMFS_WRITE_ABI,
    functionName: "storeManifest",
    args: [bytesToHex(compressed)],
    account: clients.account,
    chain: clients.wallet.chain,
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === EVMFS_STORE_TOPIC
  );
  if (!log || !log.topics[1]) throw new Error("Store log not found in receipt");
  return {
    hash: log.topics[1] as `0x${string}`,
    block: Number(receipt.blockNumber),
    txHash,
    contract: address,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

export type { WalletClient, PublicClient };
