// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./helpers/TestBase.sol";
import {IMintiMarketplace} from "../src/interfaces/IMintiMarketplace.sol";

contract BidsTest is TestBase {
    // ═══════════════════════════ PLACE BID ═══════════════════════════

    function test_placeBid() public {
        uint256 tokenId = nft.mint(seller);
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        assertEq(bidId, 1);
        assertEq(weth.balanceOf(address(marketplace)), 1 ether);
        assertEq(marketplace.getCollectionBidCount(address(nft)), 1);

        IMintiMarketplace.Bid memory bid = _getBid(bidId);
        assertEq(bid.bidder, buyer);
        assertEq(bid.amount, 1 ether);
        assertEq(bid.nftContract, address(nft));
        assertEq(bid.tokenId, tokenId);
    }

    function test_placeBid_emitsEvent() public {
        uint256 tokenId = nft.mint(seller);
        _approveWeth(buyer, 1 ether);

        vm.expectEmit(true, true, true, true);
        emit IMintiMarketplace.BidPlaced(1, address(nft), tokenId, buyer, 1 ether, 1, 0);

        vm.prank(buyer);
        marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);
    }

    function test_placeBid_revert_zeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.InvalidPrice.selector);
        marketplace.placeBid(address(nft), 1, 0, 1, false, 0, 0);
    }

    function test_placeBid_revert_insufficientWeth() public {
        _approveWeth(buyer, 100 ether);

        vm.prank(buyer);
        vm.expectRevert(); // WETH transfer will fail
        marketplace.placeBid(address(nft), 1, 100 ether, 1, false, 0, 0);
    }

    function test_placeBid_revert_invalidRoyaltyBps() public {
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.InvalidRoyaltyBps.selector);
        marketplace.placeBid(address(nft), 1, 1 ether, 1, false, 10001, 0);
    }

    // ═══════════════════════════ CANCEL BID ═══════════════════════════

    function test_cancelBid() public {
        uint256 tokenId = nft.mint(seller);
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        uint256 buyerWethBefore = weth.balanceOf(buyer);

        vm.prank(buyer);
        marketplace.cancelBid(bidId);

        // WETH returned
        assertEq(weth.balanceOf(buyer), buyerWethBefore + 1 ether);
        assertEq(weth.balanceOf(address(marketplace)), 0);
        assertEq(marketplace.getCollectionBidCount(address(nft)), 0);
    }

    function test_cancelBid_revert_notBidder() public {
        uint256 tokenId = nft.mint(seller);
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.NotBidder.selector);
        marketplace.cancelBid(bidId);
    }

    // ═══════════════════════════ ACCEPT BID ═══════════════════════════

    function test_acceptBid() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        uint256 sellerWethBefore = weth.balanceOf(seller);

        vm.prank(seller);
        marketplace.acceptBid(bidId);

        // NFT transferred
        assertEq(nft.ownerOf(tokenId), buyer);

        // WETH distributed
        uint256 expectedFee = 1 ether / 200; // 0.5%
        uint256 expectedProceeds = 1 ether - expectedFee;
        assertEq(weth.balanceOf(seller) - sellerWethBefore, expectedProceeds);
        assertEq(weth.balanceOf(feeRecipient), expectedFee);
        assertEq(weth.balanceOf(address(marketplace)), 0);

        // Bid removed
        assertEq(marketplace.getCollectionBidCount(address(nft)), 0);
    }

    function test_acceptBid_emitsEvent() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        uint256 expectedFee = 1 ether / 200;

        vm.expectEmit(true, true, true, true);
        emit IMintiMarketplace.BidAccepted(
            bidId, address(nft), tokenId, seller, 1 ether, expectedFee, 0, address(0)
        );

        vm.prank(seller);
        marketplace.acceptBid(bidId);
    }

    function test_acceptBid_revert_callerIsBidder() public {
        uint256 tokenId = nft.mint(buyer);
        vm.prank(buyer);
        nft.approve(address(marketplace), tokenId);

        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.CallerIsSeller.selector);
        marketplace.acceptBid(bidId);
    }

    function test_acceptBid_revert_nftNotApproved() public {
        uint256 tokenId = nft.mint(seller);
        // Not approved for marketplace
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, 1 ether, 1, false, 0, 0);

        vm.prank(seller);
        vm.expectRevert(); // safeTransferFrom will revert
        marketplace.acceptBid(bidId);
    }

    function test_acceptBid_ERC1155() public {
        _mintAndApproveERC1155(seller, 1, 10);
        _approveWeth(buyer, 5 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(erc1155), 1, 1 ether, 5, true, 0, 0);

        vm.prank(seller);
        marketplace.acceptBid(bidId);

        assertEq(erc1155.balanceOf(buyer, 1), 5);
        assertEq(erc1155.balanceOf(seller, 1), 5);
    }

    // ═══════════════════════════ FUZZ ═══════════════════════════

    function testFuzz_placeBid_acceptBid(uint256 bidAmount) public {
        bidAmount = bound(bidAmount, 0.001 ether, 10 ether);

        uint256 tokenId = _mintAndApproveERC721(seller);

        // Ensure buyer has enough WETH
        _approveWeth(buyer, bidAmount);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(nft), tokenId, bidAmount, 1, false, 0, 0);

        uint256 sellerWethBefore = weth.balanceOf(seller);

        vm.prank(seller);
        marketplace.acceptBid(bidId);

        // Verify fee math
        uint256 expectedFee = (bidAmount * 50) / 10_000;
        uint256 expectedProceeds = bidAmount - expectedFee;

        assertEq(weth.balanceOf(seller) - sellerWethBefore, expectedProceeds);
        assertEq(weth.balanceOf(feeRecipient), expectedFee);
    }

    // ── Helper ──

    function _getBid(uint256 bidId) internal view returns (IMintiMarketplace.Bid memory) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        return marketplace.getBidsByIds(ids)[0];
    }
}
