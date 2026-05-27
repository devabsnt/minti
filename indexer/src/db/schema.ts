import {
  pgTable,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
  real,
  timestamp,
  smallint,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Schema source of truth. Run `npm run db:push` to sync to Postgres
 * during development; `npm run db:generate` for proper migrations later.
 *
 * BigInts that come from the chain (tokenIds, prices, supplies) are
 * stored as text — Postgres bigint maxes out at 2^63 while ERC standards
 * allow 2^256 token IDs. Text + cast-on-read is safer than truncating.
 */

// ── collections ────────────────────────────────────────────────────
export const collections = pgTable("collections", {
  address: text("address").primaryKey(), // lowercased
  name: text("name"),
  symbol: text("symbol"),
  totalSupply: text("total_supply"),
  is721: boolean("is_721").notNull().default(false),
  is1155: boolean("is_1155").notNull().default(false),
  firstSeenBlock: integer("first_seen_block"),

  // Metadata precheck — ported from scripts/lib/precheck.mjs
  metadataChecked: boolean("metadata_checked").notNull().default(false),
  metadataBroken: boolean("metadata_broken").notNull().default(false),
  tokenUriTemplate: text("token_uri_template"),
  sampleImageUrl: text("sample_image_url"),
  imageUrlTemplate: text("image_url_template"),
  isOnChainMetadata: boolean("is_on_chain_metadata").notNull().default(false),

  // Tier — 0 hidden, 1 indexed, 2 explore-eligible, 3 curated
  tier: smallint("tier").notNull().default(1),

  // Aggregate stats; refreshed periodically
  transferCount: integer("transfer_count").notNull().default(0),
  mintCount: integer("mint_count").notNull().default(0),
  uniqueHolders: integer("unique_holders").notNull().default(0),
  uniqueSenders: integer("unique_senders").notNull().default(0),
  // Distinct wallets that received at least one mint event. Used to
  // dampen mint contribution in the trending score: 500 mints to 500
  // wallets is genuine launch demand; 500 mints to 1 wallet is a
  // single farmer.
  uniqueMinters: integer("unique_minters").notNull().default(0),
  // Holder-concentration metrics, fraction in [0, 1]. Computed from the
  // tokens table per (contract, owner). Used to penalize the trending
  // score for collections where supply is heavily concentrated in a
  // small number of wallets (a strong gaming signal: airdroppers /
  // farmers / single-wallet whales).
  top1HolderPct: real("top1_holder_pct").notNull().default(0),
  top10HolderPct: real("top10_holder_pct").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tierIdx: index("collections_tier_idx").on(t.tier),
  nameIdx: index("collections_name_idx").on(t.name),
}));

// ── tokens ─────────────────────────────────────────────────────────
export const tokens = pgTable("tokens", {
  contract: text("contract").notNull(),
  tokenId: text("token_id").notNull(),
  owner: text("owner"), // lowercased; nullable until first Transfer captured
  imageUrl: text("image_url"),
  name: text("name"),
  description: text("description"),
  metadataJson: jsonb("metadata_json"),
  attributes: jsonb("attributes"), // array of { trait_type, value }
  lastTransferBlock: integer("last_transfer_block"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.contract, t.tokenId] }),
  ownerIdx: index("tokens_owner_idx").on(t.owner),
  // Removed `tokens_contract_idx` — redundant with the composite PK
  // (Postgres uses the PK index for `WHERE contract = X` queries since
  // `contract` is the leading column). Saves ~1 GB.
}));

