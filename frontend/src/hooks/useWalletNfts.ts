"use client";

import { useMemo } from "react";
import { useOwnedNfts, type OwnedToken } from "./useOwnedNfts";
import {
  useWalletTransferScan,
  type DiscoveredToken,
} from "./useTransferScan";

// ────────────────────── Types ──────────────────────

export interface CollectionGroup {
  contractAddress: `0x${string}`;
  tokenIds: bigint[];
  balanceOnly: boolean;
  /** True if this collection is ERC-1155 */
  is1155?: boolean;
  /** ERC-1155 balances keyed by tokenId string */
  balances1155?: Record<string, string>;
}

export interface WalletNftsResult {
  collections: CollectionGroup[];
  hasTokens: boolean;
  isLoading: boolean;
  error: Error | null;
  discoveredCount: number;
  scannedBlocks: number;
  isBackScanning: boolean;
  backwardProgress: number;
}

export interface CollectionNftsResult {
  tokens: OwnedToken[];
  balanceOnly: boolean;
  isLoading: boolean;
  error: Error | null;
}

// ────────────────────── Wallet page hook ──────────────────────

/**
 * Combined hook for the wallet page — merges tracked collections (useOwnedNfts)
 * with auto-discovery (useWalletTransferScan). Deduplicates and groups by collection.
 */
export function useWalletNfts(
  ownerAddress: `0x${string}` | undefined,
  trackedCollections: string[]
): WalletNftsResult {
  const { data: trackedTokens, isLoading: trackedLoading, error: trackedError } = useOwnedNfts(
    ownerAddress,
    trackedCollections
  );

  const scanResult = useWalletTransferScan(ownerAddress);

  return useMemo(() => {
    const manualTokens: OwnedToken[] = trackedTokens || [];
    const scannedTokens: DiscoveredToken[] = scanResult.tokens || [];

    const seen = new Set<string>();
    const byCollection = new Map<string, CollectionGroup>();

    function addToken(t: { contractAddress: `0x${string}`; tokenId: bigint; is1155?: boolean; balance1155?: bigint }) {
      const col = t.contractAddress.toLowerCase();
      if (!byCollection.has(col)) {
        byCollection.set(col, {
          contractAddress: t.contractAddress,
          tokenIds: [],
          balanceOnly: false,
        });
      }
      const entry = byCollection.get(col)!;
      if (t.is1155) {
        entry.is1155 = true;
        if (!entry.balances1155) entry.balances1155 = {};
        entry.balances1155[t.tokenId.toString()] = (t.balance1155 ?? 1n).toString();
      }
      if (t.tokenId === BigInt(-1)) {
        entry.balanceOnly = true;
      } else {
        const key = `${col}-${t.tokenId.toString()}`;
        if (!seen.has(key)) {
          entry.tokenIds.push(t.tokenId);
          seen.add(key);
        }
      }
    }

    // Tracked collections first (primary)
    for (const t of manualTokens) addToken(t);
    // Then scanned discoveries (secondary)
    for (const t of scannedTokens) addToken(t);

    const collections = Array.from(byCollection.values());
    const hasTokens = collections.some(
      (c) => c.tokenIds.length > 0 || c.balanceOnly
    );

    return {
      collections,
      hasTokens,
      isLoading: trackedLoading || scanResult.isLoading,
      error: trackedError as Error | null,
      discoveredCount: scanResult.collectionsFound,
      scannedBlocks: scanResult.scannedBlocks,
      isBackScanning: scanResult.isBackScanning,
      backwardProgress: scanResult.backwardProgress,
    };
  }, [trackedTokens, scanResult, trackedLoading, trackedError]);
}

// ────────────────────── Collection page hook ──────────────────────

/**
 * Hook for the collection page — uses useOwnedNfts which does Multicall3
 * ownerOf brute-force scan through the entire collection (up to 10k IDs).
 */
export function useCollectionNfts(
  ownerAddress: `0x${string}` | undefined,
  collectionAddress: `0x${string}` | undefined
): CollectionNftsResult {
  const addressArray = useMemo(
    () => (collectionAddress ? [collectionAddress] : []),
    [collectionAddress]
  );

  const { data: ownedTokens, isLoading, error } = useOwnedNfts(
    ownerAddress,
    addressArray
  );

  return useMemo(() => {
    const tokens: OwnedToken[] = [];
    let balanceOnly = false;

    for (const t of ownedTokens || []) {
      if (t.tokenId === BigInt(-1)) {
        balanceOnly = true;
      } else {
        tokens.push(t);
      }
    }

    return { tokens, balanceOnly, isLoading, error: error as Error | null };
  }, [ownedTokens, isLoading, error]);
}
