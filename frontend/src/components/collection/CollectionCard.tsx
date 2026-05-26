"use client";

import Link from "next/link";
import { useTokenViewerUri } from "@/hooks/useTokenViewerUri";
import { truncateAddress, formatNumber } from "@/lib/format";
import { evmfsLabel } from "@/lib/evmfs";
import { CollectionKind, isEvmfsKind, kindLabel } from "@/lib/abi/EVMFSCollectionRegistry";
import type { RegisteredCollection } from "@/hooks/useRegistry";
import {
  usePageTurnSound,
  usePaperHoverSound,
} from "@/providers/SoundProvider";

interface CollectionCardProps {
  collection: RegisteredCollection;
}

export function CollectionCard({ collection }: CollectionCardProps) {
  const supply = Number(collection.totalSupply);
  const previewTokenId = supply > 0 ? 1 : 0;
  const evmfs = isEvmfsKind(collection.kind);
  const playPageTurn = usePageTurnSound();
  const playPaperHover = usePaperHoverSound();

  return (
    <Link
      href={`/collection/${collection.nftContract}`}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
          playPageTurn();
        }
      }}
      onPointerEnter={playPaperHover}
      className="stamp-shadow group block border border-border overflow-hidden bg-background-secondary hover:border-border-hover transition-colors"
    >
      <div className="aspect-square bg-background-tertiary">
        {evmfs && previewTokenId > 0 ? (
          <CollectionThumbnail collection={collection} tokenId={previewTokenId} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-foreground-secondary text-xs">
            {supply > 0 ? "Preview unavailable" : "No tokens yet"}
          </div>
        )}
      </div>

      <div className="p-3 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 truncate">
            <span className="truncate text-sm font-medium">{collection.name}</span>
            {collection.verified && (
              <span
                title="Verified"
                aria-label="Verified"
                className="text-mint shrink-0"
              >
                ✓
              </span>
            )}
          </div>
          <KindBadges collection={collection} />
        </div>
        <div className="flex items-center justify-between text-xs text-foreground-secondary">
          <span>{collection.symbol}</span>
          <span>{formatNumber(supply)} supply</span>
        </div>
        <div className="text-[11px] text-foreground-secondary truncate">
          by {truncateAddress(collection.creator)}
        </div>
        {collection.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {collection.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] text-foreground-secondary border border-border rounded px-1.5 py-0.5"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function KindBadges({ collection }: { collection: RegisteredCollection }) {
  const { kind } = collection;
  if (isEvmfsKind(kind)) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-mint border border-mint/30 rounded px-1.5 py-0.5">
          EVMFS
        </span>
        <span className="text-[10px] uppercase tracking-wider text-foreground-secondary/70 border border-border rounded px-1 py-0.5">
          {evmfsLabel(collection.evmfsContract)}
        </span>
      </div>
    );
  }
  if (kind === CollectionKind.ON_CHAIN_DATA_URI) {
    return (
      <span className="text-[10px] uppercase tracking-wider text-sky-300 border border-sky-300/40 rounded px-1.5 py-0.5 shrink-0">
        on-chain
      </span>
    );
  }
  return (
    <span
      className="text-[10px] uppercase tracking-wider text-foreground-secondary/70 border border-border rounded px-1.5 py-0.5 shrink-0"
      title={kindLabel(kind)}
    >
      off-chain
    </span>
  );
}

function CollectionThumbnail({
  collection,
  tokenId,
}: {
  collection: RegisteredCollection;
  tokenId: number;
}) {
  const { data: uri } = useTokenViewerUri(
    collection.metadataManifest,
    collection.metadataBlock,
    BigInt(tokenId)
  );
  if (!uri) {
    return (
      <div className="w-full h-full bg-gradient-to-br from-mint/5 to-transparent" />
    );
  }
  return (
    <iframe
      src={uri}
      title={`${collection.name} #${tokenId}`}
      sandbox="allow-scripts"
      className="w-full h-full border-0 pointer-events-none"
      loading="lazy"
    />
  );
}
