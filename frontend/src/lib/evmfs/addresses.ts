/**
 * Canonical EVMFS contract addresses.
 *
 * V1 and V2 are the two EVMFS storage contracts. Both are deployed at the
 * same address on every chain via CREATE2 / Safe Singleton Factory. V2 is
 * the default for new uploads; V1 is the legacy variant (SKRUMPS lives here).
 *
 * The viewer / explorer / renderer / names contracts are EVMFS-project
 * deployments and read from V1 or V2 transparently.
 *
 * Minti's registry deploys per-chain via `forge script Deploy`. Populate
 * `MINTI_COLLECTION_REGISTRY` after running the script.
 */

import { keccak256, toHex, type Address } from "viem";

// ── Storage contracts (same address on every chain) ────────────────

export const EVMFS_V1 = "0x140cbDFf649929D003091a5B8B3be34588753aBA" as const;
export const EVMFS_V2 = "0xb61cdCDC81d97c32122E668AE782b2327d0a623C" as const;

export type EvmfsContract = typeof EVMFS_V1 | typeof EVMFS_V2;

/** Default EVMFS contract for new uploads. */
export const EVMFS_DEFAULT: EvmfsContract = EVMFS_V2;

/** Set of EVMFS contract addresses (lowercased) used to filter on-chain logs. */
export const EVMFS_ADDRESSES_LOWER: readonly string[] = [
  EVMFS_V1.toLowerCase(),
  EVMFS_V2.toLowerCase(),
];

/** True if `addr` is one of the recognized EVMFS storage contracts. */
export function isEvmfsContract(addr: string | undefined | null): addr is EvmfsContract {
  if (!addr) return false;
  const l = addr.toLowerCase();
  return l === EVMFS_V1.toLowerCase() || l === EVMFS_V2.toLowerCase();
}

/** Human label for an EVMFS contract address. */
export function evmfsLabel(addr: string | undefined | null): "v1" | "v2" | "unknown" {
  if (!addr) return "unknown";
  const l = addr.toLowerCase();
  if (l === EVMFS_V1.toLowerCase()) return "v1";
  if (l === EVMFS_V2.toLowerCase()) return "v2";
  return "unknown";
}

// ── Event topic ────────────────────────────────────────────────────

/** Topic0 of the shared `Store(bytes32 indexed hash, bytes data)` event. */
export const EVMFS_STORE_TOPIC = keccak256(toHex("Store(bytes32,bytes)"));

// ── Project deployments (EVMFS project, not minti) ─────────────────

/** EVMFSTokenViewer — Solidity contract collections delegate `tokenURI` to. */
export const EVMFS_TOKEN_VIEWER: Record<number, Address> = {
  143: "0x139EF7cFc40c6044229D8EcAEb38E1A18FB20D94", // Monad mainnet
};

/** EVMFSExplorer — autodetect manifest explorer. */
export const EVMFS_EXPLORER: Record<number, Address> = {
  143: "0x58777A7F247D39669E0659B10203776308B2ECfE", // Monad mainnet
};

/** Canonical EVMFSBlockIndex — hash → block lookup for V1 content. */
export const EVMFS_BLOCK_INDEX: Record<number, Address> = {
  1: "0x85fce8503683a76371568f2f1347cf2c85dddc39", // Ethereum mainnet
  143: "0x2b62d34557e7cb8cb31dc83d2132396d0ef5cad0", // Monad mainnet
};

/** Public HTTP gateway, used only as a last-resort fallback. */
export const EVMFS_GATEWAY_FALLBACK = "https://evmfs.xyz";

// ── Minti-deployed contracts (per chain) ───────────────────────────

/**
 * minti's `EVMFSCollectionRegistry` deployment per chain. Populated after
 * `forge script Deploy` runs. Zero address = not deployed yet on this chain.
 */
export const MINTI_COLLECTION_REGISTRY: Record<number, Address> = {
  143: "0x0000000000000000000000000000000000000000",
};

export function isRegistryDeployed(chainId: number): boolean {
  const addr = MINTI_COLLECTION_REGISTRY[chainId];
  return !!addr && addr !== "0x0000000000000000000000000000000000000000";
}

// ── Back-compat aliases (legacy names used elsewhere in the codebase) ──

/** @deprecated Use {@link EVMFS_V2} or {@link EVMFS_V1} explicitly. */
export const EVMFS_ADDRESS = EVMFS_V2;

/** @deprecated Renamed to {@link MINTI_COLLECTION_REGISTRY}. */
export const EVMFS_COLLECTION_REGISTRY = MINTI_COLLECTION_REGISTRY;
