"use client";

import { useMemo, useState } from "react";
import { privateKeyToAccount } from "viem/accounts";

export type SigningMode =
  | { kind: "connected" }
  | { kind: "private-key"; privateKey: `0x${string}`; address: `0x${string}` };

interface Props {
  value: SigningMode;
  onChange: (next: SigningMode) => void;
  connectedAddress: `0x${string}` | undefined;
}

const PK_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Two-mode signing UX, mirroring the EVMFS site:
 *   - Connected wallet (default; one wallet prompt per tx)
 *   - Private key (auto-sign; the key sits in memory only, never persisted)
 *
 * The key is kept inside this component's state — once configured it's lifted
 * up via `onChange`. Closing/refreshing the tab discards it.
 */
export function SigningModeSelector({ value, onChange, connectedAddress }: Props) {
  const [pk, setPk] = useState("");
  const [reveal, setReveal] = useState(false);

  const normalized = useMemo(() => {
    const trimmed = pk.trim();
    if (!PK_REGEX.test(trimmed)) return null;
    return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
  }, [pk]);

  const isConfigured = value.kind === "private-key";

  const applyKey = () => {
    if (!normalized) return;
    try {
      const account = privateKeyToAccount(normalized);
      onChange({ kind: "private-key", privateKey: normalized, address: account.address });
    } catch {
      // privateKeyToAccount throws on malformed input — already gated by regex
      // but keep a defensive no-op.
    }
  };

  const clearKey = () => {
    setPk("");
    onChange({ kind: "connected" });
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">2.5 Signing</h2>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange({ kind: "connected" })}
          className={`flex-1 px-3 py-2 rounded-md text-xs border transition-colors ${
            value.kind === "connected"
              ? "border-mint text-mint bg-mint/10"
              : "border-border text-foreground-secondary hover:text-foreground"
          }`}
        >
          Connected wallet
          <div className="text-[10px] text-foreground-secondary mt-0.5 font-normal">
            One wallet confirmation per transaction
          </div>
        </button>
        <button
          type="button"
          onClick={() => onChange({ kind: "private-key", privateKey: "0x" as `0x${string}`, address: "0x0000000000000000000000000000000000000000" as `0x${string}` })}
          // Pre-select the mode UI even before a key is entered; actual key
          // submission happens via the form below.
          className={`flex-1 px-3 py-2 rounded-md text-xs border transition-colors ${
            value.kind === "private-key"
              ? "border-mint text-mint bg-mint/10"
              : "border-border text-foreground-secondary hover:text-foreground"
          }`}
        >
          Private key (auto-sign)
          <div className="text-[10px] text-foreground-secondary mt-0.5 font-normal">
            Sign every tx silently from a pasted key
          </div>
        </button>
      </div>

      {value.kind === "private-key" && (
        <div className="border border-yellow-500/40 rounded-lg bg-yellow-500/5 p-4 space-y-3 text-sm">
          <div className="text-yellow-300 font-medium text-xs uppercase tracking-wider">
            Security note
          </div>
          <p className="text-xs text-foreground-secondary leading-relaxed">
            Your private key stays in your browser and is never sent to any
            server. It&apos;s only used locally to sign transactions, and is
            discarded when you close or refresh this page. Even so, for safety,
            create a new wallet specifically for this launch. Transfer only the
            funds needed, then discard the key. <strong>Never paste a key from
            a wallet that holds significant funds.</strong>
          </p>

          {!isConfigured || value.address === "0x0000000000000000000000000000000000000000" ? (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-foreground-secondary">Private key</span>
                <div className="flex gap-2">
                  <input
                    type={reveal ? "text" : "password"}
                    value={pk}
                    onChange={(e) => setPk(e.target.value)}
                    placeholder="0x..."
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 font-mono text-xs bg-background-secondary border border-border rounded-lg px-3 py-2"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((v) => !v)}
                    className="text-xs text-foreground-secondary hover:text-foreground border border-border rounded-lg px-3"
                  >
                    {reveal ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
              <button
                type="button"
                onClick={applyKey}
                disabled={!normalized}
                className="text-xs px-3 py-2 rounded-md bg-mint text-background font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Use private key for automatic signing
              </button>
            </>
          ) : (
            <div className="flex items-center justify-between text-xs">
              <div className="space-y-0.5">
                <div className="text-mint">
                  ✓ Key configured. Transactions will be signed automatically.
                </div>
                <div className="text-foreground-secondary font-mono">
                  {value.address}
                  {connectedAddress &&
                    connectedAddress.toLowerCase() !== value.address.toLowerCase() && (
                      <span className="ml-2 text-yellow-300">
                        (differs from connected wallet)
                      </span>
                    )}
                </div>
              </div>
              <button
                type="button"
                onClick={clearKey}
                className="text-foreground-secondary hover:text-danger underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
