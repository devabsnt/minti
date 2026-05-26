"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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
  useCollectionSparkline,
  type ApiCollection,
  type SortKey,
} from "@/hooks/useIndexerCollections";
import {
  useCollectionsIndex,
  type IndexedCollection,
} from "@/hooks/useCollectionsIndex";
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
  // Default: include long-tail (tier 1) so smaller / newer collections
  // surface alongside the explore-eligible (tier 2) ones. The user can
  // toggle to "Established only" to filter back to tier 2 if they want
  // a stricter view.
  const [showAll, setShowAll] = useState(true);
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

  // ── Trending hero (top 10 explore-eligible by trending) ───────────
  // Fetching more than 10 because we then filter out:
  //   - registry-tier collections (shown in the Verified section above)
  //   - user-hidden collections
  //   - whale-heavy collections per the static snapshot's concentration
  //     data (same thresholds as the warnings on the collection page —
  //     top1 > 50% supply, or top10 > 70%). We do this on the client
  //     because the snapshot has full-history holder data; the indexer's
  //     30-day retention window undercounts long-dormant whales.
  const { data: trendingData } = useIndexerCollections({
    tier: 2,
    sort: "trending",
    limit: 40,
    q,
  });
  const { data: snapshotIndex } = useCollectionsIndex();
  const snapshotByAddress = useMemo(() => {
    const map = new Map<string, IndexedCollection>();
    for (const c of snapshotIndex?.collections ?? []) {
      map.set(c.address.toLowerCase(), c);
    }
    return map;
  }, [snapshotIndex]);
  const trendingHero = useMemo(() => {
    const rows = trendingData?.collections ?? [];
    return rows
      .filter((c) => !registryAddresses.has(c.address.toLowerCase()))
      .filter((c) => !isHidden(c.address))
      .filter((c) => {
        const snap = snapshotByAddress.get(c.address.toLowerCase());
        if (!snap) return true; // not in snapshot → no data to filter by, allow
        if (typeof snap.top1HolderPct === "number" && snap.top1HolderPct > 0.5) {
          return false;
        }
        if (typeof snap.top10HolderPct === "number" && snap.top10HolderPct > 0.7) {
          return false;
        }
        return true;
      })
      .slice(0, 10);
  }, [trendingData, registryAddresses, isHidden, snapshotByAddress]);

  // Trend arrows: persist the previous rank-by-address mapping to
  // localStorage so we can show ▲/▼ when a collection moves between
  // visits. Saved AFTER reading (so the visible arrows reflect movement
  // *into* the current ordering, not into the same ordering we just
  // wrote). Untracked collections (new entries) get "same" treatment so
  // we don't lie with a fake arrow.
  const previousRanksRef = useRef<Map<string, number> | null>(null);
  if (previousRanksRef.current === null) {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem("minti.trending.previousRanks");
        previousRanksRef.current = raw
          ? new Map(JSON.parse(raw) as [string, number][])
          : new Map();
      } catch {
        previousRanksRef.current = new Map();
      }
    } else {
      previousRanksRef.current = new Map();
    }
  }
  const trendDirections = useMemo(() => {
    const prev = previousRanksRef.current!;
    const out = new Map<string, "up" | "down" | "same" | "new">();
    trendingHero.forEach((c, idx) => {
      const key = c.address.toLowerCase();
      const previousIdx = prev.get(key);
      if (previousIdx === undefined) out.set(key, "new");
      else if (previousIdx > idx) out.set(key, "up");
      else if (previousIdx < idx) out.set(key, "down");
      else out.set(key, "same");
    });
    return out;
  }, [trendingHero]);
  useEffect(() => {
    if (trendingHero.length === 0) return;
    if (typeof window === "undefined") return;
    const entries: [string, number][] = trendingHero.map((c, idx) => [
      c.address.toLowerCase(),
      idx,
    ]);
    try {
      window.localStorage.setItem(
        "minti.trending.previousRanks",
        JSON.stringify(entries),
      );
    } catch {
      // localStorage can throw in private mode / quota — fine to ignore.
    }
  }, [trendingHero]);

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
                Trending
                <span className="ml-2 text-xs text-foreground-secondary/70">
                  most active
                </span>
              </h2>
            </div>
            {/* Podium for ranks 1-3 — full-width stacked cards with
                gold/silver/bronze borders and a dimmed collage. */}
            <div className="space-y-3 mb-3">
              {trendingHero.slice(0, 3).map((collection, idx) => (
                <TrendingPodiumCard
                  key={collection.address}
                  rank={(idx + 1) as 1 | 2 | 3}
                  collection={collection}
                  trend={trendDirections.get(collection.address.toLowerCase())}
                />
              ))}
            </div>
            {/* Ranks 4-10 in the existing compact-row layout. */}
            {trendingHero.length > 3 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {trendingHero.slice(3).map((collection, idx) => (
                  <TrendingHeroCard
                    key={collection.address}
                    rank={idx + 4}
                    collection={collection}
                    trend={trendDirections.get(collection.address.toLowerCase())}
                  />
                ))}
              </div>
            )}
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
                  checked={!showAll}
                  onChange={(e) => {
                    // Checkbox represents "established only" — when
                    // ticked, we filter to tier 2 (drops the long-tail).
                    setShowAll(!e.target.checked);
                    setLongTailPage(0);
                  }}
                  className="accent-mint"
                />
                Established only
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
      className="block border border-border overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
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