// ── on-chain activity (event log) ──────────────────────────────────
export const activity = pgTable("activity", {
  txHash: text("tx_hash").notNull(),
  logIndex: integer("log_index").notNull(),
  eventType: text("event_type").notNull(), // 'transfer' | 'mint' | 'burn' | 'sale' | 'listing' | 'bid' | ...
  contract: text("contract").notNull(),
  tokenId: text("token_id"),
  fromAddr: text("from_addr"),
  toAddr: text("to_addr"),
  price: text("price"), // wei as string for sales/listings
  blockNumber: integer("block_number").notNull(),
  timestamp: timestamp("timestamp").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.txHash, t.logIndex] }),
  contractIdx: index("activity_contract_idx").on(t.contract, t.blockNumber),
  blockIdx: index("activity_block_idx").on(t.blockNumber),
  // Removed `activity_from_idx` and `activity_to_idx` — neither was wired
  // to any API endpoint and they were costing ~3-4 GB combined. Add back
  // when we surface "wallet's transfer history" queries.
}));

// ── crawler bookkeeping ────────────────────────────────────────────
// Tracks "last block successfully processed" per event topic so the
// poll loop knows where to resume after restarts.
export const crawlerState = pgTable("crawler_state", {
  topic: text("topic").primaryKey(), // 'transfers' | 'marketplace_sales' | 'marketplace_listings' | ...
  lastBlockProcessed: integer("last_block_processed").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── collection_traits ──────────────────────────────────────────────
// Dictionary-encoded trait manifest per collection. Built once by the
// trait worker, served by `/api/collections/:address/traits`, and
// consumed by the frontend filter UI without any client-side
// enumeration. Format is intentionally the same shape as the EVMFS
// `IndexManifest` the frontend already decodes, with one extra layer:
// each token's attribute values are stored as integer indices into a
// per-trait-type value dictionary, so the on-disk footprint is tiny
// (~5-15 KB per collection after Postgres TOAST compression).
//
// Resume: the worker checkpoints `lastEnumeratedTokenId` after each
// chunk so a Railway restart picks up where it left off instead of
// re-fetching a 10K-token collection from scratch.
export const collectionTraits = pgTable("collection_traits", {
  // Lowercased contract address. FK-like to collections.address but we
  // don't enforce a constraint — collections can be pruned without us
  // needing to immediately clean this up.
  contract: text("contract").primaryKey(),
  // Lifecycle:
  //   pending   — queued, not yet started
  //   partial   — checkpointed mid-enumeration (resumable)
  //   complete  — every token enumerated, manifest serves real data
  //   failed    — too many host failures; will retry on next backoff
  //   all_identical — every token has the same attribute set, filter
  //                   UI doesn't render. Still "done" — won't re-run.
  status: text("status").notNull().default("pending"),
  // totalSupply at enumeration time. If the chain's current supply
  // exceeds this, the worker re-enumerates the new tokens.
  totalSupply: text("total_supply"),
  // How many tokens we've actually pulled attributes for (independent
  // of totalSupply when status='partial' or when some tokens 404'd).
  tokenCount: integer("token_count").notNull().default(0),
  // The manifest. Shape:
  //   {
  //     traitTypes: string[],
  //     traitValues: string[][],      // [traitIdx][valueIdx] -> value
  //     traits: Array<{ id: string, t: number[] }>  // tokenId -> value indices
  //   }
  // -1 in `t[i]` means "this token doesn't have trait i". Stored as
  // jsonb; Postgres TOAST-compresses the repeating-integer payload.
  manifest: jsonb("manifest"),
  // Sampled (tokenId, tokenURI) pairs for reveal detection. On every
  // refresh, we re-call tokenURI() for these IDs and compare; mismatch
  // means the collection was re-revealed and we re-enumerate.
  sampledTokenURIs: jsonb("sampled_token_uris"),
  // Resume checkpoint. Stored as text to match tokens.tokenId's type
  // (collections can use IDs up to 2^256). Null until first chunk.
  lastEnumeratedTokenId: text("last_enumerated_token_id"),
  // Backoff bookkeeping for collections whose host is dead/flaky.
  // Incremented on each failed attempt, reset to 0 on success.
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at"),
  enumeratedAt: timestamp("enumerated_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // Worker selects on (status, nextAttemptAt) to pick up rows ready to
  // process. Composite index makes that scan a single seek.
  statusIdx: index("collection_traits_status_idx").on(t.status, t.nextAttemptAt),
}));
