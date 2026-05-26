"use client";

import { usePathname } from "next/navigation";
import { SideBamboo } from "./SideBamboo";

/**
 * Render the simple side-bamboo decoration on every page EXCEPT the
 * landing page (which has its own denser parallax bamboo). Pulled
 * into a tiny client component so the surrounding layout can stay a
 * server component.
 */
export function SideBambooMount() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return <SideBamboo />;
}
