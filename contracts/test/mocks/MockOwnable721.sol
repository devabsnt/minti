// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal stand-in for an Ownable ERC-721 used by the registry's
///         non-EVMFS auth path. Only exposes `owner()`.
contract MockOwnable721 {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOwner(address newOwner) external {
        owner = newOwner;
    }
}
