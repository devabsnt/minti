import {
  PROXY_HOST_PATTERNS,
  WORKER_PROXY_URL,
} from "@/config/constants";

const STORAGE_KEY = "minti.proxyPreferredHosts.v1";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_PREFERRED = new Set<string>();

type PersistedEntry = { host: string; until: number };

function safeReadPersisted(): PersistedEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as PersistedEntry[];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter((e) => e && typeof e.host === "string" && e.until > now);
  } catch {
    return [];
  }
}

function safeWritePersisted(entries: PersistedEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
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
 * Returns true for hosts on the static allowlist OR hosts that were
 * marked as "proxy-preferred" earlier this session / within the persisted
 * TTL (because a direct fetch failed with what looks like a CORS error).
 */
export function shouldUseProxy(url: string): boolean {
  if (!WORKER_PROXY_URL) return false;
  const host = hostFromUrl(url);
  if (!host) return false;
  if (matchesAllowlist(host)) return true;
  if (SESSION_PREFERRED.has(host)) return true;
  for (const entry of safeReadPersisted()) {
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
  const entries = safeReadPersisted().filter((e) => e.host !== host);
  entries.push({ host, until: Date.now() + TTL_MS });
  safeWritePersisted(entries);
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
