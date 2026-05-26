"use client";

import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/Button";

export default function HomePage() {
  return (
    <div className="max-w-7xl mx-auto px-4">
      {/* Hero */}
      <section className="flex flex-col items-center text-center py-20 md:py-32">
        <Image
          src="/mintiSVG.svg"
          alt="Minti mascot"
          width={200}
          height={200}
          className="mb-4"
          priority
        />
        <p className="text-2xl font-bold mb-8">
          <span className="text-mint">minti</span>
          <span className="text-foreground">.art</span>
        </p>

        <h1 className="text-4xl md:text-6xl font-bold mb-4">
          The home for
          <br />
          <span className="text-mint">on-chain</span> collections
        </h1>

        <p className="text-foreground-secondary text-lg max-w-xl mb-8">
          Launch NFT collections that live entirely on chain via EVMFS — no
          hosting, no expiry.
        </p>

        <div className="flex gap-3">
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

      {/* Stats */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6 py-12 border-t border-border">
        <StatCard label="Storage" value="On chain" />
        <StatCard label="Permanence" value="Forever" />
        <StatCard label="Hosting" value="$0/mo" />
      </section>

      {/* How it works */}
      <section className="py-16 border-t border-border">
        <h2 className="text-2xl font-bold text-center mb-12">How it works</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <StepCard
            step="1"
            title="Drop your folder"
            description="Upload metadata and images. Minti gzips and stores each byte as an Ethereum/Monad event log via EVMFS — no IPFS, no S3, no centralized service."
          />
          <StepCard
            step="2"
            title="Deploy + register"
            description="Minti deploys an immutable ERC-721 that delegates tokenURI to the canonical on-chain viewer, then registers your collection in one signed flow."
          />
          <StepCard
            step="3"
            title="Trade & verify"
            description="Every NFT can be independently re-fetched from any RPC and hash-verified. Listings settle through the minti orderbook. ERC-2981 royalties honored."
          />
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-xl p-6 text-center bg-background-secondary">
      <div className="text-3xl font-bold text-mint mb-1">{value}</div>
      <div className="text-sm text-foreground-secondary">{label}</div>
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
    <div className="flex flex-col items-center text-center">
      <div className="w-10 h-10 rounded-full border-2 border-mint flex items-center justify-center text-mint font-bold mb-4">
        {step}
      </div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-foreground-secondary">{description}</p>
    </div>
  );
}
