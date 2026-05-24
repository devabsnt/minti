"use client";

import { useCallback, useEffect, useState } from "react";
import { get, set } from "idb-keyval";

/**
 * Per-browser hide list. Stored in IndexedDB so it survives reloads.
 *
 * We intentionally keep this local-only — no aggregation, no global crowd
 * reports yet. If a user hides a collection, that decision is theirs and
 * doesn't affect anyone else. Phase-2 could surface "X others have hidden
 * this" via an on-chain attestation registry, but that's a separate design.
 *
 * Storage layout: one key per chain (`minti:hidden:<chainId>`) holding an
 * array of lowercased contract addresses.
 *
 * Usage:
 *   const { hidden, hide, unhide, isHidden } = useHiddenCollections(chainId);
 *   <button onClick={() => (isHidden(addr) ? unhide(addr) : hide(addr))}>
 *     {isHidden(addr) ? "Unhide" : "Hide"}
 *   </button>
 */

function storageKey(chainId: number): string {
  return `minti:hidden:${chainId}`;
}

export function useHiddenCollections(chainId: number) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setHidden(new Set());
    (async () => {
      try {
        const raw = await get<string[]>(storageKey(chainId));
        if (!cancelled) {
          setHidden(new Set(raw ?? []));
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const persist = useCallback(
    async (next: Set<string>) => {
      try {
        await set(storageKey(chainId), [...next]);
      } catch (err) {
        // Quota exhausted or private mode — UI gets to keep the in-memory
        // set, just won't survive reload. Acceptable degradation.
        console.warn("useHiddenCollections: persist failed", err);
      }
    },
    [chainId],
  );

  const hide = useCallback(
    (address: string) => {
      const norm = address.toLowerCase();
      setHidden((prev) => {
        if (prev.has(norm)) return prev;
        const next = new Set(prev);
        next.add(norm);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const unhide = useCallback(
    (address: string) => {
      const norm = address.toLowerCase();
      setHidden((prev) => {
        if (!prev.has(norm)) return prev;
        const next = new Set(prev);
        next.delete(norm);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const isHidden = useCallback(
    (address: string) => hidden.has(address.toLowerCase()),
    [hidden],
  );

  return { hidden, hide, unhide, isHidden, loaded };
}
