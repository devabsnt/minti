import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Collection",
  description:
    "View, list, and trade NFTs from any collection on Monad. Real-time floor, offers, and activity.",
};

export default function CollectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
