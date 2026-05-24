/**
 * Public surface of the EVMFS browser client. Everything outside this folder
 * should import from "@/lib/evmfs" rather than the individual files.
 */

export {
  EVMFS_V1,
  EVMFS_V2,
  EVMFS_DEFAULT,
  EVMFS_STORE_TOPIC,
  EVMFS_ADDRESSES_LOWER,
  EVMFS_TOKEN_VIEWER,
  EVMFS_EXPLORER,
  EVMFS_BLOCK_INDEX,
  MINTI_COLLECTION_REGISTRY,
  EVMFS_GATEWAY_FALLBACK,
  isEvmfsContract,
  evmfsLabel,
  isRegistryDeployed,
  // Back-compat
  EVMFS_ADDRESS,
  EVMFS_COLLECTION_REGISTRY,
} from "./addresses";
export type { EvmfsContract } from "./addresses";

export { parseEvmfsUrl, formatEvmfsUrl, isEvmfsUrl } from "./url";
export type { EvmfsPointer } from "./url";

export { fetchEvmfsBlob, fetchEvmfsText, fetchEvmfsJson, EvmfsFetchError } from "./fetch";
export type { EvmfsFetchInput } from "./fetch";

export { fetchManifest, findEntry, fetchEntryBytes } from "./manifest";
export type { Manifest, ManifestEntry, ManifestPart, ManifestPointer } from "./manifest";

export { gzip, gunzip } from "./gzip";

export { uploadBlob, uploadBlobBatch, uploadManifest } from "./writer";
export type { StoredBlob, WriterClients } from "./writer";
