import { WORKER_PROXY_URL } from "@/config/constants";

// One-shot cleanup of old key versions so orphaned entries don't sit
// in localStorage forever. Runs on first module import in a browser.
if (typeof localStorage !== "undefined") {
  for (const stale of [
    "minti.proxyPreferredHosts.v1",
    "minti.deadHosts.v1",
  ]) {
    try {
      localStorage.removeItem(stale);
    } catch {
      /* ignore */
    }
  }
}

// v2: cleared after a previous build briefly auto-routed allowlisted
// hosts through the Cloudflare worker. Bumping the key invalidates
// those stale entries so direct fetch gets to run again.
const STORAGE_KEY = "minti.proxyPreferredHosts.v2";
const DEAD_HOSTS_KEY = "minti.deadHosts.v2";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Dead-host TTL is shorter because upstream 502s usually recover faster
// than CORS configs change. An hour is long enough to skip a full
// enumeration sweep, short enough that the next visit re-checks.
const DEAD_TTL_MS = 60 * 60 * 1000; // 1h
const SESSION_PREFERRED = new Set<string>();
const SESSION_DEAD = new Set<string>();

type PersistedEntry = { host: string; until: number };

function safeReadPersisted(key: string): PersistedEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw) as PersistedEntry[];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter((e) => e && typeof e.host === "string" && e.until > now);
  } catch {
    return [];
  }
}

function safeWritePersisted(key: string, entries: PersistedEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    /* quota / disabled — ignore */
  }
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Should `url` be fetched through the proxy instead of direct?
 *
 * Strategy: **optimistic direct first**. Return true only for hosts
 * that have already failed CORS during this session or within the
 * persisted TTL. New hosts always get a direct attempt — the proxy
 * fallback kicks in only when that direct attempt actually fails.
 *
 * No allowlist: we used to keep one (scatter.art, pancakeswap, etc.)
 * but collections invent new metadata hosts constantly and curation
 * was perpetually out of date. The Vercel route handler has its own
 * server-side safety gates (https-only, no private IPs, size cap)
 * that don't depend on enumerating every possible host.
 */
export function shouldUseProxy(url: string): boolean {
  if (!WORKER_PROXY_URL) return false;
  const host = hostFromUrl(url);
  if (!host) return false;
  if (SESSION_PREFERRED.has(host)) return true;
  for (const entry of safeReadPersisted(STORAGE_KEY)) {
    if (entry.host === host) return true;
  }
  return false;
}

/** Build the proxy URL that wraps `target`. */
export function proxyUrlFor(target: string): string {
  return `${WORKER_PROXY_URL}?url=${encodeURIComponent(target)}`;
}

/**
 * Mark a host as "proxy-preferred" after a direct fetch failed with
 * what looks like a CORS error (TypeError on a real https URL).
 * Persists across page reloads with a 24h TTL so the next visit skips
 * straight to the proxy.
 */
export function markProxyPreferred(url: string): void {
  const host = hostFromUrl(url);
  if (!host) return;
  SESSION_PREFERRED.add(host);
  const entries = safeReadPersisted(STORAGE_KEY).filter((e) => e.host !== host);
  entries.push({ host, until: Date.now() + TTL_MS });
  safeWritePersisted(STORAGE_KEY, entries);
}

/**
 * Inverse of `markProxyPreferred`. Call this when a proxy request
 * comes back 5xx — the proxy isn't helping, so future requests should
 * try direct again instead of stuck in a proxy-502 loop.
 */
export function unmarkProxyPreferred(url: string): void {
  const host = hostFromUrl(url);
  if (!host) return;
  SESSION_PREFERRED.delete(host);
  const entries = safeReadPersisted(STORAGE_KEY).filter((e) => e.host !== host);
  safeWritePersisted(STORAGE_KEY, entries);
}

/**
 * The proxy is available for any host that survives the route's own
 * gates (https + non-private IP). The frontend doesn't need its own
 * allowlist — anything that fails direct fetch is eligible.
 */
export function canProxyUrl(url: string): boolean {
  if (!WORKER_PROXY_URL) return false;
  const host = hostFromUrl(url);
  if (!host) return false;
  // Don't try to proxy the proxy itself.
  if (host === hostFromUrl(WORKER_PROXY_URL)) return false;
  return true;
}

/**
 * Mark a host as "dead" after repeated 5xx / total-failure responses
 * (even through the proxy). Future enumeration sessions skip the host
 * entirely instead of re-spamming it. 1h TTL — long enough to cover a
 * full re-browse session, short enough that genuine outages recover.
 */
export function markHostDead(url: string): void {
  const host = hostFromUrl(url);
  if (!host) return;
  SESSION_DEAD.add(host);
  const entries = safeReadPersisted(DEAD_HOSTS_KEY).filter(
    (e) => e.host !== host,
  );
  entries.push({ host, until: Date.now() + DEAD_TTL_MS });
  safeWritePersisted(DEAD_HOSTS_KEY, entries);
}

/** All currently-dead hosts (in-memory + persisted, expired entries filtered). */
export function getDeadHosts(): string[] {
  const out = new Set<string>(SESSION_DEAD);
  for (const entry of safeReadPersisted(DEAD_HOSTS_KEY)) {
    out.add(entry.host);
  }
  return Array.from(out);
}

/** Was this host previously bailed (5xx / total failure)? */
export function isHostDead(url: string): boolean {
  const host = hostFromUrl(url);
  if (!host) return false;
  if (SESSION_DEAD.has(host)) return true;
  for (const entry of safeReadPersisted(DEAD_HOSTS_KEY)) {
    if (entry.host === host) {
      SESSION_DEAD.add(host); // memoize for this tab
      return true;
    }
  }
  return false;
}
