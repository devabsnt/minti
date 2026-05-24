// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./helpers/TestBase.sol";
import {IMintiMarketplace} from "../src/interfaces/IMintiMarketplace.sol";

contract ListingsTest is TestBase {
    // ═══════════════════════════ LIST ITEM ═══════════════════════════

    function test_listItem_ERC721() public {
        uint256 tokenId = _mintAndApproveERC721(seller);

        vm.prank(seller);
        uint256 listingId = marketplace.listItem(address(nft), tokenId, DEFAULT_PRICE, 1, false, 0);

        assertEq(listingId, 1);

        IMintiMarketplace.Listing memory listing = _getListing(listingId);
        assertEq(listing.seller, seller);
        assertEq(listing.nftContract, address(nft));
        assertEq(listing.tokenId, tokenId);
        assertEq(listing.price, DEFAULT_PRICE);
        assertEq(listing.quantity, 1);
        assertFalse(listing.isERC1155);

        // Check indexes
        assertEq(marketplace.getTotalListingCount(), 1);
        assertEq(marketplace.getCollectionListingCount(address(nft)), 1);
    }

    function test_listItem_ERC1155() public {
        _mintAndApproveERC1155(seller, 1, 10);

        vm.prank(seller);
        uint256 listingId = marketplace.listItem(address(erc1155), 1, DEFAULT_PRICE, 5, true, 0);

        IMintiMarketplace.Listing memory listing = _getListing(listingId);
        assertEq(listing.quantity, 5);
        assertTrue(listing.isERC1155);
    }

    function test_listItem_emitsEvent() public {
        uint256 tokenId = _mintAndApproveERC721(seller);

        vm.expectEmit(true, true, true, true);
        emit IMintiMarketplace.ItemListed(1, address(nft), tokenId, seller, DEFAULT_PRICE, 1, false);

        vm.prank(seller);
        marketplace.listItem(address(nft), tokenId, DEFAULT_PRICE, 1, false, 0);
    }

    function test_listItem_revert_zeroPrice() public {
        uint256 tokenId = _mintAndApproveERC721(seller);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.InvalidPrice.selector);
        marketplace.listItem(address(nft), tokenId, 0, 1, false, 0);
    }

    function test_listItem_revert_notOwner() public {
        uint256 tokenId = _mintAndApproveERC721(seller);

        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.NotSeller.selector);
        marketplace.listItem(address(nft), tokenId, DEFAULT_PRICE, 1, false, 0);
    }

    function test_listItem_revert_notApproved() public {
        uint256 tokenId = nft.mint(seller);
        // No approval given

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.TokenNotApproved.selector);
        marketplace.listItem(address(nft), tokenId, DEFAULT_PRICE, 1, false, 0);
    }

    function test_listItem_revert_alreadyListed() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.AlreadyListed.selector);
        marketplace.listItem(address(nft), tokenId, DEFAULT_PRICE, 1, false, 0);
    }

    function test_listItem_revert_erc721_quantityNotOne() public {
        uint256 tokenId = _mintAndApproveERC721(seller);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.InvalidQuantity.selector);
        marketplace.listItem(address(nft), tokenId, DEFAULT_PRICE, 2, false, 0);
    }

    function test_listItem_revert_zeroQuantity() public {
        _mintAndApproveERC1155(seller, 1, 10);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.InvalidQuantity.selector);
        marketplace.listItem(address(erc1155), 1, DEFAULT_PRICE, 0, true, 0);
    }

    // ═══════════════════════════ CANCEL LISTING ═══════════════════════════

    function test_cancelListing() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.prank(seller);
        marketplace.cancelListing(listingId);

        IMintiMarketplace.Listing memory listing = _getListing(listingId);
        assertEq(listing.seller, address(0)); // deleted

        assertEq(marketplace.getTotalListingCount(), 0);
        assertEq(marketplace.getCollectionListingCount(address(nft)), 0);
    }

    function test_cancelListing_emitsEvent() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.expectEmit(true, false, false, false);
        emit IMintiMarketplace.ListingCancelled(listingId);

        vm.prank(seller);
        marketplace.cancelListing(listingId);
    }

    function test_cancelListing_revert_notSeller() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.NotSeller.selector);
        marketplace.cancelListing(listingId);
    }

    function test_cancelListing_revert_notListed() public {
        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.NotListed.selector);
        marketplace.cancelListing(999);
    }

    function test_cancelListing_allowsRelisting() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.prank(seller);
        marketplace.cancelListing(listingId);

        // Can relist
        uint256 newListingId = _listERC721(seller, tokenId, 2 ether);
        assertEq(newListingId, 2);
    }

    // ═══════════════════════════ BUY ITEM ═══════════════════════════

    function test_buyItem() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        uint256 sellerBalBefore = seller.balance;

        vm.prank(buyer);
        marketplace.buyItem{value: DEFAULT_PRICE}(listingId, 0);

        // NFT transferred
        assertEq(nft.ownerOf(tokenId), buyer);

        // Listing removed
        assertEq(marketplace.getTotalListingCount(), 0);

        // Seller received proceeds (minus 0.5% fee)
        uint256 expectedFee = DEFAULT_PRICE / 200; // 0.5%
        uint256 expectedProceeds = DEFAULT_PRICE - expectedFee;
        assertEq(seller.balance - sellerBalBefore, expectedProceeds);

        // Fee recipient received fee
        assertEq(feeRecipient.balance, expectedFee);
    }

    function test_buyItem_ERC1155() public {
        _mintAndApproveERC1155(seller, 1, 10);

        vm.prank(seller);
        uint256 listingId = marketplace.listItem(address(erc1155), 1, DEFAULT_PRICE, 5, true, 0);

        vm.prank(buyer);
        marketplace.buyItem{value: DEFAULT_PRICE}(listingId, 0);

        assertEq(erc1155.balanceOf(buyer, 1), 5);
        assertEq(erc1155.balanceOf(seller, 1), 5); // 10 - 5 remaining
    }

    function test_buyItem_emitsEvent() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        uint256 expectedFee = DEFAULT_PRICE / 200;

        vm.expectEmit(true, true, true, true);
        emit IMintiMarketplace.ItemSold(
            listingId, address(nft), tokenId, buyer, seller, DEFAULT_PRICE, expectedFee, 0, address(0)
        );

        vm.prank(buyer);
        marketplace.buyItem{value: DEFAULT_PRICE}(listingId, 0);
    }

    function test_buyItem_revert_wrongPrice() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.InsufficientPayment.selector);
        marketplace.buyItem{value: DEFAULT_PRICE - 1}(listingId, 0);
    }

    function test_buyItem_revert_buyOwnListing() public {
        uint256 tokenId = _mintAndApproveERC721(seller);
        uint256 listingId = _listERC721(seller, tokenId, DEFAULT_PRICE);

        vm.prank(seller);
        vm.expectRevert(IMintiMarketplace.CallerIsSeller.selector);
        marketplace.buyItem{value: DEFAULT_PRICE}(listingId, 0);
    }

    function test_buyItem_revert_notListed() public {
        vm.prank(buyer);
        vm.expectRevert(IMintiMarketplace.NotListed.selector);
        marketplace.buyItem{value: DEFAULT_PRICE}(999, 0);
    }

    // ═══════════════════════════ PAGINATION ═══════════════════════════

    function test_pagination_multipleListings() public {
        // List 5 items
        for (uint256 i; i < 5; ++i) {
            uint256 tokenId = _mintAndApproveERC721(seller);
            _listERC721(seller, tokenId, DEFAULT_PRICE);
        }

        assertEq(marketplace.getTotalListingCount(), 5);

        // Get first page
        uint256[] memory page1 = marketplace.getAllListingIds(0, 3);
        assertEq(page1.length, 3);

        // Get second page
        uint256[] memory page2 = marketplace.getAllListingIds(3, 3);
        assertEq(page2.length, 2);

        // Get with offset past end
        uint256[] memory empty = marketplace.getAllListingIds(10, 5);
        assertEq(empty.length, 0);
    }

    function test_swapAndPop_correctness() public {
        // List 3 items
        uint256 tokenId1 = _mintAndApproveERC721(seller);
        uint256 id1 = _listERC721(seller, tokenId1, DEFAULT_PRICE);

        uint256 tokenId2 = _mintAndApproveERC721(seller);
        uint256 id2 = _listERC721(seller, tokenId2, DEFAULT_PRICE);

        uint256 tokenId3 = _mintAndApproveERC721(seller);
        uint256 id3 = _listERC721(seller, tokenId3, DEFAULT_PRICE);

        assertEq(marketplace.getTotalListingCount(), 3);

        // Cancel the middle one
        vm.prank(seller);
        marketplace.cancelListing(id2);

        assertEq(marketplace.getTotalListingCount(), 2);

        // Remaining listings should be id1 and id3
        uint256[] memory ids = marketplace.getAllListingIds(0, 10);
        assertEq(ids.length, 2);

        // Both id1 and id3 should still be fetchable
        uint256[] memory fetchIds = new uint256[](2);
        fetchIds[0] = id1;
        fetchIds[1] = id3;
        IMintiMarketplace.Listing[] memory results = marketplace.getListingsByIds(fetchIds);
        assertEq(results[0].seller, seller);
        assertEq(results[1].seller, seller);
    }

    // ── Helper ──

    function _getListing(uint256 listingId) internal view returns (IMintiMarketplace.Listing memory) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = listingId;
        return marketplace.getListingsByIds(ids)[0];
    }
}
