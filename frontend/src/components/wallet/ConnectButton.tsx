"use client";

import Link from "next/link";
import { ConnectButton as RainbowConnectButton } from "@rainbow-me/rainbowkit";

export function ConnectButton() {
  return (
    <RainbowConnectButton.Custom>
      {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        return (
          <div
            {...(!ready && {
              "aria-hidden": true,
              style: {
                opacity: 0,
                pointerEvents: "none" as const,
                userSelect: "none" as const,
              },
            })}
          >
            {!connected ? (
              <button
                onClick={openConnectModal}
                className="px-4 py-2 bg-mint text-background font-medium text-sm hover:bg-mint-dim transition-colors"
              >
                Connect wallet
              </button>
            ) : chain.unsupported ? (
              <button
                onClick={openConnectModal}
                className="px-4 py-2 text-sm border border-danger/50 text-danger hover:bg-danger/10 transition-colors"
              >
                Wrong network
              </button>
            ) : (
              // Connected view. The address is a Link to the user's
              // wallet profile page. The small chevron next to it opens
              // RainbowKit's account modal (disconnect, copy, chain
              // switch). Two distinct affordances on one compact control.
              <div className="flex items-center border border-border bg-background-secondary hover:border-border-hover transition-colors">
                <Link
                  href={`/wallet/${account.address}`}
                  className="text-sm text-foreground hover:text-mint transition-colors pl-3 pr-2 py-2"
                >
                  {account.displayName}
                </Link>
                <button
                  onClick={openAccountModal}
                  className="px-2 py-2 text-foreground-secondary hover:text-foreground transition-colors border-l border-border"
                  aria-label="Account menu"
                  title="Account menu"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-4 h-4"
                    aria-hidden
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.24 4.5a.75.75 0 0 1-1.08 0l-4.24-4.5a.75.75 0 0 1 .02-1.06Z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            )}
          </div>
        );
      }}
    </RainbowConnectButton.Custom>
  );
}
