import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export only for production builds; dev server needs dynamic routes
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  images: {
    unoptimized: true,
  },
  turbopack: {},
  devIndicators: false,
};

export default nextConfig;
