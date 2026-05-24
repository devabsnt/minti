// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

import {IEVMFSTokenViewer} from "./interfaces/IEVMFSTokenViewer.sol";

/// @title MintiCollection721
/// @notice Minimal, fully-ossified ERC721 template for EVMFS-native collections
///         minted through the minti.art launchpad.
///
///         - Metadata lives on chain via EVMFS event logs.
///         - `tokenURI(id)` delegates to a canonical EVMFSTokenViewer, so a
///           single contract address serves the metadata for every minti
///           collection on that chain.
///         - No admin, no proxy slot, no upgrade path. The only privileged
///           role is `minter`, set once at construction, and that role's
///           power is bounded by `totalSupply`.
///         - ERC-2981 royalties via OZ's default-royalty mechanism, fixed at
///           construction.
contract MintiCollection721 is ERC721, ERC2981 {
    error NotMinter();
    error MaxSupplyReached();
    error InvalidViewer();
    error InvalidMetadata();
    error TokenDoesNotExist();

    /// @notice Address allowed to call `mint`. Set once in the constructor.
    address public immutable minter;

    /// @notice EVMFSTokenViewer the collection delegates its tokenURI to.
    IEVMFSTokenViewer public immutable viewer;

    /// @notice The EVMFS metadata manifest pointer this collection serves.
    bytes32 public immutable metadataManifest;
    uint64 public immutable metadataBlock;

    /// @notice Hard cap on supply. Mint reverts if this would be exceeded.
    uint64 public immutable maxSupply;

    /// @notice Total tokens minted so far. Monotonically increasing.
    uint64 public totalMinted;

    constructor(
        string memory name_,
        string memory symbol_,
        bytes32 metadataManifest_,
        uint64 metadataBlock_,
        uint64 maxSupply_,
        address viewer_,
        address minter_,
        address royaltyReceiver,
        uint96 royaltyBps
    ) ERC721(name_, symbol_) {
        if (viewer_ == address(0)) revert InvalidViewer();
        if (metadataManifest_ == bytes32(0)) revert InvalidMetadata();
        if (minter_ == address(0)) revert NotMinter();

        viewer = IEVMFSTokenViewer(viewer_);
        metadataManifest = metadataManifest_;
        metadataBlock = metadataBlock_;
        maxSupply = maxSupply_;
        minter = minter_;

        if (royaltyReceiver != address(0) && royaltyBps > 0) {
            _setDefaultRoyalty(royaltyReceiver, royaltyBps);
        }
    }

    // ═══════════════════════════ MINT ═══════════════════════════

    /// @notice Mint `recipients.length` consecutive tokens starting at the
    ///         current `totalMinted + 1`. Only the immutable minter may call.
    ///         Token ids are deterministic: caller can rely on getting ids
    ///         [totalMinted+1 ... totalMinted+recipients.length].
    function mint(address[] calldata recipients) external returns (uint256 firstTokenId, uint256 lastTokenId) {
        if (msg.sender != minter) revert NotMinter();
        uint64 minted = totalMinted;
        uint256 n = recipients.length;
        if (minted + n > maxSupply) revert MaxSupplyReached();

        firstTokenId = uint256(minted) + 1;
        for (uint256 i; i < n; ++i) {
            _safeMint(recipients[i], firstTokenId + i);
        }
        lastTokenId = firstTokenId + n - 1;
        totalMinted = uint64(minted + n);
    }

    /// @notice Convenience: mint the entire collection to a single address
    ///         (e.g. the creator, who can then list / airdrop / distribute).
    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId, uint256 lastTokenId) {
        if (msg.sender != minter) revert NotMinter();
        uint64 minted = totalMinted;
        if (minted + quantity > maxSupply) revert MaxSupplyReached();

        firstTokenId = uint256(minted) + 1;
        for (uint256 i; i < quantity; ++i) {
            _safeMint(to, firstTokenId + i);
        }
        lastTokenId = firstTokenId + quantity - 1;
        totalMinted = uint64(minted + quantity);
    }

    // ═══════════════════════════ METADATA ═══════════════════════════

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        return viewer.tokenURI(metadataManifest, metadataBlock, tokenId);
    }

    /// @notice ERC721Enumerable-style supply hint (not the full extension —
    ///         the marketplace uses this for display only).
    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    // ═══════════════════════════ ERC165 ═══════════════════════════

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
