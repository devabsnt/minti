"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { RoyaltySelector } from "./RoyaltySelector";
import { useMarketplaceWrite } from "@/hooks/useMarketplaceWrite";
import { useToast } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/format";
import { useBrowseChain } from "@/providers/ChainProvider";
import { getNativeSymbol } from "@/config/chains";

interface BuyButtonProps {
  listingId: bigint;
  price: bigint;
  seller: string;
  currentUserAddress?: string;
}

export function BuyButton({
  listingId,
  price,
  seller,
  currentUserAddress,
}: BuyButtonProps) {
  const [showModal, setShowModal] = useState(false);
  const [royaltyBps, setRoyaltyBps] = useState(0);
  const { addToast, updateToast } = useToast();
  const { browseChainId } = useBrowseChain();
  const symbol = getNativeSymbol(browseChainId);

  const {
    writeContract,
    isPending,
    isConfirming,
    isSuccess,
    error,
    marketplaceAddress,
    marketplaceAbi,
    reset,
  } = useMarketplaceWrite();

  const isSeller =
    currentUserAddress?.toLowerCase() === seller.toLowerCase();

  useEffect(() => {
    if (isSuccess) {
      addToast({ type: "success", message: "NFT purchased!" });
      setShowModal(false);
      reset();
    }
  }, [isSuccess, addToast, reset]);

  useEffect(() => {
    if (error) {
      addToast({
        type: "error",
        message: error.message.includes("User rejected")
          ? "Transaction rejected"
          : "Purchase failed",
      });
    }
  }, [error, addToast]);

  function handleBuy() {
    const toastId = addToast({ type: "pending", message: "Purchasing NFT..." });

    writeContract(
      {
        address: marketplaceAddress,
        abi: marketplaceAbi,
        functionName: "buyItem",
        args: [listingId, royaltyBps],
        value: price,
      },
      {
        onError: () => {
          updateToast(toastId, { type: "error", message: "Purchase failed" });
        },
      }
    );
  }

  return (
    <>
      <Button
        onClick={() => setShowModal(true)}
        disabled={isSeller}
        className="w-full"
      >
        {isSeller ? "Your Listing" : `Buy for ${formatPrice(price)} ${symbol}`}
      </Button>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Buy NFT">
        <div className="space-y-4">
          <div className="flex justify-between text-sm">
            <span className="text-foreground-secondary">Price</span>
            <span className="text-mint font-medium">
              {formatPrice(price)} {symbol}
            </span>
          </div>

          <RoyaltySelector value={royaltyBps} onChange={setRoyaltyBps} />

          {royaltyBps > 0 && (
            <div className="flex justify-between text-xs text-foreground-secondary">
              <span>Creator royalty</span>
              <span>{(royaltyBps / 100).toFixed(1)}%</span>
            </div>
          )}

          <Button
            onClick={handleBuy}
            loading={isPending || isConfirming}
            className="w-full"
          >
            {isPending
              ? "Confirm in Wallet..."
              : isConfirming
                ? "Confirming..."
                : "Confirm Purchase"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
