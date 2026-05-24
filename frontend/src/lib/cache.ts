import { get, set, del, createStore } from "idb-keyval";

const metadataStore = createStore("minti-cache", "nft-metadata");

export async function getFromCache<T>(key: string): Promise<T | undefined> {
  try {
    return await get<T>(key, metadataStore);
  } catch {
    return undefined;
  }
}

export async function setInCache<T>(key: string, value: T): Promise<void> {
  try {
    await set(key, value, metadataStore);
  } catch {
    // IndexedDB may fail in incognito mode, silently ignore
  }
}

export async function removeFromCache(key: string): Promise<void> {
  try {
    await del(key, metadataStore);
  } catch {
    // Silently ignore
  }
}

export function metadataCacheKey(
  chainId: number,
  contractAddress: string,
  tokenId: string
): string {
  return `${chainId}-${contractAddress.toLowerCase()}-${tokenId}`;
}
