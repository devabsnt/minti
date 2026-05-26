"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import type { EnumerationState } from "@/hooks/useTraitEnumeration";
import type { TraitSelection } from "./TraitFilter";

interface EnumeratedTraitFilterProps {
  state: EnumerationState;
  selected: TraitSelection;
  onChange: (next: TraitSelection) => void;
}

/**
 * Topbar trait filter that consumes the client-side enumeration
 * state. Renders as a horizontal strip above the gallery:
 *
 *   [Status pill]   [Trait A v]  [Trait B v]  [Trait C v]   ...   [Clear]
 *
 * While enumeration is in progress, the status pill shows
 * "Fetching trait data... N%" and every trait dropdown is greyed
 * out / non-interactive. Once complete the pill disappears and the
 * dropdowns become live.
 *
 * Each trait dropdown is a popover with checkboxes. Selecting at
 * least one value filters the gallery to tokens that have that
 * value (within the trait type) and ALL selected trait types
 * across (AND across types, OR within a type).
 */
export function EnumeratedTraitFilter({
  state,
  selected,
  onChange,
}: EnumeratedTraitFilterProps) {
  const isLoading =
    state.status === "checking" || state.status === "enumerating";
  const isReady = state.status === "complete";
  const traitTypes = useMemo(
    () =>
      Object.keys(state.traitCounts).sort((a, b) =>
        a.localeCompare(b),
      ),
    [state.traitCounts],
  );

  const activeCount = Object.values(selected).reduce(
    (n, s) => n + s.size,
    0,
  );
  const clearAll = () => onChange({});

  // Don't render at all when enumeration produced nothing useful
  // (all_identical or failed with empty data). The collection gallery
  // would have nothing to filter and the empty bar reads as noise.
  if (
    !isLoading &&
    state.status !== "complete" &&
    traitTypes.length === 0
  ) {
    return null;
  }

  return (
    <div className="mb-6 stamp-shadow border border-border bg-background-secondary">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {isLoading ? (
          <span className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-background-tertiary border border-border">
            <Spinner />
            Fetching trait data... {Math.round(state.progress * 100)}%
          </span>
        ) : isReady && traitTypes.length > 0 ? (
          <span className="text-sm font-semibold mr-2">
            Filter by trait
          </span>
        ) : null}

        {traitTypes.map((traitType) => (
          <TraitDropdown
            key={traitType}
            traitType={traitType}
            values={state.traitCounts[traitType]}
            totalSupply={state.enumeratedCount || state.totalSupply}
            selected={selected[traitType] ?? new Set()}
            disabled={isLoading}
            onToggle={(value) => {
              const next: TraitSelection = { ...selected };
              const current = new Set(next[traitType] ?? []);
              if (current.has(value)) current.delete(value);
              else current.add(value);
              if (current.size === 0) delete next[traitType];
              else next[traitType] = current;
              onChange(next);
            }}
          />
        ))}

        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto text-xs text-mint hover:underline"
          >
            Clear ({activeCount})
          </button>
        )}
      </div>
    </div>
  );
}

function TraitDropdown({
  traitType,
  values,
  totalSupply,
  selected,
  disabled,
  onToggle,
}: {
  traitType: string;
  values: Record<string, number>;
  totalSupply: number;
  selected: Set<string>;
  disabled: boolean;
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Sort values rarest-first (lowest count).
  const sorted = useMemo(
    () =>
      Object.entries(values).sort((a, b) => {
        if (a[1] !== b[1]) return a[1] - b[1];
        return a[0].localeCompare(b[0]);
      }),
    [values],
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border transition-colors ${
          disabled
            ? "border-border bg-background-tertiary text-foreground-secondary/40 cursor-not-allowed"
            : selected.size > 0
              ? "border-mint/50 bg-mint/10 text-foreground"
              : "border-border bg-background hover:border-border-hover text-foreground"
        }`}
      >
        <span className="capitalize">{traitType}</span>
        {selected.size > 0 && (
          <span className="text-mint font-semibold">({selected.size})</span>
        )}
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
          aria-hidden
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 w-64 max-h-72 overflow-y-auto border border-border bg-background-secondary stamp-shadow">
          <ul className="divide-y divide-border">
            {sorted.map(([value, count]) => {
              const isSelected = selected.has(value);
              const pct = totalSupply > 0
                ? ((count / totalSupply) * 100).toFixed(1)
                : "0";
              return (
                <li key={value}>
                  <button
                    type="button"
                    onClick={() => onToggle(value)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-background-tertiary transition-colors ${
                      isSelected ? "text-mint" : "text-foreground"
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block w-3 h-3 border flex-shrink-0 ${
                          isSelected
                            ? "bg-mint border-mint"
                            : "border-border bg-transparent"
                        }`}
                      />
                      <span className="truncate">{value}</span>
                    </span>
                    <span className="text-foreground-secondary tabular-nums flex-shrink-0">
                      {count}
                      <span className="ml-1 opacity-60">({pct}%)</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      className="animate-spin text-mint"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M4 12a8 8 0 018-8"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Compute the list of tokenIds (as bigints) that pass the current
 * filter selection. AND across trait types, OR within a single trait
 * type. Returns null when no filter is active (caller should show
 * the unfiltered gallery in that case).
 */
export function filterIdsByEnumeration(
  state: EnumerationState,
  selected: TraitSelection,
): bigint[] | null {
  const entries = Object.entries(selected).filter(([, set]) => set.size > 0);
  if (entries.length === 0) return null;
  const matches: bigint[] = [];
  for (const [tokenIdStr, attrs] of Object.entries(state.tokenAttributes)) {
    let ok = true;
    for (const [traitType, values] of entries) {
      const matched = attrs.some(
        (a) => a.trait_type === traitType && values.has(a.value),
      );
      if (!matched) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(BigInt(tokenIdStr));
  }
  return matches;
}
