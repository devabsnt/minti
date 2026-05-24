/**
 * IndexedDB-backed cache for Hypersync wallet scans.
 *
 * Schema: keyed by `(chainId, walletAddress)`. Each entry stores the last
 * block we queried Hypersync through plus the union of ever-received
 * (contract, tokenId, is1155) tuples. On revisits we re-verify ownership
 * against the chain — the cache is a "seen" set, not the live wallet
 * state.
 *
 * Why IndexedDB: localStorage caps at ~5MB and stringifies expensively.
 * A wallet with hundreds of NFTs from dozens of collections can easily
 * blow past that. `idb-keyval` was already in the project as a dep.
 */

import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";

const CACHE_VERSION = 1;

export interface CandidateToken {
  contract: `0x${string}`;
  /** stored as decimal string for IndexedDB JSON-safety; convert at use sites */
  tokenId: string;
  is1155: boolean;
}

export interface HypersyncWalletCache {
  version: number;
  /** last block (exclusive) that hypersync was queried up to */
  lastBlock: number;
  /** all token candidates ever received (deduped across visits) */
  candidates: CandidateToken[];
  /** cached current ownership snapshot — what verifyOwnership last said */
  ownedSnapshot: CandidateToken[];
  /** when the snapshot was last refreshed (ms epoch) */
  ownedSnapshotAt: number;
}

function cacheKey(chainId: number, wallet: string): string {
  return `minti-hypersync-${chainId}-${wallet.toLowerCase()}`;
}

export async function loadHypersyncCache(
  chainId: number,
  wallet: string,
): Promise<HypersyncWalletCache | null> {
  try {
    const raw = await idbGet<HypersyncWalletCache>(cacheKey(chainId, wallet));
    if (!raw || raw.version !== CACHE_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveHypersyncCache(
  chainId: number,
  wallet: string,
  cache: HypersyncWalletCache,
): Promise<void> {
  try {
    await idbSet(cacheKey(chainId, wallet), { ...cache, version: CACHE_VERSION });
  } catch {
    // ignore quota errors — we'll re-fetch next visit
  }
}

export async function clearHypersyncCache(
  chainId: number,
  wallet: string,
): Promise<void> {
  try {
    await idbDel(cacheKey(chainId, wallet));
  } catch {
    // ignore
  }
}

// ── candidate helpers ─────────────────────────────────────────────

/** Dedupe candidates by (contract, tokenId, is1155). */
export function dedupeCandidates(
  candidates: CandidateToken[],
): CandidateToken[] {
  const seen = new Set<string>();
  const out: CandidateToken[] = [];
  for (const c of candidates) {
    const key = `${c.contract.toLowerCase()}|${c.tokenId}|${c.is1155 ? "1155" : "721"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
