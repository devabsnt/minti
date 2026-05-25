import type { Metadata } from "next";
import { LaunchClient } from "./client";

export const metadata: Metadata = {
  title: "Launch a collection",
  description:
    "Deploy an immutable, fully on-chain NFT collection via EVMFS in one flow. Art and metadata stored permanently as Ethereum event logs.",
};

export default function LaunchPage() {
  return <LaunchClient />;
}
