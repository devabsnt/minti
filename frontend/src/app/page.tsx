"use client";

import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { CornerBamboo } from "@/components/layout/CornerBamboo";

export default function HomePage() {
  return (
    <div className="max-w-7xl mx-auto px-4">
      <CornerBamboo />
      {/* Hero. Title and tagline use the serif family so they ladder
          cleanly with the Nº rank numerals used elsewhere. The cream
          paper backdrop + serif headline reads as "editorial album"
          rather than tech demo. */}
      <section className="flex flex-col items-center text-center pt-20 pb-24 md:pt-28 md:pb-32">
        <p className="font-serif text-2xl mb-4 tracking-tight">
          <span className="text-mint italic">minti</span>
          <span className="text-foreground">.art</span>
        </p>
        <Image
          src="/mintiSVG.svg"
          alt="Minti mascot"
          width={160}
          height={160}
          className="mb-6"
          priority
        />

        <h1 className="font-serif text-5xl md:text-7xl font-bold tracking-tight leading-[1.05] mb-6 max-w-3xl">
          The home for{" "}
          <span className="text-mint italic">on-chain</span> collections
        </h1>

        <p className="font-serif text-foreground-secondary text-xl max-w-xl mb-10 leading-relaxed">
          Launch NFT collections that live entirely on chain via EVMFS.
          No hosting, no expiry.
        </p>

        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/launch">
            <Button size="lg">Launch a collection</Button>
          </Link>
          <Link href="/explore">
            <Button variant="secondary" size="lg">
              Explore
            </Button>
          </Link>
        </div>
      </section>

      {/* Stats. Three stamp cards, centered text, all three same
          treatment so the row reads as a triptych. */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-5 py-12 border-t border-border">
        <StatCard label="Storage" value="On chain" />
        <StatCard label="Permanence" value="Forever" />
        <StatCard label="Hosting" value="$0/mo" />
      </section>

      {/* How it works. */}
      <section className="py-20 border-t border-border">
        <div className="text-center mb-16">
          <h2 className="font-serif text-4xl font-bold tracking-tight">
            How it works
          </h2>
          <p className="text-foreground-secondary mt-3 max-w-md mx-auto">
            Three steps. No backend. No subscription.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-12">
          <StepCard
            step="1"
            title="Drop your folder"
            description="Upload metadata and images. Minti gzips and stores each byte as an Ethereum/Monad event log via EVMFS. No IPFS, no S3, no centralized service."
          />
          <StepCard
            step="2"
            title="Deploy and register"
            description="Minti deploys an immutable ERC-721 that delegates tokenURI to the canonical on-chain viewer, then registers your collection in one signed flow."
          />
          <StepCard
            step="3"
            title="Trade and verify"
            description="Every NFT can be independently re-fetched from any RPC and hash-verified. Listings settle through the minti orderbook. ERC-2981 royalties honored."
          />
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stamp-shadow border border-border p-8 bg-background-secondary text-center">
      <div className="text-xs text-foreground-secondary uppercase tracking-[0.2em] mb-3 font-serif">
        {label}
      </div>
      <div className="font-serif text-3xl font-bold">{value}</div>
    </div>
  );
}

function StepCard({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-start text-left">
      <div className="font-serif text-mint text-sm mb-4">
        <span className="text-foreground-secondary">Nº</span>{" "}
        <span className="font-bold">0{step}</span>
      </div>
      <h3 className="font-serif text-xl font-semibold mb-3">{title}</h3>
      <p className="text-sm text-foreground-secondary leading-relaxed">
        {description}
      </p>
    </div>
  );
}
