"use client";

import { useEffect, useState } from "react";

/**
 * Debounce a value — only commit the latest after `delayMs` has passed
 * with no further updates. Useful for filtering large lists from a text
 * input where every keystroke would otherwise trigger expensive work.
 *
 * Example:
 *   const [query, setQuery] = useState("");
 *   const debouncedQuery = useDebounce(query, 150);
 *   const results = useMemo(() => filter(items, debouncedQuery), [items, debouncedQuery]);
 *
 * The first render returns `value` unchanged so initial paint isn't delayed.
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
