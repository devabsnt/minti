/**
 * Parser for canonical EVMFS structured pointers.
 *
 *   https://<gateway>/{chainId}/{block}/{manifestHash}/{path}
 *
 * The hostname is irrelevant — any gateway works, but EVMFS-aware code never
 * actually fetches the URL. It treats the string as a description of where
 * the bytes live on chain: (chainId, block, manifestHash, path).
 */

export interface EvmfsPointer {
  chainId: number;
  block: number;
  manifestHash: `0x${string}`;
  /** Optional path within the manifest. May be empty (resolves to the manifest itself). */
  path: string;
}

const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseEvmfsUrl(input: string): EvmfsPointer | null {
  if (!input) return null;
  let url: URL;
  try {
    // Accept absolute https:// URLs and protocol-relative paths.
    url = new URL(input, "https://evmfs.xyz");
  } catch {
    return null;
  }
  // Path segments: [ "" , chainId, block, hash, ...rest ]
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  const [chainStr, blockStr, hashStr, ...rest] = segments;
  const chainId = Number.parseInt(chainStr, 10);
  const block = Number.parseInt(blockStr, 10);
  if (!Number.isFinite(chainId) || !Number.isFinite(block)) return null;
  if (!HEX_HASH.test(hashStr)) return null;
  return {
    chainId,
    block,
    manifestHash: hashStr.toLowerCase() as `0x${string}`,
    path: rest.join("/"),
  };
}

export function formatEvmfsUrl(
  pointer: EvmfsPointer,
  gateway: string = "https://evmfs.xyz"
): string {
  const base = gateway.replace(/\/$/, "");
  const path = pointer.path ? `/${pointer.path}` : "";
  return `${base}/${pointer.chainId}/${pointer.block}/${pointer.manifestHash}${path}`;
}

/**
 * Convenience: does this string look like an EVMFS pointer?
 */
export function isEvmfsUrl(input: string | undefined | null): boolean {
  if (!input) return false;
  return parseEvmfsUrl(input) !== null;
}
