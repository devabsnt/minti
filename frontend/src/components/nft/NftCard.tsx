"use client";

import Link from "next/link";
import { useState } from "react";
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
}

export function NftCard({
  contractAddress,
  tokenId,
  metadata,
  price,
  seller,
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
      className="group border border-border rounded-xl overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
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

      <div className="p-3 space-y-2">
        <div className="truncate text-sm font-medium">
          {effectiveMetadata?.name || `#${tokenId}`}
        </div>

        <div className="flex items-center justify-between">
          {price != null && price > 0n ? (
            <div className="text-sm">
              <span className="text-mint font-medium">
                {formatPrice(price)}
              </span>
              <span className="text-foreground-secondary ml-1">{symbol}</span>
            </div>
          ) : (
            <span className="text-xs text-foreground-secondary">Not listed</span>
          )}

          {seller && (
            <span className="text-xs text-foreground-secondary">
              {truncateAddress(seller)}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
