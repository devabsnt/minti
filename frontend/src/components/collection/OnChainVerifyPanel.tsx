"use client";

import { useState } from "react";

import {
  EVMFS_GATEWAY_FALLBACK,
  evmfsLabel,
  fetchEvmfsBlob,
  formatEvmfsUrl,
  type EvmfsContract,
} from "@/lib/evmfs";
import { useBrowseChain } from "@/providers/ChainProvider";
import { CHAIN_NAMES } from "@/config/chains";

interface OnChainVerifyPanelProps {
  metadataManifest: `0x${string}`;
  metadataBlock: bigint | number;
  evmfsContract: EvmfsContract;
  /** Optional token id to deep-link the launcher at a specific entry. */
  tokenId?: bigint;
}

type VerifyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; ms: number; bytes: number }
  | { kind: "err"; message: string };

/**
 * Click-to-expand provenance panel. Shows the structured EVMFS pointer for the
 * collection's metadata manifest, deep-links to the EVMFS launcher, and runs a
 * keccak-verified re-fetch via `eth_getLogs` on the user's RPC.
 */
export function OnChainVerifyPanel({
  metadataManifest,
  metadataBlock,
  evmfsContract,
  tokenId,
}: OnChainVerifyPanelProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const { browseChainId } = useBrowseChain();

  const blockNumber = Number(metadataBlock);
  const pointer = {
    chainId: browseChainId,
    block: blockNumber,
    manifestHash: metadataManifest,
    path: tokenId !== undefined ? tokenId.toString() : "",
  };
  const launcherUrl = formatEvmfsUrl(pointer, EVMFS_GATEWAY_FALLBACK);

  const verify = async () => {
    setState({ kind: "checking" });
    const started = performance.now();
    try {
      const bytes = await fetchEvmfsBlob({
        chainId: browseChainId,
        block: blockNumber,
        hash: metadataManifest,
        evmfsContract,
      });
      setState({
        kind: "ok",
        ms: Math.round(performance.now() - started),
        bytes: bytes.length,
      });
    } catch (e: unknown) {
      setState({ kind: "err", message: (e as Error).message ?? String(e) });
    }
  };

  return (
    <div className="border border-mint/30 rounded-xl bg-mint/5 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-mint" />
          <span className="font-medium text-mint">100% on-chain</span>
          <span className="text-xs text-foreground-secondary">
            verifiable provenance
          </span>
        </span>
        <span className="text-xs text-foreground-secondary">
          {open ? "Hide" : "Show details"}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-mint/20 pt-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs font-mono break-all">
            <dt className="text-foreground-secondary">chain</dt>
            <dd>
              {CHAIN_NAMES[browseChainId] ?? `chain ${browseChainId}`} ({browseChainId})
            </dd>
            <dt className="text-foreground-secondary">storage</dt>
            <dd>
              EVMFS {evmfsLabel(evmfsContract).toUpperCase()}{" "}
              <span className="text-foreground-secondary">({evmfsContract})</span>
            </dd>
            <dt className="text-foreground-secondary">block</dt>
            <dd>{blockNumber.toLocaleString()}</dd>
            <dt className="text-foreground-secondary">hash</dt>
            <dd>{metadataManifest}</dd>
          </dl>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={verify}
              disabled={state.kind === "checking"}
              className="text-xs px-3 py-1.5 rounded-md border border-mint/40 text-mint hover:bg-mint/10 disabled:opacity-50"
            >
              {state.kind === "checking" ? "Verifying…" : "Verify on-chain"}
            </button>
            <a
              href={launcherUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:border-mint/40 hover:text-mint"
            >
              View on chain ↗
            </a>
            <VerifyStatus state={state} />
          </div>

          <p className="text-[11px] text-foreground-secondary">
            Re-fetches the metadata bytes via <code>eth_getLogs</code> and
            asserts <code>keccak256(bytes) == hash</code>. No gateway involved.
          </p>
        </div>
      )}
    </div>
  );
}

function VerifyStatus({ state }: { state: VerifyState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "checking")
    return (
      <span className="text-xs text-foreground-secondary">
        Reading event log…
      </span>
    );
  if (state.kind === "ok")
    return (
      <span className="text-xs text-mint">
        ✓ Verified · {state.bytes.toLocaleString()} bytes · {state.ms}ms
      </span>
    );
  return (
    <span className="text-xs text-danger" title={state.message}>
      ✗ Verification failed
    </span>
  );
}
