import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-auto">
      <div className="max-w-7xl mx-auto px-4 py-10">
        {/* Postcard-divider ornament: hairline with small circle
            terminators (○ ─── baoling Nº 001 ─── ○) - mirrors the
            footer motif on the NFT artwork itself. */}
        <div className="postcard-divider mb-6">
          <span className="font-serif">
            <span className="text-foreground">minti</span>
            <span className="text-mint">.art</span>
            <span className="text-foreground-secondary"> · Nº 001</span>
          </span>
        </div>

        <div className="flex flex-col md:flex-row items-center justify-between gap-3 text-sm text-foreground-secondary">
          <div>A home for on-chain collections</div>
          <div className="flex items-center gap-6">
            <Link
              href="/explore"
              className="hover:text-foreground transition-colors"
            >
              Explore
            </Link>
            <Link
              href="/launch"
              className="hover:text-foreground transition-colors"
            >
              Launch
            </Link>
            <Link
              href="/generator"
              className="hover:text-foreground transition-colors"
            >
              Generator
            </Link>
            <span className="text-foreground-secondary/40">·</span>
            <span>0.1% fee</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
