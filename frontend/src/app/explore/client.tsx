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
  isLikelyReal,
  isTrendable,
  momentum,
  type IndexedCollection,
  type SortKey,
  type ActivityWindow,
} from "@/hooks/useCollectionsIndex";
import { useTrendingLive } from "@/hooks/useTrendingLive";
import { useHiddenCollections } from "@/hooks/useHiddenCollections";
import { useDebounce } from "@/hooks/useDebounce";
import { isRegistryDeployed } from "@/lib/evmfs";
import { kindTier } from "@/lib/abi/EVMFSCollectionRegistry";

export function ExploreClient() {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  // New filter/sort state
  const [sortKey, setSortKey] = useState<SortKey>("trending");
  const [window, setWindow] = useState<ActivityWindow>("7d");
  const [tokenType, setTokenType] = useState<"721" | "1155" | "any">("any");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const { browseChainId } = useBrowseChain();
  const registryLive = isRegistryDeployed(browseChainId);
  const snapshotAvailable = hasSnapshot(browseChainId);

  const { data: registryData, isLoading: registryLoading } =
    useRegisteredCollections(page);
  const { data: indexData, isLoading: indexLoading } = useCollectionsIndex();
  // Last 6h transfer counts from a static cron-built snapshot
  // (`/data/monad-trending.json`, refreshed hourly). Used to rank the
  // Trending hero with fresher data than the daily collections snapshot.
  // Backed by a server-side cron so we never hit Hypersync per-user.
  const { data: liveTrending } = useTrendingLive(6);
  const { isHidden } = useHiddenCollections(browseChainId);

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

  // Debounce the filter input so a 150ms keystroke pause runs the
  // expensive dedupe+sort over 35k collections instead of every keypress.
  // The address-jump handler still uses the raw value so Enter works
  // without waiting for the debounce.
  const debouncedSearch = useDebounce(search, 150);
  const trimmed = debouncedSearch.trim();
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

  // Long-tail collections from the snapshot. Apply three layers of filter:
  //   1. Address dedupe — already verified, skip
  //   2. Name copycat — if the name matches a verified collection, hide
  //      (a long-tail "Baolings" with a different contract address is a
  //      knockoff, not the real one)
  //   3. Spam heuristic — `isLikelyReal` floor unless user opted to see all
  const registryAddresses = useMemo(
    () => new Set(registryCollections.map((c) => c.nftContract.toLowerCase())),
    [registryCollections],
  );
  const registryNames = useMemo(
    () =>
      new Set(
        registryCollections
          .flatMap((c) => [c.name, c.symbol])
          .filter(Boolean)
          .map((s) => s.toLowerCase()),
      ),
    [registryCollections],
  );

  const longTail = useMemo<IndexedCollection[]>(() => {
    if (!indexData) return [];
    // Search the full index (already deduped by name internally) with the
    // chosen sort + window + type filter.
    const results = searchIndex(indexData, {
      query: trimmed,
      limit: 200,
      sortKey,
      window,
      tokenType,
    });
    return results
      .filter((c) => {
        // 1. Address dedupe — already in verified tier
        if (registryAddresses.has(c.address.toLowerCase())) return false;
        // 2. Name copycat dedupe
        const name = (c.name || "").toLowerCase();
        const symbol = (c.symbol || "").toLowerCase();
        if (name && registryNames.has(name)) return false;
        if (symbol && registryNames.has(symbol)) return false;
        // 3. User-hidden in IndexedDB — bypassed when "Show hidden" is on
        // so the user can recover from an accidental hide click.
        if (!showAll && isHidden(c.address)) return false;
        // 4. Spam heuristic — opt-out via the show-all toggle
        if (!showAll && !isLikelyReal(c)) return false;
        return true;
      })
      .slice(0, 96);
  }, [indexData, trimmed, registryAddresses, registryNames, showAll, sortKey, window, tokenType, isHidden]);

  // Trending hero — six big cards at the top showing collections people
  // are *actually* trading right now. Uses isTrendable() which is stricter
  // than isLikelyReal — requires real community size, sustained history,
  // and rejects "just deployed, dumping a thousand mints in 24h" airdrops.
  //
  // Includes verified registry collections (real curated ones get the
  // verified badge). Names overlapping the registry get the copycat dedupe
  // applied so a fake "Skrumpeys" doesn't push out the real one.
  const trendingHero = useMemo<
    Array<{ collection: IndexedCollection; verified: boolean; live6h: number }>
  >(() => {
    if (!indexData || trimmed) return [];
    const live = liveTrending; // Map<address, transferCount> over last 6h

    // Score a collection using live 6h count when available; if the map
    // hasn't loaded yet OR doesn't contain this address, fall back to the
    // snapshot's recent24h instead of scoring 0. The previous behavior
    // collapsed the hero to empty whenever the only high-live-count
    // entries got filtered (e.g. when LP-position NFTs are removed and
    // the remaining legit collections aren't in the 6h window).
    const liveScore = (c: IndexedCollection): number => {
      const liveVal = live?.get(c.address.toLowerCase()) ?? 0;
      if (liveVal > 0) return liveVal;
      return c.recent24h ?? 0;
    };

    // Verified collections lifted into IndexedCollection-ish shape so the
    // hero can rank them next to long-tail entries. They get a free pass
    // through filters since they're manually vetted.
    const verifiedAsIndex: IndexedCollection[] = registryCollections.map(
      (r) => {
        const fromSnapshot = indexData.collections.find(
          (c) => c.address.toLowerCase() === r.nftContract.toLowerCase(),
        );
        return (
          fromSnapshot ?? {
            address: r.nftContract,
            name: r.name,
            symbol: r.symbol,
            totalSupply: r.totalSupply ? r.totalSupply.toString() : null,
            is721: true,
            is1155: false,
          }
        );
      },
    );

    const longTailCandidates = indexData.collections.filter((c) => {
      // Skip address dedupes vs verified
      if (registryAddresses.has(c.address.toLowerCase())) return false;
      const name = (c.name || "").toLowerCase();
      const symbol = (c.symbol || "").toLowerCase();
      // Skip name copycats
      if (name && registryNames.has(name)) return false;
      if (symbol && registryNames.has(symbol)) return false;
      // Skip user-hidden
      if (isHidden(c.address)) return false;
      // Strict trendable check on snapshot stats
      return isTrendable(c, c.recent24h ?? 0);
    });

    // Merge verified (auto-included) + long-tail trendables, then rank by
    // the live score (or snapshot fallback).
    const combined = [
      ...verifiedAsIndex.map((c) => ({ collection: c, verified: true })),
      ...longTailCandidates.map((c) => ({ collection: c, verified: false })),
    ];
    combined.sort(
      (a, b) => liveScore(b.collection) - liveScore(a.collection),
    );

    return combined
      .map((entry) => ({ ...entry, live6h: liveScore(entry.collection) }))
      .filter(({ live6h }) => live6h > 0)
      .slice(0, 6);
  }, [
    indexData,
    trimmed,
    registryCollections,
    registryAddresses,
    registryNames,
    liveTrending,
    isHidden,
  ]);

  // Count of how many long-tail items the spam filter is hiding right now.
  const hiddenCount = useMemo<number>(() => {
    if (!indexData || showAll) return 0;
    let count = 0;
    for (const c of indexData.collections) {
      if (registryAddresses.has(c.address.toLowerCase())) continue;
      const name = (c.name || "").toLowerCase();
      const symbol = (c.symbol || "").toLowerCase();
      if (name && registryNames.has(name)) { count++; continue; }
      if (symbol && registryNames.has(symbol)) { count++; continue; }
      if (isHidden(c.address)) { count++; continue; }
      if (!isLikelyReal(c)) count++;
    }
    return count;
  }, [indexData, registryAddresses, registryNames, showAll, isHidden]);

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

        {/* ── Trending hero ────────────────────────────────────── */}
        {trendingHero.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium uppercase tracking-wide text-foreground-secondary">
                <span className="text-mint">●</span> Trending now
                <span className="ml-2 text-xs text-foreground-secondary/70">
                  last 24h
                </span>
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {trendingHero.map(({ collection, verified, live6h }, idx) => (
                <TrendingHeroCard
                  key={collection.address}
                  rank={idx + 1}
                  collection={collection}
                  verified={verified}
                  live6h={live6h}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Long-tail / discovered ───────────────────────────── */}
        {snapshotAvailable && (
          <section>
            <div className="flex flex-col gap-3 mb-4">
              {/* Header row: title + show-hidden toggle */}
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium uppercase tracking-wide text-foreground-secondary">
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
                {indexData && (
                  <label className="text-xs text-foreground-secondary flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showAll}
                      onChange={(e) => setShowAll(e.target.checked)}
                      className="accent-mint"
                    />
                    Show hidden
                    {!showAll && hiddenCount > 0 && (
                      <span className="text-foreground-secondary/70">
                        ({formatNumber(hiddenCount)})
                      </span>
                    )}
                  </label>
                )}
              </div>

              {/* Filter toolbar — sort + window + type chips */}
              {indexData && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {/* Sort */}
                  <label className="flex items-center gap-1.5 text-foreground-secondary">
                    Sort
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="bg-background-secondary border border-border rounded-md px-2 py-1 text-foreground focus:outline-none focus:border-mint"
                    >
                      <option value="trending">Trending</option>
                      <option value="holders">Holders</option>
                      <option value="newest">Newest</option>
                      <option value="name">Name (A→Z)</option>
                    </select>
                  </label>

                  {/* Time window (only meaningful for trending) */}
                  {sortKey === "trending" && (
                    <div className="flex items-center gap-1">
                      {(["24h", "7d", "30d", "all"] as ActivityWindow[]).map(
                        (w) => (
                          <button
                            key={w}
                            onClick={() => setWindow(w)}
                            className={`px-2 py-1 rounded-md border transition-colors ${
                              window === w
                                ? "bg-mint/10 border-mint/40 text-mint"
                                : "border-border text-foreground-secondary hover:border-mint/30"
                            }`}
                          >
                            {w}
                          </button>
                        ),
                      )}
                    </div>
                  )}

                  {/* Type chip */}
                  <div className="flex items-center gap-1 ml-auto">
                    {(["any", "721", "1155"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTokenType(t)}
                        className={`px-2 py-1 rounded-md border transition-colors ${
                          tokenType === t
                            ? "bg-mint/10 border-mint/40 text-mint"
                            : "border-border text-foreground-secondary hover:border-mint/30"
                        }`}
                      >
                        {t === "any"
                          ? "All"
                          : t === "721"
                            ? "ERC-721"
                            : "ERC-1155"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {longTail.length > 0 ? (
              <NftGrid loading={false} empty={false}>
                {longTail.map((c) => (
                  <LongTailCard
                    key={c.address}
                    collection={c}
                    window={sortKey === "trending" ? window : "all"}
                  />
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
function LongTailCard({
  collection,
  window,
}: {
  collection: IndexedCollection;
  window: ActivityWindow;
}) {
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

  // NftImage falls back to a "?" placeholder when src is empty/errored,
  // so the card stays visible with name + stats even when every gateway
  // 502s or the centralized metadata API is down. Vanishing on metadata
  // failure caused legitimate collections (scatter / lootgo / pancakeswap
  // / on-chain SVG) to flicker in then get pruned.

  const transferCount = collection.transferCount ?? 0;
  const uniqueHolders = collection.uniqueHolders ?? 0;
  // Window-specific recent-activity number (only shown when sorting trending).
  const windowedActivity =
    window === "24h"
      ? collection.recent24h
      : window === "7d"
        ? collection.recent7d
        : window === "30d"
          ? collection.recent30d
          : null;

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
            {uniqueHolders > 0 &&
              (windowedActivity != null
                ? windowedActivity > 0
                : transferCount > 0) && <span>·</span>}
            {windowedActivity != null ? (
              windowedActivity > 0 && (
                <span className="text-mint/80">
                  {formatCompact(windowedActivity)} in {window}
                </span>
              )
            ) : transferCount > 0 ? (
              <span>{formatCompact(transferCount)} trades</span>
            ) : null}
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

/**
 * Bigger, more visually prominent card for the trending hero strip. Shows
 * rank number, verified badge, momentum %, live 6h transfer count.
 */
function TrendingHeroCard({
  rank,
  collection,
  verified,
  live6h,
}: {
  rank: number;
  collection: IndexedCollection;
  verified: boolean;
  live6h: number;
}) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const sampleTokenId =
    collection.lowestTokenId != null ? BigInt(collection.lowestTokenId) : 1n;
  const { data: metadata } = useNftMetadata(
    collection.address as `0x${string}`,
    sampleTokenId,
    collection.is1155 && !collection.is721,
  );

  // Don't hide on isError — NftImage shows a "?" placeholder when src is
  // empty, so the trending slot keeps the collection name + live6h count
  // even when metadata gateways are temporarily 502ing.

  const m = momentum(collection);
  const momentumPct = m != null ? Math.round(m * 100) : null;

  return (
    <a
      href={`/collection/${collection.address}`}
      className="group relative flex gap-3 items-center p-3 border border-border rounded-xl bg-background-secondary hover:border-mint/40 hover:shadow-lg hover:shadow-mint-glow transition-all"
    >
      {/* Rank number */}
      <div className="flex items-center justify-center w-6 text-sm font-bold text-foreground-secondary/70 flex-shrink-0">
        {rank}
      </div>

      {/* Thumbnail */}
      <div className="w-16 h-16 rounded-lg overflow-hidden border border-border flex-shrink-0">
        <NftImage
          src={metadata?.image || ""}
          rawUri={metadata?.rawImageUri}
          alt={name}
          className="w-16 h-16"
        />
      </div>

      {/* Text block */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold truncate">{name}</span>
          {verified && (
            <span
              title="Verified by minti.art"
              className="text-mint text-xs flex-shrink-0"
            >
              ✓
            </span>
          )}
        </div>
        <div className="text-xs text-foreground-secondary truncate">
          {symbol}
        </div>
        <div className="flex items-center gap-2 text-xs mt-0.5">
          <span className="text-mint">
            {formatCompact(live6h)} <span className="text-foreground-secondary">in 6h</span>
          </span>
          {momentumPct != null && momentumPct > 0 && (
            <span className="text-mint/80 text-xs">
              +{momentumPct}%
            </span>
          )}
        </div>
      </div>
    </a>
  );
}
