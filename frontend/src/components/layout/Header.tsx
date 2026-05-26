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
    (href: string, accent = false) => {
      const active = pathname === href || pathname?.startsWith(href + "/");
      const base = "text-sm transition-colors";
      if (active) return `${base} text-mint font-medium`;
      if (accent) return `${base} text-mint hover:text-mint/80 font-medium`;
      return `${base} text-foreground-secondary hover:text-foreground`;
    },
    [pathname],
  );

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
        {/* Logo + Nav */}
        <div className="flex items-center gap-8 flex-shrink-0">
          <Link href="/" className="shrink-0">
            <span className="font-bold text-lg">
              <span className="text-mint">minti</span>
              <span className="text-foreground">.art</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            <Link href="/explore" className={linkClass("/explore")}>
              Explore
            </Link>
            <Link href="/launch" className={linkClass("/launch", true)}>
              Launch
            </Link>
            <Link href="/generator" className={linkClass("/generator")}>
              Generator
            </Link>
          </nav>
        </div>

        {/* Search — autocompletes by name from the snapshot */}
        <div className="hidden sm:flex flex-1 max-w-md mx-2 min-w-0">
          <GlobalSearch />
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
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
                className={`px-2 py-2 rounded-md ${linkClass("/explore")}`}
              >
                Explore
              </Link>
              <Link
                href="/launch"
                className={`px-2 py-2 rounded-md ${linkClass("/launch", true)}`}
              >
                Launch
              </Link>
              <Link
                href="/generator"
                className={`px-2 py-2 rounded-md ${linkClass("/generator")}`}
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
