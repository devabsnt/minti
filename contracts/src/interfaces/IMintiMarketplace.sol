// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintiMarketplace {
    // ═══════════════════════════ STRUCTS ═══════════════════════════

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price; // in wei (native ETH)
        uint256 quantity; // 1 for ERC-721, 1+ for ERC-1155
        bool isERC1155;
        uint64 timestamp;
        uint64 expiresAt;
    }

    struct Bid {
        address bidder;
        address nftContract;
        uint256 tokenId;
        uint256 amount; // WETH amount escrowed
        uint256 quantity; // 1 for ERC-721, 1+ for ERC-1155
        bool isERC1155;
        uint16 optionalRoyaltyBps; // buyer-chosen additional royalty (0-10000)
        uint64 timestamp;
        uint64 expiresAt;
    }

    struct CollectionOffer {
        address bidder;
        address nftContract;
        uint256 amount; // WETH per unit
        uint256 quantity; // how many tokens the bidder wants
        uint256 fulfilled; // how many have been filled
        bool isERC1155;
        uint16 optionalRoyaltyBps;
        uint64 timestamp;
        uint64 expiresAt;
    }

    // ═══════════════════════════ EVENTS ═══════════════════════════

    event ItemListed(
        uint256 indexed listingId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address seller,
        uint256 price,
        uint256 quantity,
        bool isERC1155
    );

    event ListingCancelled(uint256 indexed listingId);

    event ItemSold(
        uint256 indexed listingId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address buyer,
        address seller,
        uint256 price,
        uint256 protocolFee,
        uint256 royaltyAmount,
        address royaltyReceiver
    );

    event BidPlaced(
        uint256 indexed bidId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address bidder,
        uint256 amount,
        uint256 quantity,
        uint16 optionalRoyaltyBps
    );

    event BidCancelled(uint256 indexed bidId);

    event BidAccepted(
        uint256 indexed bidId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address seller,
        uint256 amount,
        uint256 protocolFee,
        uint256 royaltyAmount,
        address royaltyReceiver
    );

    event CollectionOfferPlaced(
        uint256 indexed offerId,
        address indexed nftContract,
        address bidder,
        uint256 amount,
        uint256 quantity,
        uint16 optionalRoyaltyBps
    );

    event CollectionOfferCancelled(uint256 indexed offerId);

    event CollectionOfferAccepted(
        uint256 indexed offerId,
        address indexed nftContract,
        uint256 indexed tokenId,
        address seller,
        uint256 amount,
        uint256 protocolFee,
        uint256 royaltyAmount,
        address royaltyReceiver
    );

    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    event MarketplacePaused(address indexed by);
    event MarketplaceUnpaused(address indexed by);

    // ═══════════════════════════ ERRORS ═══════════════════════════

    error NotListed();
    error NotSeller();
    error NotBidder();
    error InsufficientPayment();
    error InvalidPrice();
    error InvalidQuantity();
    error AlreadyListed();
    error TokenNotApproved();
    error BidTooLow();
    error OfferFullyFilled();
    error InvalidRoyaltyBps();
    error TransferFailed();
    error ZeroAddress();
    error CallerIsSeller();
    error InvalidNftContract();
    error OrderExpired();
    error InvalidExpiration();

    // ═══════════════════════════ LISTINGS ═══════════════════════════

    function listItem(
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 quantity,
        bool isERC1155,
        uint64 expiresAt
    ) external returns (uint256 listingId);

    function cancelListing(uint256 listingId) external;

    function buyItem(uint256 listingId, uint16 optionalRoyaltyBps) external payable;

    // ═══════════════════════════ TOKEN BIDS ═══════════════════════════

    function placeBid(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        uint256 quantity,
        bool isERC1155,
        uint16 optionalRoyaltyBps,
        uint64 expiresAt
    ) external returns (uint256 bidId);

    function cancelBid(uint256 bidId) external;

    function acceptBid(uint256 bidId) external;

    // ═══════════════════════════ COLLECTION OFFERS ═══════════════════════════

    function placeCollectionOffer(
        address nftContract,
        uint256 amount,
        uint256 quantity,
        bool isERC1155,
        uint16 optionalRoyaltyBps,
        uint64 expiresAt
    ) external returns (uint256 offerId);

    function cancelCollectionOffer(uint256 offerId) external;

    function acceptCollectionOffer(uint256 offerId, uint256 tokenId) external;

    // ═══════════════════════════ BATCH OPERATIONS ═══════════════════════════

    function batchCancelListings(uint256[] calldata listingIds) external;

    // ═══════════════════════════ ADMIN ═══════════════════════════

    function setFeeRecipient(address newRecipient) external;

    function pause() external;

    function unpause() external;

    // ═══════════════════════════ VIEW FUNCTIONS ═══════════════════════════

    // Listings
    function getCollectionListingCount(address nftContract) external view returns (uint256);
    function getCollectionListingIds(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory);
    function getListingsByIds(uint256[] calldata listingIds) external view returns (Listing[] memory);
    function getTotalListingCount() external view returns (uint256);
    function getAllListingIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    // Bids
    function getCollectionBidCount(address nftContract) external view returns (uint256);
    function getCollectionBidIds(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory);
    function getBidsByIds(uint256[] calldata bidIds) external view returns (Bid[] memory);

    // Collection Offers
    function getCollectionOfferCount(address nftContract) external view returns (uint256);
    function getCollectionOfferIds(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory);
    function getCollectionOffersByIds(uint256[] calldata offerIds)
        external
        view
        returns (CollectionOffer[] memory);

    // Convenience
    function getActiveListingId(address nftContract, uint256 tokenId, address seller)
        external
        view
        returns (uint256);
}
