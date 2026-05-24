/**
 * Build the *fast* trending snapshot used by the /explore hero strip.
 *
 * This is a lightweight companion to build-collections-index.mjs. It runs on
 * a much faster cadence (e.g. hourly) and only emits per-collection activity
 * counts for the last ~6 hours. The frontend reads this static JSON instead
 * of hitting Hypersync per-user — which doesn't scale past the 500 RPM token
 * limit when many users are loading /explore simultaneously.
 *
 * Output: `frontend/public/data/monad-trending.json` shaped like:
 *
 *   {
 *     chainId: 143,
 *     builtAt: 1700000000000,
 *     windowHours: 6,
 *     fromBlock: 76000000,
 *     tipBlock: 76043200,
 *     collections: [
 *       { address, transfers, receivers, senders, mints },
 *       ...
 *     ]
 *   }
 *
 * Env vars:
 *   HYPERSYNC_TOKEN   required, free Envio token
 *   WINDOW_HOURS      optional, default 6
 *
 * Run:
 *   HYPERSYNC_TOKEN=… node build-trending-snapshot.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HYPERSYNC_TOKEN = process.env.HYPERSYNC_TOKEN;
if (!HYPERSYNC_TOKEN) {
  console.error("HYPERSYNC_TOKEN env var is required.");
  process.exit(1);
}

const HYPERSYNC_URL = "https://monad.hypersync.xyz";
const CHAIN_ID = 143;
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 6);
const MONAD_BLOCKS_PER_HOUR = 7_200; // 0.5s blocks

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDR = "0x" + "00".repeat(20);

const OUT_PATH = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "data",
  "monad-trending.json",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hypersync(body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const resp = await fetch(`${HYPERSYNC_URL}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HYPERSYNC_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp.json();
    const text = await resp.text().catch(() => "");
    const retriable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
    if (!retriable) throw new Error(`Hypersync ${resp.status}: ${text.slice(0, 200)}`);
    const wait = Math.min(30, 2 ** attempt);
    console.log(`  Hypersync ${resp.status} — waiting ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error("Hypersync exhausted retries");
}

function topicToAddr(t) {
  return t ? "0x" + t.slice(-40).toLowerCase() : null;
}

async function main() {
  console.log(`Building trending snapshot (window=${WINDOW_HOURS}h)...`);

  // Tip first
  const tipResp = await hypersync({
    from_block: 0,
    to_block: 1,
    logs: [],
    field_selection: { log: ["block_number"] },
  });
  const tipBlock = tipResp.archive_height;
  const fromBlock = Math.max(0, tipBlock - WINDOW_HOURS * MONAD_BLOCKS_PER_HOUR);
  console.log(`Tip=${tipBlock} fromBlock=${fromBlock}`);

  /** @type {Map<string, {t:number, m:number, recv:Set<string>, snd:Set<string>}>} */
  const acc = new Map();
  let cursor = fromBlock;
  let queries = 0;
  const startTime = Date.now();

  while (true) {
    const result = await hypersync({
      from_block: cursor,
      to_block: tipBlock,
      logs: [{ topics: [[TRANSFER_TOPIC], [], [], []] }],
      field_selection: { log: ["address", "topic1", "topic2", "topic3"] },
    });

    for (const batch of result.data || []) {
      for (const log of batch.logs || []) {
        if (!log.topic3 || !log.address) continue;
        const addr = log.address.toLowerCase();
        const from = topicToAddr(log.topic1);
        const to = topicToAddr(log.topic2);
        let row = acc.get(addr);
        if (!row) {
          row = { t: 0, m: 0, recv: new Set(), snd: new Set() };
          acc.set(addr, row);
        }
        row.t++;
        if (from === ZERO_ADDR) row.m++;
        else row.snd.add(from);
        if (to !== ZERO_ADDR) row.recv.add(to);
      }
    }

    cursor = result.next_block;
    queries++;
    if (cursor >= tipBlock) break;
    await sleep(150);
  }

  const collections = [...acc.entries()]
    .map(([address, row]) => ({
      address,
      transfers: row.t,
      mints: row.m,
      receivers: row.recv.size,
      senders: row.snd.size,
    }))
    .filter((c) => c.transfers > 0)
    // We only care about collections with notable activity. Skip the ones that
    // had 1-2 transfers — they'd never show up in trending anyway.
    .filter((c) => c.transfers >= 3)
    .sort((a, b) => b.transfers - a.transfers)
    .slice(0, 500); // cap snapshot size at top 500

  const snapshot = {
    chainId: CHAIN_ID,
    builtAt: Date.now(),
    windowHours: WINDOW_HOURS,
    fromBlock,
    tipBlock,
    collections,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot));
  const sizeKb = (JSON.stringify(snapshot).length / 1024).toFixed(1);
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `Wrote ${OUT_PATH} (${sizeKb} KB, ${collections.length} collections, ${queries} queries, ${elapsed}s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
