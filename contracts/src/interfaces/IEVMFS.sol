// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface to the canonical EVMFS storage contracts.
///
/// Two versions are deployed at the same address on every EVM chain via
/// CREATE2 / Safe Singleton Factory:
///   V1 (legacy): 0x140cbDFf649929D003091a5B8B3be34588753aBA
///   V2 (default):0xb61cdCDC81d97c32122E668AE782b2327d0a623C
///
/// V1 and V2 emit the same `Store(bytes32 indexed hash, bytes data)` event
/// and expose the same `manifests(hash) → address uploader` accessor — that's
/// the anti-grief signature minti's registry validates against.
///
/// V2 additionally records the upload block in storage, exposed as
/// `blockOf(hash) → uint256`. Calling `blockOf` on V1 reverts (function does
/// not exist), so callers must know which version they're talking to.
interface IEVMFS {
    /// @notice Returns the address that called `storeManifest()` for `hash`.
    ///         Zero address if the hash has never been registered as a manifest.
    ///         Same signature on V1 and V2.
    function manifests(bytes32 hash) external view returns (address);

    /// @notice V2 ONLY — returns the block number where `hash` was stored.
    ///         Reverts on V1 (function does not exist).
    function blockOf(bytes32 hash) external view returns (uint256);
}
