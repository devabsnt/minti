/**
 * Thin client for the minti-indexer API. Returns parsed JSON, raises
 * on non-2xx. Used by the `useApi*` hooks in src/hooks/.
 *
 * Configure via NEXT_PUBLIC_INDEXER_URL env var (set in Vercel project
 * settings + local .env.local). Defaults to localhost for dev.
 */

const INDEXER_URL =
  (process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:8080").replace(/\/$/, "");

export class IndexerApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "IndexerApiError";
  }
}

export async function indexerFetch<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  init?: RequestInit,
): Promise<T> {
  const url = new URL(path, INDEXER_URL + "/");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const resp = await fetch(url.toString(), init);
  if (!resp.ok) {
    let detail = "";
    try {
      const body = await resp.text();
      detail = body.length > 200 ? body.slice(0, 200) + "…" : body;
    } catch {
      // ignore
    }
    throw new IndexerApiError(resp.status, `Indexer ${resp.status}: ${detail || resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

// ── shared types matching the indexer's API shapes ───────────────

export interface ApiCollection {
  address: string;
  name: string | null;
  symbol: string | null;
  totalSupply: string | null;
  is721: boolean;
  is1155: boolean;
  firstSeenBlock: number | null;
  metadataChecked: boolean;
  metadataBroken: boolean;
  tokenUriTemplate: string | null;
  sampleImageUrl: string | null;
  imageUrlTemplate: string | null;
  isOnChainMetadata: boolean;
  tier: 0 | 1 | 2 | 3;
  transferCount: number;
  mintCount: number;
  uniqueHolders: number;
  uniqueSenders: number;
  createdAt: string; // ISO date string
  updatedAt: string;
}

export interface ApiToken {
  contract: string;
  tokenId: string;
  owner: string | null;
  imageUrl: string | null;
  name: string | null;
  description: string | null;
  metadataJson: unknown;
  attributes: unknown;
  lastTransferBlock: number | null;
  updatedAt: string;
}

export interface ApiActivity {
  txHash: string;
  logIndex: number;
  eventType: "transfer" | "mint" | "burn" | "sale" | "listing" | string;
  contract: string;
  tokenId: string | null;
  fromAddr: string | null;
  toAddr: string | null;
  price: string | null;
  blockNumber: number;
  timestamp: string;
}

export interface ApiPagination {
  limit?: number;
  offset?: number;
  page?: number;
  pageSize?: number;
  total: number;
}

export interface ApiCollectionsResponse {
  collections: ApiCollection[];
  pagination: ApiPagination;
}

export interface ApiCollectionResponse {
  collection: ApiCollection;
}

export interface ApiTokensResponse {
  tokens: ApiToken[];
  pagination: ApiPagination;
}

export interface ApiActivityResponse {
  activity: ApiActivity[];
}
