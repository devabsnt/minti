"use client";

import { useParams } from "next/navigation";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useAccount } from "wagmi";
import { truncateAddress, formatPrice, timeAgo } from "@/lib/format";
import { isAddress } from "viem";
import { useBrowseChain } from "@/providers/ChainProvider";
import { CHAIN_NAMES, getNativeSymbol } from "@/config/chains";
import { useAllListings } from "@/hooks/useListings";
import { useWalletNfts } from "@/hooks/useWalletNfts";
import { useCollectionInfo } from "@/hooks/useCollectionInfo";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { NftGrid } from "@/components/nft/NftGrid";
import { NftImage } from "@/components/nft/NftImage";
import { Spinner } from "@/components/ui/Spinner";
import { useNftMetadata, useBatchNftMetadata } from "@/hooks/useNftMetadata";
import { CancelListingButton } from "@/components/marketplace/ActionButtons";
import { CopyButton } from "@/components/ui/CopyButton";

type Tab = "owned" | "listed" | "bids" | "offers";

export function WalletCatchAll() {
  const params = useParams();
  const slug = params?.slug as string[] | undefined;
  const { address: connectedAddress } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const walletAddress = slug?.[0] || (mounted ? connectedAddress : undefined);

  if (!walletAddress) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center text-foreground-secondary">
        {mounted ? (
          <>
            <p>Connect your wallet or enter an address in the URL.</p>
            <p className="text-sm mt-2">/wallet/0x...</p>
          </>
        ) : (
          <Spinner size="lg" />
        )}
      </div>
    );
  }

  return <WalletProfilePage address={walletAddress as `0x${string}`} />;
}

