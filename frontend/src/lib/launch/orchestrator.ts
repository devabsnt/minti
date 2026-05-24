/**
 * One-click launch orchestrator. Drives a folder of metadata + image files
 * from local browser memory all the way to a registered, fully on-chain
 * EVMFS-native NFT collection.
 *
 * Pipeline (each step uses the user's connected wallet — N+ signatures):
 *
 *   1. Upload images via EVMFS.storeBatch (multiple txs if large).
 *   2. Compose image manifest JSON → EVMFS.storeManifest.
 *   3. Rewrite each metadata file's `image` field to the structured EVMFS URL.
 *   4. Upload metadata files via EVMFS.storeBatch.
 *   5. Compose metadata manifest JSON → EVMFS.storeManifest.
 *   6. Compose optional trait index manifest JSON → EVMFS.storeManifest.
 *   7. Deploy MintiCollection721 (CREATE).
 *   8. EVMFSCollectionRegistry.register(...).
 *   9. NFT.mintTo(creator, totalSupply) — mint all tokens to the creator in
 *      chunks so each tx stays under the block gas limit.
 */

import type { PublicClient, WalletClient } from "viem";
import {
  formatEvmfsUrl,
  uploadBlobBatch,
  uploadManifest,
  MINTI_COLLECTION_REGISTRY,
  EVMFS_TOKEN_VIEWER,
  EVMFS_DEFAULT,
  EVMFS_V1,
  type EvmfsContract,
} from "@/lib/evmfs";
import {
  EVMFS_COLLECTION_REGISTRY_ABI,
  CollectionKind,
} from "@/lib/abi/EVMFSCollectionRegistry";
import {
  MINTI_COLLECTION_721_ABI,
  MINTI_COLLECTION_721_BYTECODE,
} from "@/lib/abi/MintiCollection721";
import { encodeAbiParameters, encodeDeployData } from "viem";

export interface LaunchInput {
  chainId: number;
  account: `0x${string}`;
  wallet: WalletClient;
  publicClient: PublicClient;
  // Files
  metadata: Array<{ tokenId: number; data: Record<string, unknown> }>;
  images: Array<{ tokenId: number; bytes: Uint8Array; filename: string }>;
  // Collection config
  name: string;
  symbol: string;
  totalSupply: number;
  royaltyReceiver: `0x${string}`;
  royaltyBps: number;
  /** Which EVMFS contract to upload to. Defaults to V2. */
  evmfsContract?: EvmfsContract;
  // Tuning
  imageBatchSize?: number;
  metadataBatchSize?: number;
  mintBatchSize?: number;
}

export type LaunchPhase =
  | "idle"
  | "uploading-images"
  | "uploading-image-manifest"
  | "uploading-metadata"
  | "uploading-metadata-manifest"
  | "uploading-index-manifest"
  | "deploying-nft"
  | "registering"
  | "minting"
  | "done";

export interface LaunchProgress {
  phase: LaunchPhase;
  step: number;
  totalSteps: number;
  message: string;
  detail?: string;
}

export interface LaunchResult {
  nftContract: `0x${string}`;
  metadataManifest: { hash: `0x${string}`; block: number };
  imageManifest: { hash: `0x${string}`; block: number };
  indexManifest: { hash: `0x${string}`; block: number };
  registryId: bigint;
}

const DEFAULT_IMAGE_BATCH_SIZE = 8; // ~25KB×8 = ~200KB / tx
const DEFAULT_METADATA_BATCH_SIZE = 32; // metadata files are small
const DEFAULT_MINT_BATCH_SIZE = 40; // ~50k gas/mint × 40 = 2M gas

