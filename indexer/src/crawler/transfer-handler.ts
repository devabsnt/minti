import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { activity, collections, crawlerState, tokens } from "../db/schema.js";
import type { ChainLog } from "./source.js";

/**
 * ERC-721 Transfer event:
 *   Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
 *
 * topic[0] = keccak256("Transfer(address,address,uint256)")
 * topic[1] = from (padded to 32 bytes)
 * topic[2] = to   (padded)
 * topic[3] = tokenId (padded)
 *
 * ERC-20 has the same name but only THREE topics (tokenId not indexed,
 * it's in `data`). We filter by topics.length === 4 to keep ERC-721 only.
 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO_ADDR = "0x" + "0".repeat(40);

/**
 * Parse a Transfer log into the fields we want to store. Returns null
 * for ERC-20-shaped events so the caller can skip them.
 */
function parseTransfer(log: ChainLog): {
  contract: string;
  from: string;
  to: string;
  tokenId: string;
  isMint: boolean;
  isBurn: boolean;
} | null {
  if (log.topics.length !== 4) return null; // ERC-20 has 3 topics, skip
  const fromTopic = log.topics[1];
  const toTopic = log.topics[2];
  const idTopic = log.topics[3];
  if (!fromTopic || !toTopic || !idTopic) return null;
  const from = "0x" + fromTopic.slice(-40).toLowerCase();
  const to = "0x" + toTopic.slice(-40).toLowerCase();
  const tokenId = BigInt(idTopic).toString();
  return {
    contract: log.address.toLowerCase(),
    from,
    to,
    tokenId,
    isMint: from === ZERO_ADDR,
    isBurn: to === ZERO_ADDR,
  };
}

/**
 * Ingest a batch of Transfer logs into `activity` + `collections`. Does
 * NOT advance the crawler cursor — caller owns that, so it can be done
 * once per wave when bootstrap fires multiple chunks in parallel.
 *
 *   1. Insert each into `activity` (ON CONFLICT DO NOTHING — idempotent
 *      across restarts since (txHash, logIndex) is the PK)
 *   2. Upsert each contract into `collections` with `first_seen_block`
 *      set to the minimum of existing + new
 *
 * Returns the number of distinct collections discovered AND the number
 * of activity rows actually inserted (after conflict dedup).
 */