function WalletProfilePage({ address }: { address: `0x${string}` }) {
  const { browseChainId } = useBrowseChain();
  const { address: connectedAddress } = useAccount();
  const [isOwnWallet, setIsOwnWallet] = useState(false);
  useEffect(() => {
    setIsOwnWallet(
      !!connectedAddress &&
        connectedAddress.toLowerCase() === address.toLowerCase()
    );
  }, [connectedAddress, address]);
  const [activeTab, setActiveTab] = useState<Tab>("owned");
  const [trackedCollections, setTrackedCollections] = useState<string[]>([]);
  useEffect(() => {
    const stored = localStorage.getItem(
      `minti_tracked_${address.toLowerCase()}`
    );
    if (stored) {
      try {
        setTrackedCollections(JSON.parse(stored));
      } catch {
        // corrupted storage, ignore
      }
    }
  }, [address]);
  const [collectionInput, setCollectionInput] = useState("");

  const addCollection = useCallback(() => {
    const addr = collectionInput.trim();
    if (
      isAddress(addr) &&
      !trackedCollections.includes(addr.toLowerCase())
    ) {
      const updated = [...trackedCollections, addr.toLowerCase()];
      setTrackedCollections(updated);
      localStorage.setItem(
        `minti_tracked_${address.toLowerCase()}`,
        JSON.stringify(updated)
      );
      setCollectionInput("");
    }
  }, [collectionInput, trackedCollections, address]);

  const removeCollection = useCallback(
    (addr: string) => {
      const updated = trackedCollections.filter((c) => c !== addr);
      setTrackedCollections(updated);
      localStorage.setItem(
        `minti_tracked_${address.toLowerCase()}`,
        JSON.stringify(updated)
      );
    },
    [trackedCollections, address]
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-full bg-mint/20 flex items-center justify-center text-mint font-bold">
            {address.slice(2, 4).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <span>{truncateAddress(address, 6)}</span>
              <CopyButton value={address} label="Copy wallet address" />
              {isOwnWallet && (
                <span className="text-xs text-mint font-normal">
                  (you)
                </span>
              )}
            </h1>
            <p className="text-sm text-foreground-secondary">
              Viewing on {CHAIN_NAMES[browseChainId]}
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-border mb-6">
        {(["owned", "listed", "bids", "offers"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`pb-3 text-sm font-medium transition-colors capitalize ${
              activeTab === tab
                ? "text-mint border-b-2 border-mint"
                : "text-foreground-secondary hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "owned" && (
        <OwnedTab
          address={address}
          trackedCollections={trackedCollections}
          collectionInput={collectionInput}
          onInputChange={setCollectionInput}
          onAdd={addCollection}
          onRemove={removeCollection}
        />
      )}
      {activeTab === "listed" && <ListedTab address={address} />}
      {activeTab === "bids" && <BidsTab address={address} />}
      {activeTab === "offers" && <OffersTab address={address} />}
    </div>
  );
}

// ═══════════════════════════ OWNED TAB ═══════════════════════════

interface FlatToken {
  contract: `0x${string}`;
  tokenId: bigint;
  is1155: boolean;
  balance?: bigint;
}

type SortMode = "recent" | "name" | "collection";

function OwnedTab({
  address,
  trackedCollections,
  collectionInput,
  onInputChange,
  onAdd,
  onRemove,
}: {
  address: `0x${string}`;
  trackedCollections: string[];
  collectionInput: string;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (addr: string) => void;
}) {
  const {
    collections,
    hasTokens,
    isLoading,
    error,
    isBackScanning,
    backwardProgress,
  } = useWalletNfts(address, trackedCollections);

  // ── Flatten all collections into a single token list ────────────
  const allTokens = useMemo<FlatToken[]>(() => {
    const tokens: FlatToken[] = [];
    for (const col of collections) {
      for (const id of col.tokenIds) {
        tokens.push({
          contract: col.contractAddress,
          tokenId: id,
          is1155: false,
        });
      }
      if (col.is1155 && col.balances1155) {
        for (const [id, bal] of Object.entries(col.balances1155)) {
          tokens.push({
            contract: col.contractAddress,
            tokenId: BigInt(id),
            is1155: true,
            balance: BigInt(bal),
          });
        }
      }
    }
    return tokens;
  }, [collections]);

  // ── Batch-fetch metadata for all tokens at once ─────────────────
  const batchTokens = useMemo(
    () =>
      allTokens.map((t) => ({
        contractAddress: t.contract,
        tokenId: t.tokenId,
        isERC1155: t.is1155,
      })),
    [allTokens],
  );
  const { data: metadataMap } = useBatchNftMetadata(batchTokens);

  // ── Manual hide set (persisted to localStorage per wallet) ──────
  const manualHideKey = `minti_hidden_${address.toLowerCase()}`;
  const [manualHidden, setManualHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(manualHideKey);
      if (raw) setManualHidden(new Set(JSON.parse(raw)));
    } catch {
      /* corrupted */
    }
  }, [manualHideKey]);

  const toggleManualHide = useCallback(
    (tokenKey: string) => {
      setManualHidden((prev) => {
        const next = new Set(prev);
        if (next.has(tokenKey)) next.delete(tokenKey);
        else next.add(tokenKey);
        try {
          localStorage.setItem(manualHideKey, JSON.stringify([...next]));
        } catch {
          /* quota */
        }
        return next;
      });
    },
    [manualHideKey],
  );

  // ── Classification: manual-hide overrides spam heuristic ────────
  // A token is "hidden" if:
  //   (a) the user has manually hidden it, OR
  //   (b) its metadata loaded AND has neither image nor name (spam shell)
  // Loading tokens stay visible — they'll re-classify when metadata arrives.
  const { visible, hidden } = useMemo(() => {
    const visible: FlatToken[] = [];
    const hidden: FlatToken[] = [];
    for (const t of allTokens) {
      const key = `${t.contract}-${t.tokenId}`;
      if (manualHidden.has(key)) {
        hidden.push(t);
        continue;
      }
      const m = metadataMap?.get(`${t.contract}:${t.tokenId}`);
      const looksLikeSpam = m && !m.image && !m.name;
      if (looksLikeSpam) hidden.push(t);
      else visible.push(t);
    }
    return { visible, hidden };
  }, [allTokens, metadataMap, manualHidden]);

  // ── Filter / search / sort state ────────────────────────────────
  const [selectedCollections, setSelectedCollections] = useState<Set<string>>(
    new Set(),
  );
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const sourceTokens = showHidden ? hidden : visible;

  // ── Apply filters + sort ────────────────────────────────────────
  const displayedTokens = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = sourceTokens.filter((t) => {
      if (selectedCollections.size > 0) {
        if (!selectedCollections.has(t.contract.toLowerCase())) return false;
      }
      if (q) {
        const m = metadataMap?.get(`${t.contract}:${t.tokenId}`);
        const name = (m?.name || `#${t.tokenId}`).toLowerCase();
        if (!name.includes(q)) return false;
      }
      return true;
    });

    // Sort
    const sorted = [...filtered];
    if (sortMode === "name") {
      sorted.sort((a, b) => {
        const an = metadataMap?.get(`${a.contract}:${a.tokenId}`)?.name || "";
        const bn = metadataMap?.get(`${b.contract}:${b.tokenId}`)?.name || "";
        return an.localeCompare(bn);
      });
    } else if (sortMode === "collection") {
      sorted.sort((a, b) => a.contract.localeCompare(b.contract));
    }
    // "recent" is the natural traversal order from the scan.

    return sorted;
  }, [sourceTokens, selectedCollections, searchQuery, sortMode, metadataMap]);

  // ── Per-collection counts for the sidebar ───────────────────────
  const collectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of visible) {
      const k = t.contract.toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return counts;
  }, [visible]);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Error */}
      {error && (
        <div className="px-4 py-3 border border-danger/30 rounded-lg bg-danger/5 text-sm text-danger">
          Failed to scan NFTs: {error.message}
        </div>
      )}

      {/* Scan progress */}
      {(isLoading || isBackScanning) && (
        <ScanProgress
          isLoading={isLoading}
          isBackScanning={isBackScanning}
          backwardProgress={backwardProgress}
          discoveredCount={visible.length + hidden.length}
        />
      )}

      <div className="flex gap-6">
        {/* ─── Sidebar (collections + status filters) ─── */}
        <aside className="hidden lg:block w-64 flex-shrink-0">
          <FilterSidebar
            collectionCounts={collectionCounts}
            selectedCollections={selectedCollections}
            onToggleCollection={(addr) => {
              setSelectedCollections((prev) => {
                const next = new Set(prev);
                if (next.has(addr)) next.delete(addr);
                else next.add(addr);
                return next;
              });
            }}
            onClearCollections={() => setSelectedCollections(new Set())}
            visibleCount={visible.length}
            hiddenCount={hidden.length}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((s) => !s)}
          />
        </aside>

        {/* ─── Main content (toolbar + grid + bottom card) ─── */}
        <div className="flex-1 min-w-0 space-y-4">
          <Toolbar
            count={displayedTokens.length}
            total={sourceTokens.length}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortMode={sortMode}
            onSortChange={setSortMode}
          />

          {displayedTokens.length === 0 ? (
            <div className="py-16 text-center text-foreground-secondary">
              {!hasTokens && !isLoading ? (
                <p className="text-sm">
                  No NFTs found on this chain. Try browsing the{" "}
                  <a href="/explore" className="text-mint hover:underline">
                    marketplace
                  </a>
                  .
                </p>
              ) : showHidden ? (
                <p className="text-sm">No hidden items.</p>
              ) : selectedCollections.size > 0 || searchQuery ? (
                <p className="text-sm">No items match your filters.</p>
              ) : (
                <p className="text-sm">No items yet.</p>
              )}
            </div>
          ) : (
            <NftGrid loading={false} empty={false}>
              {displayedTokens.map((t) => {
                const tokenKey = `${t.contract}-${t.tokenId}`;
                return (
                  <NftCardWithCollection
                    key={tokenKey}
                    token={t}
                    metadata={metadataMap?.get(`${t.contract}:${t.tokenId}`)}
                    isHidden={showHidden}
                    onToggleHide={() => toggleManualHide(tokenKey)}
                  />
                );
              })}
            </NftGrid>
          )}

          {/* Manual collection tracking — kept at bottom, lower priority */}
          <details className="border border-border rounded-xl bg-background-secondary">
            <summary className="px-4 py-3 cursor-pointer text-sm font-medium select-none">
              Track collections manually
              {trackedCollections.length > 0 && (
                <span className="ml-2 text-xs text-foreground-secondary">
                  ({trackedCollections.length})
                </span>
              )}
            </summary>
            <div className="px-4 pb-4 pt-1">
              <p className="text-xs text-foreground-secondary mb-3">
                Force a check of a specific contract. Useful if Hypersync
                missed something or the collection is new.
              </p>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="0x... collection address"
                    value={collectionInput}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && onAdd()}
                  />
                </div>
                <Button onClick={onAdd} size="md">
                  Track
                </Button>
              </div>
              {trackedCollections.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {trackedCollections.map((col) => (
                    <span
                      key={col}
                      className="inline-flex items-center gap-1.5 px-2 py-1 text-xs border border-border rounded-lg"
                    >
                      <a
                        href={`/collection/${col}`}
                        className="text-mint hover:underline font-mono"
                      >
                        {truncateAddress(col)}
                      </a>
                      <button
                        onClick={() => onRemove(col)}
                        className="text-foreground-secondary hover:text-danger"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// ─── Scan progress bar ─────────────────────────────────────────────
function ScanProgress({
  isLoading,
  isBackScanning,
  backwardProgress,
  discoveredCount,
}: {
  isLoading: boolean;
  isBackScanning: boolean;
  backwardProgress: number;
  discoveredCount: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-foreground-secondary">
        <div className="flex items-center gap-1.5">
          <Spinner size="sm" />
          <span>
            {isLoading
              ? "Scanning for NFTs..."
              : `Scanning chain history... ${backwardProgress}%`}
          </span>
        </div>
        {discoveredCount > 0 && (
          <span>
            {discoveredCount} item{discoveredCount !== 1 ? "s" : ""} so far
          </span>
        )}
      </div>
      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-mint rounded-full transition-all duration-500 ease-out"
          style={{
            width: isBackScanning ? `${Math.max(backwardProgress, 2)}%` : "15%",
          }}
        />
      </div>
    </div>
  );
}

// ─── Sidebar (collections multi-select + status toggle) ────────────
function FilterSidebar({
  collectionCounts,
  selectedCollections,
  onToggleCollection,
  onClearCollections,
  visibleCount,
  hiddenCount,
  showHidden,
  onToggleHidden,
}: {
  collectionCounts: Map<string, number>;
  selectedCollections: Set<string>;
  onToggleCollection: (addr: string) => void;
  onClearCollections: () => void;
  visibleCount: number;
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
}) {
  // Sort collections by count desc
  const sortedCollections = useMemo(
    () =>
      Array.from(collectionCounts.entries()).sort((a, b) => b[1] - a[1]),
    [collectionCounts],
  );

  return (
    <div className="sticky top-4 space-y-4">
      {/* Status: visible / hidden */}
      <div className="border border-border rounded-xl bg-background-secondary p-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-foreground-secondary mb-2">
          Status
        </h3>
        <button
          onClick={onToggleHidden}
          className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm transition-colors ${
            !showHidden
              ? "bg-mint/10 text-mint"
              : "hover:bg-background-tertiary text-foreground"
          }`}
        >
          <span>Visible</span>
          <span className="text-xs">{visibleCount}</span>
        </button>
        <button
          onClick={onToggleHidden}
          className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm transition-colors ${
            showHidden
              ? "bg-mint/10 text-mint"
              : "hover:bg-background-tertiary text-foreground"
          }`}
        >
          <span>Hidden</span>
          <span className="text-xs">{hiddenCount}</span>
        </button>
      </div>

      {/* Collections */}
      <div className="border border-border rounded-xl bg-background-secondary p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-foreground-secondary">
            Collections
          </h3>
          {selectedCollections.size > 0 && (
            <button
              onClick={onClearCollections}
              className="text-xs text-mint hover:underline"
            >
              clear
            </button>
          )}
        </div>
        <div className="space-y-0.5 max-h-96 overflow-auto">
          {sortedCollections.map(([addr, count]) => (
            <CollectionFilterRow
              key={addr}
              address={addr as `0x${string}`}
              count={count}
              selected={selectedCollections.has(addr)}
              onToggle={() => onToggleCollection(addr)}
            />
          ))}
          {sortedCollections.length === 0 && (
            <p className="text-xs text-foreground-secondary px-2 py-1.5">
              No collections yet
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CollectionFilterRow({
  address,
  count,
  selected,
  onToggle,
}: {
  address: `0x${string}`;
  count: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const { data: info } = useCollectionInfo(address);
  const name = info?.name || truncateAddress(address, 4);
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
        selected
          ? "bg-mint/10 text-mint"
          : "hover:bg-background-tertiary text-foreground"
      }`}
    >
      <div className="w-5 h-5 rounded overflow-hidden border border-border flex-shrink-0 bg-background-tertiary">
        {info?.iconUrl ? (
          <NftImage src={info.iconUrl} alt={name} className="w-5 h-5" />
        ) : null}
      </div>
      <span className="flex-1 text-left truncate text-xs">{name}</span>
      <span className="text-xs text-foreground-secondary">{count}</span>
    </button>
  );
}

// ─── Toolbar (search + sort + count) ───────────────────────────────
function Toolbar({
  count,
  total,
  searchQuery,
  onSearchChange,
  sortMode,
  onSortChange,
}: {
  count: number;
  total: number;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  sortMode: SortMode;
  onSortChange: (m: SortMode) => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
      <div className="flex-1 max-w-sm">
        <Input
          placeholder="Search by name"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-foreground-secondary whitespace-nowrap">
          {count === total ? `${count} items` : `${count} of ${total}`}
        </span>
        <select
          value={sortMode}
          onChange={(e) => onSortChange(e.target.value as SortMode)}
          className="bg-background-secondary border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-mint"
        >
          <option value="recent">Recently received</option>
          <option value="name">Name (A→Z)</option>
          <option value="collection">Collection</option>
        </select>
      </div>
    </div>
  );
}

// ─── Card wrapper that injects the collection name above the token ───
function NftCardWithCollection({
  token,
  metadata,
  isHidden,
  onToggleHide,
}: {
  token: FlatToken;
  metadata?: import("@/types/nft").NftMetadata;
  isHidden: boolean;
  onToggleHide: () => void;
}) {
  const { data: info } = useCollectionInfo(token.contract);
  const collectionName = info?.name || truncateAddress(token.contract, 4);

  return (
    <div className="group relative">
      <a
        href={`/collection/${token.contract}/${token.tokenId.toString()}`}
        className="block border border-border rounded-xl overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
      >
        <NftImage
          src={metadata?.image || ""}
          rawUri={metadata?.rawImageUri}
          alt={metadata?.name || `Token #${token.tokenId}`}
          className="aspect-square"
        />
        <div className="p-3 space-y-1">
          <div className="text-xs text-foreground-secondary truncate">
            {collectionName}
          </div>
          <div className="text-sm font-medium truncate">
            {metadata?.name || `#${token.tokenId.toString()}`}
          </div>
          {token.is1155 && token.balance && token.balance > 1n && (
            <div className="text-xs text-mint">x{token.balance.toString()}</div>
          )}
        </div>
      </a>

      {/* Hide / Unhide button. Hidden tokens always show "Unhide"; visible
          tokens show "Hide" on hover. Stops propagation so the parent link
          doesn't fire when clicked. */}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleHide();
        }}
        title={isHidden ? "Unhide" : "Hide"}
        className={`absolute top-2 right-2 px-2 py-1 rounded-md text-xs font-medium bg-background/90 backdrop-blur border border-border transition-opacity ${
          isHidden
            ? "opacity-100 text-mint hover:bg-mint/10"
            : "opacity-0 group-hover:opacity-100 text-foreground hover:bg-danger/10 hover:text-danger"
        }`}
      >
        {isHidden ? "Unhide" : "Hide"}
      </button>
    </div>
  );
}

// ═══════════════════════════ LISTED TAB ═══════════════════════════

function ListedTab({ address }: { address: `0x${string}` }) {
  const { address: connectedAddress } = useAccount();
  const isOwn = connectedAddress?.toLowerCase() === address.toLowerCase();

  // Fetch all listings and filter by seller address
  const [page, setPage] = useState(0);
  const { data, isLoading } = useAllListings(page);

  const userListings =
    data?.listings.filter(
      (l) => l.seller.toLowerCase() === address.toLowerCase()
    ) || [];

  return (
    <div>
      {isLoading ? (
        <NftGrid loading={true} empty={false}>
          {[]}
        </NftGrid>
      ) : userListings.length === 0 ? (
        <div className="py-12 text-center text-foreground-secondary">
          <p className="text-sm">No active listings</p>
        </div>
      ) : (
        <div className="space-y-3">
          {userListings.map((listing) => (
            <ListingRow
              key={listing.listingId.toString()}
              listingId={listing.listingId}
              nftContract={listing.nftContract}
              tokenId={listing.tokenId}
              price={listing.price}
              timestamp={listing.timestamp}
              isERC1155={listing.isERC1155}
              showCancel={isOwn}
            />
          ))}
        </div>
      )}

      {(data?.total || 0) > 20 && (
        <div className="flex justify-center gap-3 mt-6">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function ListingRow({
  listingId,
  nftContract,
  tokenId,
  price,
  timestamp,
  isERC1155,
  showCancel,
}: {
  listingId: bigint;
  nftContract: `0x${string}`;
  tokenId: bigint;
  price: bigint;
  timestamp: bigint;
  isERC1155: boolean;
  showCancel: boolean;
}) {
  const { data: metadata } = useNftMetadata(nftContract, tokenId, isERC1155);
  const { browseChainId } = useBrowseChain();
  const symbol = getNativeSymbol(browseChainId);

  return (
    <div className="flex items-center justify-between px-4 py-3 border border-border rounded-lg">
      <div className="flex items-center gap-3">
        <a
          href={`/collection/${nftContract}/${tokenId.toString()}`}
          className="text-sm text-mint hover:underline"
        >
          {metadata?.name || `#${tokenId.toString()}`}
        </a>
        <span className="text-xs text-foreground-secondary font-mono">
          {truncateAddress(nftContract)}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-mint font-medium">
          {formatPrice(price)} {symbol}
        </span>
        <span className="text-xs text-foreground-secondary">
          {timeAgo(timestamp)}
        </span>
        {showCancel && <CancelListingButton listingId={listingId} />}
      </div>
    </div>
  );
}

// ═══════════════════════════ BIDS TAB ═══════════════════════════

function BidsTab({ address }: { address: `0x${string}` }) {
  return (
    <div className="py-12 text-center text-foreground-secondary">
      <p className="text-sm">
        Bid tracking requires scanning specific collections.
      </p>
      <p className="text-sm mt-1">
        Visit a{" "}
        <a href="/explore" className="text-mint hover:underline">
          collection
        </a>{" "}
        to see and manage your bids on specific tokens.
      </p>
    </div>
  );
}

// ═══════════════════════════ OFFERS TAB ═══════════════════════════

function OffersTab({ address }: { address: `0x${string}` }) {
  return (
    <div className="py-12 text-center text-foreground-secondary">
      <p className="text-sm">
        Offer tracking requires scanning specific collections.
      </p>
      <p className="text-sm mt-1">
        Visit a{" "}
        <a href="/explore" className="text-mint hover:underline">
          collection
        </a>{" "}
        to see and manage your collection offers.
      </p>
    </div>
  );
}
