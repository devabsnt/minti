"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";

import { NftImage } from "@/components/nft/NftImage";
import { NftGrid } from "@/components/nft/NftGrid";
import { formatNumber, formatCompact } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useBrowseChain } from "@/providers/ChainProvider";
import { CHAIN_NAMES } from "@/config/chains";
import {
  useIndexerCollections,
  useCollectionSparkline,
  useIndexerCollection,
  type ApiCollection,
  type SortKey,
} from "@/hooks/useIndexerCollections";
import {
  useCollectionsIndex,
  type IndexedCollection,
} from "@/hooks/useCollectionsIndex";
import {
  useFeaturedCollections,
  type FeaturedCollectionEntry,
} from "@/hooks/useFeaturedCollections";
import { useHiddenCollections } from "@/hooks/useHiddenCollections";
import { useDebounce } from "@/hooks/useDebounce";
import {
  usePageTurnSound,
  usePaperHoverSound,
} from "@/providers/SoundProvider";

/**
 * Discover page. Three sections shown in order:
 *   1. Featured. Editorial picks. Driven by `/public/data/featured.json`
 *      (curated by the platform team). Cards auto-populate from indexer
 *      data using the contract address as the key.
 *   2. Trending. Top 10 explore-eligible collections from the indexer,
 *      sorted by transfer_count (and a few other anti-gaming signals)
 *      in the retention window.
 *   3. All collections. Paginated long-tail from the indexer.
 *
 * The on-chain registry (EVMFSCollectionRegistry) used to be section 1.
 * The indexer made it redundant for discovery, and curated/editorial
 * picks via the JSON file are now the canonical "platform-vouched"
 * signal.
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
  const { browseChainId } = useBrowseChain();
  const { isHidden } = useHiddenCollections(browseChainId);

  const LONG_TAIL_PAGE_SIZE = 48;

  // Debounce the search input so we don't fire a fresh API call on
  // every keystroke. Address-jump still uses the raw value for Enter.
  const debouncedSearch = useDebounce(search, 200);
  const trimmed = debouncedSearch.trim();
  const isSearchingByText = trimmed.length > 0 && !isAddress(trimmed);
  const q = isSearchingByText ? trimmed : undefined;

  // ── Featured collections (editorial picks) ─────────────────────────
  // Featured collections still appear in Trending and Long-tail when
  // they qualify; the Featured section is additive, not exclusive.
  const { data: featuredEntries } = useFeaturedCollections();

  // ── Trending hero (top 10 explore-eligible by trending) ───────────
  // Fetching more than 10 because we then filter out:
  //   - featured collections (shown in the Featured section above, no
  //     point listing them twice)
  //   - user-hidden collections
  //   - whale-heavy collections per the static snapshot's concentration
  //     data (same thresholds as the warnings on the collection page,
  //     top1 > 50% supply or top10 > 70%). We do this on the client
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
      .filter((c) => !isHidden(c.address))
      .filter((c) => {
        const snap = snapshotByAddress.get(c.address.toLowerCase());
        if (!snap) return true; // not in snapshot, no data to filter by, allow
        if (typeof snap.top1HolderPct === "number" && snap.top1HolderPct > 0.5) {
          return false;
        }
        if (typeof snap.top10HolderPct === "number" && snap.top10HolderPct > 0.7) {
          return false;
        }
        return true;
      })
      .slice(0, 10);
  }, [trendingData, isHidden, snapshotByAddress]);

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
    return rows.filter((c) => !isHidden(c.address));
  }, [longTailData, isHidden]);
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
    <div className="max-w-7xl mx-auto px-4 py-10">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 mb-10">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Discover</h1>
          <p className="text-sm text-foreground-secondary mt-2">
            Collections on {CHAIN_NAMES[browseChainId] || "Unknown Chain"}
            {longTailTotal > 0 && (
              <span> · {formatNumber(longTailTotal)} active</span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="flex-1 sm:flex-initial sm:w-80">
            <Input
              placeholder="Search name, ticker, or 0x address"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleJump()}
            />
          </div>
        </div>
      </div>

      <div className="space-y-14">
        {/* Featured tier. Editorial picks from `/public/data/featured.json`.
            Each card auto-populates from indexer data using the contract
            address as the key. */}
        {featuredEntries && featuredEntries.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-5">
              <div>
                <h2 className="text-xl font-semibold">Featured</h2>
                <p className="text-sm text-foreground-secondary mt-0.5">
                  Hand-picked by minti
                </p>
              </div>
            </div>
            <div className="space-y-4">
              {featuredEntries.map((entry) => (
                <FeaturedCard key={entry.address} entry={entry} />
              ))}
            </div>
          </section>
        )}

        {/* Trending hero. */}
        {trendingHero.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-5">
              <div>
                <h2 className="text-xl font-semibold">Trending</h2>
                <p className="text-sm text-foreground-secondary mt-0.5">
                  Most active in the last 30 days
                </p>
              </div>
            </div>
            {/* Podium for ranks 1-3: full-width stacked cards with
                gold/silver/bronze borders and a dimmed collage. */}
            <div className="space-y-4 mb-4">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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

        {/* Long-tail / all collections. */}
        <section>
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">
                  All collections
                  {longTailTotal > 0 && (
                    <span className="ml-2 text-sm font-normal text-foreground-secondary">
                      {formatNumber(longTailTotal)}
                    </span>
                  )}
                </h2>
                {longTailLoading && (
                  <p className="text-sm text-foreground-secondary mt-0.5">
                    Loading…
                  </p>
                )}
              </div>
              <label className="text-sm text-foreground-secondary flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!showAll}
                  onChange={(e) => {
                    // Checkbox represents "established only" - when
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

/**
 * Featured collection card. Editorial pick, full-width, distinct from
 * the trending podium's metallic finish. Three signals tell the viewer
 * this is platform-curated:
 *   1. The minti mascot watermark in the top-right
 *   2. A "FEATURED" pill alongside the mascot
 *   3. An italic mint editorial blurb above the stats row
 *
 * The card auto-populates from indexer data (name, symbol, sample image,
 * stats) using `entry.address` as the key. Curators only have to commit
 * an entry to `/public/data/featured.json`.
 */
function FeaturedCard({ entry }: { entry: FeaturedCollectionEntry }) {
  const { data: collData } = useIndexerCollection(entry.address);
  const collection = collData?.collection;
  const playPageTurn = usePageTurnSound();
  const playPaperHover = usePaperHoverSound();
  const collageImages = useMemo(
    () => (collection ? buildCollageImages(collection, 8) : []),
    [collection],
  );
  const driftable = collageImages.length > 1;
  const collageRow = collageImages.length > 0
    ? collageImages.concat(collageImages)
    : [];

  if (!collection) {
    return (
      <div className="block border border-mint/30 overflow-hidden bg-background-secondary p-4">
        <div className="text-sm text-foreground-secondary">
          {entry.address.slice(0, 8)}... awaiting indexer discovery
        </div>
      </div>
    );
  }

  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const transferCount = collection.transferCount ?? 0;
  const uniqueHolders = collection.uniqueHolders ?? 0;
  const supply = collection.totalSupply ? Number(collection.totalSupply) : 0;
  const blurb = entry.blurb?.trim();

  return (
    <a
      href={`/collection/${collection.address}`}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
          playPageTurn();
        }
      }}
      onPointerEnter={playPaperHover}
      // Same overall structure as TrendingPodiumCard but with the
      // breathing mint border instead of metallic shimmer, and a
      // Featured pill + postmark instead of the Nº rank stamp.
      className="group collage-drift-on-hover featured-breathe stamp-shadow relative block border overflow-hidden bg-background-secondary transition-all"
    >
      <div className="relative overflow-hidden">
        {/* Collage background - same evenly-sampled token images as
            on the podium cards, with the same drift-on-hover. Gives
            featured collections matching visual weight to top trending. */}
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
                className={
                  driftable
                    ? "h-full w-auto flex-shrink-0 object-contain"
                    : "h-full w-screen max-w-none flex-shrink-0 object-cover"
                }
              />
            ))}
          </div>
        </div>
        {/* Dimming so the collage stays atmospheric. Same gradient
            shape as podium cards but lighter (cream paper bg shows
            more) so the featured cards feel airier than ranked ones. */}
        <div className="absolute inset-0 bg-background-secondary/55" />
        <div className="absolute inset-0 bg-gradient-to-r from-background-secondary via-background-secondary/70 to-background-secondary/30" />

        {/* Featured pill + minti approval postmark in the top-right.
            The postmark is a clean SVG (no aging / erosion); reads
            "MINTI.ART / APPROVED" curved around the rings, with the
            dumpling silhouette in the center. */}
        <div
          className="absolute top-3 right-4 flex items-center gap-2 z-10 pointer-events-none"
          aria-hidden
        >
          <span className="stamp-pill">Featured</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/postmark-minti.svg"
            alt=""
            className="w-20 h-20"
            style={{ transform: "rotate(-8deg)" }}
            loading="lazy"
          />
        </div>

        <div className="relative z-10 flex gap-4 p-4 items-start">
          <div className="w-28 h-28 sm:w-32 sm:h-32 overflow-hidden border border-border bg-background-tertiary flex-shrink-0">
            <NftImage
              src={collection.sampleImageUrl ?? ""}
              alt={name}
              className="w-full h-full"
            />
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1 pr-4 sm:pr-0">
            <h3 className="text-xl sm:text-2xl font-bold truncate">{name}</h3>
            {symbol && (
              <div className="text-sm text-foreground-secondary truncate">
                {symbol}
              </div>
            )}
            {blurb && (
              <p className="text-sm italic text-mint/90 truncate mt-1">
                {blurb}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-3 text-sm">
              <span>
                <span className="font-medium">
                  {formatCompact(transferCount)}
                </span>
                <span className="text-foreground-secondary ml-1.5">
                  transfers
                </span>
              </span>
              <span>
                <span className="font-medium">
                  {formatNumber(uniqueHolders)}
                </span>
                <span className="text-foreground-secondary ml-1.5">holders</span>
              </span>
              {supply > 0 && (
                <span>
                  <span className="font-medium">{formatNumber(supply)}</span>
                  <span className="text-foreground-secondary ml-1.5">items</span>
                </span>
              )}
              <FloorPrice contractAddress={collection.address} />
            </div>
            {/* Same 24h activity sparkline as the podium cards.
                "24h" label sits immediately to the right of the
                sparkline, not floated to the card edge. */}
            <div
              className="mt-3 flex items-center gap-2"
              title="Activity in the last 24 hours"
            >
              <ActivitySparkline
                contractAddress={collection.address}
                width={240}
                height={32}
              />
              <span className="text-[10px] uppercase tracking-widest text-foreground-secondary">
                24h
              </span>
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

/**
 * Long-tail collection card. Reads everything from the API row, no
 * runtime tokenURI fetches, no IPFS gateway race. The indexer's
 * enrichment pass populated `sampleImageUrl` already.
 */
function LongTailCard({ collection }: { collection: ApiCollection }) {
  const name = collection.name || collection.address.slice(0, 10);
  const symbol = collection.symbol || "";
  const transferCount = collection.transferCount ?? 0;
  const uniqueHolders = collection.uniqueHolders ?? 0;
  const supply = collection.totalSupply ? Number(collection.totalSupply) : 0;
  const playPageTurn = usePageTurnSound();
  const playPaperHover = usePaperHoverSound();

  return (
    <a
      href={`/collection/${collection.address}`}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
          playPageTurn();
        }
      }}
      onPointerEnter={playPaperHover}
      className="stamp-shadow group block border border-border overflow-hidden bg-background-secondary hover:border-border-hover transition-colors"
    >
      <NftImage
        src={collection.sampleImageUrl ?? ""}
        alt={name}
        className="aspect-square w-full"
      />
      <div className="p-4 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold truncate">{name}</h3>
          {symbol && (
            <span className="text-xs text-foreground-secondary flex-shrink-0">
              {symbol}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-foreground-secondary">
          {uniqueHolders > 0 && (
            <span>{formatCompact(uniqueHolders)} holders</span>
          )}
          {uniqueHolders > 0 && transferCount > 0 && (
            <span aria-hidden>·</span>
          )}
          {transferCount > 0 && (
            <span>{formatCompact(transferCount)} transfers</span>
          )}
          {supply > 0 && (uniqueHolders > 0 || transferCount > 0) && (
            <span aria-hidden>·</span>
          )}
          {supply > 0 && <span>{formatNumber(supply)} items</span>}
        </div>
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
  const playPageTurn = usePageTurnSound();
  const playPaperHover = usePaperHoverSound();

  return (
    <a
      href={`/collection/${collection.address}`}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
          playPageTurn();
        }
      }}
      onPointerEnter={playPaperHover}
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
              {/* Vermillion stamp box, gold rank numeral inside. All
                  three podium positions use the same gold gradient
                  because it has the strongest contrast against the
                  red ground - silver and especially bronze were hard
                  to read. The medal-tier hierarchy still reads via
                  the border-color of the surrounding podium card. */}
              <span
                className="inline-flex items-baseline gap-1 px-2.5 py-1 font-serif"
                style={{
                  background: "var(--color-mint)",
                  boxShadow:
                    "inset 0 0 0 1px rgba(255, 245, 214, 0.5), 0 1px 2px rgba(45, 36, 24, 0.18), 0 2px 4px rgba(45, 36, 24, 0.12)",
                  transform: "rotate(-1deg)",
                }}
              >
                <span className="text-[10px] text-[#fff5d6]/85">Nº</span>
                <span
                  className="text-lg font-bold bg-gradient-to-r from-yellow-200 to-yellow-500 bg-clip-text text-transparent"
                >
                  {rank.toString().padStart(2, "0")}
                </span>
              </span>
              <TrendArrow trend={trend} />
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <h3 className="text-xl sm:text-2xl font-bold truncate">{name}</h3>
            {symbol && (
              <div className="text-sm text-foreground-secondary truncate">
                {symbol}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-3 text-sm">
              <span>
                <span className="font-medium">
                  {formatCompact(transferCount)}
                </span>
                <span className="text-foreground-secondary ml-1.5">
                  transfers
                </span>
              </span>
              <span>
                <span className="font-medium">
                  {formatNumber(uniqueHolders)}
                </span>
                <span className="text-foreground-secondary ml-1.5">holders</span>
              </span>
              {supply > 0 && (
                <span>
                  <span className="font-medium">{formatNumber(supply)}</span>
                  <span className="text-foreground-secondary ml-1.5">
                    items
                  </span>
                </span>
              )}
              <FloorPrice contractAddress={collection.address} />
            </div>
            {/* 24h activity sparkline below the stats row. "24h"
                label sits immediately to the right of the chart, not
                floated to the card edge. */}
            <div
              className="mt-3 flex items-center gap-2"
              title="Activity in the last 24 hours"
            >
              <ActivitySparkline
                contractAddress={collection.address}
                width={240}
                height={32}
              />
              <span className="text-[10px] uppercase tracking-widest text-foreground-secondary">
                24h
              </span>
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
      <span className="font-medium">{floor.priceFormatted}</span>
      <span className="text-foreground-secondary ml-1.5">floor</span>
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
  const playPageTurn = usePageTurnSound();
  const playPaperHover = usePaperHoverSound();

  return (
    <a
      href={`/collection/${collection.address}`}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
          playPageTurn();
        }
      }}
      onPointerEnter={playPaperHover}
      className="stamp-shadow group relative flex gap-4 items-center p-4 border border-border bg-background-secondary hover:border-border-hover transition-colors"
    >
      <div className="flex flex-col items-center gap-1 w-12 flex-shrink-0">
        <span
          className="inline-flex items-baseline gap-1 px-2 py-0.5 font-serif"
          style={{
            background: "var(--color-mint)",
            boxShadow:
              "inset 0 0 0 1px rgba(255, 245, 214, 0.5), 0 1px 2px rgba(45, 36, 24, 0.18)",
            transform: "rotate(-1.5deg)",
          }}
        >
          <span className="text-[9px] text-[#fff5d6]/85 leading-none">Nº</span>
          <span className="text-sm font-bold text-[#fff5d6] leading-none">
            {rank.toString().padStart(2, "0")}
          </span>
        </span>
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
        <h3 className="text-base font-semibold truncate">{name}</h3>
        {symbol && (
          <div className="text-xs text-foreground-secondary truncate">
            {symbol}
          </div>
        )}
        <div className="text-xs text-foreground-secondary mt-1">
          {formatCompact(transferCount)} transfers
        </div>
      </div>
    </a>
  );
}
