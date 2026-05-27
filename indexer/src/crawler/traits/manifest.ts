/**
 * Dictionary-encoded trait manifest builder.
 *
 * Shape (matches the EVMFS `IndexManifest` the frontend already decodes,
 * with one extra dictionary level for value strings):
 *
 *   {
 *     traitTypes:  ["Hat", "Eyes", "Background"],
 *     traitValues: [
 *       ["Crown", "Cap", "Hood"],          // values for "Hat"
 *       ["Lazer", "Normal"],               // values for "Eyes"
 *       ["Blue", "Red", "Green"]           // values for "Background"
 *     ],
 *     traits: [
 *       { id: "1", t: [0, 0, 0] },         // Crown, Lazer, Blue
 *       { id: "2", t: [1, 0, 1] },         // Cap, Lazer, Red
 *       { id: "3", t: [-1, 1, 2] }         // <no Hat>, Normal, Green
 *     ]
 *   }
 *
 * Each `t[i]` is the index of this token's value within
 * `traitValues[i]`. `-1` means the token doesn't have a value for that
 * trait type. The arrays are kept positionally aligned with traitTypes.
 *
 * Storage is small because:
 *   - Trait type names occur once per collection, not per token.
 *   - Value strings occur once per (trait, value) pair, not per token.
 *   - Per-token attributes become a fixed-length int array (typically
 *     5-15 small ints, ~10-40 bytes raw, compresses heavily).
 *
 * For a 3K-token collection with 10 trait types and ~200 unique values,
 * the manifest is roughly 30-60 KB raw and 5-15 KB after Postgres TOAST.
 *
 * The builder is incremental: callers `addToken()` as tokens arrive
 * (the worker fetches in waves), and `toJson()` returns the current
 * snapshot. New (traitType, value) pairs extend the dictionary lazily.
 */

export interface NormalizedAttribute {
  trait_type: string;
  value: string;
}

export interface SerializedManifest {
  traitTypes: string[];
  traitValues: string[][];
  traits: Array<{ id: string; t: number[] }>;
}

/**
 * Pull `{ trait_type, value }` pairs out of an arbitrary metadata JSON's
 * `attributes` field. Handles the common variants:
 *   - { trait_type, value }  — OpenSea standard
 *   - { traitType, value }   — some collections camelCase the field
 *   - { name, value }        — older spec
 *   - Bare values get filtered (no trait_type → can't filter on it)
 *   - Numeric values stringified for consistent indexing
 */
export function normalizeAttributes(raw: unknown): NormalizedAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedAttribute[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const traitTypeRaw = a.trait_type ?? a.traitType ?? a.name;
    const valueRaw = a.value;
    if (typeof traitTypeRaw !== "string" || traitTypeRaw.length === 0) continue;
    if (valueRaw == null) continue;
    // Coerce to string. Booleans become "true"/"false"; numbers become
    // their decimal form. Skip empty strings (some collections emit
    // `value: ""` placeholders).
    const value = String(valueRaw);
    if (value.length === 0) continue;
    out.push({ trait_type: traitTypeRaw, value });
  }
  return out;
}

export class ManifestBuilder {
  // traitType -> index in traitTypes
  private traitTypeIdx = new Map<string, number>();
  private traitTypes: string[] = [];
  // For each trait type (by index): valueString -> index in that trait's values array
  private valueIdxByTrait: Array<Map<string, number>> = [];
  // For each trait type (by index): list of values
  private traitValues: string[][] = [];
  // tokenId -> int[] aligned to traitTypes (extended with -1 as new types appear)
  private perToken = new Map<string, number[]>();

  /**
   * Number of distinct tokens in the manifest so far.
   */
  size(): number {
    return this.perToken.size;
  }

  /**
   * Whether a given tokenId has already been merged. Used by the worker
   * to skip re-fetching tokens that survived a checkpoint.
   */
  has(tokenId: string): boolean {
    return this.perToken.has(tokenId);
  }

