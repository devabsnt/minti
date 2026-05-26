"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { usePageTurnSound } from "@/providers/SoundProvider";
import { useAccount } from "wagmi";
import { useCollectionListings } from "@/hooks/useListings";
import { useCollectionBids, useCollectionOffers } from "@/hooks/useBids";
import { useCollectionNfts } from "@/hooks/useWalletNfts";
import { useCollectionInfo } from "@/hooks/useCollectionInfo";
import { useCollectionTokens } from "@/hooks/useCollectionTokens";
import { useCollectionTokensByIds } from "@/hooks/useCollectionTokensByIds";
import { useNftMetadata, useBatchNftMetadata } from "@/hooks/useNftMetadata";
import {
  useIndexerCollection,
  useIndexerCollectionTokens,
} from "@/hooks/useIndexerCollections";
import { useRegisteredCollectionByNft } from "@/hooks/useRegistry";
import { useEvmfsTokenMetadata } from "@/hooks/useEvmfsMetadata";
import { useTokenViewerUri } from "@/hooks/useTokenViewerUri";
import { useIndexManifest } from "@/hooks/useIndexManifest";
import { NftGrid } from "@/components/nft/NftGrid";
import { NftCard } from "@/components/nft/NftCard";
import { NftImage } from "@/components/nft/NftImage";
import { EvmfsTokenCard } from "@/components/collection/EvmfsTokenCard";
import { OnChainVerifyPanel } from "@/components/collection/OnChainVerifyPanel";
import { CollectionWarnings } from "@/components/collection/CollectionWarnings";
import { HideCollectionButton } from "@/components/collection/HideCollectionButton";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  TraitFilter,
  filterIdsBySelection,
  type TraitSelection,
} from "@/components/collection/TraitFilter";
import { evmfsLabel, type EvmfsContract } from "@/lib/evmfs";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { BuyButton } from "@/components/marketplace/BuyButton";
import { ListItemModal } from "@/components/marketplace/ListItemModal";
import { PlaceBidModal } from "@/components/marketplace/PlaceBidModal";
import { CollectionOfferModal } from "@/components/marketplace/CollectionOfferModal";
import {
  CancelListingButton,
  CancelBidButton,
  AcceptBidButton,
  CancelOfferButton,
  AcceptCollectionOfferButton,
} from "@/components/marketplace/ActionButtons";
import { formatPrice, truncateAddress, timeAgo, formatNumber } from "@/lib/format";
import { PAGE_SIZE } from "@/config/constants";
import { MINTI_MARKETPLACE_ADDRESS, getNativeSymbol } from "@/config/chains";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useReadContract } from "wagmi";
import { isAddress } from "viem";
import mintiAbi from "@/lib/abi/MintiMarketplace.json";

export function CollectionCatchAll() {
  const params = useParams();
  const slug = params?.slug as string[] | undefined;

  if (!slug || slug.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center text-foreground-secondary">
        <p>Enter a collection address in the URL to view it.</p>
        <p className="text-sm mt-2">/collection/0x...</p>
      </div>
    );
  }

  if (!isAddress(slug[0])) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center text-foreground-secondary">
        <p>Invalid contract address.</p>
        <p className="text-sm mt-2">Please enter a valid Ethereum address (0x...)</p>
      </div>
    );
  }

  const collectionAddress = slug[0] as `0x${string}`;

  // A trailing tokenId segment opens the detail modal on top of the
  // gallery, rather than navigating away. CollectionPage handles the
  // modal state, URL sync, and direct-link initialization itself.
  let initialTokenId: string | undefined;
  if (slug.length >= 2) {
    try {
      BigInt(slug[1]);
      initialTokenId = slug[1];
    } catch {
      return (
        <div className="max-w-7xl mx-auto px-4 py-20 text-center text-foreground-secondary">
          <p>Invalid token ID.</p>
        </div>
      );
    }
  }

  return (
    <CollectionPage
      collectionAddress={collectionAddress}
      initialTokenId={initialTokenId}
    />
  );
}

// ═══════════════════════════ COLLECTION PAGE ═══════════════════════════

type CollectionTab = "browse" | "listings";

