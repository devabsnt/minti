"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { useMarketplaceWrite } from "@/hooks/useMarketplaceWrite";
import { useToast } from "@/components/ui/Toast";

// ═══════════════════════ CANCEL LISTING ═══════════════════════

export function CancelListingButton({
  listingId,
  onSuccess,
}: {
  listingId: bigint;
  onSuccess?: () => void;
}) {
  const { addToast, updateToast } = useToast();
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
      addToast({ type: "success", message: "Listing cancelled" });
      reset();
      onSuccess?.();
    }
  }, [isSuccess, addToast, reset, onSuccess]);

  useEffect(() => {
    if (error) {
      addToast({ type: "error", message: "Failed to cancel listing" });
    }
  }, [error, addToast]);

  return (
    <Button
      variant="danger"
      size="sm"
      loading={isPending || isConfirming}
      onClick={() => {
        addToast({ type: "pending", message: "Cancelling listing..." });
        writeContract({
          address: marketplaceAddress,
          abi: marketplaceAbi,
          functionName: "cancelListing",
          args: [listingId],
        });
      }}
    >
      Cancel Listing
    </Button>
  );
}

// ═══════════════════════ CANCEL BID ═══════════════════════

export function CancelBidButton({
  bidId,
  onSuccess,
}: {
  bidId: bigint;
  onSuccess?: () => void;
}) {
  const { addToast } = useToast();
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
      addToast({ type: "success", message: "Bid cancelled" });
      reset();
      onSuccess?.();
    }
  }, [isSuccess, addToast, reset, onSuccess]);

  useEffect(() => {
    if (error) {
      addToast({ type: "error", message: "Failed to cancel bid" });
    }
  }, [error, addToast]);

  return (
    <Button
      variant="danger"
      size="sm"
      loading={isPending || isConfirming}
      onClick={() => {
        addToast({ type: "pending", message: "Cancelling bid..." });
        writeContract({
          address: marketplaceAddress,
          abi: marketplaceAbi,
          functionName: "cancelBid",
          args: [bidId],
        });
      }}
    >
      Cancel Bid
    </Button>
  );
}

// ═══════════════════════ ACCEPT BID ═══════════════════════

export function AcceptBidButton({
  bidId,
  onSuccess,
}: {
  bidId: bigint;
  onSuccess?: () => void;
}) {
  const { addToast } = useToast();
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
      addToast({ type: "success", message: "Bid accepted!" });
      reset();
      onSuccess?.();
    }
  }, [isSuccess, addToast, reset, onSuccess]);

  useEffect(() => {
    if (error) {
      addToast({ type: "error", message: "Failed to accept bid" });
    }
  }, [error, addToast]);

  return (
    <Button
      size="sm"
      loading={isPending || isConfirming}
      onClick={() => {
        addToast({ type: "pending", message: "Accepting bid..." });
        writeContract({
          address: marketplaceAddress,
          abi: marketplaceAbi,
          functionName: "acceptBid",
          args: [bidId],
        });
      }}
    >
      Accept
    </Button>
  );
}

// ═══════════════════════ CANCEL COLLECTION OFFER ═══════════════════════

export function CancelOfferButton({
  offerId,
  onSuccess,
}: {
  offerId: bigint;
  onSuccess?: () => void;
}) {
  const { addToast } = useToast();
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
      addToast({ type: "success", message: "Offer cancelled" });
      reset();
      onSuccess?.();
    }
  }, [isSuccess, addToast, reset, onSuccess]);

  useEffect(() => {
    if (error) {
      addToast({ type: "error", message: "Failed to cancel offer" });
    }
  }, [error, addToast]);

  return (
    <Button
      variant="danger"
      size="sm"
      loading={isPending || isConfirming}
      onClick={() => {
        addToast({ type: "pending", message: "Cancelling offer..." });
        writeContract({
          address: marketplaceAddress,
          abi: marketplaceAbi,
          functionName: "cancelCollectionOffer",
          args: [offerId],
        });
      }}
    >
      Cancel Offer
    </Button>
  );
}

// ═══════════════════════ ACCEPT COLLECTION OFFER ═══════════════════════

export function AcceptCollectionOfferButton({
  offerId,
  tokenId,
  onSuccess,
}: {
  offerId: bigint;
  tokenId: bigint;
  onSuccess?: () => void;
}) {
  const { addToast } = useToast();
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
      addToast({ type: "success", message: "Collection offer accepted!" });
      reset();
      onSuccess?.();
    }
  }, [isSuccess, addToast, reset, onSuccess]);

  useEffect(() => {
    if (error) {
      addToast({ type: "error", message: "Failed to accept offer" });
    }
  }, [error, addToast]);

  return (
    <Button
      size="sm"
      loading={isPending || isConfirming}
      onClick={() => {
        addToast({ type: "pending", message: "Accepting offer..." });
        writeContract({
          address: marketplaceAddress,
          abi: marketplaceAbi,
          functionName: "acceptCollectionOffer",
          args: [offerId, tokenId],
        });
      }}
    >
      Accept Offer
    </Button>
  );
}
