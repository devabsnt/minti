"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { monad } from "@/config/chains";
import type { SupportedChainId } from "@/config/chains";

interface ChainContextValue {
  browseChainId: SupportedChainId;
  setBrowseChainId: (chainId: SupportedChainId) => void;
}

const ChainContext = createContext<ChainContextValue>({
  browseChainId: monad.id,
  setBrowseChainId: () => {},
});

export function ChainProvider({ children }: { children: ReactNode }) {
  // Always start with Monad to match SSR; sync from localStorage after mount
  const [browseChainId, setBrowseChainIdState] =
    useState<SupportedChainId>(monad.id);

  useEffect(() => {
    const stored = localStorage.getItem("minti_browse_chain");
    if (stored) {
      setBrowseChainIdState(Number(stored) as SupportedChainId);
    }
  }, []);

  const setBrowseChainId = useCallback((chainId: SupportedChainId) => {
    setBrowseChainIdState(chainId);
    localStorage.setItem("minti_browse_chain", String(chainId));
  }, []);

  return (
    <ChainContext.Provider value={{ browseChainId, setBrowseChainId }}>
      {children}
    </ChainContext.Provider>
  );
}

export function useBrowseChain() {
  return useContext(ChainContext);
}
