"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { DEFAULT_RPCS, getChainById } from "@/config/chains";

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
      const rpcUrl = getEffectiveRpc(chainId);
      return createPublicClient({
        chain,
        transport: http(rpcUrl, {
          retryCount: 3,
          retryDelay: 1000,
        }),
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
