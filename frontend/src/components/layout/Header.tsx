"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChainSelector } from "./ChainSelector";
import { ConnectButton } from "../wallet/ConnectButton";
import { isAddress } from "viem";

export function Header() {
  const router = useRouter();
  const [searchValue, setSearchValue] = useState("");
  const [searchError, setSearchError] = useState(false);

  const handleSearch = useCallback(() => {
    const value = searchValue.trim();
    if (!value) return;

    if (isAddress(value)) {
      setSearchError(false);
      setSearchValue("");
      router.push(`/collection/${value}`);
    } else {
      setSearchError(true);
      setTimeout(() => setSearchError(false), 2000);
    }
  }, [searchValue, router]);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo + Nav */}
        <div className="flex items-center gap-8">
          <Link href="/" className="shrink-0">
            <span className="font-bold text-lg">
              <span className="text-mint">minti</span>
              <span className="text-foreground">.art</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            <Link
              href="/explore"
              className="text-sm text-foreground-secondary hover:text-foreground transition-colors"
            >
              Explore
            </Link>
            <Link
              href="/launch"
              className="text-sm text-mint hover:text-mint/80 transition-colors font-medium"
            >
              Launch
            </Link>
            <Link
              href="/generator"
              className="text-sm text-foreground-secondary hover:text-foreground transition-colors"
            >
              Generator
            </Link>
          </nav>
        </div>

        {/* Search */}
        <div className="hidden sm:flex flex-1 max-w-md mx-4">
          <div className="relative w-full">
            <input
              type="text"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search collection by address (0x...)"
              aria-label="Search collection by contract address"
              className={`w-full h-9 px-3 pr-9 text-sm bg-background-secondary border rounded-lg placeholder:text-foreground-secondary/50 focus:outline-none focus:border-mint/50 transition-colors ${
                searchError ? "border-danger" : "border-border"
              }`}
            />
            <button
              onClick={handleSearch}
              aria-label="Search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-secondary hover:text-mint transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          <ChainSelector />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
