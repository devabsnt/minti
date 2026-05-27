"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { DEFAULT_RPCS, getChainById } from "@/config/chains";
import { RPC_POOLS } from "@/lib/rpcPool";

// Module-scope client cache. Each `(chainId, userRpc)` tuple maps to a
// single PublicClient. Re-using the client across hooks means viem's
// `batch.multicall` actually batches across them — without the cache,
// 24 NftCards mounting would each create their own client and the 50ms
// batch window would batch one call per client (defeating the purpose).
// It also lets viem's fallback `rank` accumulate observed-latency state
// across all callers instead of starting fresh each time.
const clientCache = new Map<string, PublicClient>();

const RPC_STORAGE_KEY = "minti_rpc_overrides";

interface RpcOverrides {
  [chainId: number]: string;
}

interface RpcContextValue {
  overrides: RpcOverrides;
  setOverride: (chainId: number, url: string) => void;
  clearOverride: (chainId: number) => void;
  getEffectiveRpc: (chainId: number) => string;
  getPublicClient: (chainId: number) => PublicClient;
}

const RpcContext = createContext<RpcContextValue>({
  overrides: {},
  setOverride: () => {},
  clearOverride: () => {},
  getEffectiveRpc: (chainId: number) => DEFAULT_RPCS[chainId] || "",
  getPublicClient: () => {
    throw new Error("RpcProvider not mounted");
  },
});

function loadOverrides(): RpcOverrides {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(RPC_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides: RpcOverrides) {
  localStorage.setItem(RPC_STORAGE_KEY, JSON.stringify(overrides));
}

export function RpcProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<RpcOverrides>(loadOverrides);

  const setOverride = useCallback((chainId: number, url: string) => {
    setOverrides((prev) => {
      const next = { ...prev, [chainId]: url };
      saveOverrides(next);
      return next;
    });
  }, []);

  const clearOverride = useCallback((chainId: number) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[chainId];
      saveOverrides(next);
      return next;
    });
  }, []);

  const getEffectiveRpc = useCallback(
    (chainId: number) => overrides[chainId] || DEFAULT_RPCS[chainId] || "",
    [overrides]
  );

  const getPublicClient = useCallback(
    (chainId: number): PublicClient => {
      const userRpc = getEffectiveRpc(chainId);
      const cacheKey = `${chainId}:${userRpc}`;
      const cached = clientCache.get(cacheKey);
      if (cached) return cached;

      const chain = getChainById(chainId);
      // Build a fallback transport over EVERY RPC in the pool, not the
      // single DEFAULT_RPC. viem's fallback transport tries each in
      // order, advances on errors (including rate-limit), and re-ranks
      // them periodically by latency — that ranking is what we want to
      // amortize across calls, hence the module-scope cache above.
      // No per-call shuffle: `rank` learns which RPC is healthiest on
      // its own, and shuffling would discard that signal each call.
      const poolUrls = RPC_POOLS[chainId] ?? [];
      const merged = userRpc && !poolUrls.includes(userRpc)
        ? [userRpc, ...poolUrls]
        : (poolUrls.length > 0 ? poolUrls : [userRpc].filter(Boolean));

      const transports = merged.map((url) =>
        http(url, { retryCount: 1, retryDelay: 250 }),
      );

      const client = createPublicClient({
        chain,
        transport: fallback(transports, { rank: { interval: 30_000 } }),
        batch: {
          multicall: {
            batchSize: 50,
            wait: 50,
          },
        },
      });
      clientCache.set(cacheKey, client);
      return client;
    },
    [getEffectiveRpc]
  );

  const value = useMemo(
    () => ({ overrides, setOverride, clearOverride, getEffectiveRpc, getPublicClient }),
    [overrides, setOverride, clearOverride, getEffectiveRpc, getPublicClient]
  );

  return <RpcContext.Provider value={value}>{children}</RpcContext.Provider>;
}

export function useRpc() {
  return useContext(RpcContext);
}
