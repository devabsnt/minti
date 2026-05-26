import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "NFT Generator (coming soon)",
  description:
    "Generative art tool for NFT collections. Trait layers, exclusion rules, on-chain RLE rendering, IPFS export.",
};

const FEATURES = [
  "Trait layers",
  "Exclusion rules",
  "CSS / Photoshop effects",
  "RLE on-chain art",
  "IPFS export",
  "Pixel rendering",
];

export default function GeneratorPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-24 flex flex-col items-center text-center">
      <Image
        src="/mintiMascot.png"
        alt="Minti mascot"
        width={96}
        height={96}
        className="mb-8 opacity-40"
      />

      <p className="text-xs text-foreground-secondary uppercase tracking-wider mb-3">
        Coming soon
      </p>
      <h1 className="text-3xl font-bold tracking-tight mb-4">
        NFT Generator
      </h1>

      <p className="text-foreground-secondary mb-10 leading-relaxed">
        A generative art tool for NFT collections. Upload trait layers,
        configure rules, apply effects, and create collections, with
        optional on-chain RLE art storage.
      </p>

      <div className="flex flex-wrap gap-2 justify-center text-xs text-foreground-secondary">
        {FEATURES.map((label) => (
          <span
            key={label}
            className="border border-border px-3 py-1.5 bg-background-secondary"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