  /**
   * Merge a token's normalized attributes into the manifest. Idempotent
   * within a single builder instance — re-adding the same tokenId
   * replaces its prior entry (no double-counting).
   */
  addToken(tokenId: string, attributes: NormalizedAttribute[]): void {
    // Extend the dictionary lazily for any new trait types / values.
    const indices: Array<number | undefined> = [];
    for (const attr of attributes) {
      let traitIdx = this.traitTypeIdx.get(attr.trait_type);
      if (traitIdx === undefined) {
        traitIdx = this.traitTypes.length;
        this.traitTypeIdx.set(attr.trait_type, traitIdx);
        this.traitTypes.push(attr.trait_type);
        this.valueIdxByTrait.push(new Map());
        this.traitValues.push([]);
      }
      const valueDict = this.valueIdxByTrait[traitIdx]!;
      const valueList = this.traitValues[traitIdx]!;
      let valueIdx = valueDict.get(attr.value);
      if (valueIdx === undefined) {
        valueIdx = valueList.length;
        valueDict.set(attr.value, valueIdx);
        valueList.push(attr.value);
      }
      indices[traitIdx] = valueIdx;
    }
    // Fill any positions this token doesn't have with -1 (sentinel for
    // "no value for this trait type on this token").
    const row = new Array<number>(this.traitTypes.length).fill(-1);
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i];
      if (v !== undefined) row[i] = v;
    }
    this.perToken.set(tokenId, row);
  }

  /**
   * Heuristic identical-set check used by the worker to flag
   * collections where every token has the same attribute signature
   * (pre-reveal, on-chain identical art, etc.). Returns true when
   * ≥95% of enumerated tokens share one signature. Cheaper than
   * comparing every pair: hash each token's int[] to a string and
   * count.
   */
  isMostlyIdentical(threshold = 0.95): boolean {
    if (this.perToken.size < 2) return false;
    const counts = new Map<string, number>();
    for (const row of this.perToken.values()) {
      const sig = row.join(",");
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    let maxCount = 0;
    for (const c of counts.values()) {
      if (c > maxCount) maxCount = c;
    }
    return maxCount / this.perToken.size >= threshold;
  }

  /**
   * Snapshot the current state as the persisted JSON shape. Tokens
   * are returned in numeric tokenId order so consecutive snapshots
   * diff predictably (helps Postgres TOAST compression by keeping
   * the on-disk byte sequence stable across checkpoint writes).
   */
  toJson(): SerializedManifest {
    // Before serializing, normalize every token's int[] to the current
    // traitTypes.length. Tokens that were added before a new trait
    // type was discovered have a shorter array; pad with -1.
    const width = this.traitTypes.length;
    const traits: Array<{ id: string; t: number[] }> = [];
    const ids = Array.from(this.perToken.keys()).sort((a, b) => {
      const an = safeNumeric(a);
      const bn = safeNumeric(b);
      if (an === null || bn === null) return a.localeCompare(b);
      return an - bn;
    });
    for (const id of ids) {
      const row = this.perToken.get(id)!;
      if (row.length === width) {
        traits.push({ id, t: row });
      } else {
        const padded = new Array<number>(width).fill(-1);
        for (let i = 0; i < row.length; i++) padded[i] = row[i]!;
        traits.push({ id, t: padded });
      }
    }
    return {
      traitTypes: [...this.traitTypes],
      traitValues: this.traitValues.map((v) => [...v]),
      traits,
    };
  }

  /**
   * Hydrate a builder from a previously-persisted manifest so the
   * worker can resume mid-collection without losing prior work.
   */
  static fromJson(snapshot: SerializedManifest | null | undefined): ManifestBuilder {
    const b = new ManifestBuilder();
    if (!snapshot) return b;
    for (let i = 0; i < snapshot.traitTypes.length; i++) {
      const type = snapshot.traitTypes[i]!;
      const values = snapshot.traitValues[i] ?? [];
      b.traitTypeIdx.set(type, i);
      b.traitTypes.push(type);
      const valueDict = new Map<string, number>();
      for (let v = 0; v < values.length; v++) {
        valueDict.set(values[v]!, v);
      }
      b.valueIdxByTrait.push(valueDict);
      b.traitValues.push([...values]);
    }
    for (const t of snapshot.traits ?? []) {
      b.perToken.set(t.id, [...t.t]);
    }
    return b;
  }
}

function safeNumeric(s: string): number | null {
  // Cheap numeric sort for typical 0..10000 tokenIds. Bail to lex sort
  // (caller's fallback) for absurdly large IDs.
  if (s.length > 10) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
