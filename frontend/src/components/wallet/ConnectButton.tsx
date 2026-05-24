"use client";

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
                className="px-4 py-2 bg-mint text-background font-medium text-sm rounded-lg hover:bg-mint-dim transition-colors"
              >
                Connect Wallet
              </button>
            ) : chain.unsupported ? (
              <button
                onClick={openConnectModal}
                className="px-4 py-2 text-sm border border-danger/50 text-danger rounded-lg hover:bg-danger/10 transition-colors"
              >
                Wrong Network
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <a
                  href={`/wallet/${account.address}`}
                  className="text-sm text-foreground-secondary hover:text-mint transition-colors"
                >
                  {account.displayName}
                </a>
                <button
                  onClick={openAccountModal}
                  className="px-3 py-2 text-sm border border-border rounded-lg hover:border-mint/50 hover:text-mint transition-colors"
                >
                  Wallet
                </button>
              </div>
            )}
          </div>
        );
      }}
    </RainbowConnectButton.Custom>
  );
}
