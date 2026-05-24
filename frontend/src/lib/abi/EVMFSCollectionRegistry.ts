/**
 * ABI for EVMFSCollectionRegistry. Hand-written as a TypeScript const so that
 * viem can fully infer return shapes (vs a JSON blob, which loses type info).
 *
 * Mirrors `contracts/src/EVMFSCollectionRegistry.sol`. Keep in sync.
 */

/**
 * Mirrors the on-chain `Kind` enum. Numeric values are the wire format.
 *   0 → EVMFS_V1
 *   1 → EVMFS_V2
 *   2 → ON_CHAIN_DATA_URI
 *   3 → OFFCHAIN
 */
export enum CollectionKind {
  EVMFS_V1 = 0,
  EVMFS_V2 = 1,
  ON_CHAIN_DATA_URI = 2,
  OFFCHAIN = 3,
}

export function isEvmfsKind(kind: CollectionKind | number): boolean {
  return kind === CollectionKind.EVMFS_V1 || kind === CollectionKind.EVMFS_V2;
}

export function kindLabel(kind: CollectionKind | number): string {
  switch (kind) {
    case CollectionKind.EVMFS_V1:
      return "EVMFS v1";
    case CollectionKind.EVMFS_V2:
      return "EVMFS v2";
    case CollectionKind.ON_CHAIN_DATA_URI:
      return "on-chain";
    case CollectionKind.OFFCHAIN:
      return "off-chain";
    default:
      return "unknown";
  }
}

/** Inverse rank used to sort the discovery feed: EVMFS > data: > off-chain. */
export function kindTier(kind: CollectionKind | number): number {
  if (isEvmfsKind(kind)) return 0;
  if (kind === CollectionKind.ON_CHAIN_DATA_URI) return 1;
  return 2;
}

const COLLECTION_TUPLE_COMPONENTS = [
  { name: "kind", type: "uint8" },
  { name: "evmfsContract", type: "address" },
  { name: "metadataManifest", type: "bytes32" },
  { name: "metadataBlock", type: "uint64" },
  { name: "indexManifest", type: "bytes32" },
  { name: "indexBlock", type: "uint64" },
  { name: "totalSupply", type: "uint64" },
  { name: "nftContract", type: "address" },
  { name: "creator", type: "address" },
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
] as const;

const REGISTRATION_INPUT_COMPONENTS = [
  { name: "kind", type: "uint8" },
  { name: "metadataManifest", type: "bytes32" },
  { name: "metadataBlock", type: "uint64" },
  { name: "indexManifest", type: "bytes32" },
  { name: "indexBlock", type: "uint64" },
  { name: "totalSupply", type: "uint64" },
  { name: "nftContract", type: "address" },
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
] as const;

export const EVMFS_COLLECTION_REGISTRY_ABI = [
  // ── constants ──
  { type: "function", name: "EVMFS_V1", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "EVMFS_V2", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "MAX_TAGS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "MAX_TAG_LENGTH", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },

  // ── core state ──
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "collectionIdByNft",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isRegistered",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "verified",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "collectionsByCreator",
    stateMutability: "view",
    inputs: [{ name: "creator", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },

  // ── collection views ──
  {
    type: "function",
    name: "getCollection",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: COLLECTION_TUPLE_COMPONENTS }],
  },
  {
    type: "function",
    name: "getCollectionByNft",
    stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: COLLECTION_TUPLE_COMPONENTS }],
  },
  {
    type: "function",
    name: "getCollections",
    stateMutability: "view",
    inputs: [
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [{ name: "", type: "tuple[]", components: COLLECTION_TUPLE_COMPONENTS }],
  },
  {
    type: "function",
    name: "getTags",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "string[]" }],
  },
  {
    type: "function",
    name: "isEvmfsKind",
    stateMutability: "pure",
    inputs: [{ name: "kind", type: "uint8" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── registration ──
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "input", type: "tuple", components: REGISTRATION_INPUT_COMPONENTS }],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "registerCurated",
    stateMutability: "nonpayable",
    inputs: [
      { name: "input", type: "tuple", components: REGISTRATION_INPUT_COMPONENTS },
      { name: "creator", type: "address" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },

  // ── mutable updates ──
  {
    type: "function",
    name: "updateMetadata",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "metadataManifest", type: "bytes32" },
      { name: "metadataBlock", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateIndex",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "indexManifest", type: "bytes32" },
      { name: "indexBlock", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateTotalSupply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "totalSupply", type: "uint64" },
    ],
    outputs: [],
  },

  // ── curation ──
  {
    type: "function",
    name: "setVerified",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nftContract", type: "address" },
      { name: "isVerified", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setTags",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "tags", type: "string[]" },
    ],
    outputs: [],
  },

  // ── ownership ──
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "renounceOwnership",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },

  // ── events ──
  {
    type: "event",
    name: "Registered",
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: true, name: "nftContract", type: "address" },
      { indexed: false, name: "kind", type: "uint8" },
    ],
  },
  {
    type: "event",
    name: "Verified",
    anonymous: false,
    inputs: [
      { indexed: true, name: "nftContract", type: "address" },
      { indexed: false, name: "isVerified", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "TagsUpdated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "uint256" },
      { indexed: false, name: "tags", type: "string[]" },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    anonymous: false,
    inputs: [
      { indexed: true, name: "previousOwner", type: "address" },
      { indexed: true, name: "newOwner", type: "address" },
    ],
  },
] as const;

export type CollectionRecord = {
  kind: number;
  evmfsContract: `0x${string}`;
  metadataManifest: `0x${string}`;
  metadataBlock: bigint;
  indexManifest: `0x${string}`;
  indexBlock: bigint;
  totalSupply: bigint;
  nftContract: `0x${string}`;
  creator: `0x${string}`;
  name: string;
  symbol: string;
};

export type RegistrationInput = {
  kind: number;
  metadataManifest: `0x${string}`;
  metadataBlock: bigint;
  indexManifest: `0x${string}`;
  indexBlock: bigint;
  totalSupply: bigint;
  nftContract: `0x${string}`;
  name: string;
  symbol: string;
};

export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
