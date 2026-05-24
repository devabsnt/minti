// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MintiCollection721} from "../src/MintiCollection721.sol";
import {MockEVMFSTokenViewer} from "./mocks/MockEVMFSTokenViewer.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract MintiCollection721Test is Test, IERC721Receiver {
    MintiCollection721 nft;
    MockEVMFSTokenViewer viewer;

    address creator;
    address royaltyReceiver = makeAddr("royaltyReceiver");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant METADATA_HASH = bytes32(uint256(0xa1));
    uint64 constant METADATA_BLOCK = 71118217;
    uint64 constant MAX_SUPPLY = 100;
    uint96 constant ROYALTY_BPS = 500; // 5%

    function setUp() public {
        creator = address(this);
        viewer = new MockEVMFSTokenViewer();
        nft = new MintiCollection721(
            "Skrumpeys",
            "SKRUMP",
            METADATA_HASH,
            METADATA_BLOCK,
            MAX_SUPPLY,
            address(viewer),
            creator,
            royaltyReceiver,
            ROYALTY_BPS
        );
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ── Construction ──

    function test_immutables_set() public view {
        assertEq(nft.name(), "Skrumpeys");
        assertEq(nft.symbol(), "SKRUMP");
        assertEq(nft.metadataManifest(), METADATA_HASH);
        assertEq(nft.metadataBlock(), METADATA_BLOCK);
        assertEq(nft.maxSupply(), MAX_SUPPLY);
        assertEq(nft.minter(), creator);
        assertEq(address(nft.viewer()), address(viewer));
        assertEq(nft.totalMinted(), 0);
    }

    function test_constructor_reverts_on_zero_viewer() public {
        vm.expectRevert(MintiCollection721.InvalidViewer.selector);
        new MintiCollection721(
            "X", "X", METADATA_HASH, 1, 10, address(0), creator, address(0), 0
        );
    }

    function test_constructor_reverts_on_zero_metadata() public {
        vm.expectRevert(MintiCollection721.InvalidMetadata.selector);
        new MintiCollection721("X", "X", bytes32(0), 1, 10, address(viewer), creator, address(0), 0);
    }

    function test_constructor_reverts_on_zero_minter() public {
        vm.expectRevert(MintiCollection721.NotMinter.selector);
        new MintiCollection721(
            "X", "X", METADATA_HASH, 1, 10, address(viewer), address(0), address(0), 0
        );
    }

    // ── Mint ──

    function test_mintTo_creator() public {
        (uint256 first, uint256 last) = nft.mintTo(creator, 5);
        assertEq(first, 1);
        assertEq(last, 5);
        assertEq(nft.totalMinted(), 5);
        assertEq(nft.balanceOf(creator), 5);
        assertEq(nft.ownerOf(1), creator);
        assertEq(nft.ownerOf(5), creator);
    }

    function test_mint_to_recipients() public {
        address[] memory recipients = new address[](3);
        recipients[0] = alice;
        recipients[1] = bob;
        recipients[2] = alice;
        (uint256 first, uint256 last) = nft.mint(recipients);
        assertEq(first, 1);
        assertEq(last, 3);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.ownerOf(2), bob);
        assertEq(nft.ownerOf(3), alice);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_mint_reverts_for_non_minter() public {
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        vm.prank(alice);
        vm.expectRevert(MintiCollection721.NotMinter.selector);
        nft.mint(recipients);
    }

    function test_mintTo_reverts_for_non_minter() public {
        vm.prank(alice);
        vm.expectRevert(MintiCollection721.NotMinter.selector);
        nft.mintTo(alice, 1);
    }

    function test_mint_reverts_when_exceeding_max_supply() public {
        nft.mintTo(creator, 99);
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        vm.expectRevert(MintiCollection721.MaxSupplyReached.selector);
        nft.mint(recipients);
    }

    function test_mintTo_reverts_when_exceeding_max_supply() public {
        vm.expectRevert(MintiCollection721.MaxSupplyReached.selector);
        nft.mintTo(creator, MAX_SUPPLY + 1);
    }

    function test_mint_continues_ids_across_calls() public {
        nft.mintTo(creator, 3);
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        (uint256 first, uint256 last) = nft.mint(recipients);
        assertEq(first, 4);
        assertEq(last, 5);
        assertEq(nft.totalMinted(), 5);
    }

    // ── tokenURI delegation ──

    function test_tokenURI_delegates_to_viewer() public {
        nft.mintTo(creator, 1);
        string memory uri = nft.tokenURI(1);
        // MockEVMFSTokenViewer returns "evmfs://<hash>/<block>/<id>"
        assertTrue(bytes(uri).length > 0);
        // Quick sanity: ends with token id
        assertEq(
            keccak256(bytes(uri)),
            keccak256(
                bytes(
                    "evmfs://00000000000000000000000000000000000000000000000000000000000000a1/71118217/1"
                )
            )
        );
    }

    function test_tokenURI_reverts_for_nonexistent_token() public {
        vm.expectRevert(MintiCollection721.TokenDoesNotExist.selector);
        nft.tokenURI(1);
    }

    // ── ERC-2981 royalties ──

    function test_royaltyInfo_returns_default() public view {
        (address receiver, uint256 royaltyAmount) = nft.royaltyInfo(1, 1 ether);
        assertEq(receiver, royaltyReceiver);
        assertEq(royaltyAmount, 0.05 ether); // 5%
    }

    function test_royalty_disabled_if_zero_bps_or_zero_receiver() public {
        MintiCollection721 noRoyalty = new MintiCollection721(
            "X", "X", METADATA_HASH, 1, 10, address(viewer), creator, address(0), 0
        );
        (address recv, uint256 amt) = noRoyalty.royaltyInfo(1, 1 ether);
        assertEq(recv, address(0));
        assertEq(amt, 0);
    }

    // ── ERC-165 ──

    function test_supports_relevant_interfaces() public view {
        assertTrue(nft.supportsInterface(type(IERC165).interfaceId));
        assertTrue(nft.supportsInterface(type(IERC721).interfaceId));
        assertTrue(nft.supportsInterface(type(IERC721Metadata).interfaceId));
        assertTrue(nft.supportsInterface(type(IERC2981).interfaceId));
    }
}
