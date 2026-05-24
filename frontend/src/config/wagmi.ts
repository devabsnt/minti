import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { mainnet, base, arbitrum, optimism, polygon, sepolia } from "wagmi/chains";
import { monad, DEFAULT_RPCS } from "./chains";

export const wagmiConfig = getDefaultConfig({
  appName: "minti.art",
  // WalletConnect project ID — only needed for QR code mobile pairing.
  // Get one free at https://cloud.reown.com if you want WalletConnect support.
  // Injected wallets (MetaMask, Phantom, etc.) work without it.
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "placeholder",
  chains: [monad, mainnet, base, arbitrum, optimism, polygon, sepolia],
  transports: {
    [mainnet.id]: http(DEFAULT_RPCS[mainnet.id]),
    [monad.id]: http(DEFAULT_RPCS[monad.id]),
    [base.id]: http(DEFAULT_RPCS[base.id]),
    [arbitrum.id]: http(DEFAULT_RPCS[arbitrum.id]),
    [optimism.id]: http(DEFAULT_RPCS[optimism.id]),
    [polygon.id]: http(DEFAULT_RPCS[polygon.id]),
    [sepolia.id]: http(DEFAULT_RPCS[sepolia.id]),
  },
  ssr: false,
});
