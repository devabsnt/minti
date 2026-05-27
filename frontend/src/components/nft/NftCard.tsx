"use client";

import Link from "next/link";
import { type MouseEvent } from "react";
import { NftImage } from "./NftImage";
import { formatPrice, truncateAddress } from "@/lib/format";
import type { NftMetadata } from "@/types/nft";
import { useBrowseChain } from "@/providers/ChainProvider";
import { getNativeSymbol } from "@/config/chains";
import {
  usePageTurnSound,
  usePaperHoverSound,
} from "@/providers/SoundProvider";

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
  // Image fallbacks are now handled entirely inside NftImage: extension
  // probing + IPFS gateway laddering covers the recoverable cases. A
  // total NftImage failure means the metadata's image URL itself is
  // dead, and re-fetching the same metadata wouldn't help — it would
  // just hand back the same dead URL. The old metadata-retry path here
  // doubled RPC pressure on collections that were already failing.
  const effectiveMetadata = metadata;
  const playPageTurn = usePageTurnSound();
  const playPaperHover = usePaperHoverSound();
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    // Page-turn on a plain left click. Modifier clicks (cmd / ctrl /
    // shift / middle for new tab) skip the sound so we don't startle
    // the user with audio on their current tab.
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      playPageTurn();
    }
  };
  return (
    <Link
      href={`/collection/${contractAddress}/${tokenId}`}
      onClick={handleClick}
      onPointerEnter={playPaperHover}
      className="stamp-shadow group block border border-border overflow-hidden bg-background-secondary hover:border-border-hover transition-colors"
    >
      <NftImage
        src={effectiveMetadata?.image || ""}
        rawUri={effectiveMetadata?.rawImageUri}
        alt={effectiveMetadata?.name || `Token #${tokenId}`}
        className="aspect-square"
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

          {seller &&
            seller.toLowerCase() !==
              "0x0000000000000000000000000000000000000000" && (
              <span className="text-xs text-foreground-secondary truncate">
                {truncateAddress(seller)}
              </span>
            )}
        </div>
      </div>
    </Link>
  );
}
