/**
 * EVMFS manifest types + resolver helpers.
 *
 * A manifest is a JSON array of file entries. Each entry has:
 *   - h: content hash (bytes32)
 *   - b: block number where the file's Store event lives
 *   - f: optional filename (when absent, files are accessed by numeric index)
 *   - p: optional array of {h,b} parts for multi-part files
 */

import { fetchEvmfsBlob, fetchEvmfsJson } from "./fetch";
import type { EvmfsContract } from "./addresses";

export interface ManifestPart {
  h: `0x${string}`;
  b: number;
}

export interface ManifestEntry {
  h: `0x${string}`;
  b: number;
  f?: string;
  p?: ManifestPart[];
}

export type Manifest = ManifestEntry[];

export interface ManifestPointer {
  chainId: number;
  block: number;
  hash: `0x${string}`;
  /** Optional V1/V2 hint — narrows the eth_getLogs query when known. */
  evmfsContract?: EvmfsContract;
}

/**
 * Fetch and parse the manifest at the given pointer. Cached by hash.
 */
export async function fetchManifest(pointer: ManifestPointer): Promise<Manifest> {
  const data = await fetchEvmfsJson<Manifest>({
    chainId: pointer.chainId,
    block: pointer.block,
    hash: pointer.hash,
    evmfsContract: pointer.evmfsContract,
  });
  if (!Array.isArray(data)) {
    throw new Error("manifest did not parse as an array");
  }
  return data;
}

/**
 * Resolve a manifest entry by either filename or numeric index.
 * Returns undefined when nothing matches.
 */
export function findEntry(manifest: Manifest, key: string | number): ManifestEntry | undefined {
  if (typeof key === "number") {
    return manifest[key];
  }
  // Try literal filename match first.
  let match = manifest.find((e) => e.f === key);
  if (match) return match;
  // Then strip leading slashes and try again.
  const trimmed = key.replace(/^\/+/, "");
  match = manifest.find((e) => e.f === trimmed);
  if (match) return match;
  // Then accept numeric strings as indices.
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0 && n < manifest.length) {
    return manifest[n];
  }
  return undefined;
}

/**
 * Fetch the bytes of a manifest entry, handling multi-part assembly.
 */
export async function fetchEntryBytes(
  chainId: number,
  entry: ManifestEntry,
  evmfsContract?: EvmfsContract
): Promise<Uint8Array> {
  if (entry.p && entry.p.length > 0) {
    const parts: Uint8Array[] = [];
    for (const part of entry.p) {
      parts.push(
        await fetchEvmfsBlob({ chainId, block: part.b, hash: part.h, evmfsContract })
      );
    }
    return concatBytes(parts);
  }
  return fetchEvmfsBlob({ chainId, block: entry.b, hash: entry.h, evmfsContract });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
