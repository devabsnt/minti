"use client";

import { useEffect } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { MINTI_MARKETPLACE_ADDRESS } from "@/config/chains";
import mintiAbi from "@/lib/abi/MintiMarketplace.json";

export function useMarketplaceWrite() {
  const queryClient = useQueryClient();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Invalidate marketplace queries when a transaction confirms
  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries({ queryKey: ["all-listings"] });
      queryClient.invalidateQueries({ queryKey: ["collection-listings"] });
      queryClient.invalidateQueries({ queryKey: ["collection-bids"] });
      queryClient.invalidateQueries({ queryKey: ["collection-offers"] });
      queryClient.invalidateQueries({ queryKey: ["owned-nfts"] });
    }
  }, [isSuccess, queryClient]);

  return {
    writeContract,
    hash,
    isPending,
    isConfirming,
    isSuccess,
    error,
    reset,
    marketplaceAddress: MINTI_MARKETPLACE_ADDRESS,
    marketplaceAbi: mintiAbi,
  };
}
