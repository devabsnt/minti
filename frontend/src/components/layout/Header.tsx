"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "../wallet/ConnectButton";
import { GlobalSearch } from "./GlobalSearch";

export function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile menu is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const linkClass = useCallback(
    (href: string) => {
      const active = pathname === href || pathname?.startsWith(href + "/");
      const base = "text-sm font-medium transition-colors";
      if (active) return `${base} text-foreground`;
      return `${base} text-foreground-secondary hover:text-foreground`;
    },
    [pathname],
  );

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur-md">
      {/* `relative` so the absolutely-positioned search bar centers
          on the viewport regardless of how wide the left and right
          groups end up. Flex justify-between on left/right keeps
          their natural positions; the search overlays at center. */}
      <div className="relative max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
        {/* Logo + Nav */}
        <div className="relative z-10 flex items-center gap-10 flex-shrink-0">
          <Link
            href="/"
            className="text-base font-bold tracking-tight shrink-0"
          >
            <span className="text-mint">minti</span>
            <span className="text-foreground">.art</span>
          </Link>

          <nav className="hidden md:flex items-center gap-7">
            <Link href="/explore" className={linkClass("/explore")}>
              Explore
            </Link>
            <Link href="/launch" className={linkClass("/launch")}>
              Launch
            </Link>
            <Link href="/generator" className={linkClass("/generator")}>
              Generator
            </Link>
          </nav>
        </div>

        {/* Search bar. Absolutely centered on the viewport so its
            position is independent of the left/right group widths.
            Hidden on mobile (room is too tight). */}
        <div className="hidden sm:block absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-80 lg:w-96 max-w-[min(60vw,420px)]">
          <GlobalSearch />
        </div>

        {/* Right side */}
        <div className="relative z-10 flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <ConnectButton />
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden p-2 rounded-md text-foreground-secondary hover:text-foreground hover:bg-background-secondary"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              {mobileOpen ? (
                <path
                  fillRule="evenodd"
                  d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 1 0 1.06 1.06L10 11.06l5.72 5.72a.75.75 0 1 0 1.06-1.06L11.06 10l5.72-5.72a.75.75 0 0 0-1.06-1.06L10 8.94 4.28 3.22Z"
                  clipRule="evenodd"
                />
              ) : (
                <path
                  fillRule="evenodd"
                  d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 10a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Zm0 5.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z"
                  clipRule="evenodd"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden border-t border-border bg-background">
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
            <div className="sm:hidden">
              <GlobalSearch />
            </div>
            <nav className="flex flex-col gap-1 text-base">
              <Link
                href="/explore"
                className={`px-2 py-2 ${linkClass("/explore")}`}
              >
                Explore
              </Link>
              <Link
                href="/launch"
                className={`px-2 py-2 ${linkClass("/launch")}`}
              >
                Launch
              </Link>
              <Link
                href="/generator"
                className={`px-2 py-2 ${linkClass("/generator")}`}
              >
                Generator
              </Link>
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