function CollectionPage({
  collectionAddress,
  initialTokenId,
}: {
  collectionAddress: `0x${string}`;
  initialTokenId?: string;
}) {
  const { address } = useAccount();
  // Wallet address is undefined on SSR but populated after client hydration,
  // so any conditional that depends on it would mismatch. Gate those branches
  // on `mounted` so the server renders the unconnected state and the client
  // re-renders after hydration without React flagging it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [tab, setTab] = useState<CollectionTab>("browse");
  const [browsePage, setBrowsePage] = useState(0);

  // Token detail modal state. URL is the source of truth: a trailing
  // tokenId in `/collection/0xabc/123` opens the modal, removing it
  // closes. We keep the URL in sync via history.pushState so the back
  // button works, deep links open the modal on top of the gallery, and
  // copy-paste-share works.
  const playPageTurn = usePageTurnSound();
  const [openTokenId, setOpenTokenId] = useState<string | null>(
    initialTokenId ?? null,
  );
  const openTokenDetail = (tokenId: string) => {
    setOpenTokenId(tokenId);
    playPageTurn();
    if (typeof window !== "undefined") {
      window.history.pushState(
        { mintiTokenModal: true },
        "",
        `/collection/${collectionAddress}/${tokenId}`,
      );
    }
  };
  const closeTokenDetail = () => {
    setOpenTokenId(null);
    // Close gets its own page-turn. Because the sound system rotates
    // through five segments and refuses to play the same one twice
    // in a row, this naturally lands on a different segment than the
    // one that played on open.
    playPageTurn();
    if (typeof window !== "undefined") {
      // Use back() if our pushState frame is the current entry,
      // otherwise replace, so we don't accumulate empty entries.
      if (window.history.state?.mintiTokenModal) {
        window.history.back();
      } else {
        window.history.pushState(null, "", `/collection/${collectionAddress}`);
      }
    }
  };
  // Sync state with the back/forward buttons.
  useEffect(() => {
    const onPop = () => {
      if (typeof window === "undefined") return;
      const m = window.location.pathname.match(
        /^\/collection\/[^/]+\/([^/?#]+)/,
      );
      setOpenTokenId(m ? m[1] : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Body scroll lock + Escape-to-close while the modal is open.
  useEffect(() => {
    if (!openTokenId) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTokenDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
    // closeTokenDetail is stable for our purposes; deps capture changes
    // to collectionAddress which would never change for one CollectionPage
    // mount anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTokenId]);
  // Helper to pass to NftCard / EvmfsTokenCard. preventDefault stops
  // navigation; right-click / middle-click still follow the href so
  // "open in new tab" works.
  const handleTokenClick =
    (tokenId: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Modifier-clicks (cmd/ctrl-click for new tab, shift-click for
      // new window) should NOT open the modal, they should open the
      // detail page in another tab/window via the native href.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
        return;
      }
      e.preventDefault();
      openTokenDetail(tokenId);
    };
  const [listingPage, setListingPage] = useState(0);
  const [showOfferModal, setShowOfferModal] = useState(false);
  const [traitSelection, setTraitSelection] = useState<TraitSelection>({});
  const { data: listingData, isLoading: listingsLoading } = useCollectionListings(collectionAddress, listingPage);
  const { data: offers } = useCollectionOffers(collectionAddress);
  // Collection identity now comes from the indexer (live, populated by
  // the enrichment pass) with on-chain `useCollectionInfo` as a fallback
  // for collections the indexer hasn't seen yet (e.g. brand-new contract).
  const { data: indexerData } = useIndexerCollection(collectionAddress);
  const indexerCollection = indexerData?.collection ?? null;
  const { data: collectionInfo } = useCollectionInfo(collectionAddress);
  const { data: evmfsRecord } = useRegisteredCollectionByNft(collectionAddress);
  const isEvmfs = !!evmfsRecord;
  const hasIndexManifest =
    isEvmfs &&
    evmfsRecord!.indexManifest !==
      "0x0000000000000000000000000000000000000000000000000000000000000000";
  const { data: indexManifest } = useIndexManifest(
    hasIndexManifest ? evmfsRecord!.indexManifest : undefined,
    hasIndexManifest ? evmfsRecord!.indexBlock : undefined,
    hasIndexManifest ? (evmfsRecord!.evmfsContract as EvmfsContract) : undefined,
  );

  const activeFilterCount = Object.values(traitSelection).reduce(
    (n, s) => n + s.size,
    0,
  );
  const filteredIds = indexManifest && activeFilterCount > 0
    ? filterIdsBySelection(indexManifest, traitSelection)
    : null;

  const filterPageSize = 24;
  const filteredPageIds =
    filteredIds !== null
      ? filteredIds.slice(browsePage * filterPageSize, (browsePage + 1) * filterPageSize)
      : [];
  const { data: filteredTokenRows = [], isLoading: filteredLoading } =
    useCollectionTokensByIds(
      filteredIds !== null ? collectionAddress : undefined,
      filteredPageIds,
    );

  // Browse tokens — for the non-EVMFS / non-filter path, source from
  // the indexer. Works for any contract (no Enumerable requirement)
  // because the indexer enumerates from Transfer events. For the
  // filter path (EVMFS trait-filter) we keep the existing flow.
  const indexerPageSize = 48;
  const { data: indexerTokenData, isLoading: indexerBrowseLoading } =
    useIndexerCollectionTokens(
      filteredIds !== null ? undefined : collectionAddress,
      browsePage,
      indexerPageSize,
    );
  const indexerBrowseTokens = useMemo(
    () =>
      (indexerTokenData?.tokens ?? []).map((t) => ({
        tokenId: BigInt(t.tokenId),
        owner: t.owner ?? "0x0000000000000000000000000000000000000000",
      })),
    [indexerTokenData],
  );
  const indexerBrowseTotal = indexerTokenData?.pagination.total ?? 0;
  const indexerBrowsePages = Math.max(
    1,
    Math.ceil(indexerBrowseTotal / indexerPageSize),
  );

  // We still need totalSupply for the header display. Indexer collection
  // row has it for enriched collections; fall back to on-chain reader.
  const indexerTotalSupply = indexerCollection?.totalSupply
    ? Number(indexerCollection.totalSupply)
    : 0;
  // Legacy Enumerable-contract reader. Only run it when the indexer
  // genuinely has no tokens AND we're not on the filter path. Otherwise
  // it fires its own tokenURI + per-token JSON fetches in parallel that
  // we never use — the "cancelled JSON requests" that were slowing down
  // CrazyOctogon-style large collections.
  const indexerHasTokens = indexerBrowseTokens.length > 0 || indexerBrowseTotal > 0;
  const fallbackEnabled = filteredIds === null && !indexerHasTokens;
  const {
    tokens: defaultBrowseTokens,
    totalSupply: contractTotalSupply,
    totalPages: defaultTotalPages,
    isLoading: defaultBrowseLoading,
  } = useCollectionTokens(
    fallbackEnabled ? collectionAddress : undefined,
    filteredIds !== null ? 0 : browsePage,
  );
  const totalSupply = indexerTotalSupply || contractTotalSupply;

  const imageUrlTemplate = indexerCollection?.imageUrlTemplate ?? null;
  const sampleImageUrl = indexerCollection?.sampleImageUrl ?? null;

  // Synthetic browse — once we know totalSupply we don't need to wait
  // for individual tokens to transfer before rendering them. Generate
  // IDs sequentially starting at the lowest known token ID (typically
  // 0 or 1) up to totalSupply. If a `imageUrlTemplate` is known we
  // build the image URL directly; otherwise the per-token metadata
  // hook below resolves each tokenURI on demand. Either way the grid
  // displays tokens in chain order (1, 2, 3 …) instead of in the
  // order they happened to transfer within the indexer's window.
  const tokenIdStart =
    indexerBrowseTokens.length > 0 && indexerBrowseTokens[0].tokenId === 0n ? 0 : 1;
  const canUseSyntheticBrowse = filteredIds === null && totalSupply > 0;
  const syntheticBrowseTokens = useMemo(() => {
    if (!canUseSyntheticBrowse) return [] as { tokenId: bigint; owner: string }[];
    const offset = browsePage * indexerPageSize;
    const start = tokenIdStart + offset;
    const last = tokenIdStart + totalSupply - 1;
    const end = Math.min(start + indexerPageSize - 1, last);
    const out: { tokenId: bigint; owner: string }[] = [];
    for (let i = start; i <= end; i++) {
      out.push({
        tokenId: BigInt(i),
        owner: "0x0000000000000000000000000000000000000000",
      });
    }
    return out;
  }, [canUseSyntheticBrowse, browsePage, indexerPageSize, totalSupply, tokenIdStart]);
  const syntheticTotalPages = canUseSyntheticBrowse
    ? Math.max(1, Math.ceil(totalSupply / indexerPageSize))
    : 0;

  // Source preference: filter > synthetic (template+supply) > indexer
  // transferred-tokens > legacy Enumerable fallback.
  const browseTokens = filteredIds !== null
    ? filteredTokenRows
    : canUseSyntheticBrowse
      ? syntheticBrowseTokens
      : indexerBrowseTokens.length > 0 || indexerBrowseTotal > 0
        ? indexerBrowseTokens
        : defaultBrowseTokens;
  const browseLoading = filteredIds !== null
    ? filteredLoading
    : canUseSyntheticBrowse
      ? false
      : indexerBrowseLoading || (indexerBrowseTotal === 0 && defaultBrowseLoading);
  const browseTotalPages = filteredIds !== null
    ? Math.max(1, Math.ceil(filteredIds.length / filterPageSize))
    : canUseSyntheticBrowse
      ? syntheticTotalPages
      : indexerBrowseTotal > 0
        ? indexerBrowsePages
        : defaultTotalPages;

  // Per-token metadata fetch. Skipped when we have a template (synthetic
  // or indexer-listed) since we can build the image URL directly. Kept
  // when indexer lists tokens with no template (e.g. Monad Mogs, where
  // each token's image is at a unique CID), so we don't show the same
  // sample image on every card.
  const usingIndexerBrowse =
    filteredIds === null && (canUseSyntheticBrowse || indexerHasTokens);
  const skipBatchFetch = usingIndexerBrowse && !!imageUrlTemplate;
  const batchTokens = skipBatchFetch
    ? []
    : browseTokens.map((t) => ({
        contractAddress: collectionAddress,
        tokenId: t.tokenId,
      }));
  const { data: metadataMap } = useBatchNftMetadata(batchTokens);

  const {
    tokens: ownedDiscovered,
    balanceOnly: hasBalanceOnly,
    isLoading: scanLoading,
    error: scanError,
  } = useCollectionNfts(address, address ? collectionAddress : undefined);

  const listings = listingData?.listings || [];
  const listingTotal = listingData?.total || 0;
  const listingTotalPages = Math.ceil(listingTotal / PAGE_SIZE);
  const collectionName = collectionInfo?.name || truncateAddress(collectionAddress, 8);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Collection header.
          Layout reads top-to-bottom on mobile and side-by-side on desktop:
            row 1: icon + name (+ verified check) + symbol
            row 2: meta strip (address + supply + creator)
            row 3 (EVMFS only): on-chain / contract type badges
          The listing count and primary actions sit in a quiet panel on
          the right at sm+, dropping below the title on mobile. */}
      <div className="mb-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6">
        <div className="flex items-start gap-5 min-w-0">
          <div className="w-16 h-16 overflow-hidden border border-border flex-shrink-0 bg-background-secondary">
            {collectionInfo?.iconUrl ? (
              <NftImage
                src={collectionInfo.iconUrl}
                alt={collectionName}
                className="w-16 h-16"
              />
            ) : (
              <div className="w-16 h-16 flex items-center justify-center text-sm text-foreground-secondary font-mono">
                {collectionAddress.slice(2, 6)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-3xl font-bold tracking-tight">
                {isEvmfs ? evmfsRecord!.name : collectionName}
              </h1>
              {evmfsRecord?.verified && (
                <span
                  className="text-mint text-xl leading-none"
                  title="Verified by minti"
                  aria-label="Verified"
                >
                  ✓
                </span>
              )}
              {(isEvmfs ? evmfsRecord!.symbol : collectionInfo?.symbol) && (
                <span className="text-base text-foreground-secondary font-medium">
                  {isEvmfs ? evmfsRecord!.symbol : collectionInfo!.symbol}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 text-sm text-foreground-secondary">
              <span className="font-mono">
                {truncateAddress(collectionAddress, 8)}
              </span>
              <CopyButton
                value={collectionAddress}
                label="Copy contract address"
              />
              {totalSupply > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>{formatNumber(totalSupply)} items</span>
                </>
              )}
              {isEvmfs && (
                <>
                  <span aria-hidden>·</span>
                  <span>by {truncateAddress(evmfsRecord!.creator)}</span>
                </>
              )}
            </div>
            {isEvmfs && (
              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-mint border border-mint/30 px-2 py-0.5">
                  Fully on-chain
                </span>
                <span className="text-xs text-foreground-secondary border border-border px-2 py-0.5">
                  {evmfsLabel(evmfsRecord!.evmfsContract)}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-stretch sm:items-end gap-3 flex-shrink-0">
          <p className="text-sm text-foreground-secondary">
            {listingTotal} listed
            {offers && offers.length > 0 && (
              <>
                <span aria-hidden> · </span>
                {offers.length} offer{offers.length !== 1 ? "s" : ""}
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            {mounted && address && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowOfferModal(true)}
              >
                Collection offer
              </Button>
            )}
            <HideCollectionButton address={collectionAddress} />
          </div>
        </div>
      </div>

      <CollectionWarnings contractAddress={collectionAddress} />

      {offers && offers.length > 0 && (
        <div className="mb-8 border border-border rounded-xl p-4 bg-background-secondary">
          <h3 className="text-sm font-medium mb-3">Collection Offers</h3>
          <div className="space-y-2">
            {offers.slice(0, 5).map((offer) => (
              <div
                key={offer.offerId.toString()}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-foreground-secondary">
                  {truncateAddress(offer.bidder)}
                </span>
                <div className="flex items-center gap-3">
                  <span>
                    <span className="text-mint font-medium">
                      {formatPrice(offer.amount)}
                    </span>{" "}
                    <span className="text-foreground-secondary">
                      WETH &times;{" "}
                      {(offer.quantity - offer.fulfilled).toString()}
                    </span>
                  </span>
                  {address?.toLowerCase() === offer.bidder.toLowerCase() && (
                    <CancelOfferButton offerId={offer.offerId} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Your Items — gated on `mounted` so SSR markup matches client
          (wagmi's `address` is undefined server-side, populated after
          hydration, which would otherwise mismatch). */}
      {mounted && address && scanError && (
        <div className="mb-6 px-4 py-3 border border-danger/30 rounded-lg bg-danger/5 text-sm text-danger">
          Failed to scan your NFTs: {scanError.message}
        </div>
      )}
      {mounted && address && scanLoading && (
        <div className="mb-6 flex items-center gap-2 text-sm text-foreground-secondary">
          <Spinner size="sm" /> Scanning for your NFTs in this collection...
        </div>
      )}
      {mounted && address && ownedDiscovered.length > 0 && (
        <div className="mb-10">
          <h2 className="text-lg font-semibold mb-4">
            Your items
            <span className="ml-2 text-sm font-normal text-foreground-secondary">
              {ownedDiscovered.length}
              {hasBalanceOnly && ownedDiscovered.length > 0 ? "+" : ""}
            </span>
          </h2>
          <NftGrid loading={false} empty={false}>
            {ownedDiscovered.map((token) => (
              <OwnedCollectionCard
                key={`owned-${token.contractAddress}-${token.tokenId}`}
                contractAddress={token.contractAddress}
                tokenId={token.tokenId}
                onClick={handleTokenClick(token.tokenId.toString())}
              />
            ))}
          </NftGrid>
        </div>
      )}

      {/* Tabs: Browse / Listings */}
      <div className="flex gap-6 border-b border-border mb-6">
        <button
          onClick={() => setTab("browse")}
          className={`pb-3 text-sm font-semibold transition-colors ${
            tab === "browse"
              ? "text-foreground border-b-2 border-mint"
              : "text-foreground-secondary hover:text-foreground"
          }`}
        >
          Browse
        </button>
        <button
          onClick={() => setTab("listings")}
          className={`pb-3 text-sm font-semibold transition-colors ${
            tab === "listings"
              ? "text-foreground border-b-2 border-mint"
              : "text-foreground-secondary hover:text-foreground"
          }`}
        >
          Listings ({listingTotal})
        </button>
      </div>

      {/* Browse All tab */}
      {tab === "browse" && (
        <div className="flex flex-col md:flex-row gap-6">
          {indexManifest && (
            <TraitFilter
              manifest={indexManifest}
              selected={traitSelection}
              onChange={(next) => {
                setTraitSelection(next);
                setBrowsePage(0);
              }}
            />
          )}
          <div className="flex-1 min-w-0">
            {filteredIds !== null && (
              <div className="mb-4 text-xs text-foreground-secondary">
                {formatNumber(filteredIds.length)} match
                {filteredIds.length === 1 ? "" : "es"} for current filters
              </div>
            )}
            <NftGrid
              loading={browseLoading}
              empty={!browseLoading && browseTokens.length === 0}
              emptyMessage={
                filteredIds !== null
                  ? "No tokens match the selected traits"
                  : "No tokens found in this collection"
              }
            >
              {browseTokens.map((token) =>
                isEvmfs ? (
                  <EvmfsTokenCard
                    key={token.tokenId.toString()}
                    contractAddress={collectionAddress}
                    tokenId={token.tokenId}
                    metadataManifest={evmfsRecord!.metadataManifest}
                    metadataBlock={evmfsRecord!.metadataBlock}
                    evmfsContract={evmfsRecord!.evmfsContract as EvmfsContract}
                    seller={token.owner !== address?.toLowerCase() ? token.owner : undefined}
                    onClick={handleTokenClick(token.tokenId.toString())}
                  />
                ) : (
                  <NftCard
                    key={token.tokenId.toString()}
                    contractAddress={collectionAddress}
                    tokenId={token.tokenId.toString()}
                    metadata={
                      // Prefer batched-fetched metadata when present
                      // (legacy Enumerable path). Otherwise synthesize
                      // from the collection's template (or sample image
                      // for shared-image collections like Donads).
                      metadataMap?.get(`${collectionAddress}:${token.tokenId}`) ??
                      synthesizeTokenMetadata(token.tokenId, imageUrlTemplate, sampleImageUrl)
                    }
                    seller={token.owner !== address?.toLowerCase() ? token.owner : undefined}
                    onClick={handleTokenClick(token.tokenId.toString())}
                  />
                ),
              )}
            </NftGrid>

            {browseTotalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-8">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={browsePage === 0}
                  onClick={() => setBrowsePage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-foreground-secondary">
                  Page {browsePage + 1} of {browseTotalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={browsePage >= browseTotalPages - 1}
                  onClick={() => setBrowsePage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Listings tab */}
      {tab === "listings" && (
        <>
          <NftGrid
            loading={listingsLoading}
            empty={!listingsLoading && listings.length === 0}
            emptyMessage="No active listings for this collection"
          >
            {listings.map((listing) => (
              <ListingCardWithMetadata
                key={listing.listingId.toString()}
                nftContract={listing.nftContract}
                tokenId={listing.tokenId}
                price={listing.price}
                seller={listing.seller}
                isERC1155={listing.isERC1155}
                onClick={handleTokenClick(listing.tokenId.toString())}
              />
            ))}
          </NftGrid>

          {listingTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-8">
              <Button
                variant="secondary"
                size="sm"
                disabled={listingPage === 0}
                onClick={() => setListingPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-foreground-secondary">
                Page {listingPage + 1} of {listingTotalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={listingPage >= listingTotalPages - 1}
                onClick={() => setListingPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <CollectionOfferModal
        isOpen={showOfferModal}
        onClose={() => setShowOfferModal(false)}
        nftContract={collectionAddress}
      />

      {openTokenId !== null && (
        <TokenDetailModal
          collectionAddress={collectionAddress}
          tokenId={openTokenId}
          onClose={closeTokenDetail}
        />
      )}
    </div>
  );
}

// ═══════════════════════════ TOKEN DETAIL MODAL / PAGE ═══════════════════════════

/**
 * Modal wrapper around the token detail content. Renders as a fixed
 * overlay with a dimmed/blurred backdrop. Clicking the backdrop or the
 * back arrow in the header closes it. Escape close is handled by the
 * parent CollectionPage so it also fires when focus is somewhere
 * arbitrary (a button, an input inside a sub-modal, etc.).
 */
function TokenDetailModal({
  collectionAddress,
  tokenId,
  onClose,
}: {
  collectionAddress: `0x${string}`;
  tokenId: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative mx-auto my-4 sm:my-8 max-w-7xl bg-background border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-foreground-secondary hover:text-foreground transition-colors"
            aria-label="Close"
            title="Close (Esc)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
              aria-hidden
            >
              <path
                fillRule="evenodd"
                d="M12.79 5.23a.75.75 0 0 1 0 1.06L9.06 10l3.73 3.71a.75.75 0 1 1-1.06 1.06l-4.25-4.24a.75.75 0 0 1 0-1.06l4.25-4.24a.75.75 0 0 1 1.06 0Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <span className="text-xs text-foreground-secondary truncate">
            Token #{tokenId}
          </span>
        </div>
        <TokenDetailPage
          collectionAddress={collectionAddress}
          tokenId={tokenId}
          inModal
        />
      </div>
    </div>
  );
}

function TokenDetailPage({
  collectionAddress,
  tokenId,
  inModal = false,
}: {
  collectionAddress: `0x${string}`;
  tokenId: string;
  inModal?: boolean;
}) {
  const { address } = useAccount();
  // Mount gate for wallet-address-dependent conditionals — see CollectionPage
  // for the same pattern.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { browseChainId } = useBrowseChain();
  const symbol = getNativeSymbol(browseChainId);
  const tokenIdBigInt = BigInt(tokenId);
  const { data: evmfsRecord } = useRegisteredCollectionByNft(collectionAddress);
  const isEvmfs = !!evmfsRecord;
  const { data: evmfsMetadata } = useEvmfsTokenMetadata(
    evmfsRecord?.metadataManifest,
    evmfsRecord?.metadataBlock,
    isEvmfs ? tokenIdBigInt : undefined,
    evmfsRecord?.evmfsContract as EvmfsContract | undefined
  );
  const { data: viewerUri } = useTokenViewerUri(
    evmfsRecord?.metadataManifest,
    evmfsRecord?.metadataBlock,
    isEvmfs ? tokenIdBigInt : undefined
  );
  const { data: legacyMetadata, isLoading: legacyLoading } = useNftMetadata(
    collectionAddress,
    isEvmfs ? undefined : tokenIdBigInt
  );
  const metadata = isEvmfs ? evmfsMetadata : legacyMetadata;
  const isLoading = isEvmfs ? !evmfsMetadata && !viewerUri : legacyLoading;

  // Image resolution. The order matters because there are two
  // failure modes we have to handle without showing the wrong image:
  //   1. CORS-blocked tokenURI hosts (scatter etc.) - metadata fetch
  //      fails, we need a fallback so the modal doesn't sit empty.
  //   2. Collections whose `imageUrlTemplate` has no `{id}`
  //      placeholder (the indexer recorded a static URL because the
  //      shape didn't expose a tokenId substring). Substituting a
  //      template with no placeholder is a no-op and yields the same
  //      URL for every token - wrong.
  //
  // Logic:
  //   - If template contains `{id}`, the indexer cracked the
  //     per-token URL pattern. Use that - fast, no CORS, matches
  //     gallery thumbnails exactly.
  //   - Otherwise wait for the live metadata fetch (carries the
  //     per-token `image` field from the JSON). Falls back to
  //     `sampleImageUrl` only when the live fetch genuinely failed
  //     and we have nothing else.
  const { data: indexerCollData } = useIndexerCollection(collectionAddress);
  const imageUrlTemplate = indexerCollData?.collection?.imageUrlTemplate;
  const sampleImageUrl = indexerCollData?.collection?.sampleImageUrl;
  const templateHasId = !!imageUrlTemplate && imageUrlTemplate.includes("{id}");
  const effectiveImage = useMemo(() => {
    if (templateHasId && imageUrlTemplate) {
      return imageUrlTemplate.replace(/\{id\}/g, tokenId);
    }
    return metadata?.image || sampleImageUrl || "";
  }, [templateHasId, imageUrlTemplate, tokenId, metadata?.image, sampleImageUrl]);
  const { data: bids } = useCollectionBids(collectionAddress);
  const { data: offers } = useCollectionOffers(collectionAddress);

  const [showListModal, setShowListModal] = useState(false);
  const [showBidModal, setShowBidModal] = useState(false);

  const tokenBids =
    bids?.filter((b) => b.tokenId.toString() === tokenId) || [];

  // Check if this token has an active listing
  const { data: activeListingId } = useReadContract({
    address: MINTI_MARKETPLACE_ADDRESS,
    abi: mintiAbi,
    functionName: "getActiveListingId",
    args: address ? [collectionAddress, tokenIdBigInt, address] : undefined,
    query: { enabled: !!address },
  });

  // Fetch listing details if active
  const hasListing = activeListingId && (activeListingId as bigint) > 0n;

  // Find listing in collection listings for this token (from any seller)
  const { data: collectionData } = useCollectionListings(collectionAddress, 0);
  const tokenListing = collectionData?.listings.find(
    (l) => l.tokenId.toString() === tokenId
  );

  return (
    <div
      className={
        inModal ? "px-4 sm:px-6 py-6" : "max-w-7xl mx-auto px-4 py-8"
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="overflow-hidden border border-border">
          {isLoading ? (
            <div className="aspect-square flex items-center justify-center bg-background-secondary">
              <Spinner size="lg" />
            </div>
          ) : isEvmfs && viewerUri ? (
            <iframe
              src={viewerUri}
              title={metadata?.name || `Token #${tokenId}`}
              sandbox="allow-scripts"
              className="w-full aspect-square border-0 bg-background-secondary"
            />
          ) : (
            <NftImage
              src={effectiveImage}
              rawUri={
                isEvmfs ? undefined : (legacyMetadata as { rawImageUri?: string } | undefined)?.rawImageUri
              }
              alt={metadata?.name || `#${tokenId}`}
              className="aspect-square"
            />
          )}
        </div>

        <div className="space-y-6">
          <div>
            {!inModal && (
              <a
                href={`/collection/${collectionAddress}`}
                className="text-sm text-mint hover:underline"
              >
                {truncateAddress(collectionAddress, 8)}
              </a>
            )}
            <h1 className="text-3xl font-bold mt-1">
              {metadata?.name || `#${tokenId}`}
            </h1>
            {metadata?.description && (
              <p className="text-foreground-secondary mt-2 text-sm">
                {metadata.description}
              </p>
            )}
          </div>

          {isEvmfs && evmfsRecord && (
            <OnChainVerifyPanel
              metadataManifest={evmfsRecord.metadataManifest}
              metadataBlock={evmfsRecord.metadataBlock}
              evmfsContract={evmfsRecord.evmfsContract as EvmfsContract}
              tokenId={tokenIdBigInt}
            />
          )}

          {/* Action Buttons */}
          {tokenListing && (
            <div className="border border-border rounded-xl p-4 bg-background-secondary space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-foreground-secondary">Listed by</span>
                <span>{truncateAddress(tokenListing.seller)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-foreground-secondary">Price</span>
                <span className="text-mint font-medium">
                  {formatPrice(tokenListing.price)} {symbol}
                </span>
              </div>

              {address?.toLowerCase() === tokenListing.seller.toLowerCase() ? (
                <CancelListingButton listingId={tokenListing.listingId} />
              ) : (
                <BuyButton
                  listingId={tokenListing.listingId}
                  price={tokenListing.price}
                  seller={tokenListing.seller}
                  currentUserAddress={address}
                />
              )}
            </div>
          )}

          {/* User actions: list / bid */}
          {mounted && address && (
            <div className="flex gap-2">
              {!hasListing && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowListModal(true)}
                >
                  List for Sale
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowBidModal(true)}
              >
                Place Bid
              </Button>
            </div>
          )}

          {/* Traits */}
          {metadata?.attributes && metadata.attributes.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-3">Traits</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {metadata.attributes.map((attr, i) => (
                  <div
                    key={i}
                    className="border border-border rounded-lg p-2 bg-background-secondary"
                  >
                    <div className="text-xs text-mint uppercase">
                      {attr.trait_type}
                    </div>
                    <div className="text-sm font-medium truncate">
                      {String(attr.value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bids */}
          {tokenBids.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-3">
                Bids ({tokenBids.length})
              </h3>
              <div className="border border-border rounded-xl overflow-hidden">
                {tokenBids.map((bid) => (
                  <div
                    key={bid.bidId.toString()}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-b-0"
                  >
                    <div>
                      <span className="text-sm text-foreground-secondary">
                        {truncateAddress(bid.bidder)}
                      </span>
                      <span className="text-xs text-foreground-secondary/50 ml-2">
                        {timeAgo(bid.timestamp)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-sm">
                        <span className="text-mint font-medium">
                          {formatPrice(bid.amount)}
                        </span>
                        <span className="text-foreground-secondary ml-1">
                          WETH
                        </span>
                      </div>
                      {address?.toLowerCase() === bid.bidder.toLowerCase() && (
                        <CancelBidButton bidId={bid.bidId} />
                      )}
                      {tokenListing &&
                        address?.toLowerCase() ===
                          tokenListing.seller.toLowerCase() && (
                          <AcceptBidButton bidId={bid.bidId} />
                        )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Collection Offers */}
          {offers && offers.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-3">
                Collection Offers ({offers.length})
              </h3>
              <div className="border border-border rounded-xl overflow-hidden">
                {offers.slice(0, 5).map((offer) => (
                  <div
                    key={offer.offerId.toString()}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-b-0"
                  >
                    <div>
                      <span className="text-sm text-foreground-secondary">
                        {truncateAddress(offer.bidder)}
                      </span>
                      <span className="text-xs text-foreground-secondary/50 ml-2">
                        {timeAgo(offer.timestamp)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-sm">
                        <span className="text-mint font-medium">
                          {formatPrice(offer.amount)}
                        </span>
                        <span className="text-foreground-secondary ml-1">
                          WETH &times;{" "}
                          {(offer.quantity - offer.fulfilled).toString()}
                        </span>
                      </div>
                      {mounted &&
                        address?.toLowerCase() ===
                          offer.bidder.toLowerCase() && (
                          <CancelOfferButton offerId={offer.offerId} />
                        )}
                      {mounted &&
                        address &&
                        address.toLowerCase() !==
                          offer.bidder.toLowerCase() && (
                          <AcceptCollectionOfferButton
                            offerId={offer.offerId}
                            tokenId={tokenIdBigInt}
                          />
                        )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ListItemModal
        isOpen={showListModal}
        onClose={() => setShowListModal(false)}
        nftContract={collectionAddress}
        tokenId={tokenIdBigInt}
        tokenName={metadata?.name}
      />

      <PlaceBidModal
        isOpen={showBidModal}
        onClose={() => setShowBidModal(false)}
        nftContract={collectionAddress}
        tokenId={tokenIdBigInt}
        tokenName={metadata?.name}
      />
    </div>
  );
}

// ═══════════════════════════ SHARED ═══════════════════════════

/**
 * Build a minimal `NftMetadata` object from collection-level data so
 * we never need a per-token network fetch in the browse grid:
 *
 *   1. If imageUrlTemplate exists → substitute `{id}` for the tokenId.
 *      Per-token unique images (most collections).
 *   2. Otherwise if sampleImageUrl exists → use it for every token.
 *      "Shared image" collections (Donads, Pixel Panda etc) where the
 *      contract returns one image for all NFTs.
 *   3. Otherwise → undefined, NftCard shows placeholder.
 */
function synthesizeTokenMetadata(
  tokenId: bigint | string,
  imageUrlTemplate: string | null | undefined,
  sampleImageUrl: string | null | undefined,
): {
  name: string;
  description: string;
  image: string;
  attributes: never[];
  raw: Record<string, never>;
} | undefined {
  const tid = tokenId.toString();
  const image = imageUrlTemplate
    ? imageUrlTemplate.replace(/\{id\}/g, tid)
    : (sampleImageUrl ?? "");
  if (!image) return undefined;
  return {
    name: `#${tid}`,
    description: "",
    image,
    attributes: [],
    raw: {},
  };
}

function OwnedCollectionCard({
  contractAddress,
  tokenId,
  imageUrlTemplate,
  sampleImageUrl,
  onClick,
}: {
  contractAddress: `0x${string}`;
  tokenId: bigint;
  imageUrlTemplate?: string | null;
  sampleImageUrl?: string | null;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  // Skip the per-token fetch when we can synthesize from collection
  // template or shared sample image. Avoids scatter-502 storm.
  const haveSynth = !!imageUrlTemplate || !!sampleImageUrl;
  const { data: fetched } = useNftMetadata(
    contractAddress,
    haveSynth ? undefined : tokenId,
  );
  const metadata = haveSynth
    ? synthesizeTokenMetadata(tokenId, imageUrlTemplate, sampleImageUrl)
    : fetched;
  return (
    <NftCard
      contractAddress={contractAddress}
      tokenId={tokenId.toString()}
      metadata={metadata}
      onClick={onClick}
    />
  );
}

function ListingCardWithMetadata({
  nftContract,
  tokenId,
  price,
  seller,
  isERC1155,
  imageUrlTemplate,
  sampleImageUrl,
  onClick,
}: {
  nftContract: `0x${string}`;
  tokenId: bigint;
  price: bigint;
  seller: string;
  isERC1155: boolean;
  imageUrlTemplate?: string | null;
  sampleImageUrl?: string | null;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const haveSynth = !!imageUrlTemplate || !!sampleImageUrl;
  const { data: fetched } = useNftMetadata(
    nftContract,
    haveSynth ? undefined : tokenId,
    isERC1155,
  );
  const metadata = haveSynth
    ? synthesizeTokenMetadata(tokenId, imageUrlTemplate, sampleImageUrl)
    : fetched;
  return (
    <NftCard
      contractAddress={nftContract}
      tokenId={tokenId.toString()}
      metadata={metadata}
      price={price}
      seller={seller}
      onClick={onClick}
    />
  );
}
