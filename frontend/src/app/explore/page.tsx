"use client";

import { useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";

import { CollectionCard } from "@/components/collection/CollectionCard";
import { NftImage } from "@/components/nft/NftImage";
import { formatNumber, formatCompact } from "@/lib/format";
import { useNftMetadata } from "@/hooks/useNftMetadata";
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
                · {formatNumber(indexData.collections.length)} discovered
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

      <div className="space-y-10">
        {/* ── Verified tier ─────────────────────────────────────
         *  Only renders the section header + grid when the registry
         *  is actually deployed. Otherwise show a small inline notice
         *  so users on a chain without a registry deployment still
         *  see the long-tail tier below. */}
        {registryLive ? (
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
        ) : (
          <div className="text-xs text-foreground-secondary border border-border rounded-lg bg-background-secondary px-3 py-2">
            Registry not deployed on {CHAIN_NAMES[browseChainId]} yet — verified collections will appear here once it is.
          </div>
        )}

        {/* ── Long-tail / discovered ───────────────────────────── */}
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
 * Card variant for the "all collections" tier. Square thumbnail (lazy-
 * loaded from the lowest-tokenId NFT's metadata) above name / symbol /
 * activity badge. Designed to feel like an OpenSea collection tile.
 */
function LongTailCard({ collection }: { collection: IndexedCollection }) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";

  // Pick the lowest-known tokenId from the snapshot as the thumbnail source.
  // Falls back to "1" then "0" if missing. useNftMetadata only fires when
  // the tokenId is set.
  const sampleTokenId =
    collection.lowestTokenId != null ? BigInt(collection.lowestTokenId) : 1n;
  const { data: metadata } = useNftMetadata(
    collection.address as `0x${string}`,
    sampleTokenId,
    collection.is1155 && !collection.is721,
  );

  const transferCount = collection.transferCount ?? 0;
  const uniqueHolders = collection.uniqueHolders ?? 0;

  return (
    <a
      href={`/collection/${collection.address}`}
      className="block border border-border rounded-xl overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
    >
      <NftImage
        src={metadata?.image || ""}
        rawUri={metadata?.rawImageUri}
        alt={name}
        className="aspect-square w-full"
      />
      <div className="p-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium truncate">{name}</span>
          {symbol && (
            <span className="text-xs text-foreground-secondary flex-shrink-0">
              {symbol}
            </span>
          )}
        </div>
        {(transferCount > 0 || uniqueHolders > 0) && (
          <div className="flex items-center gap-2 text-xs text-foreground-secondary">
            {uniqueHolders > 0 && (
              <span>{formatCompact(uniqueHolders)} holders</span>
            )}
            {uniqueHolders > 0 && transferCount > 0 && <span>·</span>}
            {transferCount > 0 && (
              <span>{formatCompact(transferCount)} trades</span>
            )}
          </div>
        )}
        {collection.totalSupply && Number(collection.totalSupply) > 0 && (
          <div className="text-xs text-foreground-secondary">
            {formatNumber(collection.totalSupply)} items
          </div>
        )}
      </div>
    </a>
  );
}
