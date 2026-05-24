// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./helpers/TestBase.sol";
import {IMintiMarketplace} from "../src/interfaces/IMintiMarketplace.sol";

contract CollectionOffersTest is TestBase {
    // ═══════════════════════════ PLACE COLLECTION OFFER ═══════════════════════════

    function test_placeCollectionOffer() public {
        _approveWeth(buyer, 5 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 5, false, 0, 0);

        assertEq(offerId, 1);
        assertEq(weth.balanceOf(address(marketplace)), 5 ether); // 1 ETH * 5 quantity
        assertEq(marketplace.getCollectionOfferCount(address(nft)), 1);

        IMintiMarketplace.CollectionOffer memory offer = _getOffer(offerId);
        assertEq(offer.bidder, buyer);
        assertEq(offer.amount, 1 ether);
        assertEq(offer.quantity, 5);
        assertEq(offer.fulfilled, 0);
    }

    function test_placeCollectionOffer_emitsEvent() public {
        _approveWeth(buyer, 3 ether);

        vm.expectEmit(true, true, false, true);
        emit IMintiMarketplace.CollectionOfferPlaced(1, address(nft), buyer, 1 ether, 3, 0);

        vm.prank(buyer);
        marketplace.placeCollectionOffer(address(nft), 1 ether, 3, false, 0, 0);
    }

    function test_placeCollectionOffer_revert_zeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.InvalidPrice.selector);
        marketplace.placeCollectionOffer(address(nft), 0, 1, false, 0, 0);
    }

    // ═══════════════════════════ CANCEL COLLECTION OFFER ═══════════════════════════

    function test_cancelCollectionOffer_full() public {
        _approveWeth(buyer, 3 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 3, false, 0, 0);

        uint256 buyerWethBefore = weth.balanceOf(buyer);

        vm.prank(buyer);
        marketplace.cancelCollectionOffer(offerId);

        // Full refund since nothing was filled
        assertEq(weth.balanceOf(buyer), buyerWethBefore + 3 ether);
        assertEq(marketplace.getCollectionOfferCount(address(nft)), 0);
    }

    function test_cancelCollectionOffer_afterPartialFill() public {
        _approveWeth(buyer, 3 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 3, false, 0, 0);

        // Seller fills 1
        uint256 tokenId = _mintAndApproveERC721(seller);
        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId);

        uint256 buyerWethBefore = weth.balanceOf(buyer);

        // Cancel remaining
        vm.prank(buyer);
        marketplace.cancelCollectionOffer(offerId);

        // Should get 2 ether back (3 total - 1 filled)
        assertEq(weth.balanceOf(buyer), buyerWethBefore + 2 ether);
    }

    function test_cancelCollectionOffer_revert_notBidder() public {
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 1, false, 0, 0);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.NotBidder.selector);
        marketplace.cancelCollectionOffer(offerId);
    }

    // ═══════════════════════════ ACCEPT COLLECTION OFFER ═══════════════════════════

    function test_acceptCollectionOffer() public {
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 1, false, 0, 0);

        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 sellerWethBefore = weth.balanceOf(seller);

        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId);

        // NFT transferred
        assertEq(nft.ownerOf(tokenId), buyer);

        // WETH distributed
        uint256 expectedFee = 1 ether / 200;
        uint256 expectedProceeds = 1 ether - expectedFee;
        assertEq(weth.balanceOf(seller) - sellerWethBefore, expectedProceeds);
        assertEq(weth.balanceOf(feeRecipient), expectedFee);

        // Offer fully filled and removed
        assertEq(marketplace.getCollectionOfferCount(address(nft)), 0);
    }

    function test_acceptCollectionOffer_partialFill() public {
        _approveWeth(buyer, 3 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 3, false, 0, 0);

        // Fill 1 of 3
        uint256 tokenId1 = _mintAndApproveERC721(seller);
        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId1);

        // Offer still active with 1 fulfilled
        assertEq(marketplace.getCollectionOfferCount(address(nft)), 1);
        IMintiMarketplace.CollectionOffer memory offer = _getOffer(offerId);
        assertEq(offer.fulfilled, 1);

        // Fill 2 of 3
        uint256 tokenId2 = _mintAndApproveERC721(seller);
        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId2);

        offer = _getOffer(offerId);
        assertEq(offer.fulfilled, 2);

        // Fill 3 of 3 — should remove offer
        uint256 tokenId3 = _mintAndApproveERC721(seller);
        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId3);

        assertEq(marketplace.getCollectionOfferCount(address(nft)), 0);
    }

    function test_acceptCollectionOffer_revert_fullyFilled() public {
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 1, false, 0, 0);

        // Fill it
        uint256 tokenId1 = _mintAndApproveERC721(seller);
        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId1);

        // Try to fill again — offer was deleted on full fill so bidder is address(0)
        uint256 tokenId2 = _mintAndApproveERC721(seller);
        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.NotBidder.selector);
        marketplace.acceptCollectionOffer(offerId, tokenId2);
    }

    function test_acceptCollectionOffer_revert_callerIsBidder() public {
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 1, false, 0, 0);

        uint256 tokenId = nft.mint(buyer);
        vm.prank(buyer);
        nft.approve(address(marketplace), tokenId);

        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.CallerIsSeller.selector);
        marketplace.acceptCollectionOffer(offerId, tokenId);
    }

    function test_acceptCollectionOffer_emitsEvent() public {
        _approveWeth(buyer, 1 ether);

        vm.prank(buyer);
        uint256 offerId = marketplace.placeCollectionOffer(address(nft), 1 ether, 1, false, 0, 0);

        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 expectedFee = 1 ether / 200;

        vm.expectEmit(true, true, true, true);
        emit IMintiMarketplace.CollectionOfferAccepted(
            offerId, address(nft), tokenId, seller, 1 ether, expectedFee, 0, address(0)
        );

        vm.prank(seller);
        marketplace.acceptCollectionOffer(offerId, tokenId);
    }

    // ── Helper ──

    function _getOffer(uint256 offerId) internal view returns (IMintiMarketplace.CollectionOffer memory) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = offerId;
        return marketplace.getCollectionOffersByIds(ids)[0];
    }
}