export async function ingestTransferLogs(
  logs: readonly ChainLog[],
  blockTimestamps: Map<number, Date>,
): Promise<{ activityRows: number; collectionsTouched: number; tokensTouched: number }> {
  if (logs.length === 0) {
    return { activityRows: 0, collectionsTouched: 0, tokensTouched: 0 };
  }

  const activityRows: typeof activity.$inferInsert[] = [];
  const collectionFirstSeen = new Map<string, number>();
  // Per-token "latest transfer in this batch". The DB upsert below uses
  // GREATEST(last_transfer_block, EXCLUDED.last_transfer_block) so we
  // could insert every transfer and let Postgres pick — but de-duping in
  // memory shrinks the batch dramatically for tokens that change hands
  // multiple times in one wave. Easier on the connection too.
  const tokenLatest = new Map<string, {
    contract: string;
    tokenId: string;
    owner: string;
    lastBlock: number;
  }>();

  for (const log of logs) {
    const parsed = parseTransfer(log);
    if (!parsed) continue;
    const ts = blockTimestamps.get(log.blockNumber) ?? new Date();

    activityRows.push({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      eventType: parsed.isMint ? "mint" : parsed.isBurn ? "burn" : "transfer",
      contract: parsed.contract,
      tokenId: parsed.tokenId,
      fromAddr: parsed.from,
      toAddr: parsed.to,
      price: null,
      blockNumber: log.blockNumber,
      timestamp: ts,
    });

    const existing = collectionFirstSeen.get(parsed.contract);
    if (existing == null || log.blockNumber < existing) {
      collectionFirstSeen.set(parsed.contract, log.blockNumber);
    }

    // Track the most-recent-in-batch owner per token. Burns set owner
    // to 0x0 which marks the token as burned — we keep the row because
    // frontend may want to count burns / show "burned" state, and the
    // owner=0x0 record is the canonical signal.
    const tokenKey = `${parsed.contract}:${parsed.tokenId}`;
    const cur = tokenLatest.get(tokenKey);
    if (!cur || log.blockNumber > cur.lastBlock) {
      tokenLatest.set(tokenKey, {
        contract: parsed.contract,
        tokenId: parsed.tokenId,
        owner: parsed.to,
        lastBlock: log.blockNumber,
      });
    }
  }

  // Insert activity in chunks so a single huge batch doesn't trip
  // parameter-count limits on big sweeps.
  const ACTIVITY_BATCH = 1000;
  for (let i = 0; i < activityRows.length; i += ACTIVITY_BATCH) {
    const slice = activityRows.slice(i, i + ACTIVITY_BATCH);
    if (slice.length === 0) continue;
    await db
      .insert(activity)
      .values(slice)
      .onConflictDoNothing({ target: [activity.txHash, activity.logIndex] });
  }

  // Upsert collections: keep the lowest known first_seen_block.
  const COLLECTIONS_BATCH = 500;
  const collRows = Array.from(collectionFirstSeen.entries()).map(
    ([address, block]) => ({ address, firstSeenBlock: block }),
  );
  for (let i = 0; i < collRows.length; i += COLLECTIONS_BATCH) {
    const slice = collRows.slice(i, i + COLLECTIONS_BATCH);
    if (slice.length === 0) continue;
    await db
      .insert(collections)
      .values(slice)
      .onConflictDoUpdate({
        target: collections.address,
        set: {
          firstSeenBlock: sql`LEAST(${collections.firstSeenBlock}, EXCLUDED.first_seen_block)`,
        },
      });
  }

  // Upsert tokens: ownership state. Higher block wins regardless of
  // insert order — robust against any out-of-order processing.
  const TOKENS_BATCH = 500;
  const tokenRows = Array.from(tokenLatest.values()).map((t) => ({
    contract: t.contract,
    tokenId: t.tokenId,
    owner: t.owner,
    lastTransferBlock: t.lastBlock,
  }));
  for (let i = 0; i < tokenRows.length; i += TOKENS_BATCH) {
    const slice = tokenRows.slice(i, i + TOKENS_BATCH);
    if (slice.length === 0) continue;
    await db
      .insert(tokens)
      .values(slice)
      .onConflictDoUpdate({
        target: [tokens.contract, tokens.tokenId],
        set: {
          owner: sql`CASE WHEN EXCLUDED.last_transfer_block > ${tokens.lastTransferBlock} THEN EXCLUDED.owner ELSE ${tokens.owner} END`,
          lastTransferBlock: sql`GREATEST(${tokens.lastTransferBlock}, EXCLUDED.last_transfer_block)`,
          updatedAt: sql`now()`,
        },
      });
  }

  return {
    activityRows: activityRows.length,
    collectionsTouched: collectionFirstSeen.size,
    tokensTouched: tokenLatest.size,
  };
}

/**
 * Advance the transfers cursor. Idempotent — uses GREATEST so an older
 * value can't accidentally rewind the cursor.
 */
export async function advanceTransferCursor(toBlock: number): Promise<void> {
  await db
    .insert(crawlerState)
    .values({ topic: "transfers", lastBlockProcessed: toBlock })
    .onConflictDoUpdate({
      target: crawlerState.topic,
      set: {
        lastBlockProcessed: sql`GREATEST(${crawlerState.lastBlockProcessed}, EXCLUDED.last_block_processed)`,
        updatedAt: sql`now()`,
      },
    });
}

/** Returns the last block we processed for transfers, or null if never. */
export async function getTransferCursor(): Promise<number | null> {
  const rows = await db
    .select()
    .from(crawlerState)
    .where(sql`${crawlerState.topic} = 'transfers'`);
  return rows[0]?.lastBlockProcessed ?? null;
}
