"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Featured collections list. Static JSON under `/public/data/featured.json`.
 * To feature a collection, edit that file (address + optional blurb), commit,
 * push. The card auto-populates from indexer data using the address as the
 * key. No transaction needed, no contract write.
 */

export interface FeaturedCollectionEntry {
  address: string;
  blurb?: string;
}

interface FeaturedCollectionsFile {
  collections: FeaturedCollectionEntry[];
}

const STALE_TIME = 5 * 60 * 1000; // 5 min; the file rarely changes

export function useFeaturedCollections() {
  return useQuery({
    queryKey: ["featured-collections"],
    staleTime: STALE_TIME,
    queryFn: async (): Promise<FeaturedCollectionEntry[]> => {
      const resp = await fetch("/data/featured.json");
      if (!resp.ok) return [];
      const data = (await resp.json()) as FeaturedCollectionsFile;
      return (data.collections ?? []).map((c) => ({
        address: c.address.toLowerCase(),
        blurb: c.blurb,
      }));
    },
  });
}
