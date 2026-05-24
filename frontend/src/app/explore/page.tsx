"use client";

import { useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";

import { CollectionCard } from "@/components/collection/CollectionCard";
import { NftGrid } from "@/components/nft/NftGrid";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useBrowseChain } from "@/providers/ChainProvider";
import { CHAIN_NAMES } from "@/config/chains";
import {
  useRegisteredCollections,
  REGISTRY_PAGE_SIZE,
  type RegisteredCollection,
} from "@/hooks/useRegistry";
import {
  useCollectionsIndex,
  searchIndex,
  hasSnapshot,
  type IndexedCollection,
} from "@/hooks/useCollectionsIndex";
import { isRegistryDeployed } from "@/lib/evmfs";
import { kindTier } from "@/lib/abi/EVMFSCollectionRegistry";

export default function ExplorePage() {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const { browseChainId } = useBrowseChain();
  const registryLive = isRegistryDeployed(browseChainId);
  const snapshotAvailable = hasSnapshot(browseChainId);

  const { data: registryData, isLoading: registryLoading } =
    useRegisteredCollections(page);
  const { data: indexData, isLoading: indexLoading } = useCollectionsIndex();

  const handleJump = useCallback(() => {
    const value = search.trim();
    if (isAddress(value)) {
      router.push(`/collection/${value}`);
      setSearch("");
    }
  }, [search, router]);

  const registryCollections = useMemo(
    () => registryData?.collections ?? [],
    [registryData?.collections],
  );
  const total = registryData?.total ?? 0;
  const totalPages = Math.ceil(total / REGISTRY_PAGE_SIZE);

  const trimmed = search.trim();
  const isSearchingByText = trimmed.length > 0 && !isAddress(trimmed);

  // Registry collections (always shown; ranked by tier/verified).
  const rankedRegistry = useMemo<RegisteredCollection[]>(() => {
    const ranked = rankByTier(registryCollections);
    if (!isSearchingByText) return ranked;
    const needle = trimmed.toLowerCase();
    return ranked.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.symbol.toLowerCase().includes(needle),
    );
  }, [registryCollections, isSearchingByText, trimmed]);

  // Long-tail collections from the snapshot. Exclude any that are already
  // in the registry view (dedupe by lower-cased address).
  const registryAddresses = useMemo(
    () => new Set(registryCollections.map((c) => c.nftContract.toLowerCase())),
    [registryCollections],
  );

  const longTail = useMemo<IndexedCollection[]>(() => {
    if (!indexData) return [];
    const results = searchIndex(indexData, trimmed, 96);
    return results.filter(
      (c) => !registryAddresses.has(c.address.toLowerCase()),
    );
  }, [indexData, trimmed, registryAddresses]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold">Discover</h1>
          <p className="text-sm text-foreground-secondary mt-1">
            Collections on {CHAIN_NAMES[browseChainId] || "Unknown Chain"}
            {total > 0 && (
              <span className="ml-1">
                · {total} verified
              </span>
            )}
            {indexData && (
              <span className="ml-1">
                · {indexData.collections.length.toLocaleString()} discovered
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="flex-1 sm:flex-initial sm:w-72">
            <Input
              placeholder="Search name, ticker, or 0x address"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleJump()}
            />
          </div>
        </div>
      </div>

      {!registryLive ? (
        <div className="border border-border rounded-xl bg-background-secondary p-10 text-center">
          <p className="text-foreground-secondary mb-4">
            The EVMFS collection registry isn&apos;t deployed on{" "}
            {CHAIN_NAMES[browseChainId]} yet.
          </p>
          <p className="text-xs text-foreground-secondary">
            Switch chains, or run the Foundry deploy script and update{" "}
            <code>EVMFS_COLLECTION_REGISTRY</code> in{" "}
            <code>lib/evmfs/addresses.ts</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {/* ── Verified tier ───────────────────────────────────── */}
          <section>
            <h2 className="text-sm font-medium uppercase tracking-wide text-foreground-secondary mb-3">
              Verified
              {rankedRegistry.length > 0 && (
                <span className="ml-2 text-xs">{rankedRegistry.length}</span>
              )}
            </h2>
            <NftGrid
              loading={registryLoading}
              empty={!registryLoading && rankedRegistry.length === 0}
              emptyMessage={
                isSearchingByText
                  ? "No verified collections match."
                  : "No verified collections yet on this chain."
              }
            >
              {rankedRegistry.map((c) => (
                <CollectionCard key={c.id} collection={c} />
              ))}
            </NftGrid>

            {!isSearchingByText && totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-foreground-secondary">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </section>

          {/* ── Long-tail / discovered ──────────────────────────── */}
          {snapshotAvailable && (
            <section>
              <h2 className="text-sm font-medium uppercase tracking-wide text-foreground-secondary mb-3">
                All collections
                {longTail.length > 0 && (
                  <span className="ml-2 text-xs">{longTail.length}</span>
                )}
                {!indexData && indexLoading && (
                  <span className="ml-2 text-xs text-foreground-secondary/70">
                    loading…
                  </span>
                )}
              </h2>
              {longTail.length > 0 ? (
                <NftGrid loading={false} empty={false}>
                  {longTail.map((c) => (
                    <LongTailCard key={c.address} collection={c} />
                  ))}
                </NftGrid>
              ) : (
                !indexLoading && (
                  <div className="text-sm text-foreground-secondary">
                    {isSearchingByText
                      ? "No collections in the snapshot match your search."
                      : "Snapshot loaded, but no extra collections to show."}
                  </div>
                )
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Stable sort: EVMFS first, then data: URIs, then off-chain. Verified pinned
 * above unverified within each tier. Ties broken by registry id ascending.
 */
function rankByTier(items: readonly RegisteredCollection[]): RegisteredCollection[] {
  return [...items].sort((a, b) => {
    const tierDiff = kindTier(a.kind) - kindTier(b.kind);
    if (tierDiff !== 0) return tierDiff;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.id - b.id;
  });
}

/**
 * Card variant for the "all collections" tier — we have a name+symbol but
 * no icon URL or verified flag. Minimal card that links into /collection.
 */
function LongTailCard({ collection }: { collection: IndexedCollection }) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  return (
    <a
      href={`/collection/${collection.address}`}
      className="block border border-border rounded-xl bg-background-secondary p-4 hover:border-mint/30 transition-all"
    >
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium truncate">{name}</span>
        {symbol && (
          <span className="text-xs text-foreground-secondary truncate">
            {symbol}
          </span>
        )}
        <span className="text-xs text-foreground-secondary font-mono truncate">
          {collection.address.slice(0, 10)}…
        </span>
        {collection.totalSupply && (
          <span className="text-xs text-foreground-secondary">
            {Number(collection.totalSupply).toLocaleString()} items
          </span>
        )}
      </div>
    </a>
  );
}
