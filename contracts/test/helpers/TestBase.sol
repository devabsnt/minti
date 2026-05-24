// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MintiMarketplace} from "../../src/MintiMarketplace.sol";
import {IMintiMarketplace} from "../../src/interfaces/IMintiMarketplace.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockERC721} from "../mocks/MockERC721.sol";
import {MockERC721WithRoyalty} from "../mocks/MockERC721WithRoyalty.sol";
import {MockERC1155} from "../mocks/MockERC1155.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

contract TestBase is Test, IERC721Receiver, IERC1155Receiver {
    MintiMarketplace public marketplace;
    MockWETH public weth;
    MockERC721 public nft;
    MockERC721WithRoyalty public royaltyNft;
    MockERC1155 public erc1155;

    address public deployer;
    address public seller;
    address public buyer;
    address public royaltyReceiver;
    address public feeRecipient;

    uint256 public constant DEFAULT_PRICE = 1 ether;
    uint96 public constant DEFAULT_ROYALTY_BPS = 500; // 5%

    function setUp() public virtual {
        deployer = address(this);
        seller = makeAddr("seller");
        buyer = makeAddr("buyer");
        royaltyReceiver = makeAddr("royaltyReceiver");
        feeRecipient = makeAddr("feeRecipient");

        // Deploy infrastructure
        weth = new MockWETH();
        marketplace = new MintiMarketplace(address(weth), feeRecipient);

        // Deploy NFT mocks
        nft = new MockERC721();
        royaltyNft = new MockERC721WithRoyalty(royaltyReceiver, DEFAULT_ROYALTY_BPS);
        erc1155 = new MockERC1155();

        // Fund accounts
        vm.deal(seller, 100 ether);
        vm.deal(buyer, 100 ether);

        // Give buyer WETH for bidding
        vm.prank(buyer);
        weth.deposit{value: 50 ether}();
    }

    // ── Helpers ──

    function _mintAndApproveERC721(address to) internal returns (uint256 tokenId) {
        tokenId = nft.mint(to);
        vm.prank(to);
        nft.approve(address(marketplace), tokenId);
    }

    function _mintAndApproveRoyaltyNft(address to) internal returns (uint256 tokenId) {
        tokenId = royaltyNft.mint(to);
        vm.prank(to);
        royaltyNft.approve(address(marketplace), tokenId);
    }

    function _mintAndApproveERC1155(address to, uint256 tokenId, uint256 amount) internal {
        erc1155.mint(to, tokenId, amount);
        vm.prank(to);
        erc1155.setApprovalForAll(address(marketplace), true);
    }

    function _approveWeth(address account, uint256 amount) internal {
        vm.prank(account);
        weth.approve(address(marketplace), amount);
    }

    function _listERC721(address lister, uint256 tokenId, uint256 price) internal returns (uint256 listingId) {
        vm.prank(lister);
        listingId = marketplace.listItem(address(nft), tokenId, price, 1, false, 0);
    }

    function _listRoyaltyNft(address lister, uint256 tokenId, uint256 price) internal returns (uint256 listingId) {
        vm.prank(lister);
        listingId = marketplace.listItem(address(royaltyNft), tokenId, price, 1, false, 0);
    }

    // ERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ERC1155Receiver
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId
            || interfaceId == type(IERC1155Receiver).interfaceId;
    }
}
