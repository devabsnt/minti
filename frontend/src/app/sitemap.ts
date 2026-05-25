import type { MetadataRoute } from "next";

/**
 * Sitemap for the static parts of the site. Per-collection / per-wallet
 * dynamic routes are intentionally excluded — they're combinatorial and
 * search engines will discover them via links from the index pages anyway.
 *
 * Hosted at /sitemap.xml automatically by Next.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://minti.art";
  const lastMod = new Date();
  return [
    { url: `${base}/`, lastModified: lastMod, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/explore`, lastModified: lastMod, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/launch`, lastModified: lastMod, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/generator`, lastModified: lastMod, changeFrequency: "monthly", priority: 0.5 },
  ];
}
