"use client";

import { useMemo } from "react";
import {
  useCollectionsIndex,
  collectionWarnings,
  type CollectionWarning,
  type IndexedCollection,
} from "@/hooks/useCollectionsIndex";

/**
 * Inline warnings strip for the collection page. Reads the latest snapshot
 * entry for this address and renders any warning signals (high holder
 * concentration, airdrop-heavy, etc.) as one-line callouts.
 *
 * Designed to be honest about risk without burying small/young collections:
 *   - `info` warnings render in muted gray
 *   - `warn` warnings render in amber
 *   - `alert` warnings render in red
 *
 * If the collection isn't in the snapshot yet (very fresh / sub-snapshot
 * threshold) the strip renders nothing.
 */
export function CollectionWarnings({
  contractAddress,
}: {
  contractAddress: `0x${string}`;
}) {
  const { data: index } = useCollectionsIndex();

  const entry: IndexedCollection | undefined = useMemo(() => {
    if (!index) return undefined;
    const lower = contractAddress.toLowerCase();
    return index.collections.find((c) => c.address.toLowerCase() === lower);
  }, [index, contractAddress]);

  const warnings: CollectionWarning[] = useMemo(
    () => (entry ? collectionWarnings(entry) : []),
    [entry],
  );

  if (warnings.length === 0) return null;

  return (
    <div className="mb-6 space-y-1.5">
      {warnings.slice(0, 4).map((w, i) => (
        <div
          key={`${w.kind}-${i}`}
          className={
            "flex items-center gap-2 text-xs px-3 py-2 rounded-lg border " +
            severityClasses(w.severity)
          }
        >
          <span aria-hidden>{severityIcon(w.severity)}</span>
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  );
}

function severityClasses(s: CollectionWarning["severity"]): string {
  if (s === "alert") return "border-danger/40 bg-danger/5 text-danger";
  if (s === "warn") return "border-amber-500/40 bg-amber-500/5 text-amber-400";
  return "border-border bg-background-secondary text-foreground-secondary";
}

function severityIcon(s: CollectionWarning["severity"]): string {
  if (s === "alert") return "⛔";
  if (s === "warn") return "⚠";
  return "ⓘ";
}
