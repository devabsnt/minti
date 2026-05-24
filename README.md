# minti.art

EVM NFT marketplace with first-class on-chain support, built around EVMFS
(Ethereum-event-log file system) as a native storage tier.

Launching on Monad first, with multichain support to follow.

## Repo layout

```
contracts/         Foundry — MintiMarketplace + EVMFSCollectionRegistry +
                   MintiCollection721. Tests and deploy scripts included.
frontend/          Next.js 16 static export, TypeScript, wagmi v3, viem v2.
                   Talks to the contracts via a multi-RPC pool with rate-
                   limit handling. No backend.
cloudflare-worker/ Stateless CORS proxy for Envio Hypersync. Required because
                   the Hypersync hosted endpoint doesn't send CORS headers
                   for browser-origin requests. Hypersync API token lives as
                   a Worker secret.
scripts/           Build-time pipelines — currently the collections-index
                   snapshot builder (Hypersync sweep → multicall enrich →
                   static JSON, used by `/explore` for global search).
.github/           CI: weekly job that rebuilds the collections snapshot.
```

## Why no backend

minti.art is a static site that talks to chain state via public RPC and
Envio Hypersync (free). The only ongoing infrastructure is one Cloudflare
Worker that adds CORS headers to Hypersync responses, and one GitHub
Actions cron that rebuilds the collections snapshot.

The wallet view uses a sophisticated client-side scanner:

- IndexedDB cache persists across sessions (instant load on revisit)
- Cached ownership re-verified on every visit (catches transfers since)
- Hypersync delta-query in the background discovers new incoming transfers
- Multi-RPC pool with rate-limit tracking handles enrichment

## Development

```bash
# Frontend
cd frontend
npm install
npm run dev      # http://localhost:3000

# Contracts
cd contracts
forge build
forge test

# Cloudflare Worker (deploy once)
cd cloudflare-worker
npm install -g wrangler
wrangler login
wrangler deploy

# Collections-index snapshot (locally, for testing)
node scripts/build-collections-index.mjs
```

## Architecture notes

**Marketplace contracts** support ERC-721 + ERC-1155 with listings, bids,
collection offers, EIP-2981 royalties + MagicEden-style optional buyer-set
royalties, and a 0.5% protocol fee. CREATE2 deterministic deployment so
addresses are stable across chains.

**Registry contract** classifies collections into 4 tiers:
`EVMFS_V1` (curated by minti.art) > `EVMFS_V2` (self-launched via the
launchpad) > `ON_CHAIN_DATA_URI` (Loot-style data: URLs) > `OFFCHAIN`
(IPFS/HTTP). Verified collections are pinned above the rest in discovery.

**EVMFS** is the underlying on-chain storage tier — files emitted as event
logs from an immutable contract deployed at the same CREATE2 address on
every chain. Content addressed by keccak256. See the
[EVMFS docs](https://evmfs.xyz) for the protocol details.
