"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { MINTI_MARKETPLACE_ADDRESS } from "@/config/chains";

const ERC721_ABI = [
  {
    inputs: [{ type: "uint256", name: "tokenId" }],
    name: "getApproved",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "owner" },
      { type: "address", name: "operator" },
    ],
    name: "isApprovedForAll",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "to" },
      { type: "uint256", name: "tokenId" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "operator" },
      { type: "bool", name: "approved" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ERC1155_ABI = [
  {
    inputs: [
      { type: "address", name: "account" },
      { type: "address", name: "operator" },
    ],
    name: "isApprovedForAll",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "operator" },
      { type: "bool", name: "approved" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export function useNftApproval(
  nftContract: `0x${string}` | undefined,
  tokenId: bigint | undefined,
  owner: `0x${string}` | undefined,
  isERC1155: boolean
) {
  // Check single token approval (ERC721)
  const { data: approvedAddress } = useReadContract({
    address: nftContract,
    abi: ERC721_ABI,
    functionName: "getApproved",
    args: tokenId != null ? [tokenId] : undefined,
    query: { enabled: !!nftContract && tokenId != null && !isERC1155 },
  });

  // Check approval for all (both standards)
  const { data: isApprovedForAll } = useReadContract({
    address: nftContract,
    abi: isERC1155 ? ERC1155_ABI : ERC721_ABI,
    functionName: "isApprovedForAll",
    args: owner ? [owner, MINTI_MARKETPLACE_ADDRESS] : undefined,
    query: { enabled: !!nftContract && !!owner },
  });

  const isApproved =
    isApprovedForAll === true ||
    (approvedAddress?.toLowerCase() === MINTI_MARKETPLACE_ADDRESS.toLowerCase());

  const { writeContract: approve, data: approveHash, isPending: isApproving } =
    useWriteContract();

  const { isLoading: isWaitingApproval, isSuccess: approvalConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash });

  function requestApproval() {
    if (!nftContract) return;

    if (isERC1155) {
      approve({
        address: nftContract,
        abi: ERC1155_ABI,
        functionName: "setApprovalForAll",
        args: [MINTI_MARKETPLACE_ADDRESS, true],
      });
    } else {
      // Use setApprovalForAll for convenience (approve all at once)
      approve({
        address: nftContract,
        abi: ERC721_ABI,
        functionName: "setApprovalForAll",
        args: [MINTI_MARKETPLACE_ADDRESS, true],
      });
    }
  }

  return {
    isApproved: isApproved || approvalConfirmed,
    isApproving: isApproving || isWaitingApproval,
    requestApproval,
  };
}

// WETH approval for bids
const WETH_ABI = [
  {
    inputs: [
      { type: "address", name: "owner" },
      { type: "address", name: "spender" },
    ],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    name: "approve",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ type: "address", name: "account" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function useWethApproval(
  wethAddress: `0x${string}` | undefined,
  owner: `0x${string}` | undefined,
  requiredAmount: bigint
) {
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: wethAddress,
    abi: WETH_ABI,
    functionName: "allowance",
    args: owner ? [owner, MINTI_MARKETPLACE_ADDRESS] : undefined,
    query: { enabled: !!wethAddress && !!owner },
  });

  const { data: balance } = useReadContract({
    address: wethAddress,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!wethAddress && !!owner },
  });

  const MAX_UINT256 = 2n ** 256n - 1n;
  const hasAllowance = allowance === MAX_UINT256 || (allowance ?? 0n) >= requiredAmount;
  const hasBalance = (balance ?? 0n) >= requiredAmount;

  const { writeContract: approve, data: approveHash, isPending: isApproving } =
    useWriteContract();

  const { isLoading: isWaitingApproval, isSuccess: approvalConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash });

  function requestApproval() {
    if (!wethAddress) return;
    approve({
      address: wethAddress,
      abi: WETH_ABI,
      functionName: "approve",
      args: [MINTI_MARKETPLACE_ADDRESS, requiredAmount],
    });
  }

  return {
    hasAllowance: hasAllowance || approvalConfirmed,
    hasBalance,
    balance: balance ?? 0n,
    isApproving: isApproving || isWaitingApproval,
    requestApproval,
    refetchAllowance,
  };
}
