// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MintiMarketplace} from "../src/MintiMarketplace.sol";
import {EVMFSCollectionRegistry} from "../src/EVMFSCollectionRegistry.sol";

/// @notice Deploys minti.art's chain-local contracts:
///   - MintiMarketplace (existing orderbook)
///   - EVMFSCollectionRegistry (registry for V1 + V2 EVMFS collections)
///
/// EVMFS V1, V2, and the canonical BlockIndex are already deployed at
/// well-known addresses (see EVMFSCollectionRegistry's constants and the
/// frontend's `lib/evmfs/addresses.ts`). minti does NOT deploy its own
/// BlockIndex — the canonical EVMFSBlockIndex on each chain handles V1
/// hash → block lookups.
contract DeployMintiMarketplace is Script {
    // Canonical WETH addresses per chain.
    function _getWethForChain(uint256 chainId) internal pure returns (address) {
        if (chainId == 1) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // Ethereum
        if (chainId == 8453) return 0x4200000000000000000000000000000000000006; // Base
        if (chainId == 10) return 0x4200000000000000000000000000000000000006; // Optimism
        if (chainId == 42161) return 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // Arbitrum
        if (chainId == 137) return 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619; // Polygon
        if (chainId == 143) return 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A; // Monad
        if (chainId == 11155111) return 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9; // Sepolia
        if (chainId == 84532) return 0x4200000000000000000000000000000000000006; // Base Sepolia
        revert("Unsupported chain");
    }

    function run() external {
        address wethAddress = _getWethForChain(block.chainid);
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        console.log("=== Deploying minti.art stack ===");
        console.log("Chain ID:", block.chainid);
        console.log("WETH:", wethAddress);
        console.log("Fee Recipient:", feeRecipient);

        vm.startBroadcast();

        MintiMarketplace marketplace =
            new MintiMarketplace{salt: keccak256("minti-marketplace-v1")}(wethAddress, feeRecipient);
        console.log("MintiMarketplace:        ", address(marketplace));

        EVMFSCollectionRegistry registry =
            new EVMFSCollectionRegistry{salt: keccak256("minti-collection-registry-v2")}();
        console.log("EVMFSCollectionRegistry: ", address(registry));

        vm.stopBroadcast();
    }
}
