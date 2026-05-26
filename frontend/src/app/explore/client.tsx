"use client";

import { useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";

import { CollectionCard } from "@/components/collection/CollectionCard";
import { NftImage } from "@/components/nft/NftImage";
import { formatNumber, formatCompact } from "@/lib/format";
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
  useIndexerCollections,
  type ApiCollection,
  type SortKey,
} from "@/hooks/useIndexerCollections";
import { useHiddenCollections } from "@/hooks/useHiddenCollections";
import { useDebounce } from "@/hooks/useDebounce";
import { isRegistryDeployed } from "@/lib/evmfs";
import { kindTier } from "@/lib/abi/EVMFSCollectionRegistry";

/**
 * Discover page. Three tiers shown in order:
 *   1. Verified — on-chain registry collections (separate from the
 *      indexer; comes from EVMFSCollectionRegistry contract reads).
 *   2. Trending — top 6 collections from the indexer, sorted by
 *      transfer_count in the retention window.
 *   3. All collections — paginated long-tail from the indexer.
 *
 * Everything below #1 comes from the live indexer API. The previous
 * static-snapshot + client-side dedupe/filter pipeline is gone.
 */
export function ExploreClient() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("trending");
  const [longTailPage, setLongTailPage] = useState(0);
  const [registryPage, setRegistryPage] = useState(0);
  const { browseChainId } = useBrowseChain();
  const registryLive = isRegistryDeployed(browseChainId);
  const { isHidden } = useHiddenCollections(browseChainId);

  const LONG_TAIL_PAGE_SIZE = 48;

  // Debounce the search input so we don't fire a fresh API call on
  // every keystroke. Address-jump still uses the raw value for Enter.
  const debouncedSearch = useDebounce(search, 200);
  const trimmed = debouncedSearch.trim();
  const isSearchingByText = trimmed.length > 0 && !isAddress(trimmed);
  const q = isSearchingByText ? trimmed : undefined;

  // ── Registry tier (on-chain, untouched by the indexer migration) ──
  const { data: registryData, isLoading: registryLoading } =
    useRegisteredCollections(registryPage);
  const registryCollections = useMemo(
    () => registryData?.collections ?? [],
    [registryData?.collections],
  );
  const totalRegistry = registryData?.total ?? 0;
  const totalRegistryPages = Math.ceil(totalRegistry / REGISTRY_PAGE_SIZE);

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

  // Address set for dedupe against trending/long-tail tiers.
  const registryAddresses = useMemo(
    () =>
      new Set(registryCollections.map((c) => c.nftContract.toLowerCase())),
    [registryCollections],
  );

  // ── Trending hero (top 6 explore-eligible by trending) ────────────
  const { data: trendingData } = useIndexerCollections({
    tier: 2,
    sort: "trending",
    limit: 6,
    q,
  });
  const trendingHero = useMemo(() => {
    const rows = trendingData?.collections ?? [];
    return rows
      .filter((c) => !registryAddresses.has(c.address.toLowerCase()))
      .filter((c) => !isHidden(c.address))
      .slice(0, 6);
  }, [trendingData, registryAddresses, isHidden]);

  // ── Long-tail / all collections (paginated) ───────────────────────
  // tier=2 by default; "show hidden" includes tier 1 (real but quieter).
  const { data: longTailData, isLoading: longTailLoading } =
    useIndexerCollections({
      tier: showAll ? 1 : 2,
      sort: sortKey,
      limit: LONG_TAIL_PAGE_SIZE,
      offset: longTailPage * LONG_TAIL_PAGE_SIZE,
      q,
    });
  const longTail = useMemo(() => {
    const rows = longTailData?.collections ?? [];
    return rows
      .filter((c) => !registryAddresses.has(c.address.toLowerCase()))
      .filter((c) => !isHidden(c.address));
  }, [longTailData, registryAddresses, isHidden]);
  const longTailTotal = longTailData?.pagination.total ?? 0;
  const longTailTotalPages = Math.ceil(longTailTotal / LONG_TAIL_PAGE_SIZE);

  // ── Search box behavior ───────────────────────────────────────────
  const handleJump = useCallback(() => {
    const value = search.trim();
    if (isAddress(value)) {
      router.push(`/collection/${value}`);
      setSearch("");
    }
  }, [search, router]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold">Discover</h1>
          <p className="text-sm text-foreground-secondary mt-1">
            Collections on {CHAIN_NAMES[browseChainId] || "Unknown Chain"}
            {totalRegistry > 0 && (
              <span className="ml-1">· {totalRegistry} verified</span>
            )}
            {longTailTotal > 0 && (
              <span className="ml-1">
                · {formatNumber(longTailTotal)} active
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
        {/* ── Verified tier ─────────────────────────────────────── */}
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

            {!isSearchingByText && totalRegistryPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={registryPage === 0}
                  onClick={() => setRegistryPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-foreground-secondary">
                  Page {registryPage + 1} of {totalRegistryPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={registryPage >= totalRegistryPages - 1}
                  onClick={() => setRegistryPage((p) => p + 1)}
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

        {/* ── Trending hero ────────────────────────────────────── */}
        {trendingHero.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium uppercase tracking-wide text-foreground-secondary">
                <span className="text-mint">●</span> Trending
                <span className="ml-2 text-xs text-foreground-secondary/70">
                  most active
                </span>
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {trendingHero.map((collection, idx) => (
                <TrendingHeroCard
                  key={collection.address}
                  rank={idx + 1}
                  collection={collection}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Long-tail / all collections ──────────────────────── */}
        <section>
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium uppercase tracking-wide text-foreground-secondary">
                All collections
                {longTailTotal > 0 && (
                  <span className="ml-2 text-xs">{formatNumber(longTailTotal)}</span>
                )}
                {longTailLoading && (
                  <span className="ml-2 text-xs text-foreground-secondary/70">
                    loading…
                  </span>
                )}
              </h2>
              <label className="text-xs text-foreground-secondary flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => {
                    setShowAll(e.target.checked);
                    setLongTailPage(0);
                  }}
                  className="accent-mint"
                />
                Show long-tail
              </label>
            </div>

            {/* Sort chips */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 text-foreground-secondary">
                Sort
                <select
                  value={sortKey}
                  onChange={(e) => {
                    setSortKey(e.target.value as SortKey);
                    setLongTailPage(0);
                  }}
                  className="bg-background-secondary border border-border rounded-md px-2 py-1 text-foreground focus:outline-none focus:border-mint"
                >
                  <option value="trending">Trending</option>
                  <option value="holders">Holders</option>
                  <option value="newest">Newest</option>
                  <option value="name">Name (A→Z)</option>
                </select>
              </label>
            </div>
          </div>

          <NftGrid
            loading={longTailLoading}
            empty={!longTailLoading && longTail.length === 0}
            emptyMessage={
              isSearchingByText
                ? "No collections match your search."
                : "No collections to show."
            }
          >
            {longTail.map((c) => (
              <LongTailCard key={c.address} collection={c} />
            ))}
          </NftGrid>

          {longTailTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-6">
              <Button
                variant="secondary"
                size="sm"
                disabled={longTailPage === 0}
                onClick={() => setLongTailPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-foreground-secondary">
                Page {longTailPage + 1} of {longTailTotalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={longTailPage >= longTailTotalPages - 1}
                onClick={() => setLongTailPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** EVMFS-first / data: URI second / off-chain last, then verified-first. */
function rankByTier(items: readonly RegisteredCollection[]): RegisteredCollection[] {
  return [...items].sort((a, b) => {
    const tierDiff = kindTier(a.kind) - kindTier(b.kind);
    if (tierDiff !== 0) return tierDiff;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.id - b.id;
  });
}

/**
 * Long-tail collection card. Reads everything from the API row — no
 * runtime tokenURI fetches, no IPFS gateway race. The indexer's
 * enrichment pass populated `sampleImageUrl` already.
 */
function LongTailCard({ collection }: { collection: ApiCollection }) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const transferCount = collection.transferCount ?? 0;
  const uniqueHolders = collection.uniqueHolders ?? 0;

  return (
    <a
      href={`/collection/${collection.address}`}
      className="block border border-border rounded-xl overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
    >
      <NftImage
        src={collection.sampleImageUrl ?? ""}
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
              <span>{formatCompact(transferCount)} transfers</span>
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

/** Bigger card for the trending hero strip. */
function TrendingHeroCard({
  rank,
  collection,
}: {
  rank: number;
  collection: ApiCollection;
}) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const transferCount = collection.transferCount ?? 0;

  return (
    <a
      href={`/collection/${collection.address}`}
      className="group relative flex gap-3 items-center p-3 border border-border rounded-xl bg-background-secondary hover:border-mint/40 hover:shadow-lg hover:shadow-mint-glow transition-all"
    >
      <div className="flex items-center justify-center w-6 text-sm font-bold text-foreground-secondary/70 flex-shrink-0">
        {rank}
      </div>
      <div className="w-16 h-16 rounded-lg overflow-hidden border border-border flex-shrink-0">
        <NftImage
          src={collection.sampleImageUrl ?? ""}
          alt={name}
          className="w-16 h-16"
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold truncate">{name}</span>
        </div>
        <div className="text-xs text-foreground-secondary truncate">
          {symbol}
        </div>
        <div className="flex items-center gap-2 text-xs mt-0.5">
          <span className="text-mint">
            {formatCompact(transferCount)}{" "}
            <span className="text-foreground-secondary">transfers</span>
          </span>
        </div>
      </div>
    </a>
  );
}
