import type { NextConfig } from "next";

// Asset path prefix. When deploying to a GitHub Pages project URL
// (devabsnt.github.io/<repo>/), Next needs to know the URL prefix so its
// CSS/JS asset paths resolve. On the custom domain (minti.art) we serve
// from root and basePath must be empty.
//
// Set `PAGES_BASE_PATH=/minti` in the Pages build env to use the project
// URL; leave unset (default) for custom-domain serving.
const basePath = process.env.PAGES_BASE_PATH || "";

const nextConfig: NextConfig = {
  // Static export only for production builds; dev server needs dynamic routes
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: {
    unoptimized: true,
  },
  turbopack: {},
  devIndicators: false,
};

export default nextConfig;
