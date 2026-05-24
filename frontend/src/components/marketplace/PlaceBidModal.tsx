"use client";

import { useState, useEffect } from "react";
import { parseEther } from "viem";
import { useAccount } from "wagmi";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { RoyaltySelector } from "./RoyaltySelector";
import { useWethApproval } from "@/hooks/useApproval";
import { useMarketplaceWrite } from "@/hooks/useMarketplaceWrite";
import { useToast } from "@/components/ui/Toast";
import { useBrowseChain } from "@/providers/ChainProvider";
import { WETH_ADDRESSES } from "@/config/chains";
import { formatPrice } from "@/lib/format";

interface PlaceBidModalProps {
  isOpen: boolean;
  onClose: () => void;
  nftContract: `0x${string}`;
  tokenId: bigint;
  isERC1155?: boolean;
  tokenName?: string;
}

export function PlaceBidModal({
  isOpen,
  onClose,
  nftContract,
  tokenId,
  isERC1155 = false,
  tokenName,
}: PlaceBidModalProps) {
  const { address } = useAccount();
  const { browseChainId } = useBrowseChain();
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [royaltyBps, setRoyaltyBps] = useState(0);
  const { addToast, updateToast } = useToast();

  const wethAddress = WETH_ADDRESSES[browseChainId];
  const parsedAmount = amount && parseFloat(amount) > 0 ? parseEther(amount) : 0n;

  const {
    hasAllowance,
    hasBalance,
    balance,
    isApproving,
    requestApproval,
  } = useWethApproval(wethAddress, address, parsedAmount);

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

  useEffect(() => {
    if (isSuccess) {
      addToast({ type: "success", message: "Bid placed!" });
      onClose();
      reset();
      setAmount("");
      setQuantity("1");
      setRoyaltyBps(0);
    }
  }, [isSuccess, addToast, onClose, reset]);

  useEffect(() => {
    if (error) {
      addToast({
        type: "error",
        message: error.message.includes("User rejected")
          ? "Transaction rejected"
          : "Failed to place bid",
      });
    }
  }, [error, addToast]);

  function handlePlaceBid() {
    if (!amount || parseFloat(amount) <= 0) return;

    const toastId = addToast({ type: "pending", message: "Placing bid..." });

    writeContract(
      {
        address: marketplaceAddress,
        abi: marketplaceAbi,
        functionName: "placeBid",
        args: [
          nftContract,
          tokenId,
          parsedAmount,
          BigInt(quantity),
          isERC1155,
          royaltyBps,
        ],
      },
      {
        onError: () => {
          updateToast(toastId, { type: "error", message: "Failed to place bid" });
        },
      }
    );
  }

  const amountValid = amount && parseFloat(amount) > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Place Bid">
      <div className="space-y-4">
        <p className="text-sm text-foreground-secondary">
          {tokenName || `Token #${tokenId.toString()}`}
        </p>

        <Input
          label="Bid Amount"
          suffix="WETH"
          type="number"
          step="0.001"
          min="0"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        <p className="text-xs text-foreground-secondary">
          WETH Balance: {formatPrice(balance)} WETH
        </p>

        {isERC1155 && (
          <Input
            label="Quantity"
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        )}

        <RoyaltySelector value={royaltyBps} onChange={setRoyaltyBps} />

        {!hasBalance && parsedAmount > 0n && (
          <p className="text-xs text-danger">Insufficient WETH balance</p>
        )}

        {!hasAllowance && hasBalance && parsedAmount > 0n ? (
          <Button
            onClick={requestApproval}
            loading={isApproving}
            className="w-full"
          >
            {isApproving ? "Approving WETH..." : "Approve WETH"}
          </Button>
        ) : (
          <Button
            onClick={handlePlaceBid}
            loading={isPending || isConfirming}
            disabled={!amountValid || !hasBalance}
            className="w-full"
          >
            {isPending
              ? "Confirm in Wallet..."
              : isConfirming
                ? "Confirming..."
                : "Place Bid"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
