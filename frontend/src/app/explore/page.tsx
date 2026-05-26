import type { Metadata } from "next";
import { ExploreClient } from "./client";

export const metadata: Metadata = {
  title: "Discover collections",
  description:
    "Browse trending and long-tail NFT collections on Monad. Real-time activity, holder concentration, and wash-trade signals.",
  openGraph: {
    title: "Discover NFT collections on minti.art",
    description:
      "Trending and long-tail Monad NFT collections, ranked by genuine activity, not raw volume.",
  },
};

export default function ExplorePage() {
  return <ExploreClient />;
}
