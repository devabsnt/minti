# IPFS Edge Cache

Cloudflare Worker that fronts public IPFS gateways with edge caching and
gateway-racing. Used for both NFT image fetches and tokenURI JSON.

## Why

Public IPFS gateways are slow and unreliable. Cold reads can take seconds.
Repeat reads from a different user re-hit the same gateways and don't
benefit from anyone else's earlier fetch.

This Worker:
- Races every configured gateway in parallel and uses the first that
  responds (Promise.any). Cold-read latency = fastest gateway, not
  slowest.
- Caches every successful response on Cloudflare's edge for a year
  (content-addressed — IPFS data can't change). Once any user fetches
  a CID, every subsequent user globally hits the cache in <50 ms.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

The published URL becomes `IPFS_PROXY_BASE` in
`frontend/src/config/constants.ts`.

## URL shape

```
https://<worker>.workers.dev/ipfs/<cid>/<optional/path>
```

Works for any content type (images, JSON, video, etc.) — the worker is
content-agnostic.

## Cost

Free tier: 100k requests/day. Cache hits don't count against this limit
on Cloudflare's pricing (verify in dashboard). At cache-hit-rate 80%+
the worker basically scales for free.
