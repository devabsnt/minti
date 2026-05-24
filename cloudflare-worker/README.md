# Hypersync CORS Proxy

Cloudflare Worker that adds CORS headers to Envio's Hypersync endpoint so
the browser-only minti.art frontend can query it directly. Also rotates
between multiple Envio tokens and paces requests under each token's
500 RPM cap.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

The published URL becomes the value of `HYPERSYNC_ENDPOINTS[143]` in
`frontend/src/lib/hypersync/client.ts`.

## Secrets

Either form is accepted; `HYPERSYNC_TOKENS` takes priority.

```bash
# Preferred — comma-separated list, used round-robin
wrangler secret put HYPERSYNC_TOKENS
#  paste:  tok_aaaa,tok_bbbb,tok_cccc

# Legacy single-token (still works)
wrangler secret put HYPERSYNC_TOKEN
```

Get tokens at https://app.envio.dev/api-tokens (one free per Envio
account). Add 3-5 to keep the effective ceiling well above your traffic.

## How the pacer works

Each token gets its own in-memory "next available timestamp". Incoming
requests pick the token with the earliest next-available slot and reserve
it (bumping that timestamp forward by ~125 ms = 480 RPM per token, just
under Envio's 500 RPM cap).

If every token is busy, the request waits up to 2 s for a slot. Beyond
that we return `429 Retry-After: <seconds>` so the client backs off
instead of piling up. If the upstream itself returns 429, the offending
token cools off for the duration of its `Retry-After` header — the next
request naturally picks a different token.

State is in-memory per Worker isolate, so high-traffic regions running
multiple isolates each get their own pacer. Effective sustained ceiling
is roughly `(isolates) × (tokens) × 480` RPM. We're nowhere near needing
Durable Objects for global coordination.

## Cost

Free tier: 100k requests/day. A marketplace user with a fresh wallet
scan uses maybe 5-20 requests; revisits use 1-2. The free tier handles
~10k unique wallet scans/day.
