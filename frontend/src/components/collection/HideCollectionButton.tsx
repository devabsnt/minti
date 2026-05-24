"use client";

import { useHiddenCollections } from "@/hooks/useHiddenCollections";
import { useBrowseChain } from "@/providers/ChainProvider";

/**
 * Small "Hide" / "Unhide" toggle for a collection. Persists to IndexedDB
 * via {@link useHiddenCollections}. Affects what appears on /explore for
 * this browser only — no global side effects.
 */
export function HideCollectionButton({
  address,
}: {
  address: `0x${string}`;
}) {
  const { browseChainId } = useBrowseChain();
  const { isHidden, hide, unhide, loaded } = useHiddenCollections(browseChainId);
  if (!loaded) return null;
  const hidden = isHidden(address);
  return (
    <button
      type="button"
      onClick={() => (hidden ? unhide(address) : hide(address))}
      title={
        hidden
          ? "Unhide on /explore (this browser only)"
          : "Hide on /explore (this browser only)"
      }
      className="text-xs px-2 py-1 rounded-md border border-border text-foreground-secondary hover:border-mint/30 hover:text-foreground transition-colors"
    >
      {hidden ? "Unhide" : "Hide"}
    </button>
  );
}
