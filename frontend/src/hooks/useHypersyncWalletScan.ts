"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Abi } from "viem";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useRpc } from "@/providers/RpcProvider";
import {
  queryIncomingTransfers,
  extractTransferEvents,
  hasHypersync,
  type TransferEvent,
} from "@/lib/hypersync/client";
import {
  loadHypersyncCache,
  saveHypersyncCache,
  dedupeCandidates,
  type CandidateToken,
  type HypersyncWalletCache,
} from "@/lib/hypersync/cache";
import {
  createRpcPool,
  executeBatchedMulticalls,
  encodeCall,
  decodeResult,
  type MulticallRequest,
} from "@/lib/rpcPool";
import type { DiscoveredToken, TransferScanResult } from "./useTransferScan";

// ── ABIs (kept local to avoid a circular import with useTransferScan) ──
const ERC721_ABI = [
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "ownerOf",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

const ERC1155_ABI = [
  {
    inputs: [
      { type: "address", name: "account" },
      { type: "uint256", name: "id" },
    ],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

const DEBUG = process.env.NODE_ENV === "development";
const log = (...a: unknown[]) => { if (DEBUG) console.log("[hypersync]", ...a); };

// ── ownership verification ────────────────────────────────────────
/**
 * Take a flat list of candidates (everything the wallet ever received per
 * Hypersync) and confirm which ones are still owned. ERC-721 → ownerOf,
 * ERC-1155 → balanceOf(account, id). One multicall batch per ~150 IDs.
 */
async function verifyOwnership(
  chainId: number,
  userRpc: string | undefined,
  owner: `0x${string}`,
  candidates: CandidateToken[],
): Promise<DiscoveredToken[]> {
  if (candidates.length === 0) return [];

  const pool = createRpcPool(chainId, userRpc);
  const calls: MulticallRequest[] = candidates.map((c) =>
    c.is1155
      ? encodeCall(c.contract, ERC1155_ABI, "balanceOf", [owner, BigInt(c.tokenId)])
      : encodeCall(c.contract, ERC721_ABI, "ownerOf", [BigInt(c.tokenId)]),
  );

  const results = (await executeBatchedMulticalls(pool, calls)).flat();
  const normalizedOwner = owner.toLowerCase();
  const owned: DiscoveredToken[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const result = results[i];
    if (!result || !result.success) continue;
    const c = candidates[i];

    if (c.is1155) {
      const bal = decodeResult<bigint>(ERC1155_ABI, "balanceOf", result);
      if (bal && bal > 0n) {
        owned.push({
          contractAddress: c.contract,
          tokenId: BigInt(c.tokenId),
          is1155: true,
          balance1155: bal,
        });
      }
    } else {
      const addr = decodeResult<string>(ERC721_ABI, "ownerOf", result);
      if (addr && addr.toLowerCase() === normalizedOwner) {
        owned.push({
          contractAddress: c.contract,
          tokenId: BigInt(c.tokenId),
        });
      }
    }
  }

  return owned;
}

// ── extract→candidate transform ───────────────────────────────────
function eventsToCandidates(events: TransferEvent[]): CandidateToken[] {
  const out: CandidateToken[] = [];
  for (const ev of events) {
    out.push({
      contract: ev.contract,
      tokenId: ev.tokenId.toString(),
      is1155: ev.is1155,
    });
  }
  return out;
}

// ── the hook ──────────────────────────────────────────────────────
/**
 * Hypersync-powered wallet scan. Returns the same TransferScanResult shape
 * as the RPC-based useWalletTransferScan so call sites stay drop-in.
 *
 * Strategy:
 *   1. Load IndexedDB cache (instant — display previous state immediately).
 *   2. Verify cached ownership via RPC multicall (catches recent transfers
 *      out since last visit).
 *   3. Query Hypersync from cache.lastBlock → tip for new incoming transfers.
 *   4. Merge new candidates with cached, re-verify the deltas via RPC.
 *   5. Persist updated cache.
 */
export function useHypersyncWalletScan(
  ownerAddress: `0x${string}` | undefined,
): TransferScanResult {
  const { browseChainId } = useBrowseChain();
  const { getEffectiveRpc } = useRpc();

  const [state, setState] = useState<TransferScanResult>({
    tokens: [],
    scannedBlocks: 0,
    collectionsFound: 0,
    isLoading: false,
    isBackScanning: false,
    backwardProgress: 0,
  });

  const abortRef = useRef(false);
  const runningRef = useRef(false);

  const scan = useCallback(async () => {
    if (!ownerAddress || runningRef.current) return;
    if (!hasHypersync(browseChainId)) return;
    runningRef.current = true;
    abortRef.current = false;

    const userRpc = getEffectiveRpc(browseChainId);
    const cache = await loadHypersyncCache(browseChainId, ownerAddress);

    // ── 1. Instant hydration from cached snapshot ──────────────────
    // Show the previous owned-set immediately so the UI is responsive
    // even before any network call returns.
    if (cache?.ownedSnapshot && cache.ownedSnapshot.length > 0) {
      const hydrated: DiscoveredToken[] = cache.ownedSnapshot.map((c) => ({
        contractAddress: c.contract,
        tokenId: BigInt(c.tokenId),
        ...(c.is1155 ? { is1155: true, balance1155: 1n } : {}),
      }));
      setState({
        tokens: hydrated,
        scannedBlocks: cache.lastBlock,
        collectionsFound: new Set(hydrated.map((t) => t.contractAddress.toLowerCase())).size,
        isLoading: true, // priority verification still pending
        isBackScanning: false,
        backwardProgress: 100,
      });
    } else {
      setState((p) => ({ ...p, isLoading: true }));
    }

    if (abortRef.current) { runningRef.current = false; return; }

    // ── 2. PRIORITY: verify cached candidates first ────────────────
    // This is the most common case (user re-opens the page) and catches
    // "they sent some NFTs away since last visit". Hits RPC directly via
    // a single multicall round — much cheaper than the Hypersync query.
    // Result: stale entries drop off within ~1s of page load.
    let verified: DiscoveredToken[] = [];
    const cachedCandidates = cache?.candidates ?? [];
    if (cachedCandidates.length > 0) {
      try {
        verified = await verifyOwnership(
          browseChainId,
          userRpc,
          ownerAddress,
          cachedCandidates,
        );
        log(`verified cached: ${verified.length}/${cachedCandidates.length} still owned`);

        // Show the verified set immediately so transfers-out drop off the
        // grid right away. Mark as backScanning so the UI knows there's
        // still a delta-query running in the background.
        setState({
          tokens: verified,
          scannedBlocks: cache?.lastBlock ?? 0,
          collectionsFound: new Set(verified.map((t) => t.contractAddress.toLowerCase())).size,
          isLoading: false,
          isBackScanning: true,
          backwardProgress: 100,
        });

        // Persist the up-to-date snapshot now so a quick page navigation
        // away mid-flight still ends up with accurate state next visit.
        if (cache) {
          await saveHypersyncCache(browseChainId, ownerAddress, {
            ...cache,
            ownedSnapshot: verified.map((t) => ({
              contract: t.contractAddress,
              tokenId: t.tokenId.toString(),
              is1155: !!t.is1155,
            })),
            ownedSnapshotAt: Date.now(),
          });
        }
      } catch (err) {
        log("verify-cached error:", err);
        // Keep showing cached snapshot; fall through to Hypersync anyway.
      }
    }

    if (abortRef.current) { runningRef.current = false; return; }

    // ── 3. BACKGROUND: Hypersync delta for new transfers ───────────
    // Only queries from cache.lastBlock to tip, so on revisits this is
    // a tiny range. First-visit users do the full sweep here.
    let newEvents: TransferEvent[] = [];
    let lastBlock = cache?.lastBlock ?? 0;
    try {
      const result = await queryIncomingTransfers(
        browseChainId,
        ownerAddress,
        lastBlock,
        (block, target) => {
          setState((p) => ({
            ...p,
            scannedBlocks: block,
            backwardProgress: target > 0 ? Math.round((block / target) * 100) : 0,
          }));
        },
      );
      newEvents = extractTransferEvents(result.logs);
      lastBlock = result.lastBlock;
      log(`fetched ${result.logs.length} logs → ${newEvents.length} new candidates`);
    } catch (err) {
      log("hypersync error:", err);
      setState((p) => ({ ...p, isLoading: false, isBackScanning: false }));
      runningRef.current = false;
      return;
    }

    if (abortRef.current) { runningRef.current = false; return; }

    // ── 4. Verify only the NEW candidates (delta) ──────────────────
    // We already verified the cached pool above; no need to re-verify.
    // Just confirm the freshly-discovered ones.
    const knownKey = new Set(
      cachedCandidates.map((c) => `${c.contract.toLowerCase()}|${c.tokenId}|${c.is1155 ? "1155" : "721"}`),
    );
    const newCandidates = eventsToCandidates(newEvents).filter(
      (c) => !knownKey.has(`${c.contract.toLowerCase()}|${c.tokenId}|${c.is1155 ? "1155" : "721"}`),
    );

    let newVerified: DiscoveredToken[] = [];
    if (newCandidates.length > 0) {
      try {
        newVerified = await verifyOwnership(browseChainId, userRpc, ownerAddress, newCandidates);
      } catch (err) {
        log("verify-new error:", err);
      }
    }

    if (abortRef.current) { runningRef.current = false; return; }

    // ── 5. Merge + persist ─────────────────────────────────────────
    const merged = [...verified, ...newVerified];
    const mergedCandidates = dedupeCandidates([
      ...cachedCandidates,
      ...eventsToCandidates(newEvents),
    ]);

    const finalCache: HypersyncWalletCache = {
      version: 1,
      lastBlock,
      candidates: mergedCandidates,
      ownedSnapshot: merged.map((t) => ({
        contract: t.contractAddress,
        tokenId: t.tokenId.toString(),
        is1155: !!t.is1155,
      })),
      ownedSnapshotAt: Date.now(),
    };
    await saveHypersyncCache(browseChainId, ownerAddress, finalCache);

    setState({
      tokens: merged,
      scannedBlocks: lastBlock,
      collectionsFound: new Set(merged.map((t) => t.contractAddress.toLowerCase())).size,
      isLoading: false,
      isBackScanning: false,
      backwardProgress: 100,
    });

    runningRef.current = false;
  }, [ownerAddress, browseChainId, getEffectiveRpc]);

  useEffect(() => {
    abortRef.current = true;
    runningRef.current = false;
    const t = setTimeout(scan, 100);
    return () => {
      abortRef.current = true;
      clearTimeout(t);
    };
  }, [scan]);

  return state;
}
