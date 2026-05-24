// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

import {IMintiMarketplace} from "./interfaces/IMintiMarketplace.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {FeeMath} from "./libraries/FeeMath.sol";

contract MintiMarketplace is IMintiMarketplace, ReentrancyGuard, Ownable2Step, Pausable {
    using FeeMath for uint256;

    // ═══════════════════════════ CONSTANTS & IMMUTABLES ═══════════════════════════

    IWETH public immutable weth;

    // ═══════════════════════════ STATE ═══════════════════════════

    address public feeRecipient;

    // Counters (start at 1 so that 0 means "no listing/bid/offer")
    uint256 private _nextListingId = 1;
    uint256 private _nextBidId = 1;
    uint256 private _nextCollectionOfferId = 1;

    // Primary storage
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Bid) public bids;
    mapping(uint256 => CollectionOffer) public collectionOffers;

    // ── Enumerable indexes (swap-and-pop) ──

    // Per-collection listing IDs
    mapping(address => uint256[]) private _collectionListingIds;
    mapping(uint256 => uint256) private _listingIdIndex;

    // Global active listing IDs (for Explore page)
    uint256[] private _allActiveListingIds;
    mapping(uint256 => uint256) private _allListingIdIndex;

    // Per-collection bid IDs
    mapping(address => uint256[]) private _collectionBidIds;
    mapping(uint256 => uint256) private _bidIdIndex;

    // Per-collection offer IDs
    mapping(address => uint256[]) private _collectionOfferIds;
    mapping(uint256 => uint256) private _collectionOfferIdIndex;

    // Deduplication: keccak256(nftContract, tokenId, seller) => listingId
    mapping(bytes32 => uint256) private _activeListingKey;

    // ═══════════════════════════ CONSTRUCTOR ═══════════════════════════

    constructor(address _weth, address _feeRecipient) Ownable(msg.sender) {
        if (_weth == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        weth = IWETH(_weth);
        feeRecipient = _feeRecipient;
    }

    // ═══════════════════════════ LISTINGS ═══════════════════════════

    function listItem(
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 quantity,
        bool isERC1155,
        uint64 expiresAt
    ) external whenNotPaused returns (uint256 listingId) {
        if (nftContract == address(0)) revert InvalidNftContract();
        if (price == 0) revert InvalidPrice();
        if (quantity == 0) revert InvalidQuantity();
        if (!isERC1155 && quantity != 1) revert InvalidQuantity();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiration();

        // Check for duplicate listing
        bytes32 key = _listingKey(nftContract, tokenId, msg.sender);
        if (_activeListingKey[key] != 0) revert AlreadyListed();

        // Verify ownership and approval
        if (isERC1155) {
            if (IERC1155(nftContract).balanceOf(msg.sender, tokenId) < quantity) revert InvalidQuantity();
            if (!IERC1155(nftContract).isApprovedForAll(msg.sender, address(this))) revert TokenNotApproved();
        } else {
            if (IERC721(nftContract).ownerOf(tokenId) != msg.sender) revert NotSeller();
            if (
                IERC721(nftContract).getApproved(tokenId) != address(this)
                    && !IERC721(nftContract).isApprovedForAll(msg.sender, address(this))
            ) revert TokenNotApproved();
        }

        listingId = _nextListingId++;

        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            price: price,
            quantity: quantity,
            isERC1155: isERC1155,
            timestamp: uint64(block.timestamp),
            expiresAt: expiresAt
        });

        // Add to indexes
        _activeListingKey[key] = listingId;
        _addToArray(_collectionListingIds[nftContract], _listingIdIndex, listingId);
        _addToArray(_allActiveListingIds, _allListingIdIndex, listingId);

        emit ItemListed(listingId, nftContract, tokenId, msg.sender, price, quantity, isERC1155);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.seller != msg.sender) revert NotSeller();

        address nftContract = listing.nftContract;
        bytes32 key = _listingKey(nftContract, listing.tokenId, msg.sender);

        // Remove from indexes
        delete _activeListingKey[key];
        _removeFromArray(_collectionListingIds[nftContract], _listingIdIndex, listingId);
        _removeFromArray(_allActiveListingIds, _allListingIdIndex, listingId);

        delete listings[listingId];

        emit ListingCancelled(listingId);
    }

    function buyItem(uint256 listingId, uint16 optionalRoyaltyBps) external payable nonReentrant whenNotPaused {
        Listing memory listing = listings[listingId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.seller == msg.sender) revert CallerIsSeller();
        if (msg.value != listing.price) revert InsufficientPayment();
        if (optionalRoyaltyBps > FeeMath.MAX_BPS) revert InvalidRoyaltyBps();
        if (listing.expiresAt != 0 && block.timestamp > listing.expiresAt) revert OrderExpired();

        // Remove listing from state BEFORE external calls (CEI)
        bytes32 key = _listingKey(listing.nftContract, listing.tokenId, listing.seller);
        delete _activeListingKey[key];
        _removeFromArray(_collectionListingIds[listing.nftContract], _listingIdIndex, listingId);
        _removeFromArray(_allActiveListingIds, _allListingIdIndex, listingId);
        delete listings[listingId];

        // Transfer NFT from seller to buyer
        _transferNft(listing.nftContract, listing.tokenId, listing.quantity, listing.isERC1155, listing.seller, msg.sender);

        // Distribute funds (ETH)
        FeeMath.FeeBreakdown memory fees = _calculateFees(
            listing.price, listing.nftContract, listing.tokenId, optionalRoyaltyBps
        );

        _transferETH(feeRecipient, fees.protocolFee);
        if (fees.royaltyAmount > 0 && fees.royaltyReceiver != address(0)) {
            _transferETH(fees.royaltyReceiver, fees.royaltyAmount);
        }
        _transferETH(listing.seller, fees.sellerProceeds);

        emit ItemSold(
            listingId,
            listing.nftContract,
            listing.tokenId,
            msg.sender,
            listing.seller,
            listing.price,
            fees.protocolFee,
            fees.royaltyAmount,
            fees.royaltyReceiver
        );
    }

    // ═══════════════════════════ TOKEN BIDS ═══════════════════════════

    function placeBid(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        uint256 quantity,
        bool isERC1155,
        uint16 optionalRoyaltyBps,
        uint64 expiresAt
    ) external whenNotPaused returns (uint256 bidId) {
        if (nftContract == address(0)) revert InvalidNftContract();
        if (amount == 0) revert InvalidPrice();
        if (quantity == 0) revert InvalidQuantity();
        if (!isERC1155 && quantity != 1) revert InvalidQuantity();
        if (optionalRoyaltyBps > FeeMath.MAX_BPS) revert InvalidRoyaltyBps();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiration();

        // Escrow WETH
        bool success = weth.transferFrom(msg.sender, address(this), amount * quantity);
        if (!success) revert TransferFailed();

        bidId = _nextBidId++;

        bids[bidId] = Bid({
            bidder: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            amount: amount,
            quantity: quantity,
            isERC1155: isERC1155,
            optionalRoyaltyBps: optionalRoyaltyBps,
            timestamp: uint64(block.timestamp),
            expiresAt: expiresAt
        });

        _addToArray(_collectionBidIds[nftContract], _bidIdIndex, bidId);

        emit BidPlaced(bidId, nftContract, tokenId, msg.sender, amount, quantity, optionalRoyaltyBps);
    }

    function cancelBid(uint256 bidId) external nonReentrant {
        Bid memory bid = bids[bidId];
        if (bid.bidder == address(0)) revert NotBidder();
        if (bid.bidder != msg.sender) revert NotBidder();

        // Remove from state before external calls
        _removeFromArray(_collectionBidIds[bid.nftContract], _bidIdIndex, bidId);
        delete bids[bidId];

        // Return escrowed WETH
        bool success = weth.transfer(msg.sender, bid.amount * bid.quantity);
        if (!success) revert TransferFailed();

        emit BidCancelled(bidId);
    }

    function acceptBid(uint256 bidId) external nonReentrant whenNotPaused {
        Bid memory bid = bids[bidId];
        if (bid.bidder == address(0)) revert NotBidder();
        if (bid.bidder == msg.sender) revert CallerIsSeller();
        if (bid.expiresAt != 0 && block.timestamp > bid.expiresAt) revert OrderExpired();

        // Remove bid from state before external calls
        _removeFromArray(_collectionBidIds[bid.nftContract], _bidIdIndex, bidId);
        delete bids[bidId];

        // Transfer NFT from seller (msg.sender) to bidder
        _transferNft(bid.nftContract, bid.tokenId, bid.quantity, bid.isERC1155, msg.sender, bid.bidder);

        // Calculate fees on the bid amount
        uint256 totalPayment = bid.amount * bid.quantity;
        FeeMath.FeeBreakdown memory fees =
            _calculateFees(totalPayment, bid.nftContract, bid.tokenId, bid.optionalRoyaltyBps);

        // Distribute WETH
        _transferWETH(feeRecipient, fees.protocolFee);
        if (fees.royaltyAmount > 0 && fees.royaltyReceiver != address(0)) {
            _transferWETH(fees.royaltyReceiver, fees.royaltyAmount);
        }
        _transferWETH(msg.sender, fees.sellerProceeds);

        emit BidAccepted(
            bidId,
            bid.nftContract,
            bid.tokenId,
            msg.sender,
            totalPayment,
            fees.protocolFee,
            fees.royaltyAmount,
            fees.royaltyReceiver
        );
    }

    // ═══════════════════════════ COLLECTION OFFERS ═══════════════════════════

    function placeCollectionOffer(
        address nftContract,
        uint256 amount,
        uint256 quantity,
        bool isERC1155,
        uint16 optionalRoyaltyBps,
        uint64 expiresAt
    ) external whenNotPaused returns (uint256 offerId) {
        if (nftContract == address(0)) revert InvalidNftContract();
        if (amount == 0) revert InvalidPrice();
        if (quantity == 0) revert InvalidQuantity();
        if (optionalRoyaltyBps > FeeMath.MAX_BPS) revert InvalidRoyaltyBps();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiration();

        // Escrow WETH for all requested tokens
        bool success = weth.transferFrom(msg.sender, address(this), amount * quantity);
        if (!success) revert TransferFailed();

        offerId = _nextCollectionOfferId++;

        collectionOffers[offerId] = CollectionOffer({
            bidder: msg.sender,
            nftContract: nftContract,
            amount: amount,
            quantity: quantity,
            fulfilled: 0,
            isERC1155: isERC1155,
            optionalRoyaltyBps: optionalRoyaltyBps,
            timestamp: uint64(block.timestamp),
            expiresAt: expiresAt
        });

        _addToArray(_collectionOfferIds[nftContract], _collectionOfferIdIndex, offerId);

        emit CollectionOfferPlaced(offerId, nftContract, msg.sender, amount, quantity, optionalRoyaltyBps);
    }

    function cancelCollectionOffer(uint256 offerId) external nonReentrant {
        CollectionOffer memory offer = collectionOffers[offerId];
        if (offer.bidder == address(0)) revert NotBidder();
        if (offer.bidder != msg.sender) revert NotBidder();

        // Calculate unfilled WETH to return
        uint256 unfilledQuantity = offer.quantity - offer.fulfilled;
        uint256 refundAmount = offer.amount * unfilledQuantity;

        // Remove from state before external calls
        _removeFromArray(_collectionOfferIds[offer.nftContract], _collectionOfferIdIndex, offerId);
        delete collectionOffers[offerId];

        // Return escrowed WETH for unfilled portion
        if (refundAmount > 0) {
            bool success = weth.transfer(msg.sender, refundAmount);
            if (!success) revert TransferFailed();
        }

        emit CollectionOfferCancelled(offerId);
    }

    function acceptCollectionOffer(uint256 offerId, uint256 tokenId) external nonReentrant whenNotPaused {
        CollectionOffer storage offer = collectionOffers[offerId];
        if (offer.bidder == address(0)) revert NotBidder();
        if (offer.bidder == msg.sender) revert CallerIsSeller();
        if (offer.fulfilled >= offer.quantity) revert OfferFullyFilled();
        if (offer.expiresAt != 0 && block.timestamp > offer.expiresAt) revert OrderExpired();

        // Increment fulfilled count
        offer.fulfilled++;
        bool fullyFilled = offer.fulfilled == offer.quantity;

        address bidder = offer.bidder;
        address nftContract = offer.nftContract;
        uint256 amount = offer.amount;
        bool isERC1155 = offer.isERC1155;
        uint16 optionalRoyaltyBps = offer.optionalRoyaltyBps;

        // Remove from indexes if fully filled
        if (fullyFilled) {
            _removeFromArray(_collectionOfferIds[nftContract], _collectionOfferIdIndex, offerId);
            delete collectionOffers[offerId];
        }

        // Transfer NFT from seller to bidder
        uint256 qty = 1; // Collection offers fill one token at a time
        _transferNft(nftContract, tokenId, qty, isERC1155, msg.sender, bidder);

        // Calculate and distribute fees
        FeeMath.FeeBreakdown memory fees = _calculateFees(amount, nftContract, tokenId, optionalRoyaltyBps);

        _transferWETH(feeRecipient, fees.protocolFee);
        if (fees.royaltyAmount > 0 && fees.royaltyReceiver != address(0)) {
            _transferWETH(fees.royaltyReceiver, fees.royaltyAmount);
        }
        _transferWETH(msg.sender, fees.sellerProceeds);

        emit CollectionOfferAccepted(
            offerId, nftContract, tokenId, msg.sender, amount, fees.protocolFee, fees.royaltyAmount, fees.royaltyReceiver
        );
    }

    // ═══════════════════════════ BATCH OPERATIONS ═══════════════════════════

    function batchCancelListings(uint256[] calldata listingIds) external whenNotPaused {
        for (uint256 i; i < listingIds.length; ++i) {
            uint256 id = listingIds[i];
            Listing storage listing = listings[id];
            if (listing.seller == address(0)) revert NotListed();
            if (listing.seller != msg.sender) revert NotSeller();

            address nftContract = listing.nftContract;
            bytes32 key = _listingKey(nftContract, listing.tokenId, msg.sender);

            delete _activeListingKey[key];
            _removeFromArray(_collectionListingIds[nftContract], _listingIdIndex, id);
            _removeFromArray(_allActiveListingIds, _allListingIdIndex, id);
            delete listings[id];

            emit ListingCancelled(id);
        }
    }

    // ═══════════════════════════ ADMIN ═══════════════════════════

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

    function pause() external onlyOwner {
        _pause();
        emit MarketplacePaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit MarketplaceUnpaused(msg.sender);
    }

    // ═══════════════════════════ VIEW FUNCTIONS ═══════════════════════════

    // ── Listings ──

    function getCollectionListingCount(address nftContract) external view returns (uint256) {
        return _collectionListingIds[nftContract].length;
    }

    function getCollectionListingIds(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory)
    {
        return _paginateArray(_collectionListingIds[nftContract], offset, limit);
    }

    function getListingsByIds(uint256[] calldata listingIds) external view returns (Listing[] memory result) {
        result = new Listing[](listingIds.length);
        for (uint256 i; i < listingIds.length; ++i) {
            result[i] = listings[listingIds[i]];
        }
    }

    function getTotalListingCount() external view returns (uint256) {
        return _allActiveListingIds.length;
    }

    function getAllListingIds(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _paginateArray(_allActiveListingIds, offset, limit);
    }

    // ── Bids ──

    function getCollectionBidCount(address nftContract) external view returns (uint256) {
        return _collectionBidIds[nftContract].length;
    }

    function getCollectionBidIds(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory)
    {
        return _paginateArray(_collectionBidIds[nftContract], offset, limit);
    }

    function getBidsByIds(uint256[] calldata bidIds) external view returns (Bid[] memory result) {
        result = new Bid[](bidIds.length);
        for (uint256 i; i < bidIds.length; ++i) {
            result[i] = bids[bidIds[i]];
        }
    }

    // ── Collection Offers ──

    function getCollectionOfferCount(address nftContract) external view returns (uint256) {
        return _collectionOfferIds[nftContract].length;
    }

    function getCollectionOfferIds(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory)
    {
        return _paginateArray(_collectionOfferIds[nftContract], offset, limit);
    }

    function getCollectionOffersByIds(uint256[] calldata offerIds)
        external
        view
        returns (CollectionOffer[] memory result)
    {
        result = new CollectionOffer[](offerIds.length);
        for (uint256 i; i < offerIds.length; ++i) {
            result[i] = collectionOffers[offerIds[i]];
        }
    }

    // ── Convenience ──

    function getActiveListingId(address nftContract, uint256 tokenId, address seller)
        external
        view
        returns (uint256)
    {
        return _activeListingKey[_listingKey(nftContract, tokenId, seller)];
    }

    // ═══════════════════════════ INTERNAL HELPERS ═══════════════════════════

    function _listingKey(address nftContract, uint256 tokenId, address seller) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nftContract, tokenId, seller));
    }

    function _transferNft(
        address nftContract,
        uint256 tokenId,
        uint256 quantity,
        bool isERC1155,
        address from,
        address to
    ) internal {
        if (isERC1155) {
            IERC1155(nftContract).safeTransferFrom(from, to, tokenId, quantity, "");
        } else {
            IERC721(nftContract).safeTransferFrom(from, to, tokenId);
        }
    }

    function _calculateFees(uint256 salePrice, address nftContract, uint256 tokenId, uint16 optionalRoyaltyBps)
        internal
        view
        returns (FeeMath.FeeBreakdown memory)
    {
        // Check ERC-2981 royalty
        uint256 erc2981Royalty;
        address erc2981Receiver;

        try IERC165(nftContract).supportsInterface(type(IERC2981).interfaceId) returns (bool supported) {
            if (supported) {
                try IERC2981(nftContract).royaltyInfo(tokenId, salePrice) returns (
                    address receiver, uint256 amount
                ) {
                    erc2981Receiver = receiver;
                    erc2981Royalty = amount;
                } catch {}
            }
        } catch {}

        // Fallback royalty receiver: try collection owner
        address fallbackReceiver;
        if (erc2981Receiver == address(0) && optionalRoyaltyBps > 0) {
            try Ownable(nftContract).owner() returns (address contractOwner) {
                fallbackReceiver = contractOwner;
            } catch {}
        }

        return FeeMath.calculateFees(salePrice, erc2981Royalty, erc2981Receiver, optionalRoyaltyBps, fallbackReceiver);
    }

    function _transferETH(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _transferWETH(address to, uint256 amount) internal {
        if (amount == 0) return;
        bool success = weth.transfer(to, amount);
        if (!success) revert TransferFailed();
    }

    // ── Swap-and-pop array management ──

    function _addToArray(uint256[] storage arr, mapping(uint256 => uint256) storage indexMap, uint256 id) internal {
        indexMap[id] = arr.length;
        arr.push(id);
    }

    function _removeFromArray(uint256[] storage arr, mapping(uint256 => uint256) storage indexMap, uint256 id)
        internal
    {
        uint256 index = indexMap[id];
        uint256 lastIndex = arr.length - 1;

        if (index != lastIndex) {
            uint256 lastId = arr[lastIndex];
            arr[index] = lastId;
            indexMap[lastId] = index;
        }

        arr.pop();
        delete indexMap[id];
    }

    function _paginateArray(uint256[] storage arr, uint256 offset, uint256 limit)
        internal
        view
        returns (uint256[] memory)
    {
        uint256 len = arr.length;
        if (offset >= len) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > len) end = len;
        uint256 size = end - offset;

        uint256[] memory result = new uint256[](size);
        for (uint256 i; i < size; ++i) {
            result[i] = arr[offset + i];
        }
        return result;
    }

    // Required to receive ETH (e.g., refunds from failed transfers)
    receive() external payable {}
}
