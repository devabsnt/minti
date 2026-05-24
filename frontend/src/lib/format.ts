import { formatEther } from "viem";

export function truncateAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/**
 * Format an integer with thousands separators using a fixed locale so the
 * SSR-rendered string matches the client-rendered one. Using `undefined` as
 * the locale (i.e. user's locale) is a classic hydration mismatch source.
 */
export function formatNumber(n: number | bigint | string | null | undefined): string {
  if (n == null) return "0";
  const num = typeof n === "bigint" ? Number(n) : typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("en-US");
}

/**
 * Compact integer formatting: 1234 → 1.2k, 1234567 → 1.2M. Used for activity
 * badges in tight UI spaces.
 */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
}

export function formatPrice(weiAmount: bigint): string {
  const eth = formatEther(weiAmount);
  const num = parseFloat(eth);
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(4);
  if (num < 100) return num.toFixed(3);
  if (num < 10000) return num.toFixed(2);
  return num.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export function formatTimestamp(timestamp: bigint): string {
  const date = new Date(Number(timestamp) * 1000);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function timeAgo(timestamp: bigint): string {
  const seconds = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatTimestamp(timestamp);
}