/**
 * Build a list of image URLs to use as the collage background of a
 * podium card. Picks `count` evenly-spaced token IDs across the supply
 * range and substitutes into the template — gives a representative
 * sample of the collection. Falls back to the single sample image when
 * we don't have a template or supply.
 */
function buildCollageImages(
  collection: ApiCollection,
  count: number,
): string[] {
  const template = collection.imageUrlTemplate;
  const supply = collection.totalSupply ? Number(collection.totalSupply) : 0;
  if (!template || supply <= 0) {
    return collection.sampleImageUrl ? [collection.sampleImageUrl] : [];
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    // Evenly distributed: centers of `count` equal buckets across 1..supply.
    const id = Math.max(1, Math.floor(((i + 0.5) * supply) / count));
    out.push(template.replace(/\{id\}/g, String(id)));
  }
  return out;
}

const PODIUM_TIERS: Record<
  1 | 2 | 3,
  { borderClass: string; ring: string; gradient: string }
> = {
  1: {
    borderClass: "podium-border podium-gold",
    ring: "shadow-yellow-400/30",
    gradient: "from-yellow-200 to-yellow-500",
  },
  2: {
    borderClass: "podium-border podium-silver",
    ring: "shadow-zinc-300/25",
    gradient: "from-zinc-100 to-zinc-400",
  },
  3: {
    borderClass: "podium-border podium-bronze",
    ring: "shadow-amber-700/25",
    gradient: "from-amber-500 to-amber-800",
  },
};

/**
 * Full-width podium card for the top 3 trending collections. Gold,
 * silver, or bronze metallic border by rank (animated shimmer), with a
 * dimmed collage of token images as the background and the canonical
 * thumbnail+info pinned to the left. Optional trend arrow shows
 * movement since the user's last visit.
 */
