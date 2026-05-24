import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-border mt-auto">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="text-sm text-foreground-secondary">
            <span className="font-medium text-foreground">minti</span>
            <span className="text-mint">.art</span>
            <span className="ml-2">Decentralized NFT Marketplace</span>
          </div>

          <div className="flex items-center gap-6 text-sm text-foreground-secondary">
            <Link
              href="/explore"
              className="hover:text-foreground transition-colors"
            >
              Explore
            </Link>
            <Link
              href="/generator"
              className="hover:text-foreground transition-colors"
            >
              Generator
            </Link>
            <span className="text-border">|</span>
            <span>0.1% protocol fee</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
