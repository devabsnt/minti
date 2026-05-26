"use client";

import Link from "next/link";
import { useState, type MouseEvent } from "react";
import { NftImage } from "./NftImage";
import { formatPrice, truncateAddress } from "@/lib/format";
import type { NftMetadata } from "@/types/nft";
import { useBrowseChain } from "@/providers/ChainProvider";
import { useNftMetadata } from "@/hooks/useNftMetadata";
import { getNativeSymbol } from "@/config/chains";

interface NftCardProps {
  contractAddress: string;
  tokenId: string;
  metadata?: NftMetadata;
  price?: bigint;
  seller?: string;
  /**
   * Optional left-click handler. When provided, the parent typically
   * calls e.preventDefault() and opens the token detail in a modal
   * overlay instead of navigating. Right-click / middle-click still
   * follow the href so "open in new tab" works.
   */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

export function NftCard({
  contractAddress,
  tokenId,
  metadata,
  price,
  seller,
  onClick,
}: NftCardProps) {
  const { browseChainId } = useBrowseChain();
  const symbol = getNativeSymbol(browseChainId);
  // Lazy real-metadata fallback. Stays disabled until the primary image
  // signals total failure. Covers the case where a collection's image
  // template has one extension baked in (`.png`) but some tokens are
  // a different format (`.gif`, `.mp4`) — fetching tokenURI gets us the
  // authoritative URL straight from the contract. Cards that load on
  // the first try pay nothing.
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const { data: fetchedMetadata } = useNftMetadata(
    primaryFailed ? (contractAddress as `0x${string}`) : undefined,
    primaryFailed ? BigInt(tokenId) : undefined,
  );
  const effectiveMetadata =
    primaryFailed && fetchedMetadata ? fetchedMetadata : metadata;
  const showingFallback = primaryFailed && !!fetchedMetadata;
  return (
    <Link
      href={`/collection/${contractAddress}/${tokenId}`}
      onClick={onClick}
      className="group block border border-border overflow-hidden bg-background-secondary hover:border-border-hover transition-colors"
    >
      <NftImage
        // Force remount when we swap from synthesized to fetched URL so
        // gateway state / "all failed" placeholder resets cleanly.
        key={showingFallback ? "fallback" : "primary"}
        src={effectiveMetadata?.image || ""}
        rawUri={effectiveMetadata?.rawImageUri}
        alt={effectiveMetadata?.name || `Token #${tokenId}`}
        className="aspect-square"
        onAllFailed={primaryFailed ? undefined : () => setPrimaryFailed(true)}
      />

      <div className="p-4 space-y-2">
        <div className="truncate text-sm font-semibold">
          {effectiveMetadata?.name || `#${tokenId}`}
        </div>

        <div className="flex items-center justify-between gap-2">
          {price != null && price > 0n ? (
            <div className="text-sm">
              <span className="font-medium">{formatPrice(price)}</span>
              <span className="text-foreground-secondary ml-1.5">{symbol}</span>
            </div>
          ) : (
            <span className="text-xs text-foreground-secondary">Not listed</span>
          )}

          {seller && (
            <span className="text-xs text-foreground-secondary truncate">
              {truncateAddress(seller)}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