function TrendingPodiumCard({
  rank,
  collection,
  trend,
}: {
  rank: 1 | 2 | 3;
  collection: ApiCollection;
  trend?: "up" | "down" | "same" | "new";
}) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const transferCount = collection.transferCount ?? 0;
  const uniqueHolders = collection.uniqueHolders ?? 0;
  const supply = collection.totalSupply ? Number(collection.totalSupply) : 0;
  const tier = PODIUM_TIERS[rank];

  const collageImages = useMemo(
    () => buildCollageImages(collection, 8),
    [collection],
  );
  // We have two visual modes:
  //  - "driftable": multiple distinct images. Each tile is rendered at
  //    full card height with its natural aspect ratio (h-full w-auto)
  //    so the artwork is never cropped vertically. We double the list
  //    so the scroll animation can loop seamlessly at -50%.
  //  - "single-image" fallback: one cover-fitted image filling the bar,
  //    slowly scrolled on hover (same as before).
  const driftable = collageImages.length > 1;
  // Both modes duplicate the source list so translateX(-50%) seamlessly
  // returns to the starting visual state on each animation cycle. For
  // the single-image fallback this means rendering the same image
  // twice — the second copy lands exactly where the first started, so
  // there's no visible jump when the loop resets.
  const collageRow = collageImages.length > 0
    ? collageImages.concat(collageImages)
    : [];

  return (
    <a
      href={`/collection/${collection.address}`}
      // Outer: animated metal-gradient wrapper. `p-1` becomes the visible
      // 4px shimmering border around the inner card.
      className={`group collage-drift-on-hover block ${tier.borderClass} hover:shadow-xl ${tier.ring} transition-all`}
    >
      <div className="relative overflow-hidden bg-background-secondary">
        {/* Collage background — tile of evenly-sampled token images.
            Plain <img> tags with native lazy loading: no watchdog
            timers, no fallback ladder, no React state — just decoration.
            If a single tile fails, the background simply has a gap,
            which the dimming overlay hides. */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
          <div className="collage-drift-track flex h-full w-max">
            {collageRow.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={url}
                alt=""
                aria-hidden
                loading="lazy"
                decoding="async"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                {...({ fetchpriority: "low" } as any)}
                referrerPolicy="no-referrer"
                // driftable: keep natural aspect ratio, height = bar.
                // single-image: cover the whole bar (no letterboxing).
                className={
                  driftable
                    ? "h-full w-auto flex-shrink-0 object-contain"
                    : "h-full w-screen max-w-none flex-shrink-0 object-cover"
                }
              />
            ))}
          </div>
        </div>
        {/* Dimming so the collage stays atmospheric, not noisy. Left
            side stays darker so the thumbnail / text remain legible. */}
        <div className="absolute inset-0 bg-background-secondary/55" />
        <div className="absolute inset-0 bg-gradient-to-r from-background-secondary via-background-secondary/70 to-background-secondary/30" />

        {/* Content */}
        <div className="relative z-10 flex gap-4 p-4 items-start">
          <div className="flex flex-col items-center gap-2 flex-shrink-0">
            <div className="w-28 h-28 sm:w-32 sm:h-32 overflow-hidden border border-border bg-background-tertiary">
              <NftImage
                src={collection.sampleImageUrl ?? ""}
                alt={name}
                className="w-full h-full"
                priority={rank === 1}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <div
                className={`text-2xl font-extrabold bg-gradient-to-r ${tier.gradient} bg-clip-text text-transparent`}
              >
                #{rank}
              </div>
              <TrendArrow trend={trend} />
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xl sm:text-2xl font-bold truncate">
                  {name}
                </div>
                {symbol && (
                  <div className="text-sm text-foreground-secondary truncate">
                    {symbol}
                  </div>
                )}
              </div>
              <div
                className="flex-shrink-0 flex flex-col items-end gap-0.5"
                title="Activity in the last 24 hours"
              >
                <ActivitySparkline contractAddress={collection.address} />
                <span className="text-[10px] uppercase tracking-wider text-foreground-secondary/60">
                  24h
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm">
              <span>
                <span className="text-mint font-medium">
                  {formatCompact(transferCount)}
                </span>
                <span className="text-foreground-secondary ml-1">
                  transfers
                </span>
              </span>
              <span>
                <span className="text-mint font-medium">
                  {formatNumber(uniqueHolders)}
                </span>
                <span className="text-foreground-secondary ml-1">holders</span>
              </span>
              {supply > 0 && (
                <span>
                  <span className="text-mint font-medium">
                    {formatNumber(supply)}
                  </span>
                  <span className="text-foreground-secondary ml-1">items</span>
                </span>
              )}
              <FloorPrice contractAddress={collection.address} />
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

