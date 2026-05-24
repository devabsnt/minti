// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./helpers/TestBase.sol";
import {IMintiMarketplace} from "../src/interfaces/IMintiMarketplace.sol";

contract FeesTest is TestBase {
    // ═══════════════════════════ PROTOCOL FEE ═══════════════════════════

    function test_protocolFee_onBuy() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, 10 ether);

        uint256 feeRecipientBefore = feeRecipient.balance;

        vm.prank(buyer);
        marketplace.buyItem{value: 10 ether}(listingId, 0);

        // 0.5% of 10 ETH = 0.05 ETH
        assertEq(feeRecipient.balance - feeRecipientBefore, 0.05 ether);
    }

    function testFuzz_protocolFee(uint256 price) public {
        price = bound(price, 0.001 ether, 100 ether);

        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, price);

        uint256 feeRecipientBefore = feeRecipient.balance;
        uint256 sellerBefore = seller.balance;

        vm.deal(buyer, price);
        vm.prank(buyer);
        marketplace.buyItem{value: price}(listingId, 0);

        uint256 expectedFee = (price * 50) / 10_000;
        uint256 expectedProceeds = price - expectedFee;

        assertEq(feeRecipient.balance - feeRecipientBefore, expectedFee);
        assertEq(seller.balance - sellerBefore, expectedProceeds);
    }

    // ═══════════════════════════ ERC-2981 ROYALTIES ═══════════════════════════

    function test_erc2981Royalty_onBuy() public {
        uint256 tokenId = _mintAndApproveRoyaltyNft(seller);

        vm.prank(seller);
        uint256 listingId = marketplace.listItem(address(royaltyNft), tokenId, 10 ether, 1, false, 0);

        uint256 royaltyReceiverBefore = royaltyReceiver.balance;
        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        marketplace.buyItem{value: 10 ether}(listingId, 0);

        // 5% royalty = 0.5 ETH
        uint256 expectedRoyalty = 0.5 ether;
        // 0.5% fee = 0.05 ETH
        uint256 expectedFee = 0.05 ether;
        uint256 expectedProceeds = 10 ether - expectedFee - expectedRoyalty;

        assertEq(royaltyReceiver.balance - royaltyReceiverBefore, expectedRoyalty);
        assertEq(feeRecipient.balance, expectedFee);
        assertEq(seller.balance - sellerBefore, expectedProceeds);
    }

    function test_erc2981Royalty_onAcceptBid() public {
        uint256 tokenId = _mintAndApproveRoyaltyNft(seller);
        _approveWeth(buyer, 10 ether);

        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(royaltyNft), tokenId, 10 ether, 1, false, 0, 0);

        uint256 sellerWethBefore = weth.balanceOf(seller);

        vm.prank(seller);
        marketplace.acceptBid(bidId);

        uint256 expectedRoyalty = 0.5 ether; // 5%
        uint256 expectedFee = 0.05 ether; // 0.5%
        uint256 expectedProceeds = 10 ether - expectedFee - expectedRoyalty;

        assertEq(weth.balanceOf(seller) - sellerWethBefore, expectedProceeds);
        assertEq(weth.balanceOf(royaltyReceiver), expectedRoyalty);
        assertEq(weth.balanceOf(feeRecipient), expectedFee);
    }

    // ═══════════════════════════ OPTIONAL ROYALTY ═══════════════════════════

    function test_optionalRoyalty_onBuy_withErc2981() public {
        uint256 tokenId = _mintAndApproveRoyaltyNft(seller);

        vm.prank(seller);
        uint256 listingId = marketplace.listItem(address(royaltyNft), tokenId, 10 ether, 1, false, 0);

        uint256 royaltyReceiverBefore = royaltyReceiver.balance;

        // Buyer adds 2% optional royalty on top of 5% ERC-2981
        vm.prank(buyer);
        marketplace.buyItem{value: 10 ether}(listingId, 200); // 200 bps = 2%

        // Total royalty = 5% + 2% = 7% of 10 ETH = 0.7 ETH
        uint256 expectedRoyalty = 0.7 ether;
        assertEq(royaltyReceiver.balance - royaltyReceiverBefore, expectedRoyalty);
    }

    function test_optionalRoyalty_onBuy_noErc2981_fallsBackToOwner() public {
        // Use regular ERC721 (no royalty, but it doesn't have owner())
        // So optional royalty should be skipped
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, 10 ether);

        uint256 sellerBefore = seller.balance;

        // Buyer tries to add 5% optional royalty but no receiver
        vm.prank(buyer);
        marketplace.buyItem{value: 10 ether}(listingId, 500);

        // Only protocol fee deducted since MockERC721 has no owner() that returns valid address
        uint256 expectedFee = 0.05 ether;
        // No royalty collected (no valid receiver)
        assertEq(seller.balance - sellerBefore, 10 ether - expectedFee);
    }

    function test_optionalRoyalty_onBid() public {
        uint256 tokenId = _mintAndApproveRoyaltyNft(seller);
        _approveWeth(buyer, 10 ether);

        // Place bid with 3% optional royalty
        vm.prank(buyer);
        uint256 bidId = marketplace.placeBid(address(royaltyNft), tokenId, 10 ether, 1, false, 300, 0);

        uint256 sellerWethBefore = weth.balanceOf(seller);

        vm.prank(seller);
        marketplace.acceptBid(bidId);

        // Total royalty = 5% ERC-2981 + 3% optional = 8% = 0.8 ETH
        uint256 expectedRoyalty = 0.8 ether;
        uint256 expectedFee = 0.05 ether;
        uint256 expectedProceeds = 10 ether - expectedFee - expectedRoyalty;

        assertEq(weth.balanceOf(royaltyReceiver), expectedRoyalty);
        assertEq(weth.balanceOf(seller) - sellerWethBefore, expectedProceeds);
    }

    // ═══════════════════════════ FEE RECIPIENT ═══════════════════════════

    function test_setFeeRecipient() public {
        address newRecipient = makeAddr("newFeeRecipient");

        marketplace.setFeeRecipient(newRecipient);

        assertEq(marketplace.feeRecipient(), newRecipient);
    }

    function test_setFeeRecipient_emitsEvent() public {
        address newRecipient = makeAddr("newFeeRecipient");

        vm.expectEmit(true, true, false, false);
        emit IMintiMarketplace.FeeRecipientUpdated(feeRecipient, newRecipient);

        marketplace.setFeeRecipient(newRecipient);
    }

    function test_setFeeRecipient_revert_notOwner() public {
        vm.prank(seller);
        vm.expectRevert();
        marketplace.setFeeRecipient(seller);
    }

    function test_setFeeRecipient_revert_zeroAddress() public {
        vm.expectRevert(IMintiMarketplace.ZeroAddress.selector);
        marketplace.setFeeRecipient(address(0));
    }

    function test_feeGoesToNewRecipient() public {
        address newRecipient = makeAddr("newFeeRecipient");
        marketplace.setFeeRecipient(newRecipient);

        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, 10 ether);

        vm.prank(buyer);
        marketplace.buyItem{value: 10 ether}(listingId, 0);

        assertEq(newRecipient.balance, 0.05 ether);
        assertEq(feeRecipient.balance, 0); // old recipient gets nothing
    }

    // ═══════════════════════════ FEE CAP ═══════════════════════════

    function test_feeCap_royaltyExceedsSalePrice() public {
        // 5% ERC-2981 royalty + buyer adds 95% optional = 100% royalty.
        // Protocol fee is 0.5%, so total would be 100.5% > 100%. The fee cap
        // shaves the royalty back so total == 100%.
        uint256 tokenId = _mintAndApproveRoyaltyNft(seller);
        uint256 listingId = _listRoyaltyNft(seller, tokenId, 1 ether);

        vm.prank(buyer);
        marketplace.buyItem{value: 1 ether}(listingId, 9500); // 95% optional

        // Protocol fee = 0.5% of 1 ETH = 0.005 ether
        // Capped royalty = 1 ether - 0.005 ether = 0.995 ether
        uint256 expectedFee = 0.005 ether;
        uint256 maxRoyalty = 1 ether - expectedFee;

        assertEq(feeRecipient.balance, expectedFee);
        assertEq(royaltyReceiver.balance, maxRoyalty);
        // seller gets 0
    }
}
