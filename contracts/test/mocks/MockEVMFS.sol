// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stand-in for the canonical EVMFS contract. Used in tests to control
/// who is the registered uploader of each hash and (V2-only) what block it lives in.
contract MockEVMFS {
    mapping(bytes32 => address) public manifests;
    mapping(bytes32 => uint256) private _blockOf;

    /// Configure the uploader the mock will report for `hash`.
    function setManifestUploader(bytes32 hash, address who) external {
        manifests[hash] = who;
    }

    /// Configure the (V2-only) block number for `hash`.
    function setManifestBlock(bytes32 hash, uint256 block_) external {
        _blockOf[hash] = block_;
    }

    /// V2-only accessor; reverts when the test hasn't configured one (mimics
    /// the way V1 doesn't expose this function at all).
    function blockOf(bytes32 hash) external view returns (uint256) {
        uint256 b = _blockOf[hash];
        require(b != 0, "no block recorded");
        return b;
    }

    /// Convenience: behave like the real EVMFS for the common case where
    /// `msg.sender` should be recorded as the uploader at the current block.
    function storeManifest(bytes calldata) external returns (bytes32) {
        bytes32 hash = keccak256(abi.encodePacked(block.number, msg.sender, gasleft()));
        manifests[hash] = msg.sender;
        _blockOf[hash] = block.number;
        return hash;
    }
}
