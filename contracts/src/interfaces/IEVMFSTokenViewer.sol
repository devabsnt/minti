// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of EVMFSTokenViewer used by ERC721 collections to delegate
///         their `tokenURI(uint256)` implementation. The viewer returns a
///         `data:text/html;base64,...` URL whose embedded JS pulls the
///         token's metadata + image directly from EVMFS event logs.
///
///         Canonical deployment on Monad (chain 143):
///         0x139EF7cFc40c6044229D8EcAEb38E1A18FB20D94
interface IEVMFSTokenViewer {
    function tokenURI(bytes32 manifestHash, uint64 manifestBlock, uint256 tokenId)
        external
        view
        returns (string memory);
}
