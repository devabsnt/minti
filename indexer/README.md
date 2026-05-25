# minti-indexer

Live Monad chain indexer for minti.art. Postgres source of truth, Hono HTTP API, continuous polling via public RPCs.

## Why this exists

Replaces the static-snapshot + GH Action cron approach. Continuous indexing gives near-realtime listings/sales/owner data; the static snapshot can only refresh hourly. See repo root conversation history for the full migration rationale.

## Architecture

```
┌─ Railway service ────────────────────────────────┐
│  ┌─ HTTP API (Hono) ─────────────────────────┐  │
│  │  /health                                   │  │
│  │  /api/collections      (coming)            │  │
│  │  /api/collections/:addr/tokens (coming)    │  │
│  │  /api/activity         (coming)            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─ Crawler loop ────────────────────────────┐   │
│  │  Bootstrap: scan from block 0             │   │
│  │  Poll: every CRAWLER_POLL_SECONDS         │   │
│  │  Sources: pluggable via ChainSource        │   │
│  └────────────────────────────────────────────┘   │
│                                                  │
│  Postgres (Railway addon)                        │
└──────────────────────────────────────────────────┘
```

The HTTP API and crawler run in the same Node process. They share the Postgres connection pool. On crash, Railway restarts the service and the crawler resumes from `crawler_state.last_block_processed`.

## Environment variables

See `.env.example` for the full list with comments. Required for the service to boot:

- `DATABASE_URL` — Railway's Postgres addon injects this automatically
- `MONAD_RPC` — comma-separated list of public Monad RPC endpoints
- `PORT` — Railway injects this automatically

Strongly recommended in production:

- `CORS_ORIGINS` — comma-separated list of allowed browser origins. Without this set, CORS allows everything (open API). Set this to your frontend URL.
- `RATE_LIMIT_PER_MINUTE` — per-IP rate limit (default 120/min)

## Local development

```bash
cd indexer
npm ci                          # install from lockfile (NEVER `npm install` in CI)
cp .env.example .env            # fill in DATABASE_URL etc.
npm run db:push                 # sync schema to your local Postgres
npm run dev                     # tsx watch mode
```

Visit `http://localhost:8080/health` to confirm the service is up and the DB is reachable.

## Deployment on Railway

1. Create a new service in your Railway project.
2. Connect it to this repo. Set **Root Directory** to `indexer`.
3. Attach a Postgres addon to the project — `DATABASE_URL` is injected automatically.
4. Set env vars: `MONAD_RPC`, `CORS_ORIGINS`, `MARKETPLACE_ADDRESS` (optional).
5. Railway runs `npm install` and then `npm start`. The `start` script also runs `db:push` to apply the schema, which is idempotent.
6. Hit `https://<your-service>.up.railway.app/health` — should return `{ "status": "ok", "db": "connected", ... }`.

## Supply-chain hardening

We care about not being the next compromised-npm-package post-mortem:

- **All dependency versions in `package.json` are pinned EXACT** (no `^` or `~`). A new version of a dep can't slip in just because we ran `npm install` again.
- **`package-lock.json` is the source of truth** — committed to git, used by `npm ci` in production.
- **Renovate is configured with a 7-day stability window** (`renovate.json`). Automated update PRs wait 7 days after a release is published. If a malicious version gets caught in that window, we never pull it in.
- **Use `npm ci`, not `npm install`** in any CI / deploy step. `ci` installs from the lockfile verbatim and refuses if the lockfile is missing or out-of-sync with `package.json`.

If you're adding a new dependency manually, verify the package's age, maintenance, and download trend before installing. A 5-minute spot check on npmjs.com beats a 5-day incident response.

## Schema

See `src/db/schema.ts`. Tables:

- `collections` — per-contract row, name/symbol/stats/metadata
- `tokens` — `(contract, tokenId)` primary key; per-token owner + image + attributes
- `activity` — append-only event log (transfers, sales, listings, ...)
- `crawler_state` — last-block-processed per event topic, for crash recovery

BigInts (tokenIds, prices, supplies) are stored as **text** rather than `bigint`, because EVM standards allow 2^256 IDs and Postgres bigint maxes at 2^63. Cast on read where needed.

## Roadmap (in order)

This scaffold ships `/health` and the crawler-loop stub. Subsequent slices land independently and are each shippable:

1. ~~Scaffold + `/health` (this file)~~
2. RPC source implementation (`src/crawler/rpc-source.ts`) — multi-provider, paginated `eth_getLogs`, round-robin, rate-limit handling
3. Bootstrap (`src/crawler/bootstrap.ts`) — sweep from block 0, populate `collections` + `tokens`
4. Ongoing poll loop — replace the heartbeat stub with real ingestion
5. API endpoints — `/api/collections`, `/api/collections/:addr`, `/api/collections/:addr/tokens`
6. Marketplace event ingestion — `ItemListed`, `ItemSold`, etc.
7. Metadata precheck — port `scripts/lib/precheck.mjs` for image-URL extraction
8. Frontend migration — replace `useCollectionsIndex` etc. with API calls

The static snapshot in `frontend/public/data/monad-collections.json` keeps working through this whole migration. Cutover only at the end.
