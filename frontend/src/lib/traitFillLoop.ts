import type { Abi } from "viem";
import {
  buildUriTemplate,
  expandUriTemplate,
  resolveMetadata,
} from "@/lib/metadata";
import {
  createRpcPool,
  executeBatchedMulticalls,
  encodeCall,
  decodeResult,
  type MulticallRequest,
} from "@/lib/rpcPool";
import {
  getAggregateForCollection,
  mergeTokenIntoAggregate,
  setTraitCache,
} from "@/lib/traitsCache";
import { isHostDead, markHostDead } from "@/lib/proxyRouter";

/**
 * Pure-data fill loop for trait enumeration. Shared between the Web
 * Worker entrypoint and (as a fallback) the main thread, so the logic
 * lives in exactly one place.
 *
 * Side effects: writes to IndexedDB via `mergeTokenIntoAggregate` and
 * `setTraitCache`. Returns nothing. The caller polls the aggregate
 * (or listens to the per-token progress callback) to surface updates.
 *
 * Designed to be importable from a worker — no React, no DOM. The
 * RPC pool singleton is re-created lazily per call; worker and main
 * thread have separate copies and that's fine, they share no memory.
 */

const TOKEN_URI_ABI = [
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "tokenURI",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

export const URI_BATCH_SIZE = 200;
export const URI_BATCH_PARALLELISM = 5;
export const JSON_CONCURRENCY = 30;
export const HOST_FAILURE_BAIL = 12;
export const IDENTICAL_THRESHOLD = 0.95;

export interface FillLoopParams {
  contract: string;
  chainId: number;
  totalSupply: number;
  tokenIdStart: number;
  userRpc: string | undefined;
  /** Token IDs the aggregate already has (we skip these). */
  seenTokenIds: Set<string>;
  /** Indexer's raw tokenURI(1) template, if available. */
  indexerTemplate: string | null;
  /** Called when we've merged N more tokens since last call. */
  onProgress?: (mergedCount: number, totalToFetch: number) => void;
  /** Optional cancellation probe. */
  cancelled?: () => boolean;
}

export async function runFillLoop(params: FillLoopParams): Promise<void> {
  const {
    contract,
    chainId,
    totalSupply,
    tokenIdStart,
    userRpc,
    seenTokenIds,
    indexerTemplate,
    onProgress,
    cancelled = () => false,
  } = params;
  const contractLower = contract.toLowerCase();

  const missingIds: bigint[] = [];
  for (let i = 0; i < totalSupply; i++) {
    const id = BigInt(tokenIdStart + i);
    if (!seenTokenIds.has(id.toString())) missingIds.push(id);
  }
  if (missingIds.length === 0) {
    await finalizeAggregate(chainId, contractLower, totalSupply);
    return;
  }

  const { uriByTokenId, samples } = await resolveUrisForTokens({
    contract: contractLower,
    chainId,
    userRpc,
    tokenIds: missingIds,
    indexerTemplate,
    cancelled,
  });
  if (cancelled()) return;

  const hostFailures = new Map<string, number>();
  const bailedHosts = new Set<string>();
  // Hosts previously marked dead (5xx storm or persistent failure) skip
  // the network round-trip entirely. This is what makes the second
  // visit to a scatter-502 collection silent in the console.
  const entries = Array.from(uriByTokenId.entries()).filter(
    ([, uri]) => !isHostDead(uri),
  );
  let mergedSinceLastReport = 0;

  for (let i = 0; i < entries.length; i += JSON_CONCURRENCY) {
    if (cancelled()) return;
    const wave = entries.slice(i, i + JSON_CONCURRENCY);
    await Promise.all(
      wave.map(async ([tokenIdStr, uri]) => {
        const host = hostOf(uri);
        if (host && bailedHosts.has(host)) return;
        try {
          const meta = await resolveMetadata(uri, BigInt(tokenIdStr));
          if (host) hostFailures.set(host, 0);
          await mergeTokenIntoAggregate(
            chainId,
            contractLower,
            tokenIdStr,
            meta.attributes,
            { totalSupply },
          );
          mergedSinceLastReport++;
        } catch {
          if (host) {
            const next = (hostFailures.get(host) ?? 0) + 1;
            hostFailures.set(host, next);
            // Bail this host (and persist as "dead" for an hour) once it
            // crosses the threshold. We used to exempt proxiable hosts
            // here, but the proxy can't fix an upstream that's actually
            // returning 502 (e.g. scatter.art instareveal during a
            // outage) — bailing avoids the console-spam storm of a
            // 3333-token enumeration sweep against a dead endpoint.
            if (next >= HOST_FAILURE_BAIL) {
              bailedHosts.add(host);
              markHostDead(uri);
            }
          }
        }
      }),
    );
    if (mergedSinceLastReport > 0) {
      onProgress?.(mergedSinceLastReport, entries.length);
      mergedSinceLastReport = 0;
    } else {
      // Report wave completion even when every token failed so the UI
      // ticks past the wave instead of stalling on 0% progress.
      onProgress?.(0, entries.length);
    }
  }

  // Persist the sampled tokenURIs once (mergeTokenIntoAggregate doesn't
  // touch sampledTokenURIs).
  if (samples.length > 0) {
    const fresh = await getAggregateForCollection(chainId, contractLower);
    if (fresh) {
      fresh.sampledTokenURIs = samples;
      await setTraitCache(fresh);
    }
  }

  await finalizeAggregate(chainId, contractLower, totalSupply);
}

interface ResolveUrisParams {
  contract: string;
  chainId: number;
  userRpc: string | undefined;
  tokenIds: bigint[];
  indexerTemplate: string | null;
  cancelled: () => boolean;
}

interface ResolveUrisResult {
  uriByTokenId: Map<string, string>;
  samples: Array<{ tokenId: string; uri: string }>;
}

async function resolveUrisForTokens(
  params: ResolveUrisParams,
): Promise<ResolveUrisResult> {
  const { contract, chainId, userRpc, tokenIds, indexerTemplate } = params;
  const uriByTokenId = new Map<string, string>();
  const samples: Array<{ tokenId: string; uri: string }> = [];

  const template =
    indexerTemplate && indexerTemplate.length > 0
      ? indexerTemplate.includes("{id}")
        ? indexerTemplate
        : buildUriTemplate(indexerTemplate, 1n)
      : null;

  if (template) {
    for (const id of tokenIds) {
      uriByTokenId.set(id.toString(), expandUriTemplate(template, id));
    }
    for (const id of tokenIds.slice(0, 5)) {
      samples.push({
        tokenId: id.toString(),
        uri: expandUriTemplate(template, id),
      });
    }
    return { uriByTokenId, samples };
  }

  const pool = createRpcPool(chainId, userRpc);
  const chunks: bigint[][] = [];
  for (let i = 0; i < tokenIds.length; i += URI_BATCH_SIZE) {
    chunks.push(tokenIds.slice(i, i + URI_BATCH_SIZE));
  }

  for (let wave = 0; wave < chunks.length; wave += URI_BATCH_PARALLELISM) {
    if (params.cancelled()) return { uriByTokenId, samples };
    const slice = chunks.slice(wave, wave + URI_BATCH_PARALLELISM);
    const waveResults = await Promise.all(
      slice.map(async (chunk, chunkIdxInWave) => {
        const calls: MulticallRequest[] = chunk.map((id) =>
          encodeCall(contract as `0x${string}`, TOKEN_URI_ABI, "tokenURI", [id]),
        );
        try {
          const results = await executeBatchedMulticalls(pool, calls);
          return { chunk, flat: results.flat(), chunkIdxInWave };
        } catch {
          return { chunk, flat: [], chunkIdxInWave };
        }
      }),
    );
    for (const { chunk, flat, chunkIdxInWave } of waveResults) {
      const absoluteChunkIdx = wave + chunkIdxInWave;
      for (let j = 0; j < chunk.length; j++) {
        const entry = flat[j];
        if (!entry || !entry.success) continue;
        const uri = decodeResult<string>(TOKEN_URI_ABI, "tokenURI", entry);
        if (!uri) continue;
        const tokenIdStr = chunk[j].toString();
        uriByTokenId.set(tokenIdStr, uri);
        if (samples.length < 5 && absoluteChunkIdx === 0 && j < 5) {
          samples.push({ tokenId: tokenIdStr, uri });
        }
      }
    }
  }
  return { uriByTokenId, samples };
}

async function finalizeAggregate(
  chainId: number,
  contract: string,
  totalSupply: number,
): Promise<void> {
  const agg = await getAggregateForCollection(chainId, contract);
  if (!agg) return;
  const enumeratedCount = Object.keys(agg.tokenAttributes).length;
  if (enumeratedCount === 0) {
    agg.status = "failed";
    await setTraitCache(agg);
    return;
  }
  if (Object.keys(agg.traitCounts).length === 0) {
    agg.status = "all_identical";
    await setTraitCache(agg);
    return;
  }
  const sigCounts = new Map<string, number>();
  for (const attrs of Object.values(agg.tokenAttributes)) {
    const sig = attrs
      .map((a) => `${a.trait_type}=${a.value}`)
      .sort()
      .join("|");
    sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
  }
  let maxSig = 0;
  for (const c of sigCounts.values()) if (c > maxSig) maxSig = c;
  if (maxSig / enumeratedCount >= IDENTICAL_THRESHOLD) {
    agg.status = "all_identical";
  } else if (enumeratedCount >= totalSupply) {
    agg.status = "complete";
  } else {
    agg.status = "partial";
  }
  // computeRarity is already called inside mergeTokenIntoAggregate.
  // Re-call here to capture the final state including any tokens that
  // arrived in the same wave as the status promotion.
  const { computeRarity } = await import("@/lib/traitsCache");
  computeRarity(agg);
  await setTraitCache(agg);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
