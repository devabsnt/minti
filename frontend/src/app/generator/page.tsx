import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "NFT Generator (coming soon)",
  description:
    "Generative art tool for NFT collections. Trait layers, exclusion rules, on-chain RLE rendering, IPFS export.",
};

export default function GeneratorPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-20 flex flex-col items-center text-center">
      <Image
        src="/mintiMascot.png"
        alt="Minti mascot"
        width={80}
        height={80}
        className="mb-6 opacity-50"
      />

      <h1 className="text-2xl font-bold mb-3">NFT Generator</h1>

      <p className="text-foreground-secondary max-w-md mb-4">
        The generative art tool is coming soon. Upload trait layers, configure
        rules, apply effects, and create collections, with optional on-chain
        RLE art storage.
      </p>

      <div className="flex flex-wrap gap-3 justify-center text-xs text-foreground-secondary">
        <span className="border border-border rounded-full px-3 py-1">
          Trait layers
        </span>
        <span className="border border-border rounded-full px-3 py-1">
          Exclusion rules
        </span>
        <span className="border border-border rounded-full px-3 py-1">
          CSS/Photoshop effects
        </span>
        <span className="border border-border rounded-full px-3 py-1">
          RLE on-chain art
        </span>
        <span className="border border-border rounded-full px-3 py-1">
          IPFS export
        </span>
        <span className="border border-border rounded-full px-3 py-1">
          Pixel rendering
        </span>
      </div>
    </div>
  );
}
