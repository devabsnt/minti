/**
 * Global + per-host concurrency limiter.
 *
 * Why two limits:
 *   - Global cap protects the Node process and Railway egress budget
 *     from running thousands of in-flight sockets at once.
 *   - Per-host cap protects each upstream metadata host from being
 *     hammered by a single collection's enumeration. NFT metadata
 *     hosts typically rate-limit somewhere between 10-50 req/sec/IP;
 *     a per-host cap of 10 keeps us comfortably below that without
 *     prior knowledge of each host's exact limit.
 *
 * Usage:
 *   const throttle = new HostThrottle({ global: 100, perHost: 10 });
 *   const text = await throttle.run("ipfs.io", () => fetch(url).then(r => r.text()));
 */
export class HostThrottle {
  private readonly globalLimit: number;
  private readonly perHostLimit: number;
  // Per-host overrides for gateways known to rate-limit aggressively.
  // Matched by hostname suffix. Pinata's dedicated gateways (and some
  // R2 buckets) 429 hard on a burst — keep their concurrency low so we
  // don't trip the limit in the first place. The 429-retry in
  // metadata.ts recovers stragglers, but staying under the limit avoids
  // the backoff penalty entirely.
  private readonly perHostOverrides: Array<{ suffix: string; limit: number }> = [
    { suffix: "mypinata.cloud", limit: 3 },
    { suffix: "pinata.cloud", limit: 3 },
    { suffix: "r2.dev", limit: 4 },
    { suffix: "r2.cloudflarestorage.com", limit: 4 },
  ];
  private globalInFlight = 0;
  private readonly hostInFlight = new Map<string, number>();
  // Pending tasks waiting for a slot. Tasks resolve in FIFO order — the
  // first task whose host gets a free slot AND global has a free slot
  // proceeds. We re-check on every release.
  private readonly waiters: Array<{
    host: string;
    resolve: () => void;
  }> = [];

  constructor(opts: { global: number; perHost: number }) {
    this.globalLimit = opts.global;
    this.perHostLimit = opts.perHost;
  }

  /** Resolve the concurrency cap for a host, honoring overrides. */
  private limitForHost(host: string): number {
    for (const o of this.perHostOverrides) {
      if (host === o.suffix || host.endsWith("." + o.suffix)) return o.limit;
    }
    return this.perHostLimit;
  }

  /** Number of tasks waiting for a slot right now. Useful for logging. */
  get queueDepth(): number {
    return this.waiters.length;
  }

  /** Currently in-flight per host. Useful for logging hot hosts. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [host, n] of this.hostInFlight) {
      if (n > 0) out[host] = n;
    }
    return out;
  }

  /**
   * Run `fn` once a global slot AND a per-host slot are available for
   * `host`. Releases both slots when `fn` resolves or rejects.
   */
  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
    }
  }

  private acquire(host: string): Promise<void> {
    if (this.canStart(host)) {
      this.incr(host);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push({ host, resolve });
    });
  }

  private canStart(host: string): boolean {
    if (this.globalInFlight >= this.globalLimit) return false;
    const hostCount = this.hostInFlight.get(host) ?? 0;
    return hostCount < this.limitForHost(host);
  }

  private incr(host: string): void {
    this.globalInFlight++;
    this.hostInFlight.set(host, (this.hostInFlight.get(host) ?? 0) + 1);
  }

  private release(host: string): void {
    this.globalInFlight--;
    const next = (this.hostInFlight.get(host) ?? 1) - 1;
    if (next <= 0) this.hostInFlight.delete(host);
    else this.hostInFlight.set(host, next);

    // Walk the wait queue. A waiter can proceed if BOTH global has a
    // free slot AND its host has a free slot. We can't just pick the
    // head of the queue — that would starve waiters for under-utilized
    // hosts behind a long line of waiters for a saturated host.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (this.canStart(w.host)) {
        this.waiters.splice(i, 1);
        this.incr(w.host);
        w.resolve();
        // Only release one slot per release call; this matches the
        // single increment we just did. The next release will run the
        // loop again.
        return;
      }
      // Stop early if global is saturated — no point scanning further.
      if (this.globalInFlight >= this.globalLimit) return;
    }
  }
}

/**
 * Extract a hostname from a URL for throttle-keying. Falls back to a
 * sentinel for non-URL inputs (data: URIs etc) so they share a single
 * throttle bucket that doesn't compete with real hosts.
 */
export function hostKey(url: string): string {
  if (!url) return "unknown";
  if (url.startsWith("data:")) return "data";
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "unknown";
  }
}
