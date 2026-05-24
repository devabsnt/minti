"use client";

import { useMemo, useState } from "react";

import type { IndexManifest } from "@/hooks/useIndexManifest";

export type TraitSelection = Record<string, Set<string>>;

interface TraitFilterProps {
  manifest: IndexManifest;
  selected: TraitSelection;
  onChange: (next: TraitSelection) => void;
}

/**
 * Sidebar of trait-type buckets, each expandable into a checkbox list of
 * distinct values found in the collection. Counts come from a single pass over
 * the index manifest at mount.
 */
export function TraitFilter({ manifest, selected, onChange }: TraitFilterProps) {
  const traitTypes = useMemo(() => manifest.traitTypes ?? [], [manifest]);

  const valueCounts = useMemo(() => {
    const buckets: Map<string, Map<string, number>> = new Map();
    traitTypes.forEach((t) => buckets.set(t, new Map()));
    for (const entry of manifest.traits) {
      for (let i = 0; i < traitTypes.length; i++) {
        const value = entry.t[i];
        if (!value) continue;
        const bucket = buckets.get(traitTypes[i])!;
        bucket.set(value, (bucket.get(value) ?? 0) + 1);
      }
    }
    return buckets;
  }, [manifest, traitTypes]);

  const toggle = (traitType: string, value: string) => {
    const next: TraitSelection = { ...selected };
    const current = new Set(next[traitType] ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    if (current.size === 0) {
      delete next[traitType];
    } else {
      next[traitType] = current;
    }
    onChange(next);
  };

  const clearAll = () => onChange({});

  const activeCount = Object.values(selected).reduce((n, s) => n + s.size, 0);

  if (traitTypes.length === 0) return null;

  return (
    <aside className="w-full md:w-60 shrink-0 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Filter by trait</h3>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-mint hover:underline"
          >
            Clear ({activeCount})
          </button>
        )}
      </div>

      <div className="space-y-1">
        {traitTypes.map((traitType) => {
          const bucket = valueCounts.get(traitType);
          if (!bucket || bucket.size === 0) return null;
          return (
            <TraitGroup
              key={traitType}
              traitType={traitType}
              values={bucket}
              selected={selected[traitType] ?? new Set()}
              onToggle={(value) => toggle(traitType, value)}
            />
          );
        })}
      </div>
    </aside>
  );
}

function TraitGroup({
  traitType,
  values,
  selected,
  onToggle,
}: {
  traitType: string;
  values: Map<string, number>;
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(selected.size > 0);
  const sorted = useMemo(
    () =>
      Array.from(values.entries()).sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      }),
    [values],
  );

  return (
    <div className="border border-border rounded-lg bg-background-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs uppercase tracking-wider text-foreground-secondary">
          {traitType}
        </span>
        <span className="text-xs text-foreground-secondary">
          {selected.size > 0 ? `${selected.size} selected` : `${values.size}`}
          <span className="ml-1 inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>›</span>
        </span>
      </button>
      {open && (
        <ul className="max-h-56 overflow-y-auto border-t border-border divide-y divide-border">
          {sorted.map(([value, count]) => {
            const isSelected = selected.has(value);
            return (
              <li key={value}>
                <button
                  type="button"
                  onClick={() => onToggle(value)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-background-tertiary ${
                    isSelected ? "text-mint" : "text-foreground"
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <span
                      className={`inline-block w-3 h-3 rounded border ${
                        isSelected
                          ? "bg-mint border-mint"
                          : "border-border bg-transparent"
                      }`}
                    />
                    <span className="truncate">{value}</span>
                  </span>
                  <span className="text-foreground-secondary tabular-nums">
                    {count}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Compute the token IDs from a manifest that match all selected trait values.
 * AND across trait types, OR within a single trait type.
 */
export function filterIdsBySelection(
  manifest: IndexManifest,
  selected: TraitSelection,
): bigint[] {
  const traitTypes = manifest.traitTypes ?? [];
  const entries = Object.entries(selected).filter(([, set]) => set.size > 0);
  if (entries.length === 0) return [];

  const indexByType = new Map(traitTypes.map((t, i) => [t, i]));

  const matches: bigint[] = [];
  for (const entry of manifest.traits) {
    let ok = true;
    for (const [traitType, values] of entries) {
      const idx = indexByType.get(traitType);
      if (idx === undefined) {
        ok = false;
        break;
      }
      const slot = entry.t[idx] ?? "";
      if (!values.has(slot)) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(BigInt(entry.id));
  }
  return matches;
}
