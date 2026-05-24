"use client";

import { SUPPORTED_CHAINS, CHAIN_NAMES } from "@/config/chains";
import { useBrowseChain } from "@/providers/ChainProvider";
import type { SupportedChainId } from "@/config/chains";

export function ChainSelector() {
  const { browseChainId, setBrowseChainId } = useBrowseChain();

  return (
    <select
      value={browseChainId}
      onChange={(e) =>
        setBrowseChainId(Number(e.target.value) as SupportedChainId)
      }
      aria-label="Select blockchain network"
      className="bg-background-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground-secondary hover:border-mint/50 focus:border-mint focus:outline-none transition-colors cursor-pointer"
    >
      {SUPPORTED_CHAINS.map((chain) => (
        <option key={chain.id} value={chain.id}>
          {CHAIN_NAMES[chain.id] || chain.name}
        </option>
      ))}
    </select>
  );
}
