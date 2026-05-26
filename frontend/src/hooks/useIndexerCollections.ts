"use client";

import { useQuery } from "@tanstack/react-query";
import {
  indexerFetch,
  type ApiCollection,
  type ApiCollectionResponse,
  type ApiCollectionsResponse,
  type ApiActivityResponse,
  type ApiTokensResponse,
  type ApiSparklineResponse,
} from "@/lib/indexerApi";

/**
 * React-query hooks over the minti-indexer API. These are the live
 * counterparts to the old `useCollectionsIndex` + `useTrendingLive`
 * static-snapshot hooks — same shape of data, but always-fresh and
 * server-filtered/sorted/paginated instead of client-side wrangling.
 *
 * Stale times are generous because the indexer is itself only as fresh
 * as its poll loop (10s). Re-fetching faster than that is wasted.
 */

const STALE_TIME = 30 * 1000; // 30s

export type SortKey = "trending" | "holders" | "newest" | "name";

export interface UseCollectionsParams {
  tier?: number;
  sort?: SortKey;
  limit?: number;
  offset?: number;
  q?: string;
  enabled?: boolean;
}

/**
 * Paginated collection list. Drop-in replacement for the explore page's
 * combined `useCollectionsIndex` + `useTrendingLive` + `searchIndex`
 * pipeline. Filtering/sorting happens server-side via SQL — way faster
 * than the previous "ship 44MB JSON, dedupe + sort in browser" approach.
 */
export function useIndexerCollections(params: UseCollectionsParams = {}) {
  const { tier = 2, sort = "trending", limit = 50, offset = 0, q, enabled = true } = params;
  return useQuery({
    queryKey: ["indexer-collections", tier, sort, limit, offset, q],
    enabled,
    staleTime: STALE_TIME,
    queryFn: () =>
      indexerFetch<ApiCollectionsResponse>("api/collections", {
        tier,
        sort,
        limit,
        offset,
        q,
      }),
  });
}

/** Single collection by address. Used by the collection detail page. */
export function useIndexerCollection(address: string | undefined) {
  return useQuery({
    queryKey: ["indexer-collection", address?.toLowerCase()],
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    staleTime: STALE_TIME,
    queryFn: () =>
      indexerFetch<ApiCollectionResponse>(`api/collections/${address!.toLowerCase()}`),
  });
}

/** Paginated tokens for a collection. */
export function useIndexerCollectionTokens(
  address: string | undefined,
  page = 0,
  pageSize = 50,
) {
  return useQuery({
    queryKey: ["indexer-collection-tokens", address?.toLowerCase(), page, pageSize],
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    staleTime: STALE_TIME,
    queryFn: () =>
      indexerFetch<ApiTokensResponse>(`api/collections/${address!.toLowerCase()}/tokens`, {
        page,
        pageSize,
      }),
  });
}

/** Recent activity for a collection. */
export function useIndexerCollectionActivity(
  address: string | undefined,
  limit = 50,
) {
  return useQuery({
    queryKey: ["indexer-collection-activity", address?.toLowerCase(), limit],
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    staleTime: STALE_TIME,
    queryFn: () =>
      indexerFetch<ApiActivityResponse>(`api/collections/${address!.toLowerCase()}/activity`, {
        limit,
      }),
  });
}

/**
 * Hourly activity buckets for the last N hours. Drives the trending
 * podium's inline sparkline. Stays fresh for a couple of minutes since
 * the underlying counts shift continuously.
 */
export function useCollectionSparkline(
  address: string | undefined,
  hours = 24,
) {
  return useQuery({
    queryKey: ["indexer-collection-sparkline", address?.toLowerCase(), hours],
    enabled: !!address && /^0x[0-9a-fA-F]{40}$/.test(address),
    staleTime: 2 * 60 * 1000,
    queryFn: () =>
      indexerFetch<ApiSparklineResponse>(
        `api/collections/${address!.toLowerCase()}/sparkline`,
        { hours },
      ),
  });
}

export type { ApiCollection };
