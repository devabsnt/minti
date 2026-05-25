import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet",
  description:
    "View NFTs, listings, bids, and offers for any Monad wallet. Cross-collection portfolio at a glance.",
  // Discourage indexing — wallet pages are personal and combinatorial.
  robots: {
    index: false,
    follow: false,
  },
};

export default function WalletLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
