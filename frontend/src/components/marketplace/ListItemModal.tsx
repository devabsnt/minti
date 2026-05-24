"use client";

import { useState, useEffect } from "react";
import { parseEther } from "viem";
import { useAccount } from "wagmi";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useNftApproval } from "@/hooks/useApproval";
import { useMarketplaceWrite } from "@/hooks/useMarketplaceWrite";
import { useToast } from "@/components/ui/Toast";
import { useBrowseChain } from "@/providers/ChainProvider";
import { getNativeSymbol } from "@/config/chains";

interface ListItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  nftContract: `0x${string}`;
  tokenId: bigint;
  isERC1155?: boolean;
  tokenName?: string;
}

export function ListItemModal({
  isOpen,
  onClose,
  nftContract,
  tokenId,
  isERC1155 = false,
  tokenName,
}: ListItemModalProps) {
  const { address } = useAccount();
  const { browseChainId } = useBrowseChain();
  const symbol = getNativeSymbol(browseChainId);
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const { addToast, updateToast } = useToast();

  const {
    isApproved,
    isApproving,
    requestApproval,
  } = useNftApproval(nftContract, tokenId, address, isERC1155);

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
      addToast({ type: "success", message: "Item listed successfully!" });
      onClose();
      reset();
      setPrice("");
      setQuantity("1");
    }
  }, [isSuccess, addToast, onClose, reset]);

  useEffect(() => {
    if (error) {
      addToast({
        type: "error",
        message: error.message.includes("User rejected")
          ? "Transaction rejected"
          : "Failed to list item",
      });
    }
  }, [error, addToast]);

  function handleList() {
    if (!price || parseFloat(price) <= 0) return;

    const toastId = addToast({ type: "pending", message: "Listing item..." });

    writeContract(
      {
        address: marketplaceAddress,
        abi: marketplaceAbi,
        functionName: "listItem",
        args: [
          nftContract,
          tokenId,
          parseEther(price),
          BigInt(quantity),
          isERC1155,
        ],
      },
      {
        onError: () => {
          updateToast(toastId, { type: "error", message: "Failed to list item" });
        },
      }
    );
  }

  const priceValid = price && parseFloat(price) > 0;
  const quantityValid = parseInt(quantity) > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="List Item for Sale">
      <div className="space-y-4">
        <p className="text-sm text-foreground-secondary">
          {tokenName || `Token #${tokenId.toString()}`}
        </p>

        <Input
          label="Price"
          suffix={symbol}
          type="number"
          step="0.001"
          min="0"
          placeholder="0.00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />

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

        {!isApproved ? (
          <Button
            onClick={requestApproval}
            loading={isApproving}
            className="w-full"
          >
            {isApproving ? "Approving..." : "Approve Marketplace"}
          </Button>
        ) : (
          <Button
            onClick={handleList}
            loading={isPending || isConfirming}
            disabled={!priceValid || !quantityValid}
            className="w-full"
          >
            {isPending
              ? "Confirm in Wallet..."
              : isConfirming
                ? "Confirming..."
                : "List for Sale"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
