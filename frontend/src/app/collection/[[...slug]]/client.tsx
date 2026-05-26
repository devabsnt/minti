"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
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

  if (slug.length >= 2) {
    // Validate tokenId is a valid number
    let tokenId: string;
    try {
      BigInt(slug[1]);
      tokenId = slug[1];
    } catch {
      return (
        <div className="max-w-7xl mx-auto px-4 py-20 text-center text-foreground-secondary">
          <p>Invalid token ID.</p>
        </div>
      );
    }
    return (
      <TokenDetailPage
        collectionAddress={collectionAddress}
        tokenId={tokenId}
      />
    );
  }

  return <CollectionPage collectionAddress={collectionAddress} />;
}

// ═══════════════════════════ COLLECTION PAGE ═══════════════════════════

type CollectionTab = "browse" | "listings";

function CollectionPage({
  collectionAddress,
}: {
  collectionAddress: `0x${string}`;
}) {
  const { address } = useAccount();
  // Wallet address is undefined on SSR but populated after client hydration —
  // any conditional that depends on it would mismatch. Gate those branches on
  // `mounted` so the server renders the unconnected state and the client
  // re-renders after hydration without React flagging it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [tab, setTab] = useState<CollectionTab>("browse");
  const [browsePage, setBrowsePage] = useState(0);
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
  const {
    tokens: defaultBrowseTokens,
    totalSupply: contractTotalSupply,
    totalPages: defaultTotalPages,
    isLoading: defaultBrowseLoading,
  } = useCollectionTokens(collectionAddress, filteredIds !== null ? 0 : browsePage);
  const totalSupply = indexerTotalSupply || contractTotalSupply;

  // Source preference: filtered (EVMFS trait filter) > indexer > legacy
  // Enumerable fallback (only kicks in if indexer somehow has zero tokens
  // for this collection, e.g. it was just discovered).
  const browseTokens = filteredIds !== null
    ? filteredTokenRows
    : indexerBrowseTokens.length > 0 || indexerBrowseTotal > 0
      ? indexerBrowseTokens
      : defaultBrowseTokens;
  const browseLoading = filteredIds !== null
    ? filteredLoading
    : indexerBrowseLoading || (indexerBrowseTotal === 0 && defaultBrowseLoading);
  const browseTotalPages = filteredIds !== null
    ? Math.max(1, Math.ceil(filteredIds.length / filterPageSize))
    : indexerBrowseTotal > 0
      ? indexerBrowsePages
      : defaultTotalPages;

  // Per-token metadata via Multicall — only used for the legacy
  // Enumerable fallback (when indexer doesn't have the collection yet)
  // AND for the EVMFS-trait-filtered path. The indexer-driven path uses
  // `imageUrlTemplate` substitution in NftCard instead of a per-token
  // metadata fetch, which is what kills the scatter-502 storm.
  const usingIndexerBrowse =
    filteredIds === null && (indexerBrowseTokens.length > 0 || indexerBrowseTotal > 0);
  const batchTokens = usingIndexerBrowse
    ? []
    : browseTokens.map((t) => ({
        contractAddress: collectionAddress,
        tokenId: t.tokenId,
      }));
  const { data: metadataMap } = useBatchNftMetadata(batchTokens);

  // Substitute `{id}` in the collection's image URL template for the
  // browse grid. Computed once per token list change.
  const imageUrlTemplate = indexerCollection?.imageUrlTemplate ?? null;

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
      <div className="mb-8 flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl overflow-hidden border border-border flex-shrink-0 bg-background-secondary">
            {collectionInfo?.iconUrl ? (
              <NftImage
                src={collectionInfo.iconUrl}
                alt={collectionName}
                className="w-14 h-14"
              />
            ) : (
              <div className="w-14 h-14 flex items-center justify-center text-sm text-foreground-secondary font-mono">
                {collectionAddress.slice(2, 6)}
              </div>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
              {isEvmfs ? evmfsRecord!.name : collectionName}
              {evmfsRecord?.verified && (
                <span
                  className="text-mint"
                  title="Verified by minti"
                  aria-label="Verified"
                >
                  ✓
                </span>
              )}
              {(isEvmfs ? evmfsRecord!.symbol : collectionInfo?.symbol) && (
                <span className="text-sm text-foreground-secondary font-normal">
                  {isEvmfs ? evmfsRecord!.symbol : collectionInfo!.symbol}
                </span>
              )}
              {isEvmfs && (
                <>
                  <span className="text-[10px] uppercase tracking-wider text-mint border border-mint/30 rounded px-1.5 py-0.5">
                    100% on-chain
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-foreground-secondary/70 border border-border rounded px-1 py-0.5">
                    {evmfsLabel(evmfsRecord!.evmfsContract)}
                  </span>
                </>
              )}
            </h1>
            <p className="text-xs text-foreground-secondary font-mono flex items-center gap-1.5">
              <span>{truncateAddress(collectionAddress, 8)}</span>
              <CopyButton value={collectionAddress} label="Copy contract address" />
              {totalSupply > 0 && (
                <span className="ml-1">&middot; {formatNumber(totalSupply)} items</span>
              )}
              {isEvmfs && (
                <span className="ml-1">
                  &middot; by {truncateAddress(evmfsRecord!.creator)}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="text-right space-y-2">
          <p className="text-sm text-foreground-secondary">
            {listingTotal} listed
            {offers && offers.length > 0 && (
              <span>
                {" "}&middot; {offers.length} offer{offers.length !== 1 ? "s" : ""}
              </span>
            )}
          </p>
          <div className="flex items-center justify-end gap-2">
            {mounted && address && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowOfferModal(true)}
              >
                Collection Offer
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
        <div className="mb-8">
          <h3 className="text-sm font-medium mb-3">
            Your Items ({ownedDiscovered.length}
            {hasBalanceOnly && ownedDiscovered.length > 0 ? "+" : ""})
          </h3>
          <NftGrid loading={false} empty={false}>
            {ownedDiscovered.map((token) => (
              <OwnedCollectionCard
                key={`owned-${token.contractAddress}-${token.tokenId}`}
                contractAddress={token.contractAddress}
                tokenId={token.tokenId}
              />
            ))}
          </NftGrid>
        </div>
      )}

      {/* Tabs: Browse All / Listings */}
      <div className="flex gap-6 border-b border-border mb-6">
        <button
          onClick={() => setTab("browse")}
          className={`pb-3 text-sm font-medium transition-colors ${
            tab === "browse"
              ? "text-mint border-b-2 border-mint"
              : "text-foreground-secondary hover:text-foreground"
          }`}
        >
          Browse All
        </button>
        <button
          onClick={() => setTab("listings")}
          className={`pb-3 text-sm font-medium transition-colors ${
            tab === "listings"
              ? "text-mint border-b-2 border-mint"
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
                  />
                ) : (
                  <NftCard
                    key={token.tokenId.toString()}
                    contractAddress={collectionAddress}
                    tokenId={token.tokenId.toString()}
                    metadata={
                      // Prefer batched-fetched metadata when present
                      // (legacy Enumerable path). Otherwise synthesize
                      // from the collection's template: NO per-token
                      // network fetch, no scatter 502s. Falls back to
                      // an empty object so NftImage shows its placeholder.
                      metadataMap?.get(`${collectionAddress}:${token.tokenId}`) ??
                      (imageUrlTemplate
                        ? {
                            name: `#${token.tokenId.toString()}`,
                            description: "",
                            image: imageUrlTemplate.replace(
                              /\{id\}/g,
                              token.tokenId.toString(),
                            ),
                            attributes: [],
                          }
                        : undefined)
                    }
                    seller={token.owner !== address?.toLowerCase() ? token.owner : undefined}
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
    </div>
  );
}