/**
 * Tiny inline 24-hour activity sparkline. Renders a single polyline +
 * filled area as SVG — no charting library, no per-render layout work
 * beyond a single map over the bucket array. The Y axis auto-scales to
 * the max bucket so even a quiet collection (peak of 3) still shows a
 * readable shape. Returns null while loading or when there's no data.
 */
function ActivitySparkline({
  contractAddress,
  width = 96,
  height = 28,
  colorClass = "text-mint",
}: {
  contractAddress: string;
  width?: number;
  height?: number;
  colorClass?: string;
}) {
  const { data } = useCollectionSparkline(contractAddress, 24);
  const buckets = data?.buckets ?? [];
  if (buckets.length < 2) return null;

  const max = Math.max(1, ...buckets.map((b) => b.count));
  const padX = 1;
  const padY = 2;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const xStep = buckets.length > 1 ? innerW / (buckets.length - 1) : 0;
  const points = buckets.map((b, i) => {
    const x = padX + i * xStep;
    // Flip Y because SVG origin is top-left.
    const y = padY + innerH - (b.count / max) * innerH;
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  // Closed-path for the fill: down to baseline → back to start.
  const fillPath = `${linePath} L${points[points.length - 1][0].toFixed(1)} ${(height - padY).toFixed(1)} L${points[0][0].toFixed(1)} ${(height - padY).toFixed(1)} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`${colorClass} block`}
      aria-label="24-hour activity"
      role="img"
    >
      <path d={fillPath} fill="currentColor" opacity="0.15" />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** ▲ / ▼ / – indicator for trending-rank movement since the last visit. */
function TrendArrow({ trend }: { trend?: "up" | "down" | "same" | "new" }) {
  if (!trend || trend === "new") return null;
  if (trend === "same") {
    return (
      <span
        title="No change since last visit"
        className="text-foreground-secondary/60 text-sm leading-none"
      >
        –
      </span>
    );
  }
  if (trend === "up") {
    return (
      <span
        title="Moved up since last visit"
        className="text-mint text-sm leading-none"
        aria-label="trending up"
      >
        ▲
      </span>
    );
  }
  return (
    <span
      title="Moved down since last visit"
      className="text-danger text-sm leading-none"
      aria-label="trending down"
    >
      ▼
    </span>
  );
}

/**
 * Floor-price slot. Reads from `useCollectionFloor(addr)` — currently
 * always returns `null` because the marketplace contract isn't deployed
 * yet. Once it is, this hook can be wired up to read active listings
 * from `MintiMarketplace` and the floor will appear in every podium /
 * card without further changes.
 */
function FloorPrice({ contractAddress }: { contractAddress: string }) {
  const floor = useCollectionFloor(contractAddress);
  if (!floor) return null;
  return (
    <span>
      <span className="text-mint font-medium">{floor.priceFormatted}</span>
      <span className="text-foreground-secondary ml-1">floor</span>
    </span>
  );
}

/**
 * Placeholder hook for collection floor price. Will read from
 * `MintiMarketplace` once it's deployed and indexed. For now returns
 * null so every consumer can opt into the slot without conditional
 * imports — the day the marketplace ships, swap this body for the
 * actual implementation and floor prices appear everywhere it's
 * referenced.
 */
function useCollectionFloor(_contractAddress: string): { priceFormatted: string } | null {
  return null;
}

/** Bigger card for the trending hero strip. */
function TrendingHeroCard({
  rank,
  collection,
  trend,
}: {
  rank: number;
  collection: ApiCollection;
  trend?: "up" | "down" | "same" | "new";
}) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const transferCount = collection.transferCount ?? 0;

  return (
    <a
      href={`/collection/${collection.address}`}
      className="group relative flex gap-3 items-center p-3 border border-border bg-background-secondary hover:border-mint/40 hover:shadow-lg hover:shadow-mint-glow transition-all"
    >
      <div className="flex items-center gap-0.5 w-9 text-sm font-bold text-foreground-secondary/70 flex-shrink-0">
        <span>{rank}</span>
        <TrendArrow trend={trend} />
      </div>
      <div className="w-16 h-16 overflow-hidden border border-border flex-shrink-0">
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