export async function launchCollection(
  input: LaunchInput,
  onProgress: (p: LaunchProgress) => void
): Promise<LaunchResult> {
  const {
    chainId,
    account,
    wallet,
    publicClient,
    metadata: metadataItems,
    images: imageItems,
    name,
    symbol,
    totalSupply,
    royaltyReceiver,
    royaltyBps,
  } = input;

  const registryAddr = MINTI_COLLECTION_REGISTRY[chainId];
  const viewerAddr = EVMFS_TOKEN_VIEWER[chainId];
  if (!registryAddr || registryAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error(`EVMFSCollectionRegistry is not deployed on chain ${chainId}`);
  }
  if (!viewerAddr) {
    throw new Error(`EVMFSTokenViewer is not deployed on chain ${chainId}`);
  }

  const evmfsContract = input.evmfsContract ?? EVMFS_DEFAULT;
  const clients = { wallet, publicClient, account, evmfsContract };
  const imageBatchSize = input.imageBatchSize ?? DEFAULT_IMAGE_BATCH_SIZE;
  const metadataBatchSize = input.metadataBatchSize ?? DEFAULT_METADATA_BATCH_SIZE;
  const mintBatchSize = input.mintBatchSize ?? DEFAULT_MINT_BATCH_SIZE;

  // ── 1. Upload images in batches ──
  const imageEntries: Array<{ h: `0x${string}`; b: number; f: string }> = [];
  const totalImageBatches = Math.ceil(imageItems.length / imageBatchSize);
  for (let i = 0; i < imageItems.length; i += imageBatchSize) {
    const batchIdx = i / imageBatchSize + 1;
    const batch = imageItems.slice(i, i + imageBatchSize);
    onProgress({
      phase: "uploading-images",
      step: batchIdx,
      totalSteps: totalImageBatches,
      message: `Uploading image batch ${batchIdx} of ${totalImageBatches}`,
      detail: `${batch.length} files`,
    });
    const result = await uploadBlobBatch(
      clients,
      batch.map((item) => item.bytes)
    );
    for (let j = 0; j < batch.length; j++) {
      imageEntries.push({
        h: result.entries[j].hash,
        b: result.block,
        f: batch[j].filename,
      });
    }
  }

  // ── 2. Image manifest ──
  onProgress({
    phase: "uploading-image-manifest",
    step: 0,
    totalSteps: 1,
    message: "Uploading image manifest",
  });
  const imageManifest = await uploadManifest(clients, JSON.stringify(imageEntries));

  // ── 3. Rewrite metadata to point at the image manifest ──
  const metadataSorted = [...metadataItems].sort((a, b) => a.tokenId - b.tokenId);
  const rewritten = metadataSorted.map((m) => {
    const tokenId = m.tokenId;
    const imageEntry = imageEntries.find((e) => e.f.startsWith(`${tokenId}.`)) ?? imageEntries[tokenId - 1];
    if (imageEntry) {
      const imageUrl = formatEvmfsUrl({
        chainId,
        block: imageEntry.b,
        manifestHash: imageManifest.hash,
        path: imageEntry.f,
      });
      return { ...m.data, image: imageUrl };
    }
    return m.data;
  });

  // ── 4. Upload metadata files ──
  const metadataEntries: Array<{ h: `0x${string}`; b: number; f: string }> = [];
  const totalMetaBatches = Math.ceil(rewritten.length / metadataBatchSize);
  for (let i = 0; i < rewritten.length; i += metadataBatchSize) {
    const batchIdx = i / metadataBatchSize + 1;
    const batch = rewritten.slice(i, i + metadataBatchSize);
    const tokenIds = metadataSorted.slice(i, i + metadataBatchSize).map((m) => m.tokenId);
    onProgress({
      phase: "uploading-metadata",
      step: batchIdx,
      totalSteps: totalMetaBatches,
      message: `Uploading metadata batch ${batchIdx} of ${totalMetaBatches}`,
      detail: `${batch.length} files`,
    });
    const result = await uploadBlobBatch(
      clients,
      batch.map((m) => JSON.stringify(m))
    );
    for (let j = 0; j < batch.length; j++) {
      metadataEntries.push({
        h: result.entries[j].hash,
        b: result.block,
        f: `${tokenIds[j]}`,
      });
    }
  }

  // ── 5. Metadata manifest ──
  onProgress({
    phase: "uploading-metadata-manifest",
    step: 0,
    totalSteps: 1,
    message: "Uploading metadata manifest",
  });
  const metadataManifest = await uploadManifest(clients, JSON.stringify(metadataEntries));

  // ── 6. Index manifest (optional but cheap; ship by default) ──
  onProgress({
    phase: "uploading-index-manifest",
    step: 0,
    totalSteps: 1,
    message: "Uploading trait index",
  });
  const indexPayload = buildIndexManifest({
    name,
    symbol,
    total: totalSupply,
    metadata: { hash: metadataManifest.hash, block: metadataManifest.block },
    image: { hash: imageManifest.hash, block: imageManifest.block },
    items: metadataSorted.map((m) => ({ id: m.tokenId, data: m.data })),
  });
  const indexManifest = await uploadManifest(clients, JSON.stringify(indexPayload));

  // ── 7. Deploy MintiCollection721 ──
  onProgress({
    phase: "deploying-nft",
    step: 0,
    totalSteps: 1,
    message: "Deploying ERC721 contract",
  });
  const deployHash = await wallet.deployContract({
    abi: MINTI_COLLECTION_721_ABI,
    bytecode: MINTI_COLLECTION_721_BYTECODE,
    args: [
      name,
      symbol,
      metadataManifest.hash,
      BigInt(metadataManifest.block),
      BigInt(totalSupply),
      viewerAddr,
      account,
      royaltyReceiver,
      BigInt(royaltyBps),
    ],
    account,
    chain: wallet.chain,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (!deployReceipt.contractAddress) {
    throw new Error("contract address missing from deployment receipt");
  }
  const nftContract = deployReceipt.contractAddress;

  // Sanity-check ABI encoder works (catches misaligned types early).
  encodeAbiParameters([{ type: "address" }], [nftContract]);
  // Same — keeps the import live; used by some chain libs for deterministic deploys.
  encodeDeployData({
    abi: MINTI_COLLECTION_721_ABI,
    bytecode: MINTI_COLLECTION_721_BYTECODE,
    args: [
      name,
      symbol,
      metadataManifest.hash,
      BigInt(metadataManifest.block),
      BigInt(totalSupply),
      viewerAddr,
      account,
      royaltyReceiver,
      BigInt(royaltyBps),
    ],
  });

  // ── 8. Register in registry ──
  onProgress({
    phase: "registering",
    step: 0,
    totalSteps: 1,
    message: "Registering collection",
  });
  const kind =
    metadataManifest.contract === EVMFS_V1
      ? CollectionKind.EVMFS_V1
      : CollectionKind.EVMFS_V2;
  const registerHash = await wallet.writeContract({
    address: registryAddr,
    abi: EVMFS_COLLECTION_REGISTRY_ABI,
    functionName: "register",
    args: [
      {
        kind,
        metadataManifest: metadataManifest.hash,
        metadataBlock: BigInt(metadataManifest.block),
        indexManifest: indexManifest.hash,
        indexBlock: BigInt(indexManifest.block),
        totalSupply: BigInt(totalSupply),
        nftContract,
        name,
        symbol,
      },
    ],
    account,
    chain: wallet.chain,
  });
  const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  const registeredLog = registerReceipt.logs.find(
    (l: { address: string }) => l.address.toLowerCase() === registryAddr.toLowerCase()
  );
  const registryId = registeredLog?.topics[1] ? BigInt(registeredLog.topics[1]) : 0n;

  // ── 9. Mint all tokens to creator in chunks ──
  let mintedSoFar = 0;
  while (mintedSoFar < totalSupply) {
    const remaining = totalSupply - mintedSoFar;
    const chunk = Math.min(remaining, mintBatchSize);
    onProgress({
      phase: "minting",
      step: mintedSoFar + chunk,
      totalSteps: totalSupply,
      message: `Minting ${chunk} tokens (${mintedSoFar + chunk}/${totalSupply})`,
    });
    const mintHash = await wallet.writeContract({
      address: nftContract,
      abi: MINTI_COLLECTION_721_ABI,
      functionName: "mintTo",
      args: [account, BigInt(chunk)],
      account,
      chain: wallet.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    mintedSoFar += chunk;
  }

  onProgress({ phase: "done", step: 1, totalSteps: 1, message: "Launch complete" });

  return {
    nftContract,
    metadataManifest,
    imageManifest,
    indexManifest,
    registryId,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

interface BuildIndexInput {
  name: string;
  symbol: string;
  total: number;
  metadata: { hash: `0x${string}`; block: number };
  image: { hash: `0x${string}`; block: number };
  items: Array<{ id: number; data: Record<string, unknown> }>;
}

function buildIndexManifest(input: BuildIndexInput) {
  // Extract ordered trait categories from the first item with attributes.
  const traitTypes = new Set<string>();
  for (const item of input.items) {
    const attrs = (item.data.attributes ?? []) as Array<{ trait_type?: string; value?: unknown }>;
    for (const a of attrs) {
      if (a?.trait_type) traitTypes.add(a.trait_type);
    }
  }
  const traitOrder = Array.from(traitTypes);
  const traitIndexOf = new Map(traitOrder.map((t, i) => [t, i]));

  const traits = input.items.map((item) => {
    const attrs = (item.data.attributes ?? []) as Array<{ trait_type?: string; value?: unknown }>;
    const slots = new Array<string>(traitOrder.length).fill("");
    for (const a of attrs) {
      if (!a?.trait_type) continue;
      const idx = traitIndexOf.get(a.trait_type);
      if (idx === undefined) continue;
      slots[idx] = String(a.value ?? "");
    }
    return { id: item.id, t: slots };
  });

  return {
    version: 1 as const,
    name: input.name,
    symbol: input.symbol,
    total: input.total,
    metadata: input.metadata,
    image: input.image,
    traitTypes: traitOrder,
    traits,
  };
}
