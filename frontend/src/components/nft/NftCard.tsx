"use client";

import Link from "next/link";
import { NftImage } from "./NftImage";
import { formatPrice, truncateAddress } from "@/lib/format";
import type { NftMetadata } from "@/types/nft";
import { useBrowseChain } from "@/providers/ChainProvider";
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
  return (
    <Link
      href={`/collection/${contractAddress}/${tokenId}`}
      className="group border border-border rounded-xl overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
    >
      <NftImage
        src={metadata?.image || ""}
        rawUri={metadata?.rawImageUri}
        alt={metadata?.name || `Token #${tokenId}`}
        className="aspect-square"
      />

      <div className="p-3 space-y-2">
        <div className="truncate text-sm font-medium">
          {metadata?.name || `#${tokenId}`}
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
