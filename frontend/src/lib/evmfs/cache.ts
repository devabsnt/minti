/**
 * Content-addressed cache for EVMFS blobs.
 *
 * Keys are (chainId, hash). Values are raw decompressed bytes. Because hashes
 * commit to content, this cache never invalidates — entries can live forever.
 *
 * Uses idb-keyval, which is already a dependency. Falls back to an in-memory
 * Map if IndexedDB is unavailable (SSR, private browsing, etc.).
 */

import { createStore, get as idbGet, set as idbSet } from "idb-keyval";

const memCache = new Map<string, Uint8Array>();

let store: ReturnType<typeof createStore> | null = null;

function getStore() {
  if (typeof indexedDB === "undefined") return null;
  if (!store) store = createStore("minti-evmfs", "blobs");
  return store;
}

function key(chainId: number, hash: string): string {
  return `${chainId}:${hash.toLowerCase()}`;
}

export async function cacheGet(chainId: number, hash: string): Promise<Uint8Array | null> {
  const k = key(chainId, hash);
  const memHit = memCache.get(k);
  if (memHit) return memHit;
  const s = getStore();
  if (!s) return null;
  try {
    const v = (await idbGet(k, s)) as Uint8Array | undefined;
    if (v) memCache.set(k, v);
    return v ?? null;
  } catch {
    return null;
  }
}

export async function cachePut(chainId: number, hash: string, bytes: Uint8Array): Promise<void> {
  const k = key(chainId, hash);
  memCache.set(k, bytes);
  const s = getStore();
  if (!s) return;
  try {
    await idbSet(k, bytes, s);
  } catch {
    // Quota errors etc. — in-memory cache is still valid for this session.
  }
}
