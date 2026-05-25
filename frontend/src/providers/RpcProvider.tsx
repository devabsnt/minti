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
      const chain = getChainById(chainId);
      const userRpc = getEffectiveRpc(chainId);

      // Build a fallback transport over EVERY RPC in the pool, not the
      // single DEFAULT_RPC. Otherwise every parallel useNftMetadata call
      // hammers one URL and gets 429'd. viem's fallback transport tries
      // each in order, advancing on any error (including rate-limit),
      // and re-ranks them periodically by latency.
      //
      // We also shuffle the starting index so concurrent client creations
      // don't all begin with the same RPC — that turns N cards mounting
      // at once into a natural round-robin instead of a thundering herd.
      const poolUrls = RPC_POOLS[chainId] ?? [];
      const merged = userRpc && !poolUrls.includes(userRpc)
        ? [userRpc, ...poolUrls]
        : (poolUrls.length > 0 ? poolUrls : [userRpc].filter(Boolean));
      const start = Math.floor(Math.random() * merged.length);
      const ordered = [...merged.slice(start), ...merged.slice(0, start)];

      const transports = ordered.map((url) =>
        http(url, { retryCount: 1, retryDelay: 250 }),
      );

      return createPublicClient({
        chain,
        transport: fallback(transports, { rank: { interval: 30_000 } }),
        batch: {
          multicall: {
            batchSize: 50,
            wait: 50,
          },
        },
      });
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
