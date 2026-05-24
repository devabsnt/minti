import type { NextConfig } from "next";

// Deploy target switch.
//   - Vercel (default): no basePath, no static export — Vercel handles
//     dynamic routes natively
//   - GitHub Pages project URL: set PAGES_BASE_PATH=/<repo> AND
//     STATIC_EXPORT=1 — Next produces `out/` with asset prefix baked in
//
// All pages are "use client" so even when Vercel renders, there's no
// server-side logic running. The "zero backend" principle is preserved.
const basePath = process.env.PAGES_BASE_PATH || "";
const staticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  output: staticExport ? "export" : undefined,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  images: {
    unoptimized: true,
  },
  turbopack: {},
  devIndicators: false,
};

export default nextConfig;
