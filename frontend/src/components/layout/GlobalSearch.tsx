"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";
import {
  useCollectionsIndex,
  searchIndex,
  type IndexedCollection,
} from "@/hooks/useCollectionsIndex";
import { useDebounce } from "@/hooks/useDebounce";
import { useRegisteredCollections } from "@/hooks/useRegistry";
import { formatCompact, truncateAddress } from "@/lib/format";

/**
 * Global collection search — header autocomplete.
 *
 * Behaviour:
 *   - Empty query: closed, no popover
 *   - 0x address: jumps directly on Enter (no popover needed)
 *   - Name fragment: opens popover with top matches from snapshot
 *   - "/" anywhere on the page focuses the input (so long as the user
 *     isn't already typing in another field)
 *   - Arrow keys navigate suggestions, Enter selects, Esc closes
 *
 * Verified registry collections are pinned above long-tail matches with a
 * `verified` badge so impersonators don't out-rank the real one.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [hoverIndex, setHoverIndex] = useState(0);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const debounced = useDebounce(value.trim(), 120);
  const { data: index } = useCollectionsIndex();
  const { data: registryData } = useRegisteredCollections(0);

  const isAddrInput = isAddress(value.trim());

  const results = useMemo(() => {
    if (!debounced || debounced.length < 2 || isAddress(debounced)) return [];
    const matches: SearchHit[] = [];

    // 1. Verified registry hits (pin to top)
    const lower = debounced.toLowerCase();
    if (registryData?.collections) {
      for (const r of registryData.collections) {
        if (
          r.name.toLowerCase().includes(lower) ||
          r.symbol.toLowerCase().includes(lower)
        ) {
          matches.push({
            address: r.nftContract,
            name: r.name,
            symbol: r.symbol,
            holders: null,
            verified: true,
          });
        }
      }
    }

    // 2. Long-tail snapshot hits
    const verifiedAddrs = new Set(matches.map((m) => m.address.toLowerCase()));
    const verifiedNames = new Set(matches.map((m) => m.name.toLowerCase()));
    const indexHits = searchIndex(index, {
      query: debounced,
      limit: 30,
      sortKey: "trending",
      window: "7d",
    });
    for (const c of indexHits) {
      const addr = c.address.toLowerCase();
      if (verifiedAddrs.has(addr)) continue;
      if (c.name && verifiedNames.has(c.name.toLowerCase())) continue;
      matches.push({
        address: c.address,
        name: c.name || truncateAddress(c.address),
        symbol: c.symbol || "",
        holders: c.uniqueHolders ?? null,
        verified: false,
      });
      if (matches.length >= 8) break;
    }
    return matches;
  }, [debounced, index, registryData]);

  const open = focused && (results.length > 0 || (debounced.length >= 2 && !isAddrInput));

  // Reset hover when results change
  useEffect(() => setHoverIndex(0), [results]);

  // "/" focus shortcut. Doesn't fire when the user is already typing.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes the popover
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setFocused(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const jump = useCallback(
    (address: string) => {
      setValue("");
      setFocused(false);
      router.push(`/collection/${address}`);
    },
    [router],
  );

  const handleEnter = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (isAddress(trimmed)) {
      jump(trimmed);
      return;
    }
    if (results.length > 0) {
      jump(results[hoverIndex]?.address || results[0].address);
      return;
    }
    setError(true);
    setTimeout(() => setError(false), 1500);
  }, [value, results, hoverIndex, jump]);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleEnter();
      } else if (e.key === "Escape") {
        setFocused(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHoverIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHoverIndex((i) => Math.max(i - 1, 0));
      }
    },
    [handleEnter, results.length],
  );

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={onKey}
          placeholder="Search by name or 0x address. Press /"
          aria-label="Search collections"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? "global-search-results" : undefined}
          className={`w-full h-9 px-3 pr-9 text-sm bg-background-secondary border rounded-lg placeholder:text-foreground-secondary/50 focus:outline-none focus:border-mint/50 transition-colors ${
            error ? "border-danger" : "border-border"
          }`}
        />
        <button
          type="button"
          onClick={handleEnter}
          aria-label="Search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-secondary hover:text-mint transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {open && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute top-full mt-2 left-0 right-0 max-h-[60vh] overflow-y-auto border border-border bg-background rounded-lg shadow-lg shadow-black/30 z-50"
        >
          {results.length === 0 ? (
            <div className="px-3 py-4 text-xs text-foreground-secondary text-center">
              No matches. Try a contract address.
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.address}
                role="option"
                aria-selected={i === hoverIndex}
                onMouseEnter={() => setHoverIndex(i)}
                onClick={() => jump(r.address)}
                className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
                  i === hoverIndex
                    ? "bg-background-secondary"
                    : "hover:bg-background-secondary/60"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{r.name}</span>
                    {r.verified && (
                      <span
                        className="text-mint text-xs"
                        title="Verified by minti.art"
                      >
                        ✓
                      </span>
                    )}
                    {r.symbol && (
                      <span className="text-xs text-foreground-secondary">
                        {r.symbol}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground-secondary font-mono truncate">
                    {truncateAddress(r.address)}
                  </div>
                </div>
                {r.holders != null && r.holders > 0 && (
                  <div className="text-[11px] text-foreground-secondary flex-shrink-0">
                    {formatCompact(r.holders)} holders
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface SearchHit {
  address: string;
  name: string;
  symbol: string;
  holders: number | null;
  verified: boolean;
}
