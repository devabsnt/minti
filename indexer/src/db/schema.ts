import {
  pgTable,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
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
  contractIdx: index("tokens_contract_idx").on(t.contract),
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
  fromIdx: index("activity_from_idx").on(t.fromAddr),
  toIdx: index("activity_to_idx").on(t.toAddr),
  blockIdx: index("activity_block_idx").on(t.blockNumber),
}));

// ── crawler bookkeeping ────────────────────────────────────────────
// Tracks "last block successfully processed" per event topic so the
// poll loop knows where to resume after restarts.
export const crawlerState = pgTable("crawler_state", {
  topic: text("topic").primaryKey(), // 'transfers' | 'marketplace_sales' | 'marketplace_listings' | ...
  lastBlockProcessed: integer("last_block_processed").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
