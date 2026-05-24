"use client";

import Link from "next/link";

import { useTokenViewerUri } from "@/hooks/useTokenViewerUri";
import { useEvmfsTokenMetadata } from "@/hooks/useEvmfsMetadata";
import { formatPrice, truncateAddress } from "@/lib/format";
import type { EvmfsContract } from "@/lib/evmfs";
import { useBrowseChain } from "@/providers/ChainProvider";
import { getNativeSymbol } from "@/config/chains";

interface EvmfsTokenCardProps {
  contractAddress: `0x${string}`;
  tokenId: bigint;
  metadataManifest: `0x${string}`;
  metadataBlock: bigint | number;
  evmfsContract?: EvmfsContract;
  price?: bigint;
  seller?: string;
}

export function EvmfsTokenCard({
  contractAddress,
  tokenId,
  metadataManifest,
  metadataBlock,
  evmfsContract,
  price,
  seller,
}: EvmfsTokenCardProps) {
  const { browseChainId } = useBrowseChain();
  const symbol = getNativeSymbol(browseChainId);
  const { data: viewerUri } = useTokenViewerUri(
    metadataManifest,
    metadataBlock,
    tokenId
  );
  const { data: metadata } = useEvmfsTokenMetadata(
    metadataManifest,
    metadataBlock,
    tokenId,
    evmfsContract
  );

  return (
    <Link
      href={`/collection/${contractAddress}/${tokenId}`}
      className="group border border-border rounded-xl overflow-hidden bg-background-secondary hover:border-mint/30 transition-all hover:shadow-lg hover:shadow-mint-glow"
    >
      <div className="aspect-square bg-background-tertiary">
        {viewerUri ? (
          <iframe
            src={viewerUri}
            title={`Token #${tokenId}`}
            sandbox="allow-scripts"
            className="w-full h-full border-0 pointer-events-none"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-mint/5 to-transparent" />
        )}
      </div>

      <div className="p-3 space-y-2">
        <div className="truncate text-sm font-medium">
          {metadata?.name || `#${tokenId.toString()}`}
        </div>

        <div className="flex items-center justify-between">
          {price != null && price > 0n ? (
            <div className="text-sm">
              <span className="text-mint font-medium">{formatPrice(price)}</span>
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
