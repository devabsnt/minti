import {
  PROXY_HOST_PATTERNS,
  WORKER_PROXY_URL,
} from "@/config/constants";

const STORAGE_KEY = "minti.proxyPreferredHosts.v1";
const DEAD_HOSTS_KEY = "minti.deadHosts.v1";
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

function matchesAllowlist(host: string): boolean {
  return PROXY_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Should `url` be fetched through the Cloudflare proxy instead of direct?
 *
 * Strategy: **optimistic direct first**. We don't pre-emptively proxy
 * allowlisted hosts because many of them (scatter.art is the canonical
 * example) DO serve CORS to browsers fine and the proxy just adds a
 * 502 risk when the worker's egress IP gets rate-limited or blocked.
 *
 * Returns true only for hosts that have **already failed CORS** during
 * this session OR within the persisted TTL window. `canProxyUrl`
 * separately gates whether the proxy fallback is even an option (i.e.
 * whether the worker's allowlist will accept the URL).
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

/** Build the worker URL that proxies `target`. */
export function proxyUrlFor(target: string): string {
  return `${WORKER_PROXY_URL}/proxy?url=${encodeURIComponent(target)}`;
}

/**
 * Mark a host as "proxy-preferred" after a direct fetch produced an error
 * that smells like CORS (TypeError in the browser). Persists across page
 * reloads with a 24h TTL so the next visit skips straight to the proxy.
 *
 * Caller already verified the host is one the worker accepts (otherwise
 * the proxy will 403). Use `canProxyHost(host)` to gate.
 */
export function markProxyPreferred(url: string): void {
  const host = hostFromUrl(url);
  if (!host) return;
  if (!canProxyHost(host)) return;
  SESSION_PREFERRED.add(host);
  const entries = safeReadPersisted(STORAGE_KEY).filter((e) => e.host !== host);
  entries.push({ host, until: Date.now() + TTL_MS });
  safeWritePersisted(STORAGE_KEY, entries);
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

/** Worker accepts this host on /proxy? */
export function canProxyHost(host: string): boolean {
  return matchesAllowlist(host);
}

/** True for hosts we'd like to attempt-retry through the proxy on CORS failure. */
export function canProxyUrl(url: string): boolean {
  const host = hostFromUrl(url);
  if (!host) return false;
  return canProxyHost(host);
}