// ═══════════════════════════ TOKEN DETAIL PAGE ═══════════════════════════

function TokenDetailPage({
  collectionAddress,
  tokenId,
}: {
  collectionAddress: `0x${string}`;
  tokenId: string;
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
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="rounded-xl overflow-hidden border border-border">
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
              src={metadata?.image || ""}
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
            <a
              href={`/collection/${collectionAddress}`}
              className="text-sm text-mint hover:underline"
            >
              {truncateAddress(collectionAddress, 8)}
            </a>
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

function OwnedCollectionCard({
  contractAddress,
  tokenId,
}: {
  contractAddress: `0x${string}`;
  tokenId: bigint;
}) {
  const { data: metadata } = useNftMetadata(contractAddress, tokenId);
  return (
    <NftCard
      contractAddress={contractAddress}
      tokenId={tokenId.toString()}
      metadata={metadata}
    />
  );
}

function ListingCardWithMetadata({
  nftContract,
  tokenId,
  price,
  seller,
  isERC1155,
}: {
  nftContract: `0x${string}`;
  tokenId: bigint;
  price: bigint;
  seller: string;
  isERC1155: boolean;
}) {
  const { data: metadata } = useNftMetadata(nftContract, tokenId, isERC1155);

  return (
    <NftCard
      contractAddress={nftContract}
      tokenId={tokenId.toString()}
      metadata={metadata}
      price={price}
      seller={seller}
    />
  );
}
