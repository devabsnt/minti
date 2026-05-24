"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient, useChainId } from "wagmi";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useRpc } from "@/providers/RpcProvider";
import { CHAIN_NAMES, DEFAULT_RPCS, getChainById } from "@/config/chains";
import {
  SigningModeSelector,
  type SigningMode,
} from "@/components/launch/SigningModeSelector";
import {
  launchCollection,
  type LaunchProgress,
  type LaunchResult,
} from "@/lib/launch/orchestrator";
import {
  EVMFS_DEFAULT,
  EVMFS_V1,
  EVMFS_V2,
  evmfsLabel,
  isRegistryDeployed,
  type EvmfsContract,
} from "@/lib/evmfs";

interface PreparedFiles {
  metadata: Array<{ tokenId: number; data: Record<string, unknown>; filename: string }>;
  images: Array<{ tokenId: number; bytes: Uint8Array; filename: string }>;
  errors: string[];
}

export function LaunchClient() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const { getPublicClient } = useRpc();

  const [files, setFiles] = useState<PreparedFiles | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [totalSupply, setTotalSupply] = useState(0);
  const [royaltyBps, setRoyaltyBps] = useState(500);
  const [evmfsContract, setEvmfsContract] = useState<EvmfsContract>(EVMFS_DEFAULT);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [signingMode, setSigningMode] = useState<SigningMode>({ kind: "connected" });
  const [progress, setProgress] = useState<LaunchProgress | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `chainId` from wagmi differs between SSR and client; only display
  // chain-derived text after mount to avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const chainLabel = mounted ? (CHAIN_NAMES[chainId] ?? `chain ${chainId}`) : "the connected chain";

  // For private-key mode we don't require a connected wallet — the pasted key
  // IS the signer. For connected-wallet mode we need both `address` and the
  // wagmi-provided wallet client.
  const isPkConfigured =
    signingMode.kind === "private-key" &&
    signingMode.address !== "0x0000000000000000000000000000000000000000";

  const effectiveAccount = isPkConfigured
    ? (signingMode as Extract<SigningMode, { kind: "private-key" }>).address
    : address;

  const ready =
    !!effectiveAccount &&
    (isPkConfigured || !!walletClient) &&
    !!files &&
    files.metadata.length > 0 &&
    files.images.length > 0 &&
    !!name &&
    !!symbol &&
    totalSupply > 0 &&
    isRegistryDeployed(chainId);

  const onFolderChosen = useCallback(async (selected: FileList | null) => {
    if (!selected) return;
    setError(null);
    const prepared = await prepareFiles(Array.from(selected));
    setFiles(prepared);
    if (prepared.metadata.length > 0 && !name) {
      const first = prepared.metadata[0].data as { name?: string };
      if (first.name) {
        // Strip trailing "#1" if present so user can set the collection name cleanly.
        setName(first.name.replace(/\s*#?\d+$/, "").trim());
      }
    }
    if (!totalSupply && prepared.metadata.length > 0) {
      setTotalSupply(prepared.metadata.length);
    }
  }, [name, totalSupply]);

  const onLaunch = useCallback(async () => {
    if (!ready || !files || !effectiveAccount) return;
    setError(null);
    setResult(null);
    setProgress({ phase: "idle", step: 0, totalSteps: 1, message: "Starting..." });
    try {
      const publicClient = getPublicClient(chainId);

      // Pick the signer: pasted private key OR connected wallet client.
      let signer = walletClient;
      if (signingMode.kind === "private-key" && isPkConfigured) {
        const chain = getChainById(chainId);
        if (!chain) throw new Error(`Unsupported chain ${chainId}`);
        signer = createWalletClient({
          account: privateKeyToAccount(signingMode.privateKey),
          chain,
          transport: http(DEFAULT_RPCS[chainId]),
        });
      }
      if (!signer) throw new Error("No wallet client available");

      const r = await launchCollection(
        {
          chainId,
          account: effectiveAccount,
          wallet: signer,
          publicClient,
          metadata: files.metadata.map(({ tokenId, data }) => ({ tokenId, data })),
          images: files.images,
          name,
          symbol,
          totalSupply,
          royaltyReceiver: effectiveAccount,
          royaltyBps,
          evmfsContract,
        },
        setProgress
      );
      setResult(r);
    } catch (e: unknown) {
      setError((e as Error).message ?? String(e));
      setProgress(null);
    }
  }, [
    ready,
    files,
    walletClient,
    effectiveAccount,
    signingMode,
    isPkConfigured,
    getPublicClient,
    chainId,
    name,
    symbol,
    totalSupply,
    royaltyBps,
    evmfsContract,
  ]);

  const totalCost = useMemo(() => {
    if (!files) return null;
    const imageBytes = files.images.reduce((sum, x) => sum + x.bytes.length, 0);
    const metadataBytes = files.metadata.reduce(
      (sum, x) => sum + JSON.stringify(x.data).length,
      0
    );
    return { imageBytes, metadataBytes, total: imageBytes + metadataBytes };
  }, [files]);

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <header>
        <h1 className="text-3xl font-bold mb-2">Launch a collection</h1>
        <p className="text-foreground-secondary text-sm">
          Drop a folder of metadata + images. Minti uploads everything to EVMFS,
          deploys an immutable ERC-721, and registers your collection — all on{" "}
          {chainLabel}. No server, no IPFS, no expiry.
        </p>
      </header>

      {!address && !isPkConfigured && (
        <Notice tone="warn">
          Connect a wallet to continue, or paste a private key in the signing
          section below.
        </Notice>
      )}

      {mounted && address && !isRegistryDeployed(chainId) && (
        <Notice tone="warn">
          The EVMFS collection registry isn&apos;t deployed on {chainLabel}{" "}
          yet. Deploy it via the Foundry script and update{" "}
          <code>EVMFS_COLLECTION_REGISTRY</code> in{" "}
          <code>lib/evmfs/addresses.ts</code>.
        </Notice>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">1. Choose your folder</h2>
        <p className="text-xs text-foreground-secondary">
          Include numbered JSON metadata (1.json, 2.json, …) and matching images
          (1.png, 2.png, …). Files are processed entirely in your browser.
        </p>
        <input
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          type="file"
          multiple
          onChange={(e) => onFolderChosen(e.target.files)}
          className="block w-full text-sm border border-border rounded-lg bg-background-secondary p-3 file:mr-3 file:px-3 file:py-1 file:bg-mint file:text-black file:rounded file:border-0 file:font-medium"
        />
        {files && (
          <div className="text-xs text-foreground-secondary space-y-1">
            <div>
              {files.metadata.length} metadata · {files.images.length} images
            </div>
            {totalCost && (
              <div>
                {(totalCost.total / 1024).toFixed(1)} KB total on chain
              </div>
            )}
            {files.errors.length > 0 && (
              <details className="text-danger">
                <summary>{files.errors.length} file(s) skipped</summary>
                <ul className="list-disc ml-5 mt-1">
                  {files.errors.slice(0, 10).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">2. Configure</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Collection" />
          </Field>
          <Field label="Symbol">
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="MYC" />
          </Field>
          <Field label="Total supply">
            <Input
              type="number"
              value={totalSupply || ""}
              onChange={(e) => setTotalSupply(Number(e.target.value) || 0)}
            />
          </Field>
          <Field label="Royalty (basis points, 100 = 1%)">
            <Input
              type="number"
              value={royaltyBps}
              onChange={(e) => setRoyaltyBps(Number(e.target.value) || 0)}
            />
          </Field>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-xs text-foreground-secondary hover:text-foreground transition-colors"
          >
            {advancedOpen ? "▾" : "▸"} Advanced options
          </button>
          {advancedOpen && (
            <div className="mt-3 border border-border rounded-lg p-3 bg-background-secondary space-y-2">
              <div className="text-xs text-foreground-secondary">
                Storage contract
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEvmfsContract(EVMFS_V2)}
                  className={`flex-1 px-3 py-2 rounded-md text-xs border transition-colors ${
                    evmfsContract === EVMFS_V2
                      ? "border-mint text-mint bg-mint/10"
                      : "border-border text-foreground-secondary hover:text-foreground"
                  }`}
                >
                  EVMFS V2 (recommended)
                  <div className="text-[10px] text-foreground-secondary mt-0.5 font-normal">
                    Records upload block on-chain
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setEvmfsContract(EVMFS_V1)}
                  className={`flex-1 px-3 py-2 rounded-md text-xs border transition-colors ${
                    evmfsContract === EVMFS_V1
                      ? "border-mint text-mint bg-mint/10"
                      : "border-border text-foreground-secondary hover:text-foreground"
                  }`}
                >
                  EVMFS V1 (legacy)
                  <div className="text-[10px] text-foreground-secondary mt-0.5 font-normal">
                    SKRUMPS-era interop only
                  </div>
                </button>
              </div>
              <p className="text-[11px] text-foreground-secondary">
                Most creators should leave this at V2. V1 is here for compatibility
                with older tooling that hasn&apos;t been updated. Active selection:{" "}
                <span className="text-foreground font-mono">
                  {evmfsLabel(evmfsContract)}
                </span>
                .
              </p>
            </div>
          )}
        </div>
      </section>

      <SigningModeSelector
        value={signingMode}
        onChange={setSigningMode}
        connectedAddress={address}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">3. Launch</h2>
        <p className="text-xs text-foreground-secondary">
          {signingMode.kind === "private-key"
            ? "Minti will sign every transaction automatically using the configured key — image batches, metadata batches, three manifest uploads, an ERC-721 deployment, the registry registration, and minting. Don't close this tab."
            : "You will be asked to sign multiple transactions in your wallet: image batches, metadata batches, three manifest uploads, an ERC-721 deployment, the registry registration, and minting. Don't close this tab."}
        </p>
        <Button disabled={!ready || !!progress} onClick={onLaunch}>
          {progress ? "Launching..." : "Launch collection"}
        </Button>
      </section>

      {progress && (
        <ProgressPanel progress={progress} />
      )}

      {error && (
        <Notice tone="error">
          <p className="font-medium mb-1">Something went wrong</p>
          <p className="text-xs break-words">{error}</p>
        </Notice>
      )}

      {result && (
        <SuccessPanel result={result} />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-foreground-secondary">{label}</span>
      {children}
    </label>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "warn" | "error";
  children: React.ReactNode;
}) {
  const border = tone === "error" ? "border-danger/30 bg-danger/5 text-danger" : "border-yellow-500/30 bg-yellow-500/5 text-yellow-300";
  return (
    <div className={`border rounded-xl p-4 text-sm ${border}`}>{children}</div>
  );
}

function ProgressPanel({ progress }: { progress: LaunchProgress }) {
  const pct = progress.totalSteps > 0 ? Math.round((progress.step / progress.totalSteps) * 100) : 0;
  return (
    <div className="border border-border rounded-xl p-4 bg-background-secondary space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span>{progress.message}</span>
        <span className="text-foreground-secondary text-xs">
          {progress.step}/{progress.totalSteps}
        </span>
      </div>
      <div className="h-2 bg-background-tertiary rounded overflow-hidden">
        <div
          className="h-full bg-mint transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.detail && (
        <div className="text-xs text-foreground-secondary">{progress.detail}</div>
      )}
    </div>
  );
}

function SuccessPanel({ result }: { result: LaunchResult }) {
  return (
    <div className="border border-mint/30 rounded-xl p-5 bg-mint/5 space-y-3">
      <h3 className="font-medium text-mint">Live on chain</h3>
      <div className="text-xs space-y-1 font-mono">
        <div>NFT: {result.nftContract}</div>
        <div>Registry id: {result.registryId.toString()}</div>
        <div>Metadata: {result.metadataManifest.hash}</div>
        <div>Image: {result.imageManifest.hash}</div>
        <div>Index: {result.indexManifest.hash}</div>
      </div>
      <a
        href={`/collection/${result.nftContract}`}
        className="text-sm text-mint hover:underline inline-block"
      >
        Open collection →
      </a>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

async function prepareFiles(files: File[]): Promise<PreparedFiles> {
  const metadata: PreparedFiles["metadata"] = [];
  const images: PreparedFiles["images"] = [];
  const errors: string[] = [];

  for (const file of files) {
    const name = file.name;
    const match = name.match(/^(\d+)(?:\.[^.]+)?$/i) || name.match(/^(\d+)\./);
    const tokenId = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(tokenId)) {
      errors.push(`${name}: filename doesn't start with a number`);
      continue;
    }

    const isJson = name.toLowerCase().endsWith(".json");
    if (isJson) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        metadata.push({ tokenId, data, filename: name });
      } catch (e: unknown) {
        errors.push(`${name}: ${(e as Error).message}`);
      }
    } else if (isImageFile(name)) {
      const buf = await file.arrayBuffer();
      images.push({ tokenId, bytes: new Uint8Array(buf), filename: name });
    } else {
      errors.push(`${name}: unsupported file type`);
    }
  }

  metadata.sort((a, b) => a.tokenId - b.tokenId);
  images.sort((a, b) => a.tokenId - b.tokenId);

  return { metadata, images, errors };
}

function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name);
}
