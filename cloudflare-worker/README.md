# Hypersync CORS Proxy

Cloudflare Worker that adds CORS headers to Envio's Hypersync endpoint so
the browser-only minti.art frontend can query it directly.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

The published URL becomes the value of `HYPERSYNC_ENDPOINTS[143]` in
`frontend/src/lib/hypersync/client.ts`.

## Cost

Free tier: 100k requests/day. A marketplace user with a fresh wallet
scan uses maybe 5-20 requests; revisits use 1-2. The free tier handles
~10k unique wallet scans/day.
