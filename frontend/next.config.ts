import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import path from "node:path";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  turbopack: {
    // Pin the workspace root to this directory so Turbopack stops walking
    // upward and (incorrectly) detecting the user's home as the workspace.
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  devIndicators: false,
};

export default nextConfig;
