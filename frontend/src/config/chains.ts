import { mainnet, base, arbitrum, optimism, polygon, sepolia } from "wagmi/chains";
import { defineChain } from "viem";
import type { Chain } from "wagmi/chains";

export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc-mainnet.monadinfra.com"] },
  },
  blockExplorers: {
    default: { name: "Monadscan", url: "https://monadscan.com" },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export const SUPPORTED_CHAINS = [
  mainnet,
  monad,
  base,
  arbitrum,
  optimism,
  polygon,
  sepolia,
] as const;

export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]["id"];

export const WETH_ADDRESSES: Record<number, `0x${string}`> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [monad.id]: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", // Wrapped MON
  [base.id]: "0x4200000000000000000000000000000000000006",
  [optimism.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  [polygon.id]: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  [sepolia.id]: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
};

// TODO: Update after CREATE2 deployment
export const MINTI_MARKETPLACE_ADDRESS =
  "0x0000000000000000000000000000000000000000" as `0x${string}`;

export const isMarketplaceDeployed =
  MINTI_MARKETPLACE_ADDRESS !== "0x0000000000000000000000000000000000000000";

export const DEFAULT_RPCS: Record<number, string> = {
  [mainnet.id]: "https://ethereum.publicnode.com",
  [monad.id]: "https://rpc3.monad.xyz",
  [base.id]: "https://mainnet.base.org",
  [optimism.id]: "https://mainnet.optimism.io",
  [arbitrum.id]: "https://arb1.arbitrum.io/rpc",
  [polygon.id]: "https://polygon-rpc.com",
  [sepolia.id]: "https://ethereum-sepolia-rpc.publicnode.com",
};

export const CHAIN_NAMES: Record<number, string> = {
  [mainnet.id]: "Ethereum",
  [monad.id]: "Monad",
  [base.id]: "Base",
  [arbitrum.id]: "Arbitrum",
  [optimism.id]: "Optimism",
  [polygon.id]: "Polygon",
  [sepolia.id]: "Sepolia",
};

export function getChainById(chainId: number): Chain | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId);
}

/**
 * Native currency symbol for the chain (e.g. "ETH" on mainnet, "MON" on Monad).
 * Falls back to "ETH" if the chain isn't in {@link SUPPORTED_CHAINS}.
 */
export function getNativeSymbol(chainId: number | undefined): string {
  if (chainId === undefined) return "ETH";
  return getChainById(chainId)?.nativeCurrency.symbol ?? "ETH";
}
